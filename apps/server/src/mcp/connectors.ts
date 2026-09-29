// MCP-Konnektoren: Liste, an/aus, Anlegen aus Vorlage, Test (Werkzeuge auflisten) und die
// fertigen Server-Angaben für Nyx (`enabledSpecs`). Token aus dem Geheimnis-Speicher (`mcp.<name>`,
// OAuth: `mcp.<name>.oauth`). des Nutzers eigene `~/.claude`-Einstellungen werden nie gelesen oder geändert.
import { MCP_TEMPLATES, type ConnectorPatch, type ConnectorSave, type ConnectorView, type McpTestResult, t } from "@nyxos/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mcpConnectors } from "../db/schema.js";
import type { SecretStore } from "../secrets/store.js";
import { listMcpTools, McpError, type McpServerSpec, type McpTool } from "./client.js";
import { MCP_SERVER_NAME } from "../haiku/engine.js";
import { assertPublicUrl, UnsafeUrlError } from "../net/safeFetch.js";
import { OAuthError, OAuthFlows, oauthSecretName } from "./oauth.js";

export const connectorSecretName = (name: string) => `mcp.${name}`;

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

type Row = typeof mcpConnectors.$inferSelect;

export interface ConnectorServiceOptions {
  secrets: SecretStore;
  oauth: OAuthFlows;
  fetchImpl?: typeof fetch;
  /** Befehls-Konnektoren (stdio) laufen im Nyx-Motor (Agent-Container) – der Test auch. Ohne: lokal (Probe/Entwicklung). */
  stdioLister?: ((spec: McpServerSpec) => Promise<McpTool[]>) | null;
}

function toTest(v: unknown): McpTestResult | null {
  return v && typeof v === "object" ? (v as McpTestResult) : null;
}

export class ConnectorService {
  constructor(
    private readonly db: Db,
    private readonly o: ConnectorServiceOptions,
  ) {}

  private async view(r: Row): Promise<ConnectorView> {
    const tpl = MCP_TEMPLATES.find((t) => t.id === r.template);
    const info = r.auth === "oauth" || r.auth === "device" ? await this.o.secrets.info(oauthSecretName(r.name)) : r.auth === "none" ? null : await this.o.secrets.info(connectorSecretName(r.name));
    return {
      id: r.id,
      name: r.name,
      label: r.label,
      template: r.template,
      transport: r.transport as ConnectorView["transport"],
      url: r.url,
      command: r.command,
      args: r.args,
      headers: r.headers,
      auth: r.auth as ConnectorView["auth"],
      authName: r.authName,
      authConfig: r.authConfig ?? null,
      login: r.auth === "device" ? this.o.oauth.deviceStatus(r.name) : null,
      enabled: r.enabled,
      allowedTools: r.allowedTools ?? null,
      token: { set: info?.set ?? false, last4: info?.last4 ?? null, expiresAt: r.oauthExpiresAt },
      lastTest: toTest(r.lastTest),
      note: tpl?.note ?? (r.transport === "stdio" ? t("Läuft im Nyx-Motor auf dem Server – nur mit Claude-Modellen.") : null),
      tokenHint: tpl?.tokenHint ?? null,
    };
  }

  private async row(id: number): Promise<Row> {
    const [r] = await this.db.select().from(mcpConnectors).where(eq(mcpConnectors.id, id)).limit(1);
    if (!r) throw new ConnectorError(t("Diesen Konnektor gibt es nicht (mehr)."), 404);
    return r;
  }

  async list(): Promise<ConnectorView[]> {
    const rows = await this.db.select().from(mcpConnectors).orderBy(asc(mcpConnectors.id));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: number): Promise<ConnectorView> {
    return this.view(await this.row(id));
  }

  /**: Adressen nie ins interne Netz (Docker-Dienste, Metadaten); DNS prüft erst der Aufruf. */
  private async validateUrls(v: { transport: string; url?: string | null; authConfig?: { deviceAuthorizeUrl?: string; deviceTokenUrl?: string } | null }): Promise<void> {
    const urls = [v.transport !== "stdio" ? v.url : null, v.authConfig?.deviceAuthorizeUrl, v.authConfig?.deviceTokenUrl].filter((u): u is string => !!u);
    try {
      for (const u of urls) await assertPublicUrl(u, { dns: false });
    } catch (e) {
      throw new ConnectorError(e instanceof UnsafeUrlError ? e.message : t("Die Adresse passt nicht."));
    }
  }

  private validate(v: { transport: string; url?: string | null; command?: string | null; auth: string; authName?: string | null; authConfig?: { deviceAuthorizeUrl?: string; deviceTokenUrl?: string } | null }): void {
    if (v.auth === "device" && (v.transport === "stdio" || !v.authConfig?.deviceAuthorizeUrl || !v.authConfig.deviceTokenUrl)) throw new ConnectorError(t("Für die Geräte-Anmeldung fehlen die Anmelde-Adressen."));
    if (v.transport === "stdio" && !v.command) throw new ConnectorError(t("Bitte den Befehl eintragen (z. B. npx)."));
    if (v.transport !== "stdio" && !v.url) throw new ConnectorError(t("Bitte die Adresse des Konnektors eintragen."));
    if (v.transport !== "stdio" && v.url && !/^https?:\/\//.test(v.url)) throw new ConnectorError(t("Die Adresse muss mit http:// oder https:// beginnen."));
    if ((v.auth === "header" || v.auth === "env") && !v.authName) throw new ConnectorError(v.auth === "env" ? t("Bitte den Namen der Umgebungsvariable eintragen.") : t("Bitte den Namen der Kopfzeile eintragen."));
    if (v.auth === "env" && v.transport !== "stdio") throw new ConnectorError(t("Umgebungsvariablen gibt es nur bei Befehlen."));
    if (v.auth === "oauth" && v.transport === "stdio") throw new ConnectorError(t("Anmelden im Browser geht nur mit einer Adresse."));
  }

  async create(input: ConnectorSave): Promise<ConnectorView> {
    if (input.name === MCP_SERVER_NAME) throw new ConnectorError(t("Dieser Name ist für Nyx selbst reserviert."));
    const [dup] = await this.db.select({ id: mcpConnectors.id }).from(mcpConnectors).where(eq(mcpConnectors.name, input.name)).limit(1);
    if (dup) throw new ConnectorError(t("Einen Konnektor mit diesem Namen gibt es schon."), 409);
    this.validate(input);
    await this.validateUrls(input);
    if (input.token) await this.o.secrets.setSecret(connectorSecretName(input.name), input.token);
    const [r] = await this.db
      .insert(mcpConnectors)
      .values({
        name: input.name,
        label: input.label,
        template: input.template ?? null,
        transport: input.transport,
        url: input.transport === "stdio" ? null : (input.url ?? null),
        command: input.transport === "stdio" ? (input.command ?? null) : null,
        args: input.args ?? [],
        headers: input.headers ?? {},
        auth: input.auth,
        authName: input.authName ?? null,
        authConfig: input.authConfig ?? null,
        enabled: input.enabled ?? false,
      })
      .returning();
    return this.view(r as Row);
  }

  async update(id: number, patch: ConnectorPatch): Promise<ConnectorView> {
    const r = await this.row(id);
    const next = {
      transport: patch.transport ?? r.transport,
      url: patch.url !== undefined ? patch.url : r.url,
      command: patch.command !== undefined ? patch.command : r.command,
      auth: patch.auth ?? r.auth,
      authName: patch.authName !== undefined ? patch.authName : r.authName,
      authConfig: patch.authConfig !== undefined ? patch.authConfig : r.authConfig,
    };
    this.validate(next);
    await this.validateUrls(next);
    // (4): Zeigt der Konnektor auf etwas anderes, gelten alte Freigaben und Zugangsdaten nicht mehr –
    // sonst bekäme ein neuer Server mit gleichen Werkzeug-Namen sofort Freigabe und das alte Token.
    const retarget = next.transport !== r.transport || next.url !== r.url || next.command !== r.command || JSON.stringify(patch.args ?? r.args) !== JSON.stringify(r.args);
    if (retarget && !patch.token) {
      await this.o.secrets.deleteSecret(connectorSecretName(r.name)).catch(() => false);
      await this.o.secrets.deleteSecret(oauthSecretName(r.name)).catch(() => false);
    }
    if (patch.token) await this.o.secrets.setSecret(connectorSecretName(r.name), patch.token);
    else if (patch.clearToken) {
      await this.o.secrets.deleteSecret(connectorSecretName(r.name));
      await this.o.secrets.deleteSecret(oauthSecretName(r.name));
    }
    await this.db
      .update(mcpConnectors)
      .set({
        ...next,
        label: patch.label ?? r.label,
        args: patch.args ?? r.args,
        headers: patch.headers ?? r.headers,
        enabled: patch.enabled ?? r.enabled,
        ...(patch.allowedTools ? { allowedTools: patch.allowedTools } : {}),
        ...(retarget ? { allowedTools: null, lastTest: null } : {}),
        ...(patch.clearToken || (retarget && !patch.token) ? { oauthExpiresAt: null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpConnectors.id, id));
    return this.get(id);
  }

  async remove(id: number): Promise<void> {
    const r = await this.row(id);
    await this.db.delete(mcpConnectors).where(eq(mcpConnectors.id, id));
    await this.o.secrets.deleteSecret(connectorSecretName(r.name)).catch(() => false);
    await this.o.secrets.deleteSecret(oauthSecretName(r.name)).catch(() => false);
  }

  /** Geräte-Anmeldung beginnen (Link für den Nutzer), s. `OAuthFlows.startDevice`. */
  async startDeviceLogin(id: number) {
    const r = await this.row(id);
    if (r.auth !== "device" || !r.authConfig?.deviceAuthorizeUrl || !r.authConfig.deviceTokenUrl) throw new ConnectorError(t("Dieser Konnektor meldet sich nicht per Geräte-Code an."));
    return this.o.oauth.startDevice(r.name, r.authConfig.deviceAuthorizeUrl, r.authConfig.deviceTokenUrl);
  }

  async idByName(name: string): Promise<number | null> {
    const [r] = await this.db.select({ id: mcpConnectors.id }).from(mcpConnectors).where(eq(mcpConnectors.name, name)).limit(1);
    return r?.id ?? null;
  }

  /** Nach „Anmelden“: Ablaufzeit merken (Anzeige), Test-Stand zurücksetzen. */
  async markOAuth(name: string, expiresAt: number | null): Promise<void> {
    await this.db
      .update(mcpConnectors)
      .set({ oauthExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, lastTest: null, updatedAt: new Date().toISOString() })
      .where(eq(mcpConnectors.name, name));
  }

  /** Fertige Server-Angabe mit Token (nur im Speicher). Wirft mit einfachen Worten, wenn der Zugang fehlt. */
  async spec(r: Row): Promise<McpServerSpec> {
    const headers: Record<string, string> = { ...r.headers };
    const env: Record<string, string> = {};
    if (r.auth === "oauth" || r.auth === "device") {
      const tok = await this.o.oauth.accessToken(r.name);
      if (!tok) throw new ConnectorError(t("Noch nicht angemeldet – bitte „Anmelden“ drücken."));
      headers.Authorization = `Bearer ${tok.token}`;
      if (tok.expiresAt) await this.db.update(mcpConnectors).set({ oauthExpiresAt: new Date(tok.expiresAt).toISOString() }).where(eq(mcpConnectors.id, r.id));
    } else if (r.auth !== "none") {
      const token = await this.o.secrets.getSecret(connectorSecretName(r.name));
      if (!token) throw new ConnectorError(t("Noch kein Token eingetragen."));
      if (r.auth === "bearer") headers.Authorization = `Bearer ${token}`;
      else if (r.auth === "header" && r.authName) headers[r.authName] = token;
      else if (r.auth === "env" && r.authName) env[r.authName] = token;
    }
    return { name: r.name, transport: r.transport as McpServerSpec["transport"], url: r.url, command: r.command, args: r.args, headers, env, ...(r.allowedTools ? { allowedTools: r.allowedTools } : {}) };
  }

  /** Test-Knopf: verbinden und Werkzeuge auflisten; Ergebnis bleibt am Konnektor stehen. */
  async test(id: number): Promise<McpTestResult> {
    const r = await this.row(id);
    const started = Date.now();
    let result: McpTestResult;
    try {
      const { allowedTools: _pinned, ...spec } = await this.spec(r);
      const tools = spec.transport === "stdio" && this.o.stdioLister ? await this.o.stdioLister(spec) : await listMcpTools(spec, { fetchImpl: this.o.fetchImpl, timeoutMs: spec.transport === "stdio" ? 60_000 : 20_000 });
      result = { ok: true, at: new Date().toISOString(), ms: Date.now() - started, message: t("Verbunden – {n} Werkzeuge.", { n: tools.length }), tools: tools.slice(0, 200).map((t) => ({ name: t.name, description: t.description?.slice(0, 300) ?? null })) };
    } catch (e) {
      const known = e instanceof McpError || e instanceof ConnectorError || e instanceof OAuthError || (e instanceof Error && e.name === "SecretsKeyError");
      result = { ok: false, at: new Date().toISOString(), ms: Date.now() - started, message: known ? (e as Error).message : t("Der Test hat nicht geklappt."), tools: [] };
    }
    // Tool-Pinning: beim ersten erfolgreichen Test gelten die gezeigten Werkzeuge als freigegeben; spätere neue bleiben aus.
    const pin = result.ok && r.allowedTools === null ? { allowedTools: result.tools.map((t) => t.name) } : {};
    await this.db.update(mcpConnectors).set({ lastTest: result, ...pin, updatedAt: new Date().toISOString() }).where(eq(mcpConnectors.id, id));
    return result;
  }

  /** Eingeschaltete Konnektoren mit Zugang – für Nyx. Einer ohne Zugang wird übersprungen (Nyx läuft trotzdem). */
  async enabledSpecs(log?: (msg: string, extra?: Record<string, unknown>) => void): Promise<McpServerSpec[]> {
    const rows = await this.db.select().from(mcpConnectors).where(eq(mcpConnectors.enabled, true)).orderBy(asc(mcpConnectors.id));
    const out: McpServerSpec[] = [];
    for (const r of rows) {
      if (r.allowedTools === null) {
        log?.("konnektor-uebersprungen", { name: r.name, grund: "noch nie getestet" });
        continue;
      }
      try {
        out.push(await this.spec(r));
      } catch (e) {
        log?.("konnektor-uebersprungen", { name: r.name, grund: e instanceof Error ? e.message.slice(0, 120) : "?" });
      }
    }
    return out;
  }
}
