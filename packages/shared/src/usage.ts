// Preise und Kontextfenster je Modell. Rechenweise und Preis-Vorlage folgen `ccusage`
// (https://github.com/ccusage/ccusage, nur Logik angesehen, siehe NOTICE): Kosten = Tokens je Art
// (Input/Output/Cache-Lesen/Cache-Schreiben) mal Preis je Token, Cache-Schreiben mit 1-Std-TTL
// (`cache_creation.ephemeral_1h_input_tokens`) zum höheren Satz. Die Preis-/Kontextfenster-Werte
// selbst stammen aus dem LiteLLM-Datensatz `model_prices_and_context_window.json`
// (https://github.com/BerriAI/litellm, MIT — Datenwerte, kein Code-Übernahme, daher nicht in NOTICE
// nötig) plus den Anbieter-Preisseiten, wie sie `ccusage` selbst nachlädt. Stand: 25.09.2026.
import { z } from "zod";

export const ModelPriceSchema = z.object({
  model: z.string().min(1),
  /** USD je Token (nicht je 1M — das rechnet sich in `computeCost` einfacher ohne Rundungsstufen). */
  inputPerToken: z.number().nonnegative(),
  outputPerToken: z.number().nonnegative(),
  cacheReadPerToken: z.number().nonnegative(),
  /** Cache-Schreiben mit kurzer TTL (Claude: 5 Minuten; bei anderen Anbietern der einzige Satz). */
  cacheCreation5mPerToken: z.number().nonnegative(),
  /** Cache-Schreiben mit 1-Std-TTL (nur Claude `cache_creation.ephemeral_1h_input_tokens`). `null` = wie 5-Min-Satz. */
  cacheCreation1hPerToken: z.number().nonnegative().nullable(),
  /** Kontextfenster in Tokens, `null` = unbekannt (nie schätzen, s. GOAL). */
  contextWindow: z.number().int().positive().nullable(),
  validFrom: z.string(),
  source: z.string(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/**
 * Eingebaute Ausgangswerte (Seed für die editierbare `prices`-Tabelle, s. Schema). Quelle je Zeile
 * im Feld `source` — bei fehlendem Modell liefert `computeCost`/`getContextWindow` `null`, nie eine
 * Schätzung (GOAL P6, ESKALATION).
 */
export const BUILTIN_MODEL_PRICES: ModelPrice[] = [
  {
    model: "claude-opus-5",
    inputPerToken: 5e-6,
    outputPerToken: 2.5e-5,
    cacheReadPerToken: 5e-7,
    cacheCreation5mPerToken: 6.25e-6,
    cacheCreation1hPerToken: 1e-5,
    contextWindow: 1_000_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache) + platform.claude.com/docs/about-claude/pricing",
  },
  {
    model: "claude-opus-5-5",
    inputPerToken: 4e-6,
    outputPerToken: 2e-5,
    cacheReadPerToken: 2e-7,
    cacheCreation5mPerToken: 5e-6,
    cacheCreation1hPerToken: null,
    contextWindow: 1_000_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache)",
  },
  {
    model: "claude-sonnet-5",
    inputPerToken: 2e-6,
    outputPerToken: 1e-5,
    cacheReadPerToken: 2e-7,
    cacheCreation5mPerToken: 2.5e-6,
    cacheCreation1hPerToken: null,
    contextWindow: 1_000_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache)",
  },
  {
    model: "claude-haiku-4-5",
    inputPerToken: 1e-6,
    outputPerToken: 5e-6,
    cacheReadPerToken: 1e-7,
    cacheCreation5mPerToken: 1.25e-6,
    cacheCreation1hPerToken: 2e-6,
    contextWindow: 200_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache)",
  },
  {
    model: "gpt-6-astra",
    inputPerToken: 1e-5,
    outputPerToken: 5e-5,
    cacheReadPerToken: 1e-6,
    cacheCreation5mPerToken: 1.25e-5,
    cacheCreation1hPerToken: null,
    // Codex meldet sein Kontextfenster live je Session (`token_count.model_context_window`) — dieser
    // Wert ist nur der Rückfall, wenn eine Session (noch) kein `token_count`-Ereignis hatte.
    contextWindow: 922_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache); live: Codex `token_count.model_context_window`",
  },
  {
    model: "gpt-5.6-terra",
    inputPerToken: 2e-6,
    outputPerToken: 1.2e-5,
    cacheReadPerToken: 2e-7,
    cacheCreation5mPerToken: 2.5e-6,
    cacheCreation1hPerToken: null,
    contextWindow: 922_000,
    validFrom: "2026-01-01",
    source: "LiteLLM model_prices_and_context_window.json (via ccusage-Cache); live: Codex `token_count.model_context_window`",
  },
];

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-Minuten-TTL (oder einziger Satz, wenn der Anbieter nicht zwischen TTLs unterscheidet). */
  cacheCreation5m: number;
  /** 1-Std-TTL (nur Claude); 0 bei anderen Anbietern. */
  cacheCreation1h: number;
}

/** `null` = kein Preis für dieses Modell hinterlegt — nie schätzen, s. GOAL/ESKALATION. */
export function computeCost(price: Pick<ModelPrice, "inputPerToken" | "outputPerToken" | "cacheReadPerToken" | "cacheCreation5mPerToken" | "cacheCreation1hPerToken"> | undefined, t: UsageTokens): number | null {
  if (!price) return null;
  const cc1hRate = price.cacheCreation1hPerToken ?? price.cacheCreation5mPerToken;
  return t.input * price.inputPerToken + t.output * price.outputPerToken + t.cacheRead * price.cacheReadPerToken + t.cacheCreation5m * price.cacheCreation5mPerToken + t.cacheCreation1h * cc1hRate;
}

/** Kontextfenster für ein Modell: `liveWindow` (z. B. Codex `model_context_window`) hat Vorrang vor
 * der gepflegten Tabelle. `null` = unbekannt — die Anzeige muss dann "unbekannt" zeigen, nie raten. */
export function resolveContextWindow(model: string | null, liveWindow: number | null | undefined, table: ModelPrice[] = BUILTIN_MODEL_PRICES): { window: number | null; source: string | null } {
  if (liveWindow && liveWindow > 0) return { window: liveWindow, source: "live: Codex `token_count.model_context_window`" };
  if (!model) return { window: null, source: null };
  const row = table.find((p) => p.model === model);
  return row?.contextWindow ? { window: row.contextWindow, source: row.source } : { window: null, source: null };
}

/**
 * Kontext-Anteil: Tokens der letzten Antwort (Input + Cache-Lesen + Cache-Schreiben — das ist
 * die Kontextgröße VOR der Antwort, also das, was beim nächsten Turn wieder mitgeschickt wird) gegen
 * das Kontextfenster des Modells. `null` = Modell/Kontextfenster unbekannt — die UI zeigt dann
 * "unbekannt" statt einer Zahl (nie schätzen).
 */
export function computeContextPct(usage: { input: number; cacheRead: number; cacheCreation: number } | null, model: string | null, liveWindow: number | null | undefined, table: ModelPrice[] = BUILTIN_MODEL_PRICES): number | null {
  if (!usage) return null;
  const { window } = resolveContextWindow(model, liveWindow, table);
  if (!window) return null;
  const used = usage.input + usage.cacheRead + usage.cacheCreation;
  return Math.round((used / window) * 1000) / 10; // eine Nachkommastelle
}

export function findPrice(model: string, table: ModelPrice[] = BUILTIN_MODEL_PRICES): ModelPrice | undefined {
  return table.find((p) => p.model === model);
}

/** Eimer für Sessions außerhalb der Projektordner — bewusst EIN fester Wert ohne Namen oder Pfad
 * (fremde Projekte erscheinen nur als Summe). */
export const USAGE_OTHER_PROJECT = "andere";
/** Eimer, wenn eine erfasste Session keinen Projektnamen mitbringt (z. B. OTel ohne bekannte Session). */
export const USAGE_UNKNOWN_PROJECT = "projekt";

/**
 * Eine Zeile, die die Brücke an `POST /ingest/usage` schickt ("alle Projekte, aber ohne Inhalte"):
 * NUR Zeit/Werkzeug/Modell/Projekt-Eimer/Tokenzahlen — kein Titel, kein Pfad, kein Text. `project`:
 * Name des Projekts (Ordnername des Repos) für Sessions in den Projektordnern, sonst
 * `USAGE_OTHER_PROJECT`. `sessionKey` nur bei erfassten Projekten gesetzt.
 */
export const UsageIngestRowSchema = z.object({
  ts: z.iso.datetime({ offset: true }),
  tool: z.enum(["claude", "codex"]),
  model: z.string().nullable(),
  project: z.string().trim().min(1).max(200),
  sessionKey: z.string().nullable(),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation5m: z.number().int().nonnegative(),
  cacheCreation1h: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  /** Stabile Herkunfts-ID der Quellzeile (Claude: `message.id`) — `null` bei Codex/OTel, wo es keine
   * gibt. Grund (Fund NUTZUNG-BEFUND.md "Sub-Agent-Duplikate"): ein Subagent-Verlauf (Claude Code
   * Task-Tool) wiederholt die geerbte Eltern-Antwort samt `usage` wortgleich, aber mit der EIGENEN
   * Aufruf-Zeit statt der ursprünglichen `timestamp` — ein Schlüssel aus `(ts, Zahlen)` dedupliziert
   * das dann NICHT (verschiedene `ts`), `message.id` bleibt aber global stabil. `usageEventId`
   * (apps/server/src/usage/ingest.ts) nutzt sie bevorzugt, alte Bestandsdaten ohne das Feld gelten
   * als `null` (kein Bruch beim Rollout). */
  sourceId: z.string().nullable().default(null),
});
export type UsageIngestRow = z.infer<typeof UsageIngestRowSchema>;

export const UsageIngestBatchSchema = z.object({ items: z.array(UsageIngestRowSchema).min(1).max(2000) });
export type UsageIngestBatch = z.infer<typeof UsageIngestBatchSchema>;
