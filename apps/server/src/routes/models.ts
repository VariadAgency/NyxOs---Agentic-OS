// Einstellungen → Modelle, Konnektoren, Geheimnisse. Keine Route gibt je Klartext eines Geheimnisses
// zurück (nur „gesetzt“ + letzte 4 Zeichen). Hängt außerdem Modellwahl + Konnektoren in den Nyx-Motor ein.
import {
  BRIDGE_CAP_LOCAL_PROXY,
  ConnectorPatchSchema,
  ConnectorSaveSchema,
  MCP_TEMPLATES,
  ModelRoleSchema,
  ProviderSaveSchema,
  ProviderTestRequestSchema,
  RoleAssignSchema,
  SecretNameSchema,
  SecretPutSchema, getLang, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import type { RemoteEngine } from "../haiku/remoteEngine.js";
import { ConnectorError, ConnectorService } from "../mcp/connectors.js";
import { McpError, type McpServerSpec } from "../mcp/client.js";
import { OAuthError, OAuthFlows } from "../mcp/oauth.js";
import { ProviderError } from "../models/chat.js";
import { ProviderEngine } from "../models/providerEngine.js";
import { ModelService, roleForKind } from "../models/providers.js";
import { UnsafeUrlError } from "../net/safeFetch.js";
import { SecretsKeyError, SecretStore } from "../secrets/store.js";
import { isAllowedOrigin, parseAllowedHosts } from "../security.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";

export interface ModelsRouteDeps {
  db: Db;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  bridgeHub?: BridgeHub | null;
  /** Nyx-Motor: bekommt Modellwahl + Konnektoren eingehängt. */
  runtime?: HaikuRuntime | null;
  /** Agent-Container (Server-Betrieb): dort laufen Befehls-Konnektoren. */
  remote?: RemoteEngine | null;
  allowedHosts?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Tests: fetch für Anbieter, Konnektoren, Anmeldung. */
  fetchImpl?: typeof fetch;
  /** Tests: Abfrage-Takt der Geräte-Anmeldung. */
  devicePollMs?: number;
}

export interface ModelsApi {
  models: ModelService;
  connectors: ConnectorService;
  secrets: SecretStore;
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Bekannte Fehler → einfache Worte + passender Status; alles andere: ohne Technik-Meldung. */
function fail(c: Context, e: unknown, log: ModelsRouteDeps["log"]) {
  if (e instanceof SecretsKeyError) return c.json({ error: e.message, code: `key_${e.state}` }, 409);
  if (e instanceof ConnectorError) return c.json({ error: e.message }, e.status);
  if (e instanceof ProviderError || e instanceof OAuthError || e instanceof McpError || e instanceof UnsafeUrlError) return c.json({ error: e.message }, 400);
  log("modelle-fehler", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  return c.json({ error: t("Das hat nicht geklappt – bitte nochmal versuchen.") }, 500);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

function callbackPage(ok: boolean, text: string): string {
  return `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${escapeHtml(t("NyxOS · Anmeldung"))}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0F14;color:#E6EDF3;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:24px;border:1px solid #243040;border-radius:14px;background:#111821}b{color:${ok ? "#3FD08A" : "#FF6B6B"}}</style></head>
<body><main><p><b>${ok ? t("Verbunden.") : t("Hat nicht geklappt.")}</b></p><p>${escapeHtml(text)}</p><p>${t("Du kannst dieses Fenster schließen.")}</p></main>
<script>try{window.opener&&window.opener.postMessage({type:"nyxos-mcp-oauth",ok:${ok ? "true" : "false"}},location.origin)}catch(e){}${ok ? "setTimeout(function(){window.close()},1500)" : ""}</script></body></html>`;
}

export function registerModelsRoutes(app: Hono<Env>, deps: ModelsRouteDeps): ModelsApi {
  const { db, log } = deps;
  const env = deps.env ?? process.env;
  const models = new ModelService(db, { bridgeHub: deps.bridgeHub ?? null, env, fetchImpl: deps.fetchImpl });
  const secrets = models.secrets;
  // Nach der Geräte-Anmeldung gleich testen – dann steht die Werkzeug-Liste da, ohne dass der Nutzer etwas drückt.
  let onLoggedIn: (name: string, exp: number | null) => Promise<void> = async () => {};
  const oauth = new OAuthFlows(secrets, { fetchImpl: deps.fetchImpl, devicePollMs: deps.devicePollMs, onLoggedIn: (n, e) => onLoggedIn(n, e) });
  const remote = deps.remote ?? null;
  const connectors = new ConnectorService(db, {
    secrets,
    oauth,
    fetchImpl: deps.fetchImpl,
    // Server-Betrieb: Befehle nur im Agent-Container (nie im API-Container mit DB-Zugang).
    stdioLister: remote
      ? (spec: McpServerSpec) =>
          remote.mcpListTools(spec).catch((e: unknown) => {
            throw new McpError(e instanceof Error ? e.message : t("Der Test hat nicht geklappt."));
          })
      : null,
  });
  onLoggedIn = async (name, exp) => {
    await connectors.markOAuth(name, exp);
    const id = await connectors.idByName(name);
    if (id !== null) await connectors.test(id);
  };
  const allowedHosts = parseAllowedHosts(deps.allowedHosts ?? env.NYXOS_ALLOWED_HOSTS);

  // Nyx-Motor: Rolle mit Fremd-Anbieter → ProviderEngine; eingeschaltete Konnektoren für jeden eigenen Lauf.
  deps.runtime?.useModels({
    engineForRun: async (kind, role) => {
      // Ideen-Links (von außen) nie über einen Fremd-Anbieter – auch nicht mit ausdrücklicher Rolle.
      if (kind === "idealink") return null;
      const r = role ?? roleForKind(kind);
      // Feste Rollen (Skills: Opus 5.5 in eigener Session; Prompt verbessern: Sonnet 5 über das Claude-Programm).
      if (!r || r === "skills.create" || r === "prompt.improve") return null;
      const m = await models.resolveModel(r);
      if (m.source !== "provider") return null;
      return new ProviderEngine({ resolved: m, endpoint: () => models.endpointFor(m.providerId) });
    },
    connectors: () => connectors.enabledSpecs(log),
  });

  // ─── Geheimnisse ───
  app.get("/api/secrets", async (c) => c.json(await secrets.status()));
  app.put("/api/secrets/:name", async (c) => {
    const name = SecretNameSchema.safeParse(c.req.param("name"));
    const b = SecretPutSchema.safeParse(await body(c));
    if (!name.success || !b.success) return c.json({ error: t("Name oder Wert passt nicht.") }, 400);
    try {
      return c.json(await secrets.setSecret(name.data, b.data.value));
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.delete("/api/secrets/:name", async (c) => {
    const name = SecretNameSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: t("Name passt nicht.") }, 400);
    return c.json({ ok: await secrets.deleteSecret(name.data) });
  });

  // ─── Anbieter ───
  const bridgeState = () => ({ online: deps.bridgeHub?.online ?? false, localProxy: deps.bridgeHub?.supports(BRIDGE_CAP_LOCAL_PROXY) ?? false });
  app.get("/api/models/providers", async (c) => c.json({ providers: await models.listProviders(), secretsKey: secrets.keyState, bridge: bridgeState() }));
  app.post("/api/models/providers", async (c) => {
    const b = ProviderSaveSchema.safeParse(await body(c));
    if (!b.success || b.data.kind !== "custom") return c.json({ error: t("Bitte Adresse und Namen des Endpunkts angeben.") }, 400);
    try {
      return c.json(await models.saveProvider(b.data), 201);
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.put("/api/models/providers/:id", async (c) => {
    const id = c.req.param("id");
    const b = ProviderSaveSchema.safeParse(await body(c));
    if (!b.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    const current = await models.getProvider(id);
    if (!current) return c.json({ error: t("Diesen Anbieter gibt es nicht.") }, 404);
    if (current.kind !== b.data.kind) return c.json({ error: t("Die Anbieter-Art lässt sich nicht ändern.") }, 400);
    try {
      return c.json(await models.saveProvider(b.data, id));
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.delete("/api/models/providers/:id", async (c) => c.json({ ok: await models.deleteProvider(c.req.param("id")) }));
  app.post("/api/models/providers/:id/test", async (c) => {
    const b = ProviderTestRequestSchema.safeParse((await body(c)) ?? {});
    if (!b.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    const p = await models.getProvider(c.req.param("id"));
    if (!p?.configured) return c.json({ error: "Diesen Anbieter zuerst speichern." }, 404);
    return c.json(await models.testProvider(p.id, b.data.model));
  });

  // ─── Rollen ───
  // Modell-Wähler – fester Katalog (genaue Kennungen, Kontext, Preise) + Live-Listen der Anbieter.
  app.get("/api/models/catalog", async (c) => c.json({ models: await models.modelCatalog() }));
  app.get("/api/models/roles", async (c) => c.json({ roles: await models.listRoles() }));
  app.put("/api/models/roles/:role", async (c) => {
    const role = ModelRoleSchema.safeParse(c.req.param("role"));
    const b = RoleAssignSchema.safeParse(await body(c));
    if (!role.success || !b.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    if (role.data === "skills.create") return c.json({ error: t("Skills werden immer mit Opus 5.5 erstellt – diese Rolle lässt sich nicht ändern.") }, 409);
    if (role.data === "prompt.improve") return c.json({ error: t("Prompt verbessern läuft immer mit Sonnet 5 · Reasoning hoch – diese Rolle lässt sich nicht ändern.") }, 409);
    try {
      const active = await models.assignRole(role.data, b.data.providerId, b.data.model);
      log("rolle-zugeordnet", { role: role.data, source: active.source });
      return c.json({ active });
    } catch (e) {
      return fail(c, e, log);
    }
  });

  // ─── Konnektoren ───
  app.get("/api/mcp/connectors", async (c) => c.json({ connectors: await connectors.list(), templates: MCP_TEMPLATES, secretsKey: secrets.keyState, engineRemote: !!remote }));
  app.post("/api/mcp/connectors", async (c) => {
    const b = ConnectorSaveSchema.safeParse(await body(c));
    if (!b.success) return c.json({ error: t("Die Angaben passen nicht (Name nur Kleinbuchstaben, Ziffern und Bindestrich).") }, 400);
    try {
      return c.json(await connectors.create(b.data), 201);
    } catch (e) {
      return fail(c, e, log);
    }
  });
  const idOf = (c: Context) => z.coerce.number().int().positive().safeParse(c.req.param("id"));
  app.patch("/api/mcp/connectors/:id", async (c) => {
    const id = idOf(c);
    const b = ConnectorPatchSchema.safeParse(await body(c));
    if (!id.success || !b.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    try {
      return c.json(await connectors.update(id.data, b.data));
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.delete("/api/mcp/connectors/:id", async (c) => {
    const id = idOf(c);
    if (!id.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    try {
      await connectors.remove(id.data);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.post("/api/mcp/connectors/:id/test", async (c) => {
    const id = idOf(c);
    if (!id.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    try {
      return c.json(await connectors.test(id.data));
    } catch (e) {
      return fail(c, e, log);
    }
  });
  // Anmelden im Browser: der Browser nennt seine eigene Adresse (hinter Tunnel/Tailscale kennt nur er sie).
  app.post("/api/mcp/connectors/:id/oauth/start", async (c) => {
    const id = idOf(c);
    const b = z.object({ origin: z.string().url().max(300) }).safeParse(await body(c));
    if (!id.success || !b.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    if (!isAllowedOrigin(b.data.origin, allowedHosts)) return c.json({ error: t("Diese Adresse ist für NyxOS nicht freigegeben.") }, 400);
    try {
      const conn = await connectors.get(id.data);
      if (conn.auth !== "oauth" || !conn.url) return c.json({ error: t("Dieser Konnektor meldet sich nicht im Browser an.") }, 400);
      const url = await oauth.start(conn.name, conn.url, `${b.data.origin.replace(/\/+$/, "")}/api/mcp/oauth/callback`);
      return c.json({ url });
    } catch (e) {
      return fail(c, e, log);
    }
  });
  // Geräte-Code (Higgsfield): Link + Code für den Nutzer, der Server fragt danach selbst nach (Stand in GET /api/mcp/connectors → login).
  app.post("/api/mcp/connectors/:id/device/start", async (c) => {
    const id = idOf(c);
    if (!id.success) return c.json({ error: t("Die Angaben passen nicht.") }, 400);
    try {
      return c.json(await connectors.startDeviceLogin(id.data));
    } catch (e) {
      return fail(c, e, log);
    }
  });
  app.get("/api/mcp/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    if (c.req.query("error")) return c.html(callbackPage(false, t("Die Anmeldung wurde abgebrochen oder abgelehnt. In NyxOS kannst du es nochmal versuchen.")), 400);
    if (!state || !code) return c.html(callbackPage(false, t("Hier fehlt die Rückmeldung des Dienstes. Bitte in NyxOS nochmal „Anmelden“ drücken.")), 400);
    try {
      const r = await oauth.finish(state, code);
      await connectors.markOAuth(r.connector, r.expiresAt);
      return c.html(callbackPage(true, t("Der Konnektor ist angemeldet. NyxOS testet ihn gleich.")));
    } catch (e) {
      const msg = e instanceof OAuthError || e instanceof SecretsKeyError ? e.message : t("Die Anmeldung hat nicht geklappt. Bitte in NyxOS nochmal „Anmelden“ drücken.");
      if (!(e instanceof OAuthError)) log("oauth-fehler", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return c.html(callbackPage(false, msg), 400);
    }
  });

  return { models, connectors, secrets };
}
