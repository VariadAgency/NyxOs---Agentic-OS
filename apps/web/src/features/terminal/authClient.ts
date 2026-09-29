// Anmeldung im Browser: Passkey (WebAuthn) + CSRF-Token. Das Cookie selbst ist
// `HttpOnly` — JavaScript sieht nur das CSRF-Token (aus `/api/auth/status` oder der Anmelde-Antwort).
//
// „Anmeldung bleibt":
// - Ein gescheiterter Status-Abruf (Verbindungsaussetzer, 502 vom Tunnel) galt früher als
//   „nicht angemeldet": `fetchAuthStatus` gab dann `{authenticated:false, csrf:null}` zurück, löschte
//   das gemerkte Token und behielt genau dieses gescheiterte Ergebnis im Zwischenspeicher. Danach
//   schickte jede Schreibaktion KEIN Token mehr mit (403 „CSRF-Token fehlt oder falsch"), obwohl die
//   Sitzung auf dem Server die ganze Zeit gültig war. Jetzt wirft ein gescheiterter Abruf, der
//   letzte bestätigte Stand und das Token bleiben, und nichts Gescheitertes wird zwischengespeichert.
// - Alle schreibenden Anfragen laufen über `authFetch`: Token immer dabei; `403 code:"csrf"` → Token
//   einmal frisch holen und wiederholen; `401` → Dialog „Bitte anmelden" (Touch ID), danach läuft die
//   ursprüngliche Aktion weiter. Wird der Dialog geschlossen, kommt ein freundlicher Fehler.
import { t } from "@nyxos/shared";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { announceDemoReadonly, DEMO_READONLY_CODE, DemoReadonlyError } from "../../lib/demoReadonly";

export interface AuthStatus {
  authenticated: boolean;
  csrf: string | null;
  hasPasskey: boolean;
  authReads: boolean;
}

/** Der Status-Abruf selbst ist gescheitert (Netz, Tunnel, Server kurz weg) — sagt NICHTS über die Anmeldung. */
export class AuthStatusUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(t("Anmeldestatus gerade nicht abrufbar"));
  }
}

/** Eine Aktion brauchte die Anmeldung, und der Dialog wurde ohne Anmeldung geschlossen. */
export class LoginRequiredError extends Error {
  readonly status = 401;
  constructor() {
    super(t("Dafür bitte anmelden (Touch ID) – dann geht es weiter."));
  }
}

let csrf: string | null = null;
let statusPromise: Promise<AuthStatus> | null = null;
const listeners = new Set<() => void>();

export const LOGIN_EVENT = "nyxos:login-required";
export const CSRF_HEADER = "x-nyxos-csrf";

/**
 * Anmeldestatus vom Server. `force` holt neu; sonst teilt sich ein laufender bzw. zuletzt
 * ERFOLGREICHER Abruf. Wirft `AuthStatusUnavailableError`, wenn der Server nicht antwortet — dann
 * bleiben der letzte Stand und das gemerkte Token unangetastet.
 */
export function fetchAuthStatus(force = false): Promise<AuthStatus> {
  if (!statusPromise || force) {
    const p: Promise<AuthStatus> = fetch("/api/auth/status", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new AuthStatusUnavailableError(r.status);
        return (await r.json()) as AuthStatus;
      })
      .then((s) => {
        csrf = s.csrf;
        return s;
      })
      .catch((e: unknown) => {
        if (statusPromise === p) statusPromise = null; // nie ein gescheitertes Ergebnis wiederverwenden
        throw e instanceof AuthStatusUnavailableError ? e : new AuthStatusUnavailableError(null);
      });
    statusPromise = p;
  }
  return statusPromise;
}

/** Kopf mit dem CSRF-Token. Ist keins gemerkt, wird der Status frisch geholt (nie ein alter Fehlschlag). */
export async function csrfHeader(): Promise<Record<string, string>> {
  if (csrf === null) {
    try {
      await fetchAuthStatus(true);
    } catch {
      // Server gerade nicht erreichbar — die Anfrage selbst meldet dann den eigentlichen Fehler.
    }
  }
  return csrf ? { [CSRF_HEADER]: csrf } : {};
}

/**
 * Nur für Tests (`apps/web/test/helpers.tsx` `stubFetchRoutes`): setzt den zwischengespeicherten
 * CSRF-Stand direkt, ohne echten Fetch. Verhindert, dass `csrfHeader()` beim ersten schreibenden
 * Aufruf eines Tests still eine zusätzliche `/api/auth/status`-Anfrage auslöst — die würde sonst eine
 * per `mockImplementationOnce` für den eigentlichen Aufruf vorgesehene Antwort abfangen
 */
export function __primeAuthForTests(token: string | null = "test-csrf"): void {
  csrf = token;
  statusPromise = Promise.resolve({ authenticated: token !== null, csrf: token, hasPasskey: token !== null, authReads: false });
}

/** Nur für Tests: alles vergessen (Token, Zwischenspeicher, offene Anmelde-Wartende). */
export function __resetAuthForTests(): void {
  csrf = null;
  statusPromise = null;
  pendingLogin = null;
}

export interface LoginDialogDetail {
  /** Direkt im Einrichtungs-Code-Modus öffnen (Einstellungen → „Neues Gerät einrichten"). */
  newDevice?: boolean;
  /** Eine Aktion wartet auf die Anmeldung → Überschrift „Bitte anmelden". */
  forAction?: boolean;
}

/**
 * Anmelde-Dialog öffnen — z. B. von den Einstellungen aus. `newDevice: true` startet ihn direkt im
 * Einrichtungs-Code-Modus (Neues Gerät einrichten), statt erst beim Passkey-Login-Screen.
 */
export function openLoginDialog(opts?: LoginDialogDetail): void {
  window.dispatchEvent(new CustomEvent<LoginDialogDetail | undefined>(LOGIN_EVENT, { detail: opts }));
}

// ───────────── Warten auf die Anmeldung (mehrere Aktionen → ein Dialog) ─────────────

let pendingLogin: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;

/**
 * Öffnet (einmal) den Dialog „Bitte anmelden" und wartet: `true` nach erfolgreicher Anmeldung,
 * `false`, wenn der Dialog ohne Anmeldung geschlossen wird. Gleichzeitige Aufrufer teilen sich
 * denselben Dialog.
 */
export function ensureSignedIn(): Promise<boolean> {
  if (!pendingLogin) {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    pendingLogin = { promise, resolve };
    openLoginDialog({ forAction: true });
  }
  return pendingLogin.promise;
}

function settleLogin(ok: boolean): void {
  const p = pendingLogin;
  pendingLogin = null;
  p?.resolve(ok);
}

/** Der Dialog wurde ohne Anmeldung geschlossen. */
export function loginDialogClosed(): void {
  settleLogin(false);
}

/** Eine Anfrage bzw. der Terminal-Kanal wurde mit 401 abgelehnt → Anzeige neu laden, Dialog öffnen. */
export function requireLogin(): void {
  csrf = null;
  statusPromise = null;
  notify();
  void ensureSignedIn();
}

/** Jede Änderung (Anmeldung, Abmeldung, 401) — für Anzeigen, die den Status neu laden. */
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const signInListeners = new Set<() => void>();

/**
 * Nur erfolgreiche Anmeldungen — für Verbindungen, die danach neu aufgebaut werden (Terminal).
 * Bewusst getrennt von `onAuthChange`: hinge das Terminal an jeder Änderung, löste sein eigenes
 * `requireLogin()` (→ Änderung) sofort den nächsten Verbindungsversuch aus — Dauerschleife, und der
 * Dialog ließe sich nicht schließen.
 */
export function onSignedIn(fn: () => void): () => void {
  signInListeners.add(fn);
  return () => signInListeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

function signedIn(token: string): void {
  csrf = token;
  statusPromise = null;
  notify();
  for (const fn of signInListeners) fn();
  settleLogin(true);
}

// ───────────── Anfragen mit Anmeldung ─────────────

const isWrite = (method: string) => method !== "GET" && method !== "HEAD";

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * `fetch` für alles, was die Anmeldung braucht. Schreibende Anfragen tragen immer das CSRF-Token.
 * - `403 code:"csrf"`: Token einmal frisch holen und wiederholen (Token veraltet, z. B. nach
 *   Anmeldung in einem anderen Tab).
 * - `403 code:"demo_readonly"` (Demo): globale Demo-Meldung, `DemoReadonlyError`, keine Wiederholung.
 * - `401`: Dialog „Bitte anmelden" (Touch ID); nach der Anmeldung einmal wiederholen. Wird der Dialog
 *   geschlossen: `LoginRequiredError` (freundliche Meldung statt Technik).
 * Der Body muss wiederholbar sein (String, Blob, FormData — kein Stream).
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const send = async () => {
    const headers = new Headers(init.headers);
    if (isWrite(method)) {
      headers.delete(CSRF_HEADER);
      for (const [k, v] of Object.entries(await csrfHeader())) headers.set(k, v);
    }
    return fetch(url, { ...init, headers });
  };

  let res = await send();
  if (res.status === 403 && isWrite(method) && (await errorCode(res)) === "csrf") {
    csrf = null;
    let fresh: AuthStatus;
    try {
      fresh = await fetchAuthStatus(true);
    } catch {
      return res; // Server gerade weg — Aufrufer zeigt den Fehler, kein Dialog
    }
    if (fresh.authenticated) res = await send();
    else res = new Response(JSON.stringify({ code: "auth_required" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (res.status === 401) {
    csrf = null;
    statusPromise = null;
    notify();
    if (!(await ensureSignedIn())) throw new LoginRequiredError();
    res = await send();
    if (res.status === 401) throw new LoginRequiredError();
  }
  if (res.status === 403 && (await errorCode(res)) === DEMO_READONLY_CODE) {
    // Demo: nur umsehen. Eine ruhige, globale Meldung statt eines Fehlers je Funktion; nie wiederholen.
    announceDemoReadonly();
    throw new DemoReadonlyError();
  }
  return res;
}

/** WebAuthn erlaubt keine IP-Adresse als Relying-Party → von 127.0.0.1 auf localhost wechseln. */
export function localhostUrl(): string | null {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "[::1]") return null;
  return `${location.protocol}//localhost${location.port ? `:${location.port}` : ""}${location.pathname}${location.search}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t("Server antwortet mit {status}", { status: res.status }));
  return data;
}

export async function loginWithPasskey(): Promise<void> {
  const { options, challengeId } = await postJson<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; challengeId: string }>("/api/auth/login/options", {});
  const response = await startAuthentication({ optionsJSON: options });
  const r = await postJson<{ csrf: string }>("/api/auth/login/verify", { challengeId, response });
  signedIn(r.csrf);
}

export async function registerPasskey(setupCode: string, name: string): Promise<void> {
  const { options, challengeId } = await postJson<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"]; challengeId: string }>("/api/auth/register/options", {
    setupCode,
  });
  const response = await startRegistration({ optionsJSON: options });
  const r = await postJson<{ csrf: string }>("/api/auth/register/verify", { setupCode, challengeId, response, name });
  signedIn(r.csrf);
}

/** Abmelden: wie `authFetch` mit einmaliger Token-Erneuerung, aber OHNE „Bitte anmelden" bei 401
 * (wer schon abgemeldet ist, muss sich nicht erst anmelden, um sich abzumelden). */
async function signOutRequest(url: string): Promise<void> {
  const send = async () => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(await csrfHeader()) }, body: "{}" });
  let res = await send();
  if (res.status === 403 && (await errorCode(res)) === "csrf") {
    csrf = null;
    res = await send(); // csrfHeader() holt den Status frisch
  }
  if (!res.ok && res.status !== 401) throw new Error(t("Abmelden hat nicht geklappt – bitte noch einmal versuchen."));
  csrf = null;
  statusPromise = null;
  notify();
}

export function logout(): Promise<void> {
  return signOutRequest("/api/auth/logout");
}

/** Widerruf: alle Sitzungen auf allen Geräten beenden (Passkeys bleiben). */
export function logoutEverywhere(): Promise<void> {
  return signOutRequest("/api/auth/logout-all");
}

/**
 * Einrichtungs-Code für ein weiteres Gerät. Der Server gibt ihn nur heraus, wenn diese Sitzung in
 * den letzten 5 Minuten per Passkey bestätigt wurde — darum erst Touch ID, dann der Code.
 */
export async function createDeviceSetupCode(): Promise<{ code: string; expiresAt: string }> {
  await loginWithPasskey();
  const res = await authFetch("/api/auth/setup-code", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = (await res.json().catch(() => ({}))) as { code?: string; expiresAt?: string; error?: string };
  if (!res.ok || !data.code || !data.expiresAt) throw new Error(data.error ?? t("Code konnte nicht erzeugt werden – bitte noch einmal versuchen."));
  return { code: data.code, expiresAt: data.expiresAt };
}

/** Ein registrierter Passkey, wie ihn Einstellungen → Anmeldung zeigt (nie der Schlüssel selbst). */
export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Erste 6 Zeichen der Kennung — unterscheidet gleichnamige Passkeys. */
  shortId?: string;
  /** Mit diesem Passkey ist dieser Browser gerade angemeldet. */
  current: boolean;
}

/**
 * Anfrage an die Passkey-Verwaltung: Token immer dabei (auch beim Lesen), einmal frisches Token bei
 * `csrf`; verlangt der Server eine frische Bestätigung (`reauth`, älter als 5 Min) oder fehlt die
 * Anmeldung (`401`), einmal Touch ID und dann wiederholen — dasselbe Muster wie „Code erzeugen".
 */
async function passkeyRequest(url: string, method: "GET" | "DELETE" | "PATCH", body?: unknown): Promise<Response> {
  const send = async () =>
    fetch(url, { method, headers: { "content-type": "application/json", ...(await csrfHeader()) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let res = await send();
  if (res.status === 403 && (await errorCode(res)) === "csrf") {
    csrf = null;
    res = await send();
  }
  if (res.status === 401 || (res.status === 403 && (await errorCode(res)) === "reauth")) {
    await loginWithPasskey();
    res = await send();
  }
  return res;
}

async function failMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const res = await passkeyRequest("/api/auth/credentials", "GET");
  if (!res.ok) throw new Error(await failMessage(res, t("Die Passkeys ließen sich gerade nicht laden – bitte noch einmal versuchen.")));
  return ((await res.json()) as { credentials: PasskeyInfo[] }).credentials;
}

/** Entfernt einen Passkey und meldet alle Geräte ab, die mit ihm angemeldet waren. */
export async function removePasskey(id: string): Promise<void> {
  const res = await passkeyRequest(`/api/auth/credentials/${encodeURIComponent(id)}`, "DELETE");
  if (!res.ok) throw new Error(await failMessage(res, t("Entfernen hat nicht geklappt – bitte noch einmal versuchen.")));
}

/** Passkey umbenennen (gleiche Hürden wie Entfernen). */
export async function renamePasskey(id: string, name: string): Promise<void> {
  const res = await passkeyRequest(`/api/auth/credentials/${encodeURIComponent(id)}`, "PATCH", { name });
  if (!res.ok) throw new Error(await failMessage(res, t("Umbenennen hat nicht geklappt – bitte noch einmal versuchen.")));
}
