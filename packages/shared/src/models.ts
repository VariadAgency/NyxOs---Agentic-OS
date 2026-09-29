// Modelle, Geheimnisse, Konnektoren (MCP). Vertrag zwischen Server (`apps/server/src/models`,
// `apps/server/src/secrets`, `apps/server/src/mcp`), Web (Einstellungen → Modelle/Konnektoren) und Brücke
// (`http_proxy_local`). Die API gibt NIE Klartext eines Geheimnisses zurück – nur „gesetzt“ + letzte 4 Zeichen.
import { z } from "zod";
import { lazyFields, tr } from "./lazy-text.js";

// ───────────────────────────── Geheimnisse ─────────────────────────────

/** Zustand des Geheimnis-Speichers: Schlüssel da · fehlt · passt nicht zu den gespeicherten Daten. */
export type SecretsKeyState = "ok" | "missing" | "invalid";

/** Namen: klein, Punkte/Bindestriche erlaubt (z. B. `provider.openai`, `telegram.bot`, `mcp.higgsfield`). */
export const SecretNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);

export interface SecretInfo {
  name: string;
  set: boolean;
  /** Letzte 4 Zeichen (nur Anzeige), bei sehr kurzen Werten `null`. */
  last4: string | null;
  updatedAt: string | null;
}

export interface SecretsStatus {
  key: SecretsKeyState;
  /** Einfache Worte für den Nutzer, wenn der Schlüssel fehlt/nicht passt. */
  reason: string | null;
  secrets: SecretInfo[];
}

export const SecretPutSchema = z.object({ value: z.string().min(1).max(20_000) });

// ───────────────────────────── Anbieter + Rollen ─────────────────────────────

export const PROVIDER_KINDS = ["anthropic", "openai", "openrouter", "gemini", "mistral", "groq", "xai", "deepseek", "ollama", "lmstudio", "custom"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Wie der Server den Anbieter erreicht: direkt per URL oder über die Brücke (lokale Modelle). */
export const ProviderViaSchema = z.enum(["direct", "bridge"]);
export type ProviderVia = z.infer<typeof ProviderViaSchema>;

/** API-Stil: Anthropic-Messages oder OpenAI-kompatibel (Chat Completions). */
export type ProviderApi = "anthropic" | "openai";

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  api: ProviderApi;
  baseUrl: string;
  /** Braucht einen Schlüssel? (Ollama/LM Studio nicht) */
  needsKey: boolean;
  /** Standard-Weg (Ollama/LM Studio: über die Brücke). */
  via: ProviderVia;
  /** Ein Satz, wo es den Schlüssel gibt. */
  keyHint: string;
}

const PROVIDER_PRESETS_DE: readonly ProviderPreset[] = [
  { kind: "anthropic", label: "Anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com", needsKey: true, via: "direct", keyHint: "API-Schlüssel aus console.anthropic.com oder Token aus „claude setup-token“." },
  { kind: "openai", label: "OpenAI", api: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus platform.openai.com → API keys." },
  { kind: "openrouter", label: "OpenRouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus openrouter.ai → Keys." },
  { kind: "gemini", label: "Google Gemini", api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, via: "direct", keyHint: "Schlüssel aus aistudio.google.com → Get API key." },
  { kind: "mistral", label: "Mistral", api: "openai", baseUrl: "https://api.mistral.ai/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus console.mistral.ai → API Keys." },
  { kind: "groq", label: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus console.groq.com → API Keys." },
  { kind: "xai", label: "xAI (Grok)", api: "openai", baseUrl: "https://api.x.ai/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus console.x.ai." },
  { kind: "deepseek", label: "DeepSeek", api: "openai", baseUrl: "https://api.deepseek.com/v1", needsKey: true, via: "direct", keyHint: "Schlüssel aus platform.deepseek.com → API keys." },
  { kind: "ollama", label: "Ollama (auf dem Rechner)", api: "openai", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, via: "bridge", keyHint: "Kein Schlüssel nötig. Ollama muss auf dem Rechner laufen." },
  { kind: "lmstudio", label: "LM Studio (auf dem Rechner)", api: "openai", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, via: "bridge", keyHint: "Kein Schlüssel nötig. In LM Studio den lokalen Server starten." },
  { kind: "custom", label: "Eigener Endpunkt", api: "openai", baseUrl: "", needsKey: false, via: "direct", keyHint: "Adresse eines OpenAI-kompatiblen Servers, Schlüssel nur falls nötig." },
];

/** Label and key hint are German source texts, translated on every read. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = PROVIDER_PRESETS_DE.map((p) => lazyFields(p, { label: tr, keyHint: tr }));

export function providerPreset(kind: ProviderKind): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.kind === kind) ?? (PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1] as ProviderPreset);
}

export interface ProviderModel {
  id: string;
  label: string | null;
  /** Kontextfenster in Token, falls der Anbieter es nennt (Anthropic `max_input_tokens`, OpenRouter `context_length`). */
  context?: number | null;
  /** USD pro 1 Mio. Token, falls der Anbieter Preise nennt (OpenRouter). */
  priceIn?: number | null;
  priceOut?: number | null;
}

export interface ProviderTest {
  ok: boolean;
  at: string;
  ms: number;
  /** Einfache Worte, was los ist (bei Fehlern: was der Nutzer tun kann). */
  message: string;
  models: number;
  /** Probe-Antwort des Modells (kurz), falls mit Modell getestet. */
  reply?: string | null;
  /** Hat das Modell beim Test ein angebotenes Werkzeug benutzt? `null` = nicht geprüft. */
  tools?: boolean | null;
}

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  label: string;
  api: ProviderApi;
  baseUrl: string;
  via: ProviderVia;
  enabled: boolean;
  needsKey: boolean;
  keyHint: string;
  /** Schlüssel gespeichert? Nie der Wert, nur letzte 4 Zeichen. */
  key: { set: boolean; last4: string | null };
  /** Angelegt (Zeile existiert) oder nur Vorlage. */
  configured: boolean;
  models: ProviderModel[];
  lastTest: ProviderTest | null;
}

export const ProviderSaveSchema = z.object({
  kind: ProviderKindSchema,
  label: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  via: ProviderViaSchema.optional(),
  enabled: z.boolean().optional(),
  /** Neuer Schlüssel (leer lassen = unverändert). */
  apiKey: z.string().trim().min(1).max(20_000).optional(),
  /** Schlüssel entfernen. */
  clearKey: z.boolean().optional(),
});
export type ProviderSave = z.infer<typeof ProviderSaveSchema>;

export const ProviderTestRequestSchema = z.object({ model: z.string().trim().min(1).max(200).optional() });

export const MODEL_ROLES = ["nyx.chat", "nyx.briefing", "nyx.voice", "prompt.improve", "skills.create"] as const;
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

const MODEL_ROLE_LABEL_DE: Record<ModelRole, { label: string; hint: string }> = {
  "nyx.chat": { label: "Nyx · Chat", hint: "Antworten im Chat, Pläne, Sortieren, Auswertungen." },
  "nyx.briefing": { label: "Nyx · Briefing", hint: "Morgen-Briefing und Abend-Rückblick." },
  "nyx.voice": { label: "Nyx · Stimme", hint: "Antworten auf gesprochene Fragen (kurz, schnell)." },
  "prompt.improve": { label: "Prompt verbessern", hint: "Macht aus deinem Entwurf im Sessions-Tab einen klaren Prompt – immer Sonnet 5 mit Reasoning hoch, nie Haiku." },
  "skills.create": { label: "Skills erstellen", hint: "Neue Skills und Verbesserungen – immer Opus 5.5, nie ein anderes Modell." },
};

/** German source texts, translated on every read. */
export const MODEL_ROLE_LABEL: Record<ModelRole, { label: string; hint: string }> = Object.fromEntries(
  Object.entries(MODEL_ROLE_LABEL_DE).map(([role, v]) => [role, lazyFields(v, { label: tr, hint: tr })]),
) as Record<ModelRole, { label: string; hint: string }>;

/** `claude-cli` = der bisherige Weg (Claude-Programm im Nyx-Motor, Standard Haiku). */
export type ResolvedModel =
  | { role: ModelRole; source: "claude-cli"; providerId: null; providerKind: null; model: string; label: string; fixed: boolean }
  | { role: ModelRole; source: "provider"; providerId: string; providerKind: ProviderKind; model: string; label: string; fixed: false };

/** Rollen, die fest verdrahtet sind (nicht änderbar, nie Haiku). */
export const FIXED_MODEL_ROLES: readonly ModelRole[] = ["prompt.improve", "skills.create"];

/** Feste Rolle `skills.create`: Opus 5.5 über Claude Code (nie Haiku, nicht änderbar). */
export const SKILLS_CREATE_MODEL = "claude-opus-5-5";
export const SKILLS_CREATE_LABEL = "Claude Opus 5.5 · claude-opus-5-5 (Claude Code)";
export const DEFAULT_ROLE_LABEL = "Claude Haiku 4.5 · claude-haiku-4-5-20251001 (Standard, Claude-Programm)";
/** Anzeige des Standard-Wegs mit genauer Version (Kennung aus `NYXOS_HAIKU_MODEL`, Standard „haiku“). */
export const DEFAULT_ROLE_SUFFIX = "(Standard, Claude-Programm)";

export interface RoleView {
  role: ModelRole;
  label: string;
  hint: string;
  active: ResolvedModel;
  fixed: boolean;
}

/**
 * Embedding-/Rerank-Modelle können nicht chatten („abgelehnt (400)“). Erkennung am Namen,
 * weil OpenAI-kompatible Listen (LM Studio `/v1/models`, Ollama) keine Fähigkeit mitliefern.
 */
const EMBEDDING_MODEL_RE = /embed|rerank|(^|[/:_.-])(bge|gte|e5|minilm|all-minilm)([/:_.-]|$)/i;
export function isEmbeddingModel(model: string): boolean {
  return EMBEDDING_MODEL_RE.test(model.trim());
}
export const EMBEDDING_ROLE_ERROR = "Das ist ein Embedding-Modell – es ist nur für die Suche gedacht und kann nicht chatten. Bitte ein Chat-Modell wählen.";

export const RoleAssignSchema = z.object({
  /** `null` = zurück zum Standard (Haiku über das Claude-Programm). */
  providerId: z.string().trim().min(1).max(60).nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
});

// ───────────────────────────── Konnektoren (MCP) ─────────────────────────────

export const McpTransportSchema = z.enum(["http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** Anmeldung: keine · Token als Kopfzeile (Bearer oder eigener Name) · Token als Umgebungsvariable (Befehl) ·
 * Anmelden im Browser (OAuth mit Rückkehr) · Geräte-Code (Link öffnen, bestätigen – NyxOS wartet, z. B. Higgsfield). */
export const McpAuthSchema = z.enum(["none", "bearer", "header", "env", "oauth", "device"]);
export type McpAuth = z.infer<typeof McpAuthSchema>;

export const McpAuthConfigSchema = z.object({ deviceAuthorizeUrl: z.string().url().max(500).optional(), deviceTokenUrl: z.string().url().max(500).optional() });
export type McpAuthConfig = z.infer<typeof McpAuthConfigSchema>;

export interface McpTemplate {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  auth: McpAuth;
  /** Name der Kopfzeile (auth=header) bzw. Umgebungsvariable (auth=env). */
  authName?: string;
  authConfig?: McpAuthConfig;
  /** Wo es den Zugang gibt – ein Satz. */
  tokenHint: string;
  /** Ehrlicher Hinweis (z. B. „kostet Credits“, „braucht einen Browser im Motor“). */
  note?: string;
}

/** Vorlagen (Adressen live geprüft 25.09.2026). */
const MCP_TEMPLATES_DE: readonly McpTemplate[] = [
  {
    id: "higgsfield",
    label: "Higgsfield",
    description: "Bilder und Videos erzeugen, Soul-Characters, Credit-Stand.",
    transport: "http",
    url: "https://mcp.higgsfield.ai/mcp",
    auth: "device",
    authConfig: { deviceAuthorizeUrl: "https://fnf-device-auth.higgsfield.ai/authorize", deviceTokenUrl: "https://fnf-device-auth.higgsfield.ai/token" },
    tokenHint: "Kein Schlüssel: „Anmelden“ drücken, Link öffnen, mit dem Higgsfield-Konto bestätigen – NyxOS merkt es von selbst.",
    note: "Jede Erzeugung über Nyx kostet normale Higgsfield-Credits (Unlimited gilt nur auf higgsfield.ai).",
  },
  { id: "github", label: "GitHub", description: "Repos, Issues und Pull Requests lesen und bearbeiten.", transport: "http", url: "https://api.githubcopilot.com/mcp/", auth: "bearer", tokenHint: "Persönliches Token aus github.com → Settings → Developer settings → Tokens." },
  { id: "linear", label: "Linear", description: "Aufgaben und Projekte in Linear.", transport: "http", url: "https://mcp.linear.app/mcp", auth: "bearer", tokenHint: "API-Schlüssel aus Linear → Settings → Security & access → API keys." },
  { id: "notion", label: "Notion", description: "Seiten und Datenbanken durchsuchen und bearbeiten.", transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth", tokenHint: "Kein Schlüssel: „Anmelden“ drücken und Notion im Browser freigeben." },
  { id: "fal", label: "fal", description: "Bild-, Video- und Audio-Modelle von fal.ai.", transport: "http", url: "https://mcp.fal.ai/mcp", auth: "bearer", tokenHint: "Schlüssel aus fal.ai → Dashboard → Keys.", note: "Erzeugungen kosten fal-Guthaben." },
  { id: "elevenlabs", label: "ElevenLabs", description: "Stimmen und Sprachausgabe.", transport: "http", url: "https://api.elevenlabs.io/v1/mcp", auth: "oauth", tokenHint: "Kein Schlüssel: „Anmelden“ drücken und ElevenLabs im Browser freigeben.", note: "Sprachausgabe kostet ElevenLabs-Guthaben." },
  { id: "replicate", label: "Replicate", description: "Offene Modelle auf Replicate ausführen.", transport: "http", url: "https://mcp.replicate.com/mcp", auth: "oauth", tokenHint: "„Anmelden“ drücken und im Browser mit dem Replicate-Token bestätigen.", note: "Läufe kosten Replicate-Guthaben." },
  { id: "brave-search", label: "Brave Search", description: "Websuche.", transport: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], auth: "env", authName: "BRAVE_API_KEY", tokenHint: "Schlüssel aus api-dashboard.search.brave.com.", note: "Läuft als Befehl im Nyx-Motor auf dem Server – nur mit Claude-Modellen." },
  { id: "playwright", label: "Playwright", description: "Webseiten öffnen, klicken, Screenshots.", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"], auth: "none", tokenHint: "Kein Schlüssel nötig.", note: "Braucht einen Browser im Nyx-Motor auf dem Server – dort ist noch keiner installiert, der Test sagt ehrlich, ob es geht." },
];

/** Description, token hint and note are German source texts, translated on every read. */
export const MCP_TEMPLATES: readonly McpTemplate[] = MCP_TEMPLATES_DE.map((m) => lazyFields(m, { description: tr, tokenHint: tr, note: tr }));

export interface McpToolInfo {
  name: string;
  description: string | null;
}

export interface McpTestResult {
  ok: boolean;
  at: string;
  ms: number;
  message: string;
  tools: McpToolInfo[];
}

export interface ConnectorView {
  id: number;
  /** Kurzname (auch Name des MCP-Servers für Nyx), z. B. `higgsfield`. */
  name: string;
  label: string;
  template: string | null;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  /** Nicht geheime Kopfzeilen. */
  headers: Record<string, string>;
  auth: McpAuth;
  authName: string | null;
  authConfig: McpAuthConfig | null;
  /** Laufende Geräte-Anmeldung (nur Link + Ablauf, nie der Code selbst). */
  login: { state: "pending" | "failed"; verificationUri: string | null; userCode: string | null; expiresAt: string; message: string | null } | null;
  enabled: boolean;
  /** Tool-Pinning: freigegebene Werkzeuge. `null` = noch nie getestet (Nyx nutzt dann keins); neue Werkzeuge bleiben aus, bis der Nutzer sie freigibt. */
  allowedTools: string[] | null;
  /** Token/Anmeldung gespeichert? Nie der Wert. */
  token: { set: boolean; last4: string | null; expiresAt: string | null };
  lastTest: McpTestResult | null;
  note: string | null;
  tokenHint: string | null;
}

export const ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const ConnectorSaveSchema = z.object({
  name: ConnectorNameSchema,
  label: z.string().trim().min(1).max(60),
  template: z.string().max(40).nullable().optional(),
  transport: McpTransportSchema,
  url: z.string().trim().url().max(500).nullable().optional(),
  command: z.string().trim().min(1).max(200).nullable().optional(),
  args: z.array(z.string().max(500)).max(40).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,60}$/), z.string().max(2000)).optional(),
  auth: McpAuthSchema,
  authName: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,59}$/).nullable().optional(),
  authConfig: McpAuthConfigSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  /** Neuer Token (leer = unverändert). */
  token: z.string().trim().min(1).max(20_000).optional(),
  clearToken: z.boolean().optional(),
});
export type ConnectorSave = z.infer<typeof ConnectorSaveSchema>;

export const ConnectorPatchSchema = ConnectorSaveSchema.partial()
  .omit({ name: true })
  .extend({ allowedTools: z.array(z.string().min(1).max(200)).max(500).optional() });
export type ConnectorPatch = z.infer<typeof ConnectorPatchSchema>;

/** Fähigkeit der Brücke: lokale Modelle (Ollama/LM Studio) für den Server erreichbar machen. */
export const BRIDGE_CAP_LOCAL_PROXY = "http_proxy_local";
/** Standard-Erlaubnisliste der Brücke: Ollama 11434, LM Studio 1234 (weitere in der Brücken-Konfiguration). */
export const LOCAL_PROXY_DEFAULT_PORTS = [11434, 1234] as const;
/** Größte Antwort, die über die Brücke zurückgeht. */
export const LOCAL_PROXY_MAX_BYTES = 8 * 1024 * 1024;

export const LocalProxyRequestSchema = z.object({
  port: z.number().int().min(1).max(65535),
  method: z.enum(["GET", "POST"]),
  /** Pfad inkl. Suchteil, muss mit `/` beginnen (kein Host – immer 127.0.0.1). */
  path: z.string().regex(/^\/[^\s]*$/).max(2000),
  headers: z.record(z.string(), z.string().max(4000)).optional(),
  body: z.string().max(LOCAL_PROXY_MAX_BYTES).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});
export type LocalProxyRequest = z.infer<typeof LocalProxyRequestSchema>;

export interface LocalProxyResult {
  status: number;
  contentType: string | null;
  body: string;
}
