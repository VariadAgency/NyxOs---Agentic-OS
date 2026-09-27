// Datenschutz-Extraktor für die Nutzungs-Zahlen ("Alle Projekte, aber ohne
// Inhalte"): liest aus einer JSONL-Zeile NUR Modell, Zeitstempel und Token-Zahlen — nie
// Nachrichtentext, nie Werkzeug-Ziele, nie Dateipfade. Damit ist strukturell ausgeschlossen, dass
// ein fremdes Projekt (außerhalb der Projektordner) Inhalte oder Titel in die NyxOS schickt, auch
// wenn der Aufrufer (Bestand-Scan der Brücke) beliebige Projekte einliest. Rechenweise wie
// `packages/shared/src/parse/claude.ts`/`codex.ts` (dieselbe Quelle, s. NOTICE), hier bewusst
// eigenständig gehalten, damit dieser Pfad nie versehentlich Inhalte mitzieht.
import { isObj, isoTs, parseJsonLine, str } from "./common.js";

export interface UsageRow {
  ts: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  reasoning: number;
  /** Nur Codex: Kontextfenster, das die Session selbst meldet (`token_count.model_context_window`). */
  liveContextWindow: number | null;
  /** Stabile Herkunfts-ID (Claude: `message.id`, global eindeutig) — `null` bei Codex. S.
   * `UsageIngestRowSchema` (packages/shared/src/usage.ts) für den Grund. */
  sourceId: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Eine Claude-JSONL-Zeile → Nutzungszeile, oder `null` (keine `assistant`-Nachricht mit Nutzung).
 * `previousMessageId`: die `message.id` der zuletzt verarbeiteten Zeile — mehrere Inhaltsblöcke
 * derselben Antwort stehen als mehrere, unmittelbar aufeinanderfolgende Zeilen mit IDENTISCHER
 * `usage` (Claude wiederholt sie je Block); ohne diese Sperre würde eine mehrteilige Antwort
 * mehrfach gezählt. Liefert die neue `lastMessageId` zum Weiterreichen an den nächsten Aufruf.
 */
export function extractClaudeUsageLine(line: string, previousMessageId: string | null): { row: UsageRow | null; lastMessageId: string | null } {
  const o = parseJsonLine(line);
  if (!o || o.type !== "assistant") return { row: null, lastMessageId: previousMessageId };
  const msg = isObj(o.message) ? o.message : {};
  const messageId = str(msg.id);
  const ts = isoTs(o.timestamp);
  const u = isObj(msg.usage) ? msg.usage : null;
  if (!ts || !u || !messageId || messageId === previousMessageId) return { row: null, lastMessageId: messageId ?? previousMessageId };
  const cc = isObj(u.cache_creation) ? u.cache_creation : null;
  const cc1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const cc5m = cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const model = str(msg.model);
  return {
    lastMessageId: messageId,
    row: {
      ts,
      model: model && model !== "<synthetic>" ? model : null,
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreation5m: cc5m,
      cacheCreation1h: cc1h,
      reasoning: num(details.thinking_tokens),
      liveContextWindow: null,
      sourceId: messageId,
    },
  };
}

/** Roh-Zählwerte aus `token_count.info.{total,last}_token_usage` — dieselben 6 Felder, die Codex in
 * beiden Objekten meldet (s. `extractCodexUsageLine`). */
export interface CodexRawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function codexRawUsage(v: unknown): CodexRawUsage | null {
  if (!isObj(v)) return null;
  return {
    input_tokens: num(v.input_tokens),
    cached_input_tokens: num(v.cached_input_tokens),
    cache_write_input_tokens: num(v.cache_write_input_tokens),
    output_tokens: num(v.output_tokens),
    reasoning_output_tokens: num(v.reasoning_output_tokens),
    total_tokens: num(v.total_tokens),
  };
}

function sameCodexRawUsage(a: CodexRawUsage | null, b: CodexRawUsage | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.cache_write_input_tokens === b.cache_write_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens &&
    a.total_tokens === b.total_tokens
  );
}

function subtractCodexRawUsage(total: CodexRawUsage, previous: CodexRawUsage | null): CodexRawUsage {
  const p = previous ?? { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const diff = (a: number, b: number) => Math.max(0, a - b);
  return {
    input_tokens: diff(total.input_tokens, p.input_tokens),
    cached_input_tokens: diff(total.cached_input_tokens, p.cached_input_tokens),
    cache_write_input_tokens: diff(total.cache_write_input_tokens, p.cache_write_input_tokens),
    output_tokens: diff(total.output_tokens, p.output_tokens),
    reasoning_output_tokens: diff(total.reasoning_output_tokens, p.reasoning_output_tokens),
    total_tokens: diff(total.total_tokens, p.total_tokens),
  };
}

/**
 * Eine Codex-JSONL-Zeile → Nutzungszeile, oder `null`. Nutzt `last_token_usage` (die Zahlen NUR der
 * letzten Antwort, nicht die Summe der ganzen Session — von Codex selbst so geliefert) statt eines
 * eigenen Delta aus den kumulativen Zahlen. `currentModel`: das zuletzt aus `turn_context` gesehene
 * Modell (Codex trägt es nicht im `token_count`-Ereignis selbst).
 *
 * **Fund NUTZUNG-BEFUND.md** ("Codex weicht ~5–7 % nach oben ab"): Codex meldet `token_count` sehr
 * oft — auch mit `last_token_usage`, das exakt eine vorherige Meldung wiederholt, OHNE dass sich das
 * kumulative `total_token_usage` der Session verändert hat (kein neuer echter Turn, z. B. ein
 * Limit-Update). Ein erster Versuch, exakt wiederholte `last_token_usage`-WERTE zu verwerfen, hat
 * weit MEHR entfernt als vermutet (40–70 % zu wenig statt 5–7 % zu viel) — echte, zufällig gleich
 * große Antworten in einer engen Tool-Schleife sehen genauso aus. Die richtige Unterscheidung ist
 * darum nicht "ist `last_token_usage` identisch?", sondern "hat sich das KUMULATIVE
 * `total_token_usage` seit dem letzten `token_count`-Ereignis dieser Session überhaupt bewegt?" —
 * exakt das Muster aus der ccusage-Referenzquelle (Rust, `rust/adapters/codex/src/parser.rs`,
 * `cumulative_advanced`, s. NOTICE): nur wenn der kumulative Zähler weitergerückt ist, zählt
 * `last_token_usage`; sonst gilt die Zeile als Wiederholung (0 Tokens neu), mit einem Rückfall auf
 * `total_token_usage`-Differenz, falls `last_token_usage` ausnahmsweise fehlt. Gegen echte
 * `~/.codex/sessions`-Verläufe geprüft: trifft ccusage an allen 4 bekannten Tagen exakt (s. Bericht).
 * `previousTotals`: das zuletzt gesehene `total_token_usage` DIESER Session (vom Aufrufer je Datei
 * neu mit `null` gestartet, wie `currentModel`).
 */
export function extractCodexUsageLine(
  line: string,
  currentModel: string | null,
  previousTotals: CodexRawUsage | null,
): { row: UsageRow | null; previousTotals: CodexRawUsage | null } {
  const o = parseJsonLine(line);
  if (!o || o.type !== "event_msg") return { row: null, previousTotals };
  const p = isObj(o.payload) ? o.payload : {};
  if (p.type !== "token_count") return { row: null, previousTotals };
  const ts = isoTs(o.timestamp);
  const info = isObj(p.info) ? p.info : null;
  const totalUsage = info ? codexRawUsage(info.total_token_usage) : null;
  const cumulativeAdvanced = totalUsage === null || !sameCodexRawUsage(totalUsage, previousTotals);
  const nextTotals = totalUsage ?? previousTotals;
  if (!ts || !info) return { row: null, previousTotals: nextTotals };
  const lastUsage = cumulativeAdvanced ? codexRawUsage(info.last_token_usage) : null;
  const raw = lastUsage ?? (totalUsage ? subtractCodexRawUsage(totalUsage, previousTotals) : null);
  if (!raw) return { row: null, previousTotals: nextTotals };
  if (raw.input_tokens === 0 && raw.cached_input_tokens === 0 && raw.cache_write_input_tokens === 0 && raw.output_tokens === 0 && raw.reasoning_output_tokens === 0) {
    return { row: null, previousTotals: nextTotals };
  }
  const input = raw.input_tokens;
  const cached = Math.min(raw.cached_input_tokens, input);
  const written = Math.min(raw.cache_write_input_tokens, input - cached);
  const liveWindow = num(info.model_context_window);
  return {
    previousTotals: nextTotals,
    row: {
      ts,
      model: currentModel,
      input: input - cached - written,
      output: raw.output_tokens,
      cacheRead: cached,
      cacheCreation5m: written,
      cacheCreation1h: 0,
      reasoning: raw.reasoning_output_tokens,
      liveContextWindow: liveWindow > 0 ? liveWindow : null,
      sourceId: null,
    },
  };
}

/** Aus einer Codex-Zeile nur das Modell (für `extractCodexUsageLine`s `currentModel`), oder `null`. */
export function extractCodexModelLine(line: string): string | null {
  const o = parseJsonLine(line);
  if (!o || o.type !== "turn_context") return null;
  const p = isObj(o.payload) ? o.payload : {};
  return str(p.model);
}
