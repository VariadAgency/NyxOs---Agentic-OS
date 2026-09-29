// Anmelden im Browser für MCP-Konnektoren (OAuth 2.1 laut MCP-Spezifikation): Schutz-Metadaten
// (RFC 9728) → Server-Metadaten (RFC 8414) → dynamische Anmeldung des Clients (RFC 7591) → Code mit PKCE
// → Token (+ Auffrischen). Nötig für Higgsfield, Notion, ElevenLabs (dort gibt es keinen API-Schlüssel).
// Token liegen verschlüsselt im Geheimnis-Speicher (`mcp.<name>.oauth`), nie im Klartext an der Oberfläche.
import { t } from "@nyxos/shared";
import { createHash, randomBytes } from "node:crypto";
import { safeFetch } from "../net/safeFetch.js";
import type { SecretStore } from "../secrets/store.js";

export const oauthSecretName = (connector: string) => `mcp.${connector}.oauth`;

export interface OAuthServerInfo {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
  resource: string;
}

export interface StoredOAuth {
  /** "code" = Browser mit Rückkehr (Formular-Format), "device" = Geräte-Code (JSON-Format, z. B. Higgsfield). */
  kind?: "code" | "device";
  accessToken: string;
  refreshToken: string | null;
  /** ms seit 1970, `null` = unbekannt. */
  expiresAt: number | null;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resource: string;
}

interface Pending {
  connector: string;
  verifier: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
}

export class OAuthError extends Error {}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `https://a.b/x/y` → Kandidaten für `/.well-known/<name>` (mit Pfad eingefügt, dann ohne). */
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  const out = path && path !== "/" ? [`${u.origin}/.well-known/${name}${path}`] : [];
  out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

export async function discoverOAuth(mcpUrl: string, fetchImpl: typeof fetch = safeFetch()): Promise<OAuthServerInfo> {
  // 1) Schutz-Metadaten: Kopf `WWW-Authenticate: … resource_metadata="…"` einer Anfrage ohne Anmeldung, sonst well-known.
  let prm: Record<string, unknown> | null = null;
  try {
    const res = await fetchImpl(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), signal: AbortSignal.timeout(10_000) });
    const m = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "");
    if (m?.[1]) prm = await getJson(fetchImpl, new URL(m[1], mcpUrl).toString());
  } catch {
    // weiter mit well-known
  }
  if (!prm) for (const u of wellKnown(mcpUrl, "oauth-protected-resource")) if ((prm = await getJson(fetchImpl, u))) break;
  const asList = Array.isArray(prm?.authorization_servers) ? (prm?.authorization_servers as string[]) : [];
  const issuer = asList[0] ?? new URL(mcpUrl).origin;
  // 2) Server-Metadaten (OAuth, sonst OpenID).
  let meta: Record<string, unknown> | null = null;
  for (const u of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) if ((meta = await getJson(fetchImpl, u))) break;
  if (!meta || !webLink(meta.authorization_endpoint) || typeof meta.token_endpoint !== "string") throw new OAuthError(t("Dieser Dienst bietet keine Anmeldung im Browser an."));
  const scopes = Array.isArray(prm?.scopes_supported) ? (prm?.scopes_supported as string[]) : [];
  return {
    authorizationEndpoint: meta.authorization_endpoint as string,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : null,
    scopes,
    resource: typeof prm?.resource === "string" ? prm.resource : mcpUrl,
  };
}

function webLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return ["https:", "http:"].includes(new URL(v).protocol) ? v : null;
  } catch {
    return null;
  }
}

async function postForm(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new OAuthError(t("Der Anmelde-Dienst ist nicht erreichbar."));
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") throw new OAuthError(t("Die Anmeldung wurde abgelehnt – bitte nochmal „Anmelden“ drücken."));
  return body;
}

export interface DeviceLogin {
  state: "pending" | "failed";
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string | null;
}

interface DevicePending {
  deviceCode: string;
  tokenUrl: string;
  intervalMs: number;
  expiresAt: number;
  view: DeviceLogin;
  timer: NodeJS.Timeout | null;
}

export interface OAuthFlowsOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests: kürzerer Abfrage-Takt der Geräte-Anmeldung. */
  devicePollMs?: number;
  /** Nach erfolgreicher Anmeldung (Geräte-Code): Ablauf merken, Konnektor testen. */
  onLoggedIn?: (connector: string, expiresAt: number | null) => Promise<void>;
}

export class OAuthFlows {
  private readonly pending = new Map<string, Pending>();
  private readonly devices = new Map<string, DevicePending>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(
    private readonly secrets: SecretStore,
    private readonly o: OAuthFlowsOptions = {},
  ) {
    //: Metadaten-, Token- und Registrierungs-Adressen kommen vom fremden Server → geprüft abrufen.
    this.fetchImpl = safeFetch(o.fetchImpl ?? fetch);
    this.now = o.now ?? Date.now;
  }

  // ─── Geräte-Code (z. B. Higgsfield: JSON statt Formular) ───

  /** Geräte-Anmeldung beginnen: Link (+ Code) für den Nutzer; NyxOS fragt danach selbst nach, bis bestätigt. */
  async startDevice(connector: string, authorizeUrl: string, tokenUrl: string): Promise<DeviceLogin> {
    if (this.secrets.keyState !== "ok") throw new OAuthError(t("Der Geheimnis-Speicher hat noch keinen Schlüssel – die Anmeldung geht erst nach dem nächsten Deploy."));
    this.cancelDevice(connector);
    let body: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(authorizeUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body.device_code !== "string") throw new Error();
    } catch {
      throw new OAuthError(t("Der Anmelde-Dienst hat keinen Anmelde-Link geliefert – bitte später nochmal versuchen."));
    }
    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 900;
    const intervalS = Number(body.interval) > 0 ? Number(body.interval) : 5;
    const view: DeviceLogin = {
      state: "pending",
      // (10): der Link landet in window.open – nur http(s), nie javascript:/data: ….
      verificationUri: webLink(body.verification_uri_complete) ?? webLink(body.verification_uri),
      userCode: typeof body.user_code === "string" ? body.user_code : null,
      expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
      message: null,
    };
    const p: DevicePending = { deviceCode: body.device_code as string, tokenUrl, intervalMs: this.o.devicePollMs ?? intervalS * 1000, expiresAt: this.now() + expiresIn * 1000, view, timer: null };
    this.devices.set(connector, p);
    this.scheduleDevice(connector, p);
    return view;
  }

  deviceStatus(connector: string): DeviceLogin | null {
    return this.devices.get(connector)?.view ?? null;
  }

  cancelDevice(connector: string): void {
    const p = this.devices.get(connector);
    if (p?.timer) clearTimeout(p.timer);
    this.devices.delete(connector);
  }

  private scheduleDevice(connector: string, p: DevicePending): void {
    p.timer = setTimeout(() => void this.pollDevice(connector, p), p.intervalMs);
    p.timer.unref?.();
  }

  private failDevice(p: DevicePending, message: string): void {
    p.timer = null;
    p.view = { ...p.view, state: "failed", message };
  }

  private async pollDevice(connector: string, p: DevicePending): Promise<void> {
    if (this.devices.get(connector) !== p) return;
    if (this.now() > p.expiresAt) return this.failDevice(p, t("Der Anmelde-Link ist abgelaufen – bitte nochmal „Anmelden“ drücken."));
    let body: Record<string, unknown> = {};
    try {
      const res = await this.fetchImpl(p.tokenUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ device_code: p.deviceCode }), signal: AbortSignal.timeout(15_000) });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      // Netz-Aussetzer: einfach beim nächsten Takt nochmal.
    }
    if (this.devices.get(connector) !== p) return;
    if (typeof body.access_token === "string") {
      const stored: StoredOAuth = { ...this.toStored(body, p.tokenUrl, "", null, "", null), kind: "device" };
      try {
        await this.secrets.setSecret(oauthSecretName(connector), JSON.stringify(stored), { showLast4: false });
      } catch {
        return this.failDevice(p, t("Die Anmeldung kam an, ließ sich aber nicht speichern – bitte nochmal „Anmelden“ drücken."));
      }
      this.devices.delete(connector);
      await this.o.onLoggedIn?.(connector, stored.expiresAt).catch(() => {});
      return;
    }
    const err = typeof body.error === "string" ? body.error : "";
    if (err === "access_denied") return this.failDevice(p, t("Die Anmeldung wurde abgelehnt."));
    if (err === "expired_token") return this.failDevice(p, t("Der Anmelde-Link ist abgelaufen – bitte nochmal „Anmelden“ drücken."));
    if (err === "slow_down") p.intervalMs += 5000;
    this.scheduleDevice(connector, p);
  }

  /** Anmeldung beginnen: liefert die Adresse, die der Browser öffnet. */
  async start(connector: string, mcpUrl: string, redirectUri: string): Promise<string> {
    // Schlüssel muss da sein, bevor der Nutzer sich irgendwo anmeldet (sonst ginge das Token verloren).
    if (this.secrets.keyState !== "ok") throw new OAuthError(t("Der Geheimnis-Speicher hat noch keinen Schlüssel – die Anmeldung geht erst nach dem nächsten Deploy."));
    const info = await discoverOAuth(mcpUrl, this.fetchImpl);
    if (!info.registrationEndpoint) throw new OAuthError(t("Dieser Dienst erlaubt keine automatische Anmeldung neuer Programme."));
    let reg: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(info.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_name: "NyxOS", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
        signal: AbortSignal.timeout(15_000),
      });
      reg = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof reg.client_id !== "string") throw new Error();
    } catch {
      throw new OAuthError(t("Der Dienst hat NyxOS als Programm nicht angenommen."));
    }
    for (const [k, p] of this.pending) if (p.expiresAt < this.now()) this.pending.delete(k);
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(24));
    this.pending.set(state, {
      connector,
      verifier,
      clientId: reg.client_id as string,
      clientSecret: typeof reg.client_secret === "string" ? reg.client_secret : null,
      tokenEndpoint: info.tokenEndpoint,
      redirectUri,
      resource: info.resource,
      expiresAt: this.now() + 15 * 60_000,
    });
    const u = new URL(info.authorizationEndpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", reg.client_id as string);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    u.searchParams.set("resource", info.resource);
    if (info.scopes.length) u.searchParams.set("scope", info.scopes.join(" "));
    return u.toString();
  }

  /** Rückkehr aus dem Browser: Code gegen Token tauschen und verschlüsselt ablegen. Liefert den Konnektor-Namen. */
  async finish(state: string, code: string): Promise<{ connector: string; expiresAt: number | null }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expiresAt < this.now()) throw new OAuthError(t("Diese Anmeldung ist abgelaufen – bitte in NyxOS nochmal „Anmelden“ drücken."));
    const body = await postForm(this.fetchImpl, p.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
      resource: p.resource,
      ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
    });
    const stored = this.toStored(body, p.tokenEndpoint, p.clientId, p.clientSecret, p.resource, null);
    await this.secrets.setSecret(oauthSecretName(p.connector), JSON.stringify(stored), { showLast4: false });
    return { connector: p.connector, expiresAt: stored.expiresAt };
  }

  private toStored(body: Record<string, unknown>, tokenEndpoint: string, clientId: string, clientSecret: string | null, resource: string, prevRefresh: string | null): StoredOAuth {
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
    return {
      accessToken: body.access_token as string,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : prevRefresh,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : null,
      tokenEndpoint,
      clientId,
      clientSecret,
      resource,
    };
  }

  /** Gültiges Zugangs-Token (frischt 60 s vor Ablauf auf). `null` = nie angemeldet. */
  async accessToken(connector: string): Promise<{ token: string; expiresAt: number | null } | null> {
    const raw = await this.secrets.getSecret(oauthSecretName(connector));
    if (!raw) return null;
    let s: StoredOAuth;
    try {
      s = JSON.parse(raw) as StoredOAuth;
    } catch {
      return null;
    }
    if (s.expiresAt === null || s.expiresAt - 60_000 > this.now()) return { token: s.accessToken, expiresAt: s.expiresAt };
    if (!s.refreshToken) throw new OAuthError(t("Die Anmeldung ist abgelaufen – bitte nochmal „Anmelden“ drücken."));
    if (s.kind === "device") {
      // Geräte-Anmeldung: Auffrischen im selben JSON-Format; klappt es nicht, ehrlich neu anmelden lassen.
      let fresh: Record<string, unknown> = {};
      try {
        const res = await this.fetchImpl(s.tokenEndpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ refresh_token: s.refreshToken, grant_type: "refresh_token" }), signal: AbortSignal.timeout(15_000) });
        fresh = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        // unten: neu anmelden
      }
      if (typeof fresh.access_token !== "string") throw new OAuthError(t("Die Anmeldung ist abgelaufen – bitte nochmal „Anmelden“ drücken."));
      const next: StoredOAuth = { ...this.toStored(fresh, s.tokenEndpoint, "", null, "", s.refreshToken), kind: "device" };
      await this.secrets.setSecret(oauthSecretName(connector), JSON.stringify(next), { showLast4: false });
      return { token: next.accessToken, expiresAt: next.expiresAt };
    }
    const body = await postForm(this.fetchImpl, s.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: s.refreshToken,
      client_id: s.clientId,
      resource: s.resource,
      ...(s.clientSecret ? { client_secret: s.clientSecret } : {}),
    });
    const next = this.toStored(body, s.tokenEndpoint, s.clientId, s.clientSecret, s.resource, s.refreshToken);
    await this.secrets.setSecret(oauthSecretName(connector), JSON.stringify(next), { showLast4: false });
    return { token: next.accessToken, expiresAt: next.expiresAt };
  }
}
