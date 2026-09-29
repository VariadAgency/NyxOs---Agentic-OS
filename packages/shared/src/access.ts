// Zugänge + Modell-Katalog. Vertrag zwischen Server (`apps/server/src/access`, `routes/access.ts`,
// `models/*`) und Web (Einstellungen → Zugänge, Modellwahl). Geheimnisse gehen nur zum Server – zurück kommt
// höchstens „gesetzt · endet auf …1234“ (siehe `SecretInfo.last4`).
import { z } from "zod";
import type { ProviderKind } from "./models.js";
import { t } from "./i18n/index.js";
import { lazyFields, tr, trList } from "./lazy-text.js";

// ───────────────────────────── Zugänge ─────────────────────────────

/** Wie ein Zugang gespeichert wird: Anbieter-Schlüssel, lokale Adresse, Telegram, Geheimnis, nur Verweis. */
export type AccessStorage = "provider-key" | "provider-url" | "telegram" | "secret" | "link";

export const ACCESS_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "deepseek",
  "mistral",
  "groq",
  "xai",
  "ollama",
  "lmstudio",
  "telegram",
  "higgsfield",
  "elevenlabs",
  "push",
] as const;
export const AccessIdSchema = z.enum(ACCESS_IDS);
export type AccessId = z.infer<typeof AccessIdSchema>;

export interface AccessStep {
  text: string;
  /** Offizielle Seite für diesen Schritt. */
  url?: string;
}

export interface AccessItem {
  id: AccessId;
  label: string;
  storage: AccessStorage;
  /** Gehört zu einem N5-Anbieter (Schlüssel/Adresse landen dort). */
  providerKind?: ProviderKind;
  /** Geheimnis-Name im Speicher (nur `storage: "secret"`). */
  secretName?: string;
  /** Ein Satz: wofür. */
  purpose: string;
  /** Was damit in NyxOS freigeschaltet wird. */
  unlocks: string[];
  /** Schritt für Schritt, wo es den Schlüssel gibt. */
  steps: AccessStep[];
  /** Offizielle Adresse (Hauptlink der Karte). */
  link: { url: string; label: string };
  /** Beispiel-Form im Eingabefeld (nie ein echter Wert). */
  placeholder?: string;
  /** Kostet Geld/Guthaben? Ehrlicher Satz. */
  cost?: string;
  /** Verweis-Karten: wohin in NyxOS (Pfad + Anker). */
  target?: string;
  /** Wichtig für den Alltag (Assistent zeigt diese zuerst). */
  core?: boolean;
}

const ANTHROPIC_STEPS: AccessStep[] = [
  { text: "console.anthropic.com öffnen und anmelden.", url: "https://console.anthropic.com/settings/keys" },
  { text: "Links „API Keys“ → „Create Key“, Namen z. B. „NyxOS“ geben." },
  { text: "Den Schlüssel (beginnt mit sk-ant-) kopieren – er wird nur einmal angezeigt." },
  { text: "Hier einfügen und „Prüfen“ drücken." },
];

const ACCESS_ITEMS_DE: readonly AccessItem[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    storage: "provider-key",
    providerKind: "anthropic",
    purpose: "Claude-Modelle direkt über die API – Opus, Sonnet, Fable, Haiku mit genauer Version.",
    unlocks: ["Nyx mit einem bestimmten Claude-Modell (z. B. Sonnet 5 statt Haiku)", "Live-Liste aller Claude-Modelle mit Kontext-Größe"],
    steps: ANTHROPIC_STEPS,
    link: { url: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com" },
    placeholder: "sk-ant-…",
    cost: "Abrechnung pro Token über dein Anthropic-Konto.",
    core: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    storage: "provider-key",
    providerKind: "openai",
    purpose: "GPT-Modelle von OpenAI.",
    unlocks: ["GPT-5 & Co. als Modell für Nyx", "Live-Modell-Liste von OpenAI"],
    steps: [
      { text: "platform.openai.com öffnen und anmelden.", url: "https://platform.openai.com/api-keys" },
      { text: "„API keys“ → „Create new secret key“." },
      { text: "Den Schlüssel (beginnt mit sk-proj- oder sk-) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
    placeholder: "sk-proj-…",
    cost: "Abrechnung pro Token, Guthaben vorher aufladen.",
    core: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    storage: "provider-key",
    providerKind: "openrouter",
    purpose: "Ein Schlüssel für Hunderte Modelle (Claude, GPT, Gemini, Llama, Mistral …) mit Preisen und Kontext-Größe.",
    unlocks: ["Riesige Modell-Auswahl mit Live-Preisen", "Modelle ohne eigenes Konto beim Hersteller"],
    steps: [
      { text: "openrouter.ai öffnen und anmelden.", url: "https://openrouter.ai/keys" },
      { text: "„Keys“ → „Create Key“." },
      { text: "Den Schlüssel (beginnt mit sk-or-) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://openrouter.ai/keys", label: "openrouter.ai/keys" },
    placeholder: "sk-or-v1-…",
    cost: "Guthaben bei OpenRouter, Preis je Modell.",
    core: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    storage: "provider-key",
    providerKind: "gemini",
    purpose: "Gemini-Modelle von Google (sehr großer Kontext, günstige Flash-Modelle).",
    unlocks: ["Gemini Pro/Flash als Modell für Nyx", "Live-Modell-Liste von Google"],
    steps: [
      { text: "aistudio.google.com öffnen und mit dem Google-Konto anmelden.", url: "https://aistudio.google.com/app/apikey" },
      { text: "„Get API key“ → „Create API key“." },
      { text: "Den Schlüssel (beginnt mit AIza) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://aistudio.google.com/app/apikey", label: "aistudio.google.com" },
    placeholder: "AIza…",
    cost: "Kostenlose Stufe mit Grenzen, danach pro Token.",
    core: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    storage: "provider-key",
    providerKind: "deepseek",
    purpose: "Sehr günstige Chat- und Denk-Modelle von DeepSeek.",
    unlocks: ["DeepSeek Chat/Reasoner als Modell für Nyx"],
    steps: [
      { text: "platform.deepseek.com öffnen und anmelden.", url: "https://platform.deepseek.com/api_keys" },
      { text: "„API keys“ → „Create new API key“." },
      { text: "Den Schlüssel (beginnt mit sk-) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" },
    placeholder: "sk-…",
    cost: "Guthaben vorher aufladen, sehr niedrige Preise.",
    core: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    storage: "provider-key",
    providerKind: "mistral",
    purpose: "Modelle von Mistral (Europa).",
    unlocks: ["Mistral Large/Small als Modell für Nyx"],
    steps: [
      { text: "console.mistral.ai öffnen und anmelden.", url: "https://console.mistral.ai/api-keys" },
      { text: "„API Keys“ → „Create new key“, kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://console.mistral.ai/api-keys", label: "console.mistral.ai" },
    cost: "Abrechnung pro Token.",
  },
  {
    id: "groq",
    label: "Groq",
    storage: "provider-key",
    providerKind: "groq",
    purpose: "Offene Modelle mit extrem schneller Antwort.",
    unlocks: ["Sehr schnelle Antworten (z. B. für die Stimme)"],
    steps: [
      { text: "console.groq.com öffnen und anmelden.", url: "https://console.groq.com/keys" },
      { text: "„API Keys“ → „Create API Key“, Schlüssel (gsk_…) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://console.groq.com/keys", label: "console.groq.com" },
    placeholder: "gsk_…",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    storage: "provider-key",
    providerKind: "xai",
    purpose: "Grok-Modelle von xAI.",
    unlocks: ["Grok als Modell für Nyx"],
    steps: [
      { text: "console.x.ai öffnen und anmelden.", url: "https://console.x.ai" },
      { text: "„API Keys“ → „Create API Key“, Schlüssel (xai-…) kopieren." },
      { text: "Hier einfügen und „Prüfen“ drücken." },
    ],
    link: { url: "https://console.x.ai", label: "console.x.ai" },
    placeholder: "xai-…",
  },
  {
    id: "ollama",
    label: "Ollama (auf dem Rechner)",
    storage: "provider-url",
    providerKind: "ollama",
    purpose: "Lokale Modelle auf deinem Mac – kostenlos, nichts verlässt den Rechner.",
    unlocks: ["Lokale Modelle (Llama, Qwen, Gemma …) für Nyx", "Modell-Liste direkt vom Mac"],
    steps: [
      { text: "Ollama installieren.", url: "https://ollama.com/download" },
      { text: "Im Terminal ein Modell holen, z. B. „ollama pull qwen3“." },
      { text: "Adresse bleibt meist http://127.0.0.1:11434/v1 – „Prüfen“ drücken (geht über die Brücke)." },
    ],
    link: { url: "https://ollama.com/download", label: "ollama.com" },
    placeholder: "http://127.0.0.1:11434/v1",
  },
  {
    id: "lmstudio",
    label: "LM Studio (auf dem Rechner)",
    storage: "provider-url",
    providerKind: "lmstudio",
    purpose: "Lokale Modelle aus LM Studio – kostenlos, nichts verlässt den Rechner.",
    unlocks: ["Lokale Modelle aus LM Studio für Nyx"],
    steps: [
      { text: "LM Studio installieren.", url: "https://lmstudio.ai" },
      { text: "Ein Modell laden, dann links „Developer“ → „Start Server“." },
      { text: "Adresse bleibt meist http://127.0.0.1:1234/v1 – „Prüfen“ drücken (geht über die Brücke)." },
    ],
    link: { url: "https://lmstudio.ai", label: "lmstudio.ai" },
    placeholder: "http://127.0.0.1:1234/v1",
  },
  {
    id: "telegram",
    label: "Telegram-Bot",
    storage: "telegram",
    purpose: "Nyx schreibt dir in Telegram und du kannst ihm von unterwegs antworten.",
    unlocks: ["Nachrichten und Freigaben per Telegram", "Sprachnachrichten an Nyx", "Erinnerungen aufs Handy"],
    steps: [
      { text: "In Telegram @BotFather öffnen.", url: "https://t.me/BotFather" },
      { text: "„/newbot“ schicken, Namen und Benutzernamen (endet auf „bot“) wählen." },
      { text: "Das Token (Form 123456789:ABC…) kopieren." },
      { text: "Hier einfügen, „Prüfen“ – danach unter Telegram den Kopplungs-Code an den Bot schicken." },
    ],
    link: { url: "https://t.me/BotFather", label: "@BotFather" },
    placeholder: "123456789:ABC…",
    core: true,
  },
  {
    id: "higgsfield",
    label: "Higgsfield",
    storage: "link",
    purpose: "Bilder und Videos erzeugen. Kein Schlüssel – Anmeldung per Link.",
    unlocks: ["Nyx erzeugt Bilder/Videos", "Soul-Characters und Credit-Stand"],
    steps: [
      { text: "Unten bei „Konnektoren“ Higgsfield hinzufügen." },
      { text: "„Anmelden“ drücken, Link öffnen, mit dem Higgsfield-Konto bestätigen – NyxOS merkt es von selbst." },
    ],
    link: { url: "https://higgsfield.ai", label: "higgsfield.ai" },
    cost: "Jede Erzeugung kostet Higgsfield-Credits.",
    target: "/settings/modelle#konnektoren",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs (Stimme)",
    storage: "link",
    purpose: "Natürliche Stimme für Nyx. Den Schlüssel trägst du bei Nyx → Stimme ein.",
    unlocks: ["Nyx spricht mit einer ElevenLabs-Stimme"],
    steps: [
      { text: "elevenlabs.io öffnen und anmelden.", url: "https://elevenlabs.io/app/settings/api-keys" },
      { text: "„API Keys“ → „Create API Key“, kopieren." },
      { text: "In NyxOS: Einstellungen → Nyx → Stimme, dort einfügen." },
    ],
    link: { url: "https://elevenlabs.io/app/settings/api-keys", label: "elevenlabs.io" },
    cost: "Sprachausgabe kostet ElevenLabs-Guthaben.",
    target: "/einstellungen/nyx/stimme",
  },
  {
    id: "push",
    label: "Push-Mitteilungen",
    storage: "link",
    purpose: "Mitteilungen aufs Handy (ntfy / Browser-Push).",
    unlocks: ["Meldungen aufs Handy, auch wenn NyxOS zu ist"],
    steps: [{ text: "Unten bei „Push“ einrichten und Test-Push schicken." }],
    link: { url: "https://ntfy.sh", label: "ntfy.sh" },
    target: "/settings/mitteilungen",
  },
];

/** German source texts translated on every read (the app language can change at runtime). */
export const ACCESS_ITEMS: readonly AccessItem[] = ACCESS_ITEMS_DE.map((item) =>
  lazyFields(item, {
    label: tr,
    purpose: tr,
    unlocks: trList,
    steps: (steps) => steps.map((s) => ({ ...s, text: tr(s.text) })),
    link: (link) => ({ ...link, label: tr(link.label) }),
    cost: tr,
  }),
);

export function accessItem(id: AccessId): AccessItem {
  return ACCESS_ITEMS.find((i) => i.id === id) as AccessItem;
}

/** Zugänge, die man hier eintragen kann (Verweise nicht). */
export const isEditableAccess = (i: AccessItem) => i.storage !== "link";

export type AccessState = "ok" | "missing" | "error" | "unchecked" | "link";

export interface AccessCheck {
  ok: boolean;
  at: string;
  ms: number;
  /** Einfache Worte. */
  message: string;
}

export interface AccessStatus {
  id: AccessId;
  state: AccessState;
  /** Kurzer Satz zum Zustand (z. B. „verbunden · 42 Modelle“). */
  detail: string | null;
  /** Nur Anzeige: letzte 4 Zeichen. Nie der Wert. */
  last4: string | null;
  /** Adresse (nur lokale Anbieter – keine Geheimnisse). */
  url: string | null;
  updatedAt: string | null;
  lastCheck: AccessCheck | null;
  /** Kann hier gerade nicht gespeichert werden (z. B. Speicher-Schlüssel fehlt) – Satz dazu. */
  blocked: string | null;
}

export interface AccessListResponse {
  items: AccessStatus[];
  secretsKey: "ok" | "missing" | "invalid";
}

export const AccessValueSchema = z.object({ value: z.string().trim().min(1).max(20_000) });

export const AccessBulkSchema = z.object({
  entries: z.array(z.object({ id: AccessIdSchema, value: z.string().trim().min(1).max(20_000) })).min(1).max(ACCESS_IDS.length),
  /** Gleich nach dem Speichern prüfen (Standard: ja). */
  check: z.boolean().optional(),
});
export type AccessBulk = z.infer<typeof AccessBulkSchema>;

export interface AccessBulkResult {
  results: { id: AccessId; saved: boolean; error: string | null; check: AccessCheck | null }[];
  items: AccessStatus[];
}

// ───────────────────────────── Schlau einfügen ─────────────────────────────

export interface DetectedCredential {
  id: AccessId;
  value: string;
  /** Woran erkannt: „Form“ (Präfix) oder „Name“ (z. B. OPENAI_API_KEY=…). */
  by: "prefix" | "name";
}

/** Variablen-Namen (aus .env-Zeilen) → Zugang. */
const ENV_NAMES: [RegExp, AccessId][] = [
  [/^ANTHROPIC_(API_KEY|KEY|AUTH_TOKEN)$/, "anthropic"],
  [/^OPENAI_(API_KEY|KEY)$/, "openai"],
  [/^OPENROUTER_(API_KEY|KEY)$/, "openrouter"],
  [/^(GEMINI|GOOGLE|GOOGLE_AI|GOOGLE_GENERATIVE_AI)_(API_KEY|KEY)$/, "gemini"],
  [/^DEEPSEEK_(API_KEY|KEY)$/, "deepseek"],
  [/^MISTRAL_(API_KEY|KEY)$/, "mistral"],
  [/^GROQ_(API_KEY|KEY)$/, "groq"],
  [/^(XAI|GROK)_(API_KEY|KEY)$/, "xai"],
  [/^(TELEGRAM_BOT_TOKEN|TELEGRAM_TOKEN|BOT_TOKEN)$/, "telegram"],
  [/^OLLAMA_(HOST|BASE_URL|URL)$/, "ollama"],
  [/^(LMSTUDIO|LM_STUDIO)_(HOST|BASE_URL|URL)$/, "lmstudio"],
  [/^(ELEVENLABS|ELEVEN|XI)_(API_KEY|KEY)$/, "elevenlabs"],
];

/** Form eines einzelnen Werts → Zugang (Reihenfolge wichtig: spezielle Präfixe vor „sk-“). */
export function detectCredentialKind(raw: string): AccessId | null {
  const v = raw.trim();
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v)) return "anthropic";
  if (/^sk-or-[A-Za-z0-9_-]{20,}$/.test(v)) return "openrouter";
  if (/^sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}$/.test(v)) return "openai";
  // DeepSeek: „sk-“ + genau 32 Hex-Zeichen; OpenAI-Altschlüssel sind länger und gemischt.
  if (/^sk-[a-f0-9]{32}$/.test(v)) return "deepseek";
  if (/^sk_[a-f0-9]{40,}$/.test(v)) return "elevenlabs";
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(v)) return "openai";
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(v)) return "gemini";
  if (/^gsk_[A-Za-z0-9]{20,}$/.test(v)) return "groq";
  if (/^xai-[A-Za-z0-9]{20,}$/.test(v)) return "xai";
  if (/^\d{6,12}:[A-Za-z0-9_-]{35}$/.test(v)) return "telegram";
  if (/^https?:\/\/(127\.0\.0\.1|localhost):11434(\/v1)?\/?$/.test(v)) return "ollama";
  if (/^https?:\/\/(127\.0\.0\.1|localhost):1234(\/v1)?\/?$/.test(v)) return "lmstudio";
  return null;
}

const unquote = (s: string) => s.trim().replace(/^export\s+/, "").replace(/^["'`]|["'`,;]$/g, "").replace(/^["'`]|["'`]$/g, "");

/**
 * Viele Schlüssel auf einmal einfügen (Liste, .env-Zeilen, Mail-Text): erkennt je Wert den Zugang am Präfix
 * oder am Variablen-Namen. Pro Zugang zählt der erste Treffer. Unbekanntes wird ignoriert (nie geraten).
 */
export function detectCredentials(text: string): DetectedCredential[] {
  const found = new Map<AccessId, DetectedCredential>();
  const add = (d: DetectedCredential) => {
    if (!found.has(d.id)) found.set(d.id, d);
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,60})\s*[=:]\s*(.+?)\s*$/.exec(line);
    if (m) {
      const name = m[1] as string;
      const value = unquote(m[2] as string);
      const byName = ENV_NAMES.find(([re]) => re.test(name))?.[1];
      if (byName && value) {
        add({ id: byName, value, by: "name" });
        continue;
      }
    }
    for (const token of line.split(/[\s,;|]+/)) {
      const value = unquote(token);
      if (!value) continue;
      const id = detectCredentialKind(value);
      if (id) add({ id, value, by: "prefix" });
    }
  }
  return [...found.values()];
}

// ───────────────────────────── Modell-Katalog ─────────────────────────────

export type ModelSpeed = "sehr schnell" | "schnell" | "mittel" | "gründlich";

export interface CatalogModel {
  /** Genaue Modell-Kennung, wie sie an die API geht. */
  id: string;
  provider: ProviderKind;
  /** Name mit Version, z. B. „Claude Haiku 4.5“. */
  name: string;
  /** Weitere Kennungen, die auf dasselbe Modell zeigen (Kurzname, Alias). */
  aliases?: string[];
  /** Kontextfenster in Token. */
  context: number | null;
  /** USD pro 1 Mio. Token (Eingabe / Ausgabe). */
  priceIn: number | null;
  priceOut: number | null;
  speed: ModelSpeed | null;
  /** Wofür es gut ist, kurz. */
  strength: string | null;
  /** Preise sind grob (Stand der Liste) – live nur über OpenRouter. */
  approx?: boolean;
  /** Woher der Eintrag kommt. */
  source: "catalog" | "live";
}

/**
 * Feste Liste (Rückfall ohne Live-Abfrage). Claude: Preise/Kontext laut Anthropic (Stand 2026-09).
 * Andere Anbieter: grobe Preise (approx) – die genaue Liste kommt live vom Anbieter.
 */
const MODEL_CATALOG_DE: readonly CatalogModel[] = [
  { id: "claude-fable-5-1", provider: "anthropic", name: "Claude Fable 5.1", context: 1_000_000, priceIn: 10, priceOut: 50, speed: "gründlich", strength: "Stärkstes Claude-Modell – schwerste Aufgaben, lange Agenten-Läufe.", source: "catalog" },
  { id: "claude-fable-5", provider: "anthropic", name: "Claude Fable 5", context: 1_000_000, priceIn: 10, priceOut: 50, speed: "gründlich", strength: "Vorgänger von Fable 5.1.", source: "catalog" },
  { id: "claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", context: 1_000_000, priceIn: 4, priceOut: 20, speed: "mittel", strength: "Neuestes Opus – sehr stark bei Code und Planung, günstiger als Opus 5.", source: "catalog" },
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5", context: 1_000_000, priceIn: 5, priceOut: 25, speed: "mittel", strength: "Starkes Allround-Modell für Code und Agenten.", source: "catalog" },
  { id: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", context: 1_000_000, priceIn: 5, priceOut: 25, speed: "mittel", strength: "Ältere Opus-Generation.", source: "catalog" },
  { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7", context: 1_000_000, priceIn: 5, priceOut: 25, speed: "mittel", strength: "Ältere Opus-Generation.", source: "catalog" },
  { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6", context: 1_000_000, priceIn: 5, priceOut: 25, speed: "mittel", strength: "Ältere Opus-Generation.", source: "catalog" },
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5", context: 1_000_000, priceIn: 2, priceOut: 10, speed: "schnell", strength: "Bestes Verhältnis aus Tempo, Preis und Können.", source: "catalog" },
  { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet 4.6", context: 1_000_000, priceIn: 3, priceOut: 15, speed: "schnell", strength: "Vorgänger von Sonnet 5.", source: "catalog" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", name: "Claude Haiku 4.5", aliases: ["claude-haiku-4-5", "haiku"], context: 200_000, priceIn: 1, priceOut: 5, speed: "sehr schnell", strength: "Schnell und günstig – Standard für Nyx.", source: "catalog" },

  { id: "gpt-5", provider: "openai", name: "GPT-5", context: 400_000, priceIn: 1.25, priceOut: 10, speed: "mittel", strength: "Stärkstes allgemeines OpenAI-Modell.", approx: true, source: "catalog" },
  { id: "gpt-5-mini", provider: "openai", name: "GPT-5 mini", context: 400_000, priceIn: 0.25, priceOut: 2, speed: "schnell", strength: "Günstig, gut für Alltag.", approx: true, source: "catalog" },
  { id: "gpt-5-nano", provider: "openai", name: "GPT-5 nano", context: 400_000, priceIn: 0.05, priceOut: 0.4, speed: "sehr schnell", strength: "Sehr billig, einfache Aufgaben.", approx: true, source: "catalog" },
  { id: "gpt-4.1", provider: "openai", name: "GPT-4.1", context: 1_000_000, priceIn: 2, priceOut: 8, speed: "schnell", strength: "Langer Kontext, ohne Denkpause.", approx: true, source: "catalog" },
  { id: "o3", provider: "openai", name: "o3", context: 200_000, priceIn: 2, priceOut: 8, speed: "gründlich", strength: "Denk-Modell für knifflige Fragen.", approx: true, source: "catalog" },

  { id: "gemini-2.5-pro", provider: "gemini", name: "Gemini 2.5 Pro", context: 1_048_576, priceIn: 1.25, priceOut: 10, speed: "mittel", strength: "Stärkstes Gemini, sehr langer Kontext.", approx: true, source: "catalog" },
  { id: "gemini-2.5-flash", provider: "gemini", name: "Gemini 2.5 Flash", context: 1_048_576, priceIn: 0.3, priceOut: 2.5, speed: "schnell", strength: "Schnell und günstig.", approx: true, source: "catalog" },
  { id: "gemini-2.5-flash-lite", provider: "gemini", name: "Gemini 2.5 Flash-Lite", context: 1_048_576, priceIn: 0.1, priceOut: 0.4, speed: "sehr schnell", strength: "Am günstigsten.", approx: true, source: "catalog" },

  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat (V3)", context: 128_000, priceIn: 0.28, priceOut: 0.42, speed: "schnell", strength: "Sehr günstiger Allrounder.", approx: true, source: "catalog" },
  { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek Reasoner", context: 128_000, priceIn: 0.28, priceOut: 0.42, speed: "gründlich", strength: "Denk-Modell, günstig.", approx: true, source: "catalog" },

  { id: "mistral-large-latest", provider: "mistral", name: "Mistral Large", context: 128_000, priceIn: 2, priceOut: 6, speed: "mittel", strength: "Stärkstes Mistral-Modell.", approx: true, source: "catalog" },
  { id: "mistral-small-latest", provider: "mistral", name: "Mistral Small", context: 128_000, priceIn: 0.1, priceOut: 0.3, speed: "schnell", strength: "Klein und günstig.", approx: true, source: "catalog" },
  { id: "llama-3.3-70b-versatile", provider: "groq", name: "Llama 3.3 70B (Groq)", context: 128_000, priceIn: 0.59, priceOut: 0.79, speed: "sehr schnell", strength: "Offenes Modell, extrem schnell.", approx: true, source: "catalog" },
  { id: "grok-4", provider: "xai", name: "Grok 4", context: 256_000, priceIn: 3, priceOut: 15, speed: "mittel", strength: "Stärkstes Grok-Modell.", approx: true, source: "catalog" },
];

/** Speed and strength are German source texts, translated on every read. */
export const MODEL_CATALOG: readonly CatalogModel[] = MODEL_CATALOG_DE.map((m) => lazyFields(m, { speed: tr, strength: tr }));

/** Katalog-Eintrag zu einer Kennung (auch über Alias, z. B. „haiku“). */
export function catalogModel(id: string): CatalogModel | null {
  const k = id.trim().toLowerCase();
  return MODEL_CATALOG.find((m) => m.id === k || m.aliases?.includes(k)) ?? null;
}

/** Schlusskritik: kurzer Name mit Version für enge Anzeigen („haiku“ → „Claude Haiku 4.5“, unbekannt: die Kennung). */
export function modelName(id: string): string {
  return catalogModel(id)?.name ?? id;
}

/** „Claude Haiku 4.5 · claude-haiku-4-5-20251001“ – Name mit genauer Kennung (unbekannt: nur die Kennung). */
export function describeModel(id: string): string {
  const m = catalogModel(id);
  return m ? `${m.name} · ${m.id}` : id;
}

/** Eintrag im Modell-Wähler: Katalog + Live-Liste je Anbieter zusammengeführt. */
export interface ModelChoice extends CatalogModel {
  /** Anbieter-Kennung in NyxOS (`anthropic`, `custom-ab12` …). */
  providerId: string;
  providerLabel: string;
  /** Anbieter eingerichtet + an → wählbar. */
  usable: boolean;
}

export interface ModelCatalogResponse {
  models: ModelChoice[];
}

/** „1M“, „200K“ – kurz für die Anzeige. */
export function formatContext(tokens: number | null): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 2 : 0)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** „$1 / $5“ pro 1 Mio. Token (Eingabe / Ausgabe). */
export function formatPrice(m: Pick<CatalogModel, "priceIn" | "priceOut" | "approx">): string | null {
  if (m.priceIn == null || m.priceOut == null) return null;
  const f = (n: number) => `$${n >= 1 ? +n.toFixed(2) : +n.toFixed(3)}`;
  const price = `${f(m.priceIn)} / ${f(m.priceOut)}`;
  return m.approx ? t("ca. {price}", { price }) : price;
}
