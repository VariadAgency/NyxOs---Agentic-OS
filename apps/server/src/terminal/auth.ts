// Schritt 6 · Anmeldung für alles, was schreibt. Passkey (WebAuthn) für den Nutzer, Sitzungs-Cookie
// `HttpOnly; SameSite=Strict`, CSRF-Token im Kopf `x-nyxos-csrf`. Zusätzlich zum Host-/Origin-Schutz
// aus security.ts, nicht statt dessen.
//
// Was geschützt ist (s. `needsAuth`):
// - jede nicht-GET-Anfrage unter /api/* (außer den Anmelde-Endpunkten selbst),
// - der Terminal-Kanal `GET /terminal/*` (WebSocket),
// - mit `NYXOS_AUTH_READS=1` zusätzlich alle lesenden /api/*-Pfade und `/live` (für später,
//   sobald Zugriff außerhalb von 127.0.0.1 möglich ist — Tailscale).
// Nicht betroffen: `/ingest/*` und `/bridge` (Maschinen-Token), `/health`, die Web-App-Dateien.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app.js";
import type { Db } from "../db/client.js";
import { authCredentials, authSessions, authSetupCodes } from "../db/schema.js";
import { isInternalRequest } from "../nyx/appApi/internal.js";
import { isBlockedForInternal } from "../nyx/appApi/rules.js";
import { loadAppSettings } from "../app-info/settings.js";
import { t } from "@nyxos/shared";

export const SESSION_COOKIE = "nyxos_session";
export const CSRF_HEADER = "x-nyxos-csrf";
/** Sitzung gilt 30 Tage ab der letzten Nutzung (gleitend), nicht ab der Anmeldung. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Verlängert wird höchstens einmal am Tag — sonst schriebe jede Anfrage eine DB-Zeile + ein Cookie. */
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** „Code erzeugen" und „Passkeys verwalten" nur, wenn die Sitzung frisch per Passkey bestätigt wurde
 * (s. `/api/auth/setup-code`, `/api/auth/credentials`). */
const FRESH_REAUTH_MS = 5 * 60 * 1000;
const SETUP_CODE_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = "NyxOS";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** CSRF-Vergleich per `!==` verrät über die Antwortzeit, wie viele führende
 * Zeichen schon stimmen. Beide Seiten erst hashen (fester 32-Byte-Digest, unabhängig von der Länge
 * des Kopf-Werts) und dann mit `timingSafeEqual` vergleichen — so wirft es nie wegen unterschiedlich
 * langer Eingaben, und die Vergleichszeit hängt nicht mehr vom Inhalt ab. */
function csrfMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  return timingSafeEqual(Buffer.from(sha256(header)), Buffer.from(sha256(expected)));
}

export interface AuthSession {
  tokenHash: string;
  csrf: string;
  createdAt: string;
  expiresAt: string;
  /** Passkey, mit dem diese Sitzung entstand (null: Probe-/CLI-Sitzung ohne Passkey). */
  credentialId: string | null;
}

/**
 * Cookies trennen NICHT nach Port — `localhost:47801` (echte NyxOS über den Tunnel) und
 * `localhost:47890`/`47912` (Probe) teilen sich sonst dasselbe `nyxos_session`-Cookie, und eine
 * Anmeldung an der Probe überschreibt still die echte (und umgekehrt). Darum hängt der Name am Port
 * des Hosts. Ohne Port (später Tailscale-Name über https) bleibt der alte Name.
 */
export function sessionCookieName(host: string | undefined | null): string {
  const m = /:(\d+)$/.exec(host ?? "");
  return m ? `${SESSION_COOKIE}_${m[1]}` : SESSION_COOKIE;
}

/** Cookie-Wert der Anfrage: erst der Port-Name, dann (Übergang, vor R1 gesetzt) der alte Name. */
function readSessionToken(c: Context): { token: string | undefined; name: string; legacy: boolean } {
  const name = sessionCookieName(c.req.header("host"));
  const own = getCookie(c, name);
  if (own) return { token: own, name, legacy: false };
  if (name !== SESSION_COOKIE) {
    const old = getCookie(c, SESSION_COOKIE);
    if (old) return { token: old, name, legacy: true };
  }
  return { token: undefined, name, legacy: false };
}

/** Legt eine Anmelde-Sitzung an und gibt den (nur hier bekannten) Cookie-Wert zurück. */
export async function createAuthSession(db: Db, credentialId: string | null, now = Date.now()): Promise<{ token: string; csrf: string }> {
  const token = randomToken();
  const csrf = randomToken(24);
  await db.insert(authSessions).values({
    tokenHash: sha256(token),
    csrf,
    credentialId,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  return { token, csrf };
}

export async function findAuthSession(db: Db, token: string | undefined, now = Date.now()): Promise<AuthSession | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({
      tokenHash: authSessions.tokenHash,
      csrf: authSessions.csrf,
      createdAt: authSessions.createdAt,
      expiresAt: authSessions.expiresAt,
      credentialId: authSessions.credentialId,
    })
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, sha256(token)), gt(authSessions.expiresAt, new Date(now).toISOString())))
    .limit(1);
  return row ?? null;
}

/** Local mode: one-time sign-in links (`nyxos open`). Code → expiry; valid for two minutes, usable once. */
const localLoginCodes = new Map<string, number>();
const LOCAL_LOGIN_TTL_MS = 2 * 60 * 1000;

export function createLocalLoginCode(now = Date.now()): string {
  for (const [code, exp] of localLoginCodes) if (exp <= now) localLoginCodes.delete(code);
  const code = randomToken(24);
  localLoginCodes.set(code, now + LOCAL_LOGIN_TTL_MS);
  return code;
}

/**
 * Where `/auth/local` may send the browser afterwards: only a path on this server. Browsers read `/\\host` and
 * `/<tab>/host` like `//host` (another site), so anything but a plain path falls back to `/`.
 */
export function safeLocalNext(next: string | undefined | null): string {
  if (!next || !next.startsWith("/") || next.length > 2000) return "/";
  if (next.startsWith("//") || [...next].some((ch) => ch === "\\" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "/";
  try {
    const url = new URL(next, "http://nyxos.invalid");
    if (url.origin !== "http://nyxos.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function consumeLocalLoginCode(code: unknown, now = Date.now()): boolean {
  if (typeof code !== "string" || code.length > 200) return false;
  const exp = localLoginCodes.get(code);
  localLoginCodes.delete(code);
  return exp !== undefined && exp > now;
}

/** Einmal-Code zum Einrichten eines Passkeys (CLI `passkey-setup`, Probe-Start). */
export async function createSetupCode(db: Db, now = Date.now()): Promise<string> {
  const code = randomToken(18);
  await db.insert(authSetupCodes).values({ codeHash: sha256(code), expiresAt: new Date(now + SETUP_CODE_TTL_MS).toISOString() });
  return code;
}

async function setupCodeValid(db: Db, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || code.length < 8 || code.length > 100) return false;
  const [row] = await db
    .select({ codeHash: authSetupCodes.codeHash })
    .from(authSetupCodes)
    .where(and(eq(authSetupCodes.codeHash, sha256(code)), isNull(authSetupCodes.usedAt), gt(authSetupCodes.expiresAt, new Date().toISOString())))
    .limit(1);
  return !!row;
}

/** Prüfung und Verbrauch waren getrennt (erst `setupCodeValid` lesen, ganz
 * am Ende separat `usedAt` setzen) — zwei fast gleichzeitige `register/verify`-Anfragen mit
 * demselben Code hätten beide die Prüfung bestanden und beide einen Passkey angelegt. Jetzt EIN
 * atomarer, bedingter `UPDATE … WHERE used_at IS NULL … RETURNING`: nur die Anfrage, die ihn
 * WIRKLICH als erste verbraucht, bekommt `true` — die zweite (egal wie knapp danach) `false`. */
export async function consumeSetupCode(db: Db, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || code.length < 8 || code.length > 100) return false;
  const rows = await db
    .update(authSetupCodes)
    .set({ usedAt: sql`now()` })
    .where(and(eq(authSetupCodes.codeHash, sha256(code)), isNull(authSetupCodes.usedAt), gt(authSetupCodes.expiresAt, new Date().toISOString())))
    .returning({ codeHash: authSetupCodes.codeHash });
  return rows.length > 0;
}

/** Alle Passkeys und Sitzungen löschen (CLI `passkey-reset`). */
export async function resetPasskeys(db: Db): Promise<{ credentials: number; sessions: number }> {
  const c = await db.delete(authCredentials).returning({ id: authCredentials.id });
  const s = await db.delete(authSessions).returning({ id: authSessions.tokenHash });
  return { credentials: c.length, sessions: s.length };
}

/** Relying-Party aus dem Host der Anfrage. WebAuthn erlaubt keine IP-Adressen als RP-ID →
 * `127.0.0.1` wird abgelehnt (die Web-App leitet vorher auf `localhost` um). */
export function rpFromRequest(c: Context): { rpId: string; origin: string } | { error: string } {
  const host = c.req.header("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) return { error: t("Host fehlt") };
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return { error: t("Passkeys brauchen einen Namen statt einer IP-Adresse — bitte über http://localhost öffnen") };
  const proto = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:" ? "https" : "http";
  return { rpId: hostname, origin: `${proto}://${host}` };
}

export function needsAuth(method: string, path: string, authReads: boolean): boolean {
  if (path.startsWith("/api/auth/")) return false;
  // Version, language and onboarding state: the web app needs them before anyone is signed in.
  if (path === "/api/app/info" && (method === "GET" || method === "HEAD")) return false;
  if (path.startsWith("/terminal/")) return true;
  // Container-Logs der Produktion (eigene Ansicht + Dozzle) können Personen- und Zugangsdaten
  // enthalten — immer nur mit Anmeldung, auch wenn Lesen sonst frei ist.
  if (path.startsWith("/api/server/containers/") || path === "/dozzle" || path.startsWith("/dozzle/")) return true;
  // Bilder aus des Nutzers Eingaben (Chat-Vorschau) — persönliche Inhalte, immer nur mit Anmeldung.
  if (/^\/api\/sessions\/[^/]+\/attachments\//.test(path)) return true;
  // Dateien vom Mac (Downloads, Bildschirmfotos, Projektordner) — persönlich, immer nur mit Anmeldung.
  if (path.startsWith("/api/finder/")) return true;
  // Dateien und Host-Daten des Servers (Pfade, offene Ports) — nur lesen, aber immer nur mit Anmeldung.
  if (path.startsWith("/api/server/files/") || path === "/api/server/host") return true;
  // Server-SSH: echte Shell auf dem Produktionsserver — auch der Status nur mit Anmeldung.
  if (path === "/api/server/ssh" || path.startsWith("/api/server/ssh/")) return true;
  // Nyx-Ablage (Simulator-Screenshots, Anhänge vom Nutzer) — ebenso persönlich, immer mit Anmeldung.
  if (path === "/api/nyx/files" || path.startsWith("/api/nyx/files/")) return true;
  // Nyx steuert den Browser und liest den Bildschirm (Route, Beschriftungen) — nie ohne Anmeldung.
  if (path.startsWith("/api/nyx/ui/")) return true;
  // ⌘K-Suche über alles liefert auch Nyx-Gedächtnis (persönliche Fakten) — immer mit Anmeldung.
  if (path === "/api/search/all") return true;
  // das geheime ntfy-Thema (wer es kennt, liest die Mitteilungen mit) — immer nur mit Anmeldung.
  if (path === "/api/push/subscribe") return true;
  // Feedback & Unterstützen: eigene Meldungen (E-Mail, Bildschirmfoto, Diagnose) — immer nur mit Anmeldung.
  if (path.startsWith("/api/support/")) return true;
  if (path.startsWith("/api/")) return method !== "GET" && method !== "HEAD" ? true : authReads;
  if (path === "/live") return authReads;
  return false;
}

export interface AuthOptions {
  /** Lesende Endpunkte auch schützen (später, mit Tailscale). Default: `NYXOS_AUTH_READS=1`. */
  authReads?: boolean;
  /**
   * der MCP-Anschluss (`apps/bridge/src/mcp.ts`) läuft in einem eigenen Prozess auf
   * dem Rechner und kann kein Browser-Cookie halten — dieselbe Vertrauensstufe wie `/ingest/*`
   * (Maschinen-Token) genügt deshalb für `POST/PATCH /api/entries/*`. Passkey bleibt für alles
   * Browser-Erreichbare (Sessions, Terminal, …) Pflicht. Injiziert statt importiert (wie
   * `registerTerminalRoutes`s `hashToken`-Abhängigkeit), damit `auth.ts` nicht auf `app.ts`
   * zurückgreifen muss (Zirkel).
   */
  verifyMachineToken?: (token: string) => Promise<boolean>;
  /**
   * knappes Protokoll jeder Ablehnung (401/403) — Grund, Methode, Weg und nur OB Cookie bzw.
   * Token mitkamen, nie deren Werte. Vorher loggte der Server keine Anfragen; ob „Nicht angemeldet"
   * im Review eine echte Ablehnung war, ließ sich darum nur indirekt belegen.
   */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Local mode: one-time sign-in links from the `nyxos` command (`GET /auth/local`). Off in server mode. */
  localLogin?: boolean;
}

export function createAuth(db: Db, opts: AuthOptions = {}) {
  const authReads = opts.authReads ?? process.env.NYXOS_AUTH_READS === "1";
  const verifyMachineToken = opts.verifyMachineToken;
  const localLogin = opts.localLogin ?? false;
  const log = opts.log ?? (() => {});
  const reject = (c: Context, status: 401 | 403, code: string, error: string) => {
    log("auth-abgelehnt", {
      status,
      code,
      method: c.req.method,
      path: c.req.path,
      cookie: readSessionToken(c).token !== undefined,
      csrf: !!c.req.header(CSRF_HEADER),
    });
    return c.json({ error, code }, status);
  };
  // Offene Challenges nur im Speicher (5 Min): ein Neustart dazwischen heißt nur „noch einmal tippen".
  const challenges = new Map<string, { challenge: string; kind: "register" | "login"; expires: number }>();
  const takeChallenge = (id: unknown, kind: "register" | "login"): string | null => {
    if (typeof id !== "string") return null;
    const entry = challenges.get(id);
    challenges.delete(id);
    if (!entry || entry.kind !== kind || entry.expires < Date.now()) return null;
    return entry.challenge;
  };
  const putChallenge = (challenge: string, kind: "register" | "login") => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    const id = randomToken(16);
    challenges.set(id, { challenge, kind, expires: now + CHALLENGE_TTL_MS });
    return id;
  };

  const writeCookie = (c: Context, name: string, token: string) => {
    const rp = rpFromRequest(c);
    setCookie(c, name, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: "origin" in rp && rp.origin.startsWith("https:"),
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  const issueCookie = async (c: Context, credentialId: string) => {
    // Neu angemeldet (z. B. frische Bestätigung für „Code erzeugen"): die bisherige Sitzung dieses
    // Browsers ist damit abgelöst und wird gleich gelöscht, statt bis zum Ablauf herumzuliegen.
    const previous = readSessionToken(c);
    if (previous.token) await db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(previous.token)));
    const { token, csrf } = await createAuthSession(db, credentialId);
    writeCookie(c, previous.name, token);
    return csrf;
  };

  /**
   * Gültige Sitzung der Anfrage (oder null). Gleitend: Ist die letzte Verlängerung älter als einen
   * Tag, gilt die Sitzung ab jetzt wieder volle 30 Tage (DB + Cookie-Max-Age). Ein Cookie unter dem
   * alten Namen wird dabei auf den Port-Namen umgeschrieben.
   */
  const currentSession = async (c: Context, now = Date.now()): Promise<AuthSession | null> => {
    const { token, name, legacy } = readSessionToken(c);
    if (!token) return null;
    const session = await findAuthSession(db, token, now);
    if (!session) return null;
    const extendedAt = Date.parse(session.expiresAt) - SESSION_TTL_MS;
    if (now - extendedAt >= SESSION_REFRESH_AFTER_MS) {
      const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
      await db.update(authSessions).set({ expiresAt, lastSeenAt: sql`now()` }).where(eq(authSessions.tokenHash, session.tokenHash));
      session.expiresAt = expiresAt;
      writeCookie(c, name, token);
    } else if (legacy) {
      writeCookie(c, name, token);
    }
    return session;
  };

  /** Middleware: schützt schreibende Wege + Terminal-Kanal. Muss VOR den Routen registriert sein. */
  const gate: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    // app_api: vom Server selbst gebaute Anfrage (Nyx im Auftrag vom Nutzer, s. nyx/appApi/internal.ts) – gilt
    // als angemeldet, aber nie für gesperrte Wege (Anmeldung, Geheimnisse …). Zweite Sperre neben dem Werkzeug.
    if (isInternalRequest(c.req.raw)) {
      if (isBlockedForInternal(method, path)) return reject(c, 403, "blocked_for_nyx", t("Diesen Weg darf Nyx nicht benutzen"));
      return next();
    }
    if (!needsAuth(method, path, authReads)) return next();
    // MCP-Anschluss (eigener Prozess, kein Browser-Cookie) — ein gültiges
    // Maschinen-Token genügt für /api/entries/*, dieselbe Vertrauensstufe wie /ingest/*.
    // dazu NUR der Haiku-Selbsttest (feste Frage „Wer bist du?“, kein Faden) für scripts/haiku-smoke.mjs.
    // A deploy script reports deploys with the machine token too (no passkey session on a server shell).
    if (verifyMachineToken && (path.startsWith("/api/entries") || (method === "POST" && (path === "/api/haiku/selftest" || path === "/api/server/deploys")))) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (token && (await verifyMachineToken(token))) return next();
    }
    const session = await currentSession(c);
    if (!session) return reject(c, 401, "auth_required", t("Bitte anmelden"));
    // CSRF: bei schreibenden Anfragen muss der Kopf zum Token der Sitzung passen. Der WebSocket-
    // Handschlag (GET) kann keinen eigenen Kopf setzen — dort schützen SameSite=Strict + die strenge
    // Origin-gleich-Host-Prüfung in routes/terminal.ts. Der Web-Client holt bei `code: "csrf"`
    // einmal ein frisches Token und wiederholt die Anfrage (authClient `authFetch`).
    if (method !== "GET" && method !== "HEAD" && !csrfMatches(c.req.header(CSRF_HEADER), session.csrf)) {
      return reject(c, 403, "csrf", t("Bitte noch einmal versuchen"));
    }
    await db.update(authSessions).set({ lastSeenAt: sql`now()` }).where(eq(authSessions.tokenHash, session.tokenHash));
    return next();
  };

  function register(app: Hono<AppEnv>) {
    // Local mode: the `nyxos` command opens the browser with a one-time link; it signs this browser in.
    // Server mode has no such link: there the passkey is the only way in.
    if (localLogin) {
      app.get("/auth/local", async (c) => {
        c.header("cache-control", "no-store");
        if (!consumeLocalLoginCode(c.req.query("code"))) return c.redirect("/?login=expired", 302);
        const previous = readSessionToken(c);
        if (previous.token) await db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(previous.token)));
        const { token } = await createAuthSession(db, null);
        writeCookie(c, previous.name, token);
        return c.redirect(safeLocalNext(c.req.query("next")), 302);
      });
    }

    app.get("/api/auth/status", async (c) => {
      // Nie zwischenspeichern: ein alter Stand hier hieße „Nicht angemeldet", obwohl die Sitzung gilt.
      c.header("cache-control", "no-store");
      const session = await currentSession(c);
      const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(authCredentials)) as [{ n: number }];
      return c.json({ authenticated: !!session, csrf: session?.csrf ?? null, hasPasskey: n > 0, authReads });
    });

    app.post("/api/auth/register/options", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { setupCode?: unknown } | null;
      if (!(await setupCodeValid(db, body?.setupCode))) return c.json({ error: t("Einrichtungs-Code ungültig oder abgelaufen") }, 403);
      const rp = rpFromRequest(c);
      if ("error" in rp) return c.json({ error: rp.error }, 400);
      const existing = await db.select({ id: authCredentials.id, transports: authCredentials.transports }).from(authCredentials);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpId,
        userName: "nyxos",
        userDisplayName: (await loadAppSettings(db).catch(() => null))?.userName.trim() || "NyxOS",
        attestationType: "none",
        excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      return c.json({ options, challengeId: putChallenge(options.challenge, "register") });
    });

    app.post("/api/auth/register/verify", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { setupCode?: unknown; challengeId?: unknown; response?: unknown; name?: unknown } | null;
      if (!(await setupCodeValid(db, body?.setupCode))) return c.json({ error: t("Einrichtungs-Code ungültig oder abgelaufen") }, 403);
      const challenge = takeChallenge(body?.challengeId, "register");
      if (!challenge) return c.json({ error: t("Anfrage abgelaufen, bitte neu starten") }, 400);
      const rp = rpFromRequest(c);
      if ("error" in rp) return c.json({ error: rp.error }, 400);
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: body?.response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          requireUserVerification: false,
        });
      } catch (e) {
        return c.json({ error: t("Passkey nicht angenommen: {error}", { error: e instanceof Error ? e.message : String(e) }) }, 400);
      }
      if (!verified.verified) return c.json({ error: t("Passkey nicht bestätigt") }, 400);
      // Atomarer Verbrauch UNMITTELBAR vor dem Schreiben der Anmeldedaten (nicht schon ganz am
      // Anfang — der frühere `setupCodeValid`-Check oben bleibt als schneller, NICHT-verbrauchender
      // Vorab-Filter, damit ein offensichtlich falscher/abgelaufener Code nicht erst die teure
      // WebAuthn-Prüfung durchläuft). Zwei parallele Anfragen mit demselben Code: nur eine gewinnt
      // hier `true` und legt einen Passkey an, die andere bekommt 403.
      if (!(await consumeSetupCode(db, body?.setupCode))) return c.json({ error: t("Einrichtungs-Code wurde bereits verwendet") }, 403);
      const cred = verified.registrationInfo.credential;
      const baseName = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "Passkey";
      // Browser/Gerät aus der Anmeldung mitspeichern, damit gleichnamige Passkeys unterscheidbar sind.
      const device = deviceSummary(c.req.header("user-agent"));
      const name = (device && !baseName.includes(device) ? `${baseName} · ${device}` : baseName).slice(0, 60);
      await db.insert(authCredentials).values({
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey).toString("base64url"),
        counter: cred.counter,
        transports: (cred.transports ?? []) as string[],
        rpId: rp.rpId,
        name,
      });
      const csrf = await issueCookie(c, cred.id);
      return c.json({ ok: true, csrf });
    });

    app.post("/api/auth/login/options", async (c) => {
      const rp = rpFromRequest(c);
      if ("error" in rp) return c.json({ error: rp.error }, 400);
      const creds = await db.select({ id: authCredentials.id, transports: authCredentials.transports }).from(authCredentials).where(eq(authCredentials.rpId, rp.rpId));
      if (creds.length === 0) return c.json({ error: t("Für diese Adresse ist noch kein Passkey eingerichtet"), code: "no_passkey" }, 404);
      const options = await generateAuthenticationOptions({
        rpID: rp.rpId,
        allowCredentials: creds.map((e) => ({ id: e.id, transports: e.transports })),
        // echte Bestätigung (Touch ID) verlangen — eine frische Anmeldung schaltet u. a.
        // „Code erzeugen" frei, da reicht bloßes Antippen eines Sicherheitsschlüssels nicht.
        userVerification: "required",
      });
      return c.json({ options, challengeId: putChallenge(options.challenge, "login") });
    });

    app.post("/api/auth/login/verify", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { challengeId?: unknown; response?: AuthenticationResponseJSON } | null;
      const challenge = takeChallenge(body?.challengeId, "login");
      if (!challenge || !body?.response || typeof body.response.id !== "string") return c.json({ error: t("Anfrage abgelaufen, bitte neu starten") }, 400);
      const rp = rpFromRequest(c);
      if ("error" in rp) return c.json({ error: rp.error }, 400);
      const [cred] = await db.select().from(authCredentials).where(eq(authCredentials.id, body.response.id)).limit(1);
      if (!cred || cred.rpId !== rp.rpId) return c.json({ error: t("Passkey unbekannt") }, 401);
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")), counter: cred.counter, transports: cred.transports as never },
          requireUserVerification: true,
        });
      } catch (e) {
        return c.json({ error: `Anmeldung abgelehnt: ${e instanceof Error ? e.message : String(e)}` }, 401);
      }
      if (!verified.verified) return c.json({ error: "Anmeldung abgelehnt" }, 401);
      await db.update(authCredentials).set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: sql`now()` }).where(eq(authCredentials.id, cred.id));
      const csrf = await issueCookie(c, cred.id);
      return c.json({ ok: true, csrf });
    });

    app.post("/api/auth/logout", async (c) => {
      const { token, name } = readSessionToken(c);
      if (token) await db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(token)));
      deleteCookie(c, name, { path: "/" });
      if (name !== SESSION_COOKIE && getCookie(c, SESSION_COOKIE)) deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    });

    /** Anmelde-Endpunkte laufen am `gate` vorbei — diese hier prüfen Sitzung + Token selbst. */
    const requireSessionWithCsrf = async (c: Context): Promise<AuthSession | Response> => {
      const session = await currentSession(c);
      if (!session) return reject(c, 401, "auth_required", t("Bitte anmelden"));
      if (!csrfMatches(c.req.header(CSRF_HEADER), session.csrf)) return reject(c, 403, "csrf", t("Bitte noch einmal versuchen"));
      return session;
    };

    // So herum geschrieben, dass ein unlesbares Datum (NaN) NICHT durchrutscht.
    const isFresh = (session: AuthSession) => Date.now() - Date.parse(session.createdAt) <= FRESH_REAUTH_MS;
    const reauthRequired = (c: Context) => c.json({ error: t("Bitte zuerst kurz mit Touch ID bestätigen"), code: "reauth" }, 403);

    /**
     * Passkeys verwalten (Einstellungen → Anmeldung). Wie „Code erzeugen": nur mit Sitzung +
     * CSRF-Token (auch beim Lesen — die Liste verrät, welche Geräte Zugang haben) und nur nach frischer
     * Touch-ID-Bestätigung (≤ 5 Min). Der öffentliche Schlüssel verlässt den Server nie.
     */
    app.get("/api/auth/credentials", async (c) => {
      c.header("cache-control", "no-store");
      const session = await requireSessionWithCsrf(c);
      if (session instanceof Response) return session;
      if (!isFresh(session)) return reauthRequired(c);
      const rows = await db
        .select({ id: authCredentials.id, name: authCredentials.name, createdAt: authCredentials.createdAt, lastUsedAt: authCredentials.lastUsedAt })
        .from(authCredentials)
        .orderBy(authCredentials.createdAt);
      return c.json({ credentials: rows.map((r) => ({ ...r, shortId: r.id.slice(0, 6), current: r.id === session.credentialId })) });
    });

    /** Passkey umbenennen — gleiche Hürden wie Entfernen (Sitzung, Token, frische Bestätigung). */
    app.patch("/api/auth/credentials/:id", async (c) => {
      const session = await requireSessionWithCsrf(c);
      if (session instanceof Response) return session;
      if (!isFresh(session)) return reauthRequired(c);
      const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return c.json({ error: t("Bitte einen Namen eingeben."), code: "name" }, 400);
      const updated = await db.update(authCredentials).set({ name }).where(eq(authCredentials.id, c.req.param("id"))).returning({ id: authCredentials.id });
      if (updated.length === 0) return c.json({ error: t("Diesen Passkey gibt es nicht mehr – die Liste wird neu geladen."), code: "not_found" }, 404);
      return c.json({ ok: true, name });
    });

    /**
     * Entfernt einen Passkey samt aller Anmeldungen, die mit ihm entstanden sind. Nie den gerade
     * benutzten (sonst sperrt sich der Nutzer mitten in der Handlung aus) und nie den letzten (sonst
     * bliebe nur noch `cli.js passkey-setup` mit Server-Zugang).
     */
    app.delete("/api/auth/credentials/:id", async (c) => {
      const session = await requireSessionWithCsrf(c);
      if (session instanceof Response) return session;
      if (!isFresh(session)) return reauthRequired(c);
      const id = c.req.param("id");
      if (id === session.credentialId) {
        return c.json({ error: t("Mit diesem Passkey bist du gerade angemeldet – er bleibt. Entfernen geht von einem anderen Gerät aus."), code: "current" }, 409);
      }
      const result = await db.transaction(async (tx) => {
        const all = await tx.select({ id: authCredentials.id }).from(authCredentials).for("update");
        if (!all.some((r) => r.id === id)) return "not_found" as const;
        if (all.length <= 1) return "last" as const;
        const removed = await tx.delete(authSessions).where(eq(authSessions.credentialId, id)).returning({ id: authSessions.tokenHash });
        await tx.delete(authCredentials).where(eq(authCredentials.id, id));
        return removed.length;
      });
      if (result === "not_found") return c.json({ error: t("Diesen Passkey gibt es nicht mehr – die Liste wird neu geladen."), code: "not_found" }, 404);
      if (result === "last") return c.json({ error: t("Das ist dein letzter Passkey – er bleibt, sonst kämst du nicht mehr hinein."), code: "last" }, 409);
      log("passkey-entfernt", { sessions: result });
      return c.json({ ok: true, sessions: result });
    });

    // Widerruf: alle Sitzungen auf allen Geräten beenden (z. B. Gerät verloren). Passkeys bleiben —
    // die entfernt nur `cli.js passkey-reset`.
    app.post("/api/auth/logout-all", async (c) => {
      const session = await requireSessionWithCsrf(c);
      if (session instanceof Response) return session;
      const revoked = await db.delete(authSessions).returning({ id: authSessions.tokenHash });
      deleteCookie(c, readSessionToken(c).name, { path: "/" });
      return c.json({ ok: true, revoked: revoked.length });
    });

    /**
     * Einrichtungs-Code für ein weiteres Gerät per Knopf. Sicher, weil:
     * - nur mit gültiger Sitzung + CSRF-Token (wie jede Schreibaktion; SameSite=Strict + Origin-Prüfung),
     * - nur, wenn diese Sitzung in den letzten 5 Minuten per Passkey (Touch ID) entstanden ist — ein
     *   gestohlenes oder liegengebliebenes Cookie allein reicht NICHT, um sich einen dauerhaften
     *   eigenen Passkey zu verschaffen (Widerruf per „Überall abmelden" bliebe sonst wirkungslos),
     * - der Code gilt 15 Min, nur einmal, nur als Hash gespeichert, und es ist immer nur einer offen
     *   (ein neuer macht die älteren ungültig),
     * - die Anmeldung selbst verlangt echte Nutzer-Bestätigung (Touch ID/PIN, `requireUserVerification`).
     * Das allererste Gerät bekommt den Code weiter über `cli.js passkey-setup` (Server-Zugang nötig).
     */
    app.post("/api/auth/setup-code", async (c) => {
      const session = await requireSessionWithCsrf(c);
      if (session instanceof Response) return session;
      if (!isFresh(session)) return reauthRequired(c);
      // Immer nur EIN offener Code: ein neuer macht alle älteren, noch unbenutzten ungültig.
      await db
        .update(authSetupCodes)
        .set({ expiresAt: new Date().toISOString() })
        .where(and(isNull(authSetupCodes.usedAt), gt(authSetupCodes.expiresAt, new Date().toISOString())));
      const code = await createSetupCode(db);
      return c.json({ code, expiresAt: new Date(Date.now() + SETUP_CODE_TTL_MS).toISOString() });
    });
  }

  /** Is this request from the signed-in user (or Nyx acting for them)? For public routes that hide personal fields. */
  const signedIn = async (c: Context): Promise<boolean> => isInternalRequest(c.req.raw) || !!(await findAuthSession(db, readSessionToken(c).token));

  return { gate, register, authReads, signedIn };
}

/** kurze Geräte-/Browser-Angabe aus dem User-Agent („Safari · macOS“), sonst `null`. */
export function deviceSummary(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const parts = [browser, os].filter((x): x is string => x !== null);
  return parts.length ? parts.join(" · ") : null;
}
