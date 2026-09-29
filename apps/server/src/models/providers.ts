// Anbieter + Rollen. Öffentliche Schnittstelle für andere Pakete (N1 Nyx-Kern, N4 Telegram, N6 Skills):
//
//   const models = new ModelService(db, { bridgeHub });
//   await models.resolveModel("nyx.chat")   → { source: "claude-cli" | "provider", model, label, providerId, … }
//   await models.chatComplete({ role, system?, messages, tools? })  → { text, toolCalls, usage, model, stop }
//
// `skills.create` ist FEST „Opus 5.5 (Claude Code)“ (nie Haiku, nicht änderbar – Server-Test). Alle übrigen
// Rollen stehen ohne Zuordnung auf dem bisherigen Weg (Haiku über das Claude-Programm im Nyx-Motor).
// `chatComplete` gilt nur für Rollen mit Fremd-Anbieter; für den Standard-Weg bleibt `HaikuRuntime.ask`.
import { randomBytes } from "node:crypto";
import {
  DEFAULT_ROLE_SUFFIX,
  describeModel,
  EMBEDDING_ROLE_ERROR,
  FIXED_MODEL_ROLES,
  PROMPT_IMPROVE_LABEL,
  PROMPT_IMPROVE_MODEL,
  isEmbeddingModel,
  MODEL_ROLE_LABEL,
  MODEL_ROLES,
  PROVIDER_PRESETS,
  providerPreset,
  SKILLS_CREATE_LABEL,
  SKILLS_CREATE_MODEL,
  type HaikuCallKind,
  catalogModel,
  MODEL_CATALOG,
  type CatalogModel,
  type LocalProxyResult,
  type ModelChoice,
  type ModelRole,
  type ProviderKind,
  type ProviderModel,
  type ProviderSave,
  type ProviderTest,
  type ProviderView,
  type ResolvedModel,
  type RoleView,
  t,
} from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { modelProviders, modelRoles } from "../db/schema.js";
import { SecretStore } from "../secrets/store.js";
import { assertPublicUrl, safeFetch } from "../net/safeFetch.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { chatRound, listModels, ProviderError, type ChatMessage, type ChatResult, type ChatTool, type ProviderEndpoint } from "./chat.js";

export const providerSecretName = (id: string) => `provider.${id}`;

/** Probe-Werkzeug für den Test-Knopf. */
const TIME_TOOL: ChatTool = { name: "uhrzeit", description: "Liefert die aktuelle Uhrzeit.", inputSchema: { type: "object", properties: {} } };

/** Welche Rolle ein Haiku-Lauf hat. `null` = immer der Standard-Weg (Ideen-Links von außen: nie ein bezahlter Fremd-Anbieter). */
export function roleForKind(kind: HaikuCallKind, channel?: "web" | "voice" | "telegram" | null): ModelRole | null {
  if (kind === "idealink") return null;
  if (kind === "briefing" || kind === "recap") return "nyx.briefing";
  if (channel === "voice") return "nyx.voice";
  return "nyx.chat";
}

/** Rolle nutzt den Standard-Weg – dafür gibt es keinen direkten Chat-Aufruf (→ `HaikuRuntime.ask`). */
export class RoleUsesClaudeCliError extends Error {
  constructor(role: ModelRole) {
    super(`Die Rolle ${role} läuft über das Claude-Programm (Standard).`);
  }
}

export interface ModelServiceOptions {
  bridgeHub?: BridgeHub | null;
  env?: NodeJS.ProcessEnv;
  /** Tests: eigener fetch für direkte Anbieter. */
  fetchImpl?: typeof fetch;
}

type ProviderRow = typeof modelProviders.$inferSelect;

/** fetch über die Brücke (RPC `http_proxy_local`): nur 127.0.0.1/localhost-Adressen, die Brücke prüft die Port-Erlaubnisliste. */
export function bridgeFetch(bridge: BridgeHub | null | undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ProviderError(t("Über die Brücke gehen nur Adressen auf dem Rechner selbst (127.0.0.1)."));
    if (!bridge?.online) throw new ProviderError(t("Der Rechner ist gerade nicht verbunden – lokale Modelle sind erst wieder erreichbar, wenn die Brücke läuft."));
    if (!bridge.supports("http_proxy_local")) throw new ProviderError(t("Die Brücke ist zu alt für lokale Modelle – sie wird beim nächsten Deploy erneuert."));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const r = await bridge.rpc("http_proxy_local", { port, method: (init?.method ?? "GET").toUpperCase(), path: `${url.pathname}${url.search}`, headers, body: typeof init?.body === "string" ? init.body : undefined, timeoutMs: 300_000 }, 310_000);
    if (!r.ok) {
      if (r.code === "port_not_allowed") throw new ProviderError(t("Port {port} ist in der Brücke nicht freigegeben (erlaubt: Ollama 11434, LM Studio 1234).", { port }));
      if (r.code === "unreachable") throw new ProviderError(t("Auf dem Rechner antwortet dort nichts – läuft Ollama bzw. der LM-Studio-Server?"));
      throw new ProviderError(t("Die Brücke konnte das lokale Modell nicht erreichen."));
    }
    const res = r.result as LocalProxyResult;
    return new Response(res.body, { status: res.status, headers: res.contentType ? { "content-type": res.contentType } : {} });
  }) as typeof fetch;
}

function toTest(v: unknown): ProviderTest | null {
  return v && typeof v === "object" ? (v as ProviderTest) : null;
}

export class ModelService {
  readonly secrets: SecretStore;
  constructor(
    private readonly db: Db,
    private readonly opts: ModelServiceOptions = {},
  ) {
    this.secrets = new SecretStore(db, (opts.env ?? process.env).NYXOS_SECRETS_KEY);
  }

  private get defaultModel(): string {
    return (this.opts.env ?? process.env).NYXOS_HAIKU_MODEL ?? "haiku";
  }

  // ─── Anbieter ───

  private async row(id: string): Promise<ProviderRow | null> {
    const [r] = await this.db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
    return r ?? null;
  }

  private async view(kind: ProviderKind, row: ProviderRow | null, id: string): Promise<ProviderView> {
    const preset = providerPreset(kind);
    const key = await this.secrets.info(providerSecretName(id));
    return {
      id,
      kind,
      label: row?.label ?? preset.label,
      api: preset.api,
      baseUrl: row?.baseUrl ?? preset.baseUrl,
      via: (row?.via as ProviderView["via"]) ?? preset.via,
      enabled: row?.enabled ?? false,
      needsKey: preset.needsKey,
      keyHint: preset.keyHint,
      key: { set: key.set, last4: key.last4 },
      configured: !!row,
      models: row?.models ?? [],
      lastTest: toTest(row?.lastTest),
    };
  }

  /** Alle Vorlagen (eine Karte je Anbieter) + angelegte eigene Endpunkte. */
  async listProviders(): Promise<ProviderView[]> {
    const rows = await this.db.select().from(modelProviders);
    const out: ProviderView[] = [];
    for (const p of PROVIDER_PRESETS) {
      if (p.kind === "custom") continue;
      out.push(await this.view(p.kind, rows.find((r) => r.id === p.kind) ?? null, p.kind));
    }
    for (const r of rows.filter((x) => x.kind === "custom").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) out.push(await this.view("custom", r, r.id));
    return out;
  }

  async getProvider(id: string): Promise<ProviderView | null> {
    const row = await this.row(id);
    const preset = PROVIDER_PRESETS.find((p) => p.kind === id && p.kind !== "custom");
    if (!row && !preset) return null;
    return this.view((row?.kind as ProviderKind) ?? (preset as { kind: ProviderKind }).kind, row, id);
  }

  /** Anlegen/ändern. Vorlagen haben die Art als Kennung, eigene Endpunkte `custom-…` (neu ohne `id`). */
  async saveProvider(input: ProviderSave, id?: string): Promise<ProviderView> {
    const preset = providerPreset(input.kind);
    const pid = id ?? (input.kind === "custom" ? `custom-${randomBytes(3).toString("hex")}` : input.kind);
    if (input.kind !== "custom" && pid !== input.kind) throw new ProviderError(t("Kennung passt nicht zur Anbieter-Art."));
    const existing = await this.row(pid);
    if (input.kind === "custom" && !existing && !input.baseUrl) throw new ProviderError(t("Bitte die Adresse des Endpunkts eintragen."));
    if (input.baseUrl && !/^https?:\/\/[^\s]+$/.test(input.baseUrl)) throw new ProviderError(t("Die Adresse muss mit http:// oder https:// beginnen."));
    const via = input.via ?? existing?.via ?? preset.via;
    const baseUrl = input.baseUrl ?? existing?.baseUrl ?? preset.baseUrl;
    //: direkte Adressen nie ins interne Netz (die Brücke erreicht nur den Rechner, s. bridgeFetch).
    if (via !== "bridge" && baseUrl) await assertPublicUrl(baseUrl, { dns: false });
    if (input.apiKey) await this.secrets.setSecret(providerSecretName(pid), input.apiKey);
    else if (input.clearKey || (existing && input.baseUrl && input.baseUrl !== existing.baseUrl)) {
      // Neue Adresse ohne neuen Schlüssel: den alten nicht an einen anderen Server schicken.
      await this.secrets.deleteSecret(providerSecretName(pid));
    }
    const now = new Date().toISOString();
    const values = {
      label: input.label ?? existing?.label ?? preset.label,
      baseUrl,
      via,
      enabled: input.enabled ?? existing?.enabled ?? true,
      updatedAt: now,
    };
    if (existing) await this.db.update(modelProviders).set(values).where(eq(modelProviders.id, pid));
    else await this.db.insert(modelProviders).values({ id: pid, kind: input.kind, ...values });
    return (await this.getProvider(pid)) as ProviderView;
  }

  async deleteProvider(id: string): Promise<boolean> {
    const rows = await this.db.delete(modelProviders).where(eq(modelProviders.id, id)).returning({ id: modelProviders.id });
    await this.secrets.deleteSecret(providerSecretName(id)).catch(() => false);
    return rows.length > 0;
  }

  /** Verbindung zum Anbieter mit Schlüssel (nur im Speicher) und dem richtigen Weg (direkt/Brücke). */
  async endpointFor(id: string): Promise<ProviderEndpoint> {
    const view = await this.getProvider(id);
    if (!view?.configured) throw new ProviderError(t("Dieser Anbieter ist noch nicht eingerichtet."));
    const apiKey = view.key.set ? await this.secrets.getSecret(providerSecretName(id)) : null;
    if (view.needsKey && !apiKey) throw new ProviderError(t("Für diesen Anbieter ist noch kein Schlüssel eingetragen."));
    return { api: view.api, baseUrl: view.baseUrl, apiKey, fetchImpl: view.via === "bridge" ? bridgeFetch(this.opts.bridgeHub) : safeFetch(this.opts.fetchImpl ?? fetch) };
  }

  /** Test-Knopf: Modell-Liste laden (speichert sie) und – mit Modell – eine Probe-Antwort holen. */
  async testProvider(id: string, model?: string): Promise<ProviderTest> {
    const started = Date.now();
    let test: ProviderTest;
    let models: ProviderModel[] | null = null;
    try {
      const ep = await this.endpointFor(id);
      models = await listModels(ep);
      let reply: string | null = null;
      let tools: boolean | null = null;
      if (model) {
        // Mit Werkzeug-Angebot: zeigt gleich, ob das Modell Werkzeuge kann (Nyx braucht sie).
        const probe = { model, messages: [{ role: "user" as const, content: "Wie spät ist es? Nutze dafür das Werkzeug uhrzeit." }], maxTokens: 60, timeoutMs: 90_000 };
        try {
          const r = await chatRound(ep, { ...probe, tools: [TIME_TOOL] });
          tools = r.toolCalls.some((t) => t.name === TIME_TOOL.name);
          reply = tools ? t("ruft das Werkzeug auf") : r.text.trim().slice(0, 80) || t("(leere Antwort)");
        } catch (e) {
          if (!(e instanceof ProviderError) || e.status !== 400) throw e;
          // Manche Modelle lehnen Werkzeuge ganz ab – dann ohne, und ehrlich sagen.
          const r = await chatRound(ep, probe);
          tools = false;
          reply = r.text.trim().slice(0, 80) || t("(leere Antwort)");
        }
      }
      const n = models.length;
      const message = !model
        ? t("Verbunden – {n} Modelle gefunden.", { n })
        : tools === null
          ? t("Verbunden – {n} Modelle, {model} antwortet.", { n, model })
          : tools
            ? t("Verbunden – {n} Modelle, {model} antwortet und kann Werkzeuge.", { n, model })
            : t("Verbunden – {n} Modelle, {model} antwortet – nutzt aber keine Werkzeuge (für Nyx besser ein anderes Modell).", { n, model });
      test = { ok: true, at: new Date().toISOString(), ms: Date.now() - started, message, models: models.length, reply, tools };
    } catch (e) {
      test = { ok: false, at: new Date().toISOString(), ms: Date.now() - started, message: e instanceof ProviderError ? e.message : e instanceof Error && e.name === "SecretsKeyError" ? e.message : t("Der Test hat nicht geklappt."), models: 0, reply: null };
    }
    const set: Partial<typeof modelProviders.$inferInsert> = { lastTest: test, updatedAt: new Date().toISOString() };
    if (models) set.models = models.slice(0, 500);
    await this.db.update(modelProviders).set(set).where(eq(modelProviders.id, id));
    return test;
  }

  /**
   * Alle wählbaren Modelle – je Anbieter die Live-Liste (letzter Test, mit Kontext/Preis falls geliefert),
   * ergänzt um den festen Katalog (genaue Versionen, Stärken). Embedding-Modelle fehlen (können nicht chatten).
   */
  async modelCatalog(): Promise<ModelChoice[]> {
    const providers = await this.listProviders();
    const out: ModelChoice[] = [];
    for (const p of providers) {
      const usable = p.configured && p.enabled;
      const seen = new Set<string>();
      const base = { providerId: p.id, providerLabel: p.label, usable };
      for (const m of p.models) {
        if (isEmbeddingModel(m.id) || seen.has(m.id)) continue;
        seen.add(m.id);
        // OpenRouter/Gemini: „anthropic/claude-sonnet-5“, „models/gemini-2.5-pro“ → Katalog über den letzten Teil.
        const known: CatalogModel | null = catalogModel(m.id) ?? catalogModel(m.id.split("/").pop() ?? "");
        out.push({
          ...base,
          id: m.id,
          provider: p.kind,
          name: m.label ?? known?.name ?? m.id,
          context: m.context ?? known?.context ?? null,
          priceIn: m.priceIn ?? known?.priceIn ?? null,
          priceOut: m.priceOut ?? known?.priceOut ?? null,
          approx: m.priceIn != null ? false : known?.approx,
          speed: known?.speed ?? null,
          strength: known?.strength ?? null,
          source: "live",
        });
      }
      for (const m of MODEL_CATALOG) {
        if (m.provider !== p.kind || seen.has(m.id) || m.aliases?.some((a) => seen.has(a))) continue;
        out.push({ ...m, ...base });
      }
    }
    return out;
  }

  // ─── Rollen ───

  async resolveModel(role: ModelRole): Promise<ResolvedModel> {
    if (role === "skills.create") return { role, source: "claude-cli", providerId: null, providerKind: null, model: SKILLS_CREATE_MODEL, label: SKILLS_CREATE_LABEL, fixed: true };
    // Prompt verbessern ist fest Sonnet 5 mit Denkstufe hoch (runtime.ts `fixedModelFor`) – nie Haiku.
    if (role === "prompt.improve") return { role, source: "claude-cli", providerId: null, providerKind: null, model: PROMPT_IMPROVE_MODEL, label: t(PROMPT_IMPROVE_LABEL), fixed: true };
    const standard: ResolvedModel = { role, source: "claude-cli", providerId: null, providerKind: null, model: this.defaultModel, label: `${describeModel(this.defaultModel)} ${t(DEFAULT_ROLE_SUFFIX)}`, fixed: false };
    const [r] = await this.db.select().from(modelRoles).where(eq(modelRoles.role, role)).limit(1);
    if (!r?.providerId || !r.model) return standard;
    const p = await this.row(r.providerId);
    // Abgeschalteter Anbieter → ehrlich zurück zum Standard (die Oberfläche zeigt den Standard als aktiv).
    if (!p?.enabled) return standard;
    return { role, source: "provider", providerId: p.id, providerKind: p.kind as ProviderKind, model: r.model, label: `${describeModel(r.model)} · ${p.label}`, fixed: false };
  }

  async listRoles(): Promise<RoleView[]> {
    return Promise.all(MODEL_ROLES.map(async (role) => ({ role, ...MODEL_ROLE_LABEL[role], active: await this.resolveModel(role), fixed: FIXED_MODEL_ROLES.includes(role) })));
  }

  /** Rolle zuordnen. `skills.create` ist fest (wirft). `providerId: null` = Standard. */
  async assignRole(role: ModelRole, providerId: string | null, model: string | null): Promise<ResolvedModel> {
    if (role === "skills.create") throw new ProviderError(t("Skills werden immer mit Opus 5.5 erstellt – diese Rolle lässt sich nicht ändern."));
    if (role === "prompt.improve") throw new ProviderError(t("Prompt verbessern läuft immer mit Sonnet 5 · Reasoning hoch – diese Rolle lässt sich nicht ändern."));
    if (providerId) {
      const p = await this.row(providerId);
      if (!p) throw new ProviderError(t("Diesen Anbieter gibt es nicht (mehr)."));
      if (!model) throw new ProviderError(t("Bitte ein Modell wählen."));
      // alle Rollen hier sind Chat-Rollen – ein Embedding-Modell würde jede Antwort mit 400 ablehnen.
      if (isEmbeddingModel(model)) throw new ProviderError(t(EMBEDDING_ROLE_ERROR));
    }
    const now = new Date().toISOString();
    const values = { providerId: providerId ?? null, model: providerId ? model : null, updatedAt: now };
    await this.db
      .insert(modelRoles)
      .values({ role, ...values })
      .onConflictDoUpdate({ target: modelRoles.role, set: values });
    return this.resolveModel(role);
  }

  // ─── Chat ───

  /** Ein Chat mit dem Modell der Rolle (nur Fremd-Anbieter; eine Runde – Werkzeug-Schleife macht der Aufrufer). */
  async chatComplete(o: { role: ModelRole; system?: string; messages: ChatMessage[]; tools?: ChatTool[]; maxTokens?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<ChatResult> {
    const m = await this.resolveModel(o.role);
    if (m.source !== "provider") throw new RoleUsesClaudeCliError(o.role);
    const ep = await this.endpointFor(m.providerId);
    return chatRound(ep, { model: m.model, system: o.system, messages: o.messages, tools: o.tools, maxTokens: o.maxTokens, signal: o.signal, timeoutMs: o.timeoutMs });
  }
}
