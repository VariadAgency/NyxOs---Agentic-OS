// `GET /api/sessions/:id/transcript`: liest das gzip-Archiv einer Session serverseitig,
// baut daraus einen lesbaren Chat-Verlauf und liefert ihn seitenweise über einen Cursor.
//
// Entwurfsentscheidungen (siehe Bericht):
// - Streamend entpacken: `createGunzip()` + `readline` — nie der ganze entpackte Text auf einmal
//   im Speicher, nur die daraus abgeleiteten, schlanken `TranscriptItem`s.
// - Wiederverwendung der vorhandenen Parser (`ClaudeSessionParser`/`CodexSessionParser`) aus
//   `packages/shared`, damit Codex und Claude über dasselbe `SessionEvent`-Vokabular laufen.
//   Zusätzlich lesen wir dieselbe Zeile noch einmal roh (nur `parseJsonLine`), um bei Claude
//   `toolUseResult.agentId` zu sehen — das hält der Parser intern, gibt es aber nicht als Event
//   heraus. So werden Task/Agent-Aufrufe zu `role: "subagent"`-Blöcken aufgelöst.
// - Cursor = eine Positions-Grenze (Index in der aufgebauten Liste), keine Zeilennummer der
//   Rohdatei. Da jede neue Archiv-Fassung nur anhängt (JSONL wächst), bleiben alte Positionen
//   gültig: eine gespeicherte Grenze zeigt nach einem Wachstum einfach auf denselben Eintrag,
//   plus die neu hinzugekommenen danach.
// - Cache: ein LRU über **Sitzungs-Identität** (`tool:sessionId:subagentId`), pro Eintrag mit der
//   Prüfsumme der zuletzt geparsten Fassung. Bei Treffer + gleicher Prüfsumme: sofort aus dem
//   Speicher. Bei Treffer + neuer Prüfsumme: einmal neu parsen (die ganze Datei — ein eigenes
//   Fortsetzen ist bei gzip ohne Sprungmarken nicht günstiger) und den Eintrag ersetzen. So bleibt
//   eine laufende, alle ≤ 30 s nachgezogene Session in genau einem Cache-Platz, statt bei jedem
//   Wachstum einen neuen zu belegen (anders als ein reines Prüfsummen-Schlüssel-LRU).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import {
  ClaudeSessionParser,
  CodexSessionParser,
  codexSessionIdFromPath,
  isObj,
  parseJsonLine,
  str,
  truncate,
  TRANSCRIPT_DEFAULT_LIMIT,
  TRANSCRIPT_MAX_LIMIT,
  type EventKind,
  type Json,
  type SessionEvent,
  type Tool,
  type TranscriptDirection,
  type TranscriptItem,
  type TranscriptResponse,
  type TranscriptToolStatus,
} from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { archive, sessions } from "./db/schema.js";

export { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT };

/** Werkzeuge, deren Ergebnis-Zeile Claude als Sub-Agent-Aufruf markiert (siehe `resolveClaudeAgentId`). */
const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const SUBAGENT_PATH_RE = /\/subagents\/agent-([A-Za-z0-9_-]+)\.jsonl$/;
/** Ziel eines Werkzeug-Aufrufs im Verlauf (Datei/Befehl): auf diese Länge gekürzt, s. Auftrag. */
const TARGET_MAX = 200;

function extractAgentId(path: string): string | null {
  return SUBAGENT_PATH_RE.exec(path)?.[1] ?? null;
}

function claudeMainFile(path: string, sessionId: string): boolean {
  return path.split("/").pop() === `${sessionId}.jsonl`;
}

/** Wirft `readGzLines`, wenn die Datei zwischen DB-Lesen und Öffnen verschwunden/ersetzt wurde
 * (ENOENT) oder kaputt ist (z. B. mitten im Schreiben gelesen) — s. `readGzLines`. */
export class TranscriptReadError extends Error {}

// ---------------------------------------------------------------------------------------------
// Streamendes Lesen: gzip → Zeilen, ohne den entpackten Text als Ganzes zu halten.
// ---------------------------------------------------------------------------------------------

/**
 * Live-Absturz-Fund (Prüfer): `.pipe()` reicht Fehler des Quell-Streams NICHT an das Ziel weiter —
 * ein `createReadStream`-Fehler (z. B. ENOENT, weil `recordArchive` die alte Fassung gelöscht hat,
 * während diese Anfrage noch den alten `storedPath` aus der DB in der Hand hielt) landet dann als
 * unbehandeltes `error`-Event und reißt den GANZEN Node-Prozess mit (kein `for await`/try-catch
 * fängt das ab). Fix: eigene `error`-Listener auf beiden Streams, die die Zeilen-Schleife sauber
 * beenden (`rl.close()`) und den Fehler danach als normale Exception werfen — der Aufrufer
 * (`getSessionTranscript`) fängt ihn und versucht es einmal mit der aktuellen DB-Fassung erneut.
 */
export async function* readGzLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path);
  const gunzip = createGunzip();
  const piped = input.pipe(gunzip);
  const rl = createInterface({ input: piped, crlfDelay: Infinity });
  const state: { captured: Error | null } = { captured: null };
  const onError = (e: Error) => {
    state.captured ??= e;
    rl.close(); // sonst hängt `for await` unten: ein Fehler auf `input` beendet `piped` nie von selbst
  };
  input.on("error", onError);
  gunzip.on("error", onError);
  try {
    for await (const line of rl) yield line;
  } catch (e) {
    // `gunzip`s eigener Fehler wird von readline z. T. direkt als Rejection der Zeilen-Schleife
    // durchgereicht (anders als `input`s Fehler, s. o.) — hier ebenfalls einheitlich einpacken.
    throw new TranscriptReadError(e instanceof Error ? e.message : String(e), { cause: e });
  } finally {
    input.off("error", onError);
    gunzip.off("error", onError);
    input.destroy();
    gunzip.destroy();
  }
  const captured = state.captured;
  if (captured) throw new TranscriptReadError(captured.message, { cause: captured });
}

// ---------------------------------------------------------------------------------------------
// SessionEvent → TranscriptItem (Claude)
// ---------------------------------------------------------------------------------------------

function systemText(kind: EventKind, data: Record<string, unknown>): string | null {
  if (kind === "compaction") return "Kontext komprimiert";
  if (kind === "attachment") return typeof data.attachmentType === "string" ? `Anhang: ${data.attachmentType}` : "Anhang";
  if (data.meta === true) return "Interner Hinweis";
  if (data.tagged === true) return "Formatierter Hinweis";
  if (typeof data.subtype === "string" && data.subtype) return `System: ${data.subtype}`;
  if (typeof data.itemType === "string" && data.itemType) return `System: ${data.itemType}`;
  if (typeof data.recordType === "string" && data.recordType) return `System: ${data.recordType}`;
  return null;
}

function promptText(data: Record<string, unknown>): string {
  if (typeof data.text === "string" && data.text.length > 0) return data.text;
  if (typeof data.command === "string" && data.command.length > 0) {
    const args = typeof data.args === "string" ? data.args : "";
    return args ? `/${data.command} ${args}` : `/${data.command}`;
  }
  return "";
}

function pushUser(items: TranscriptItem[], ev: SessionEvent, text: string): void {
  items.push({ id: ev.id, ts: ev.ts, role: "user", ...(text ? { text } : {}), thinking: false });
}

function pushAssistant(items: TranscriptItem[], ev: SessionEvent, text: string): void {
  items.push({ id: ev.id, ts: ev.ts, role: "assistant", ...(text ? { text } : {}), thinking: false });
}

/** `internal`: `kind === "compaction"` ("Kontext komprimiert") bleibt immer
 * sichtbar, jede andere System-Zeile (Anhang/Meta-Plumbing) ist Kandidat zum Einklappen im Web. */
function pushSystem(items: TranscriptItem[], ev: SessionEvent, text: string | null, kind: EventKind): void {
  if (!text) return;
  items.push({ id: ev.id, ts: ev.ts, role: "system", text, internal: kind !== "compaction", thinking: false });
}

/** Liest — parallel zum Parser — ob diese Zeile ein Tool-Ergebnis mit `toolUseResult.agentId` ist. */
function extractToolResultAgentId(raw: Json): { toolUseId: string; agentId: string } | null {
  if (raw.type !== "user") return null;
  const msg = isObj(raw.message) ? raw.message : null;
  const content = msg?.content;
  if (!Array.isArray(content)) return null;
  const result = content.find((b) => isObj(b) && b.type === "tool_result");
  if (!isObj(result)) return null;
  const toolUseId = str(result.tool_use_id);
  const tur = isObj(raw.toolUseResult) ? raw.toolUseResult : null;
  const agentId = tur ? str(tur.agentId) : null;
  return toolUseId && agentId ? { toolUseId, agentId } : null;
}

/** Löst einen vorgemerkten Task/Agent-Aufruf zu einem Sub-Agent-Block auf, bevor sein `tool_result` verarbeitet wird. */
function resolveClaudeAgentId(items: TranscriptItem[], pending: Map<string, number>, raw: Json): void {
  const found = extractToolResultAgentId(raw);
  if (!found) return;
  const idx = pending.get(found.toolUseId);
  if (idx === undefined) return;
  const item = items[idx];
  if (!item?.tool || !AGENT_TOOL_NAMES.has(item.tool.name)) return;
  items[idx] = { id: item.id, ts: item.ts, role: "subagent", subagent: { id: found.agentId, title: item.tool.target ?? null, count: 0 }, thinking: false };
  pending.delete(found.toolUseId);
}

function appendClaudeEvent(items: TranscriptItem[], pending: Map<string, number>, ev: SessionEvent): void {
  if (ev.source === "hook") return; // Lebenszeichen, kein Chat-Inhalt
  const data = ev.data as Record<string, unknown>;
  switch (ev.kind) {
    case "thinking":
      return; // nie ausliefern
    case "prompt":
      pushUser(items, ev, promptText(data));
      return;
    case "assistant":
      pushAssistant(items, ev, typeof data.text === "string" ? data.text : "");
      return;
    case "tool_call": {
      const name = typeof data.name === "string" ? data.name : "unbekannt";
      const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : null;
      const target = typeof data.target === "string" ? truncate(data.target, TARGET_MAX) : null;
      items.push({ id: ev.id, ts: ev.ts, role: "tool", tool: { name, ...(target ? { target } : {}) }, thinking: false });
      if (toolUseId) pending.set(toolUseId, items.length - 1);
      return;
    }
    case "tool_result": {
      const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : null;
      if (!toolUseId) return;
      const idx = pending.get(toolUseId);
      if (idx === undefined) return;
      const item = items[idx];
      if (item?.tool) item.tool.status = data.isError === true ? "error" : "ok";
      pending.delete(toolUseId);
      return;
    }
    case "system":
    case "attachment":
    case "compaction":
      pushSystem(items, ev, systemText(ev.kind, data), ev.kind);
      return;
    default:
      return; // hook/turn_*/session_meta: keine Chat-Inhalte
  }
}

/** nur echte Rasterbilder ausliefern (SVG kann Skript enthalten). */
export const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Bilder in des Nutzers EIGENER Eingabe (Claude-Zeile `type: "user"` mit Inhalts-Blöcken, kein Werkzeug-Ergebnis,
 * keine Meta-Zeile). Werkzeug-Ergebnisse (z. B. Screenshots, die Claude selbst macht) zählen nicht.
 */
export function claudePromptImages(raw: Json): { mediaType: string; data: string }[] {
  if (raw.type !== "user" || raw.isMeta === true) return [];
  const msg = isObj(raw.message) ? raw.message : null;
  const content = msg?.content;
  if (!Array.isArray(content)) return [];
  const blocks = content.filter(isObj);
  if (blocks.some((b) => b.type === "tool_result")) return [];
  const out: { mediaType: string; data: string }[] = [];
  for (const b of blocks) {
    if (b.type !== "image" || !isObj(b.source) || b.source.type !== "base64") continue;
    const mediaType = str(b.source.media_type);
    const data = str(b.source.data);
    if (mediaType && data && CHAT_IMAGE_TYPES.has(mediaType)) out.push({ mediaType, data });
  }
  return out;
}

const base64Len = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

async function parseClaudeItems(lines: AsyncIterable<string>, sessionId: string): Promise<TranscriptItem[]> {
  // der Chat zeigt den VOLLEN Text (keine Event-Kürzung auf 2.000 Zeichen).
  const parser = new ClaudeSessionParser(sessionId, { textMax: null });
  const items: TranscriptItem[] = [];
  const pending = new Map<string, number>();
  for await (const line of lines) {
    const raw = parseJsonLine(line);
    // Reihenfolge wichtig: erst zu Sub-Agent auflösen (braucht den noch offenen Eintrag),
    // danach den `tool_result`-Event verarbeiten (der ihn sonst als normales Werkzeug schließt).
    if (raw && isObj(raw)) resolveClaudeAgentId(items, pending, raw);
    for (const ev of parser.push(line)) appendClaudeEvent(items, pending, ev);
    // mitgeschickte Bilder am Nutzer-Eintrag vermerken (nur Kennzahlen, nie die Daten).
    if (raw && isObj(raw) && raw.type === "user") {
      const last = items[items.length - 1];
      const uuid = str(raw.uuid);
      if (last?.role === "user" && uuid && last.id === `claude:${sessionId}:${uuid}`) {
        const imgs = claudePromptImages(raw);
        if (imgs.length > 0) last.images = imgs.map((img, i) => ({ n: i + 1, mediaType: img.mediaType, bytes: base64Len(img.data) }));
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// SessionEvent → TranscriptItem (Codex)
// ---------------------------------------------------------------------------------------------

function toolStatusFromExitCode(exitCode: unknown): TranscriptToolStatus | undefined {
  return typeof exitCode === "number" ? (exitCode === 0 ? "ok" : "error") : undefined;
}

function appendCodexEvent(items: TranscriptItem[], pendingAgents: Map<string, number>, ev: SessionEvent): void {
  if (ev.source === "hook") return;
  const data = ev.data as Record<string, unknown>;
  switch (ev.kind) {
    case "thinking":
      return;
    case "prompt":
      pushUser(items, ev, typeof data.text === "string" ? data.text : "");
      return;
    case "assistant":
      pushAssistant(items, ev, typeof data.text === "string" ? data.text : "");
      return;
    case "tool_call": {
      const name = typeof data.name === "string" ? data.name : "unbekannt";
      const target = typeof data.target === "string" ? truncate(data.target, TARGET_MAX) : null;
      const status = toolStatusFromExitCode(data.exitCode);
      items.push({ id: ev.id, ts: ev.ts, role: "tool", tool: { name, ...(target ? { target } : {}), ...(status ? { status } : {}) }, thinking: false });
      return;
    }
    case "subagent": {
      const agentId = typeof data.agentId === "string" ? data.agentId : null;
      if (!agentId) return;
      const idx = pendingAgents.get(agentId);
      if (idx !== undefined) {
        const item = items[idx];
        if (item?.subagent) item.subagent.count += 1;
        return;
      }
      const agentPath = typeof data.agentPath === "string" ? data.agentPath : null;
      const title = agentPath ? (agentPath.split("/").pop() ?? agentPath) : null;
      items.push({ id: ev.id, ts: ev.ts, role: "subagent", subagent: { id: agentId, title, count: 1 }, thinking: false });
      pendingAgents.set(agentId, items.length - 1);
      return;
    }
    case "system":
    case "compaction":
      pushSystem(items, ev, systemText(ev.kind, data), ev.kind);
      return;
    default:
      return; // hook/turn_*/session_meta: keine Chat-Inhalte
  }
}

async function parseCodexItems(lines: AsyncIterable<string>, sessionId: string): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = [];
  const pendingAgents = new Map<string, number>();
  // Die Sitzungs-Id muss stimmen: der Parser verwirft sonst jede Zeile mit `payload.thread_id`
  // (praktisch jedes `item_completed`), weil er sie für eine fremde Session hält.
  const parser = new CodexSessionParser(sessionId, { textMax: null });
  for await (const line of lines) for (const ev of parser.push(line)) appendCodexEvent(items, pendingAgents, ev);
  return items;
}

// ---------------------------------------------------------------------------------------------
// Cache: LRU über Sitzungs-Identität, je Eintrag gültig für eine Prüfsumme (s. Modul-Kommentar).
// ---------------------------------------------------------------------------------------------

interface CacheEntry {
  sha256: string;
  items: TranscriptItem[];
}

export class TranscriptCache {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly maxEntries = 8) {}

  get(key: string, sha256: string): TranscriptItem[] | null {
    const hit = this.map.get(key);
    if (!hit || hit.sha256 !== sha256) return null;
    this.map.delete(key);
    this.map.set(key, hit); // an das Ende (zuletzt genutzt)
    return hit.items;
  }

  set(key: string, sha256: string, items: TranscriptItem[]): void {
    this.map.delete(key);
    this.map.set(key, { sha256, items });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

async function loadItems(cache: TranscriptCache, key: string, tool: Tool, sessionId: string, storedPath: string, sha256: string): Promise<TranscriptItem[]> {
  const cached = cache.get(key, sha256);
  if (cached) return cached;
  const lines = readGzLines(storedPath);
  const items = tool === "claude" ? await parseClaudeItems(lines, sessionId) : await parseCodexItems(lines, sessionId);
  cache.set(key, sha256, items);
  return items;
}

// ---------------------------------------------------------------------------------------------
// Cursor: eine Positions-Grenze in der aufgebauten Liste (s. Modul-Kommentar oben).
// ---------------------------------------------------------------------------------------------

function encodeCursor(pos: number): string {
  return Buffer.from(JSON.stringify({ pos })).toString("base64url");
}

function decodeCursor(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (isObj(parsed) && typeof parsed.pos === "number" && Number.isInteger(parsed.pos) && parsed.pos >= 0) return parsed.pos;
    return null;
  } catch {
    return null;
  }
}

export interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
}

/**
 * Schneidet eine Seite aus der (schon fertig aufgebauten) Liste. `pos` ist eine Grenze zwischen
 * zwei Einträgen, kein Zeilenindex innerhalb der Seite — `forward` liest ab `pos`, `backward`
 * bis ausschließlich `pos`. Beide zurückgegebenen Cursor sind wieder Grenzen und funktionieren
 * mit jeder Richtung, nicht nur der zuletzt genutzten.
 */
export function paginateTranscript(items: TranscriptItem[], opts: { cursor: string | null; limit: number; direction: TranscriptDirection }): TranscriptPage | "bad_cursor" {
  const total = items.length;
  let pos: number;
  if (opts.cursor === null) {
    pos = opts.direction === "backward" ? total : 0;
  } else {
    const decoded = decodeCursor(opts.cursor);
    if (decoded === null) return "bad_cursor";
    // Zeilennummern bleiben über eine neue, gewachsene Fassung hinweg gültig (JSONL wächst nur
    // an); eine Grenze jenseits des aktuellen Endes wird auf das Ende gekappt statt abgelehnt.
    pos = Math.min(decoded, total);
  }

  if (opts.direction === "forward") {
    const end = Math.min(pos + opts.limit, total);
    return {
      items: items.slice(pos, end),
      prevCursor: pos > 0 ? encodeCursor(pos) : null,
      nextCursor: end < total ? encodeCursor(end) : null,
      total,
    };
  }
  const start = Math.max(pos - opts.limit, 0);
  return {
    items: items.slice(start, pos),
    prevCursor: start > 0 ? encodeCursor(start) : null,
    nextCursor: pos < total ? encodeCursor(pos) : null,
    total,
  };
}

/**
 * Seite um eine bestimmte Position herum (Such-Sprung): `position` ist ein Eintrags-Index
 * in `items` (derselbe Index, den `search_docs.position` speichert — s. `search.ts`), keine
 * Cursor-Grenze. Zentriert die Seite möglichst mittig um diesen Eintrag (am Rand wird das Fenster
 * wieder auf `limit` aufgefüllt) und liefert zusätzlich `anchorIndex`: die Position des gesuchten
 * Eintrags *innerhalb* der zurückgegebenen `items`-Seite.
 */
export function paginateAroundTranscript(items: TranscriptItem[], opts: { position: number; limit: number }): (TranscriptPage & { anchorIndex: number }) | "bad_position" {
  const total = items.length;
  if (!Number.isInteger(opts.position) || opts.position < 0 || opts.position >= total) return "bad_position";
  const half = Math.floor(opts.limit / 2);
  const start = Math.max(0, Math.min(opts.position - half, total - opts.limit));
  const end = Math.min(total, start + opts.limit);
  return {
    items: items.slice(start, end),
    prevCursor: start > 0 ? encodeCursor(start) : null,
    nextCursor: end < total ? encodeCursor(end) : null,
    total,
    anchorIndex: opts.position - start,
  };
}

// ---------------------------------------------------------------------------------------------
// Öffentliche Anfrage: Session/Archiv auflösen, Liste (ggf. aus dem Cache) holen, Seite schneiden.
// ---------------------------------------------------------------------------------------------

export interface TranscriptRequest {
  idOrUuid: string;
  cursor: string | null;
  limit: number;
  direction: TranscriptDirection;
  subagentId: string | null;
  /** P2-4b (Such-Sprung): Seite um diesen Eintrags-Index herum statt cursor/direction, s. `paginateAroundTranscript`. */
  around: number | null;
}

export type TranscriptResult =
  | { kind: "ok"; body: TranscriptResponse }
  | { kind: "not_found" }
  | { kind: "bad_cursor" }
  | { kind: "bad_position" }
  /** Live-Absturz-Fund: die Archiv-Datei wurde zwischen DB-Lesen und Öffnen durch eine neue
   * Fassung ersetzt, UND der einmalige Neuversuch mit der jetzt aktuellen Fassung ist ebenfalls
   * fehlgeschlagen (z. B. mitten im Schreiben gelesen) — s. `getSessionTranscript`. */
  | { kind: "conflict" };

type ArchiveRow = { path: string; sha256: string; storedPath: string; updatedAt: string };

async function fetchArchiveRows(db: Db, sessionKey: string): Promise<ArchiveRow[]> {
  return db.select({ path: archive.path, sha256: archive.sha256, storedPath: archive.storedPath, updatedAt: archive.updatedAt }).from(archive).where(eq(archive.sessionKey, sessionKey));
}

function resolveTarget(rows: ArchiveRow[], tool: Tool, sessionId: string, subagentId: string | null): ArchiveRow | undefined {
  return subagentId
    ? rows.find((r) => extractAgentId(r.path) === subagentId)
    : rows.find((r) => (tool === "claude" ? claudeMainFile(r.path, sessionId) : codexSessionIdFromPath(r.path) === sessionId));
}

/**
 * Trägt die Anzahl Einträge je Sub-Agent-Block nach — nur für die Blöcke, die auf DIESER Seite
 * tatsächlich sichtbar sind (nicht für den ganzen Verlauf: eine 75-MB-Session mit
 * 60 Sub-Agent-Dateien darf nicht bei jeder Seite alle 60 parsen). Nur Hauptverlauf, nur Claude —
 * Codex-Sub-Threads sind eigene Sessions, s. Modul-Kommentar. Läuft über einen eigenen,
 * größeren Cache (`subagentCache`), der nie den Hauptverlauf-Cache verdrängt.
 */
async function annotateSubagentCounts(
  pageItems: TranscriptItem[],
  subagentCache: TranscriptCache,
  sessionId: string,
  archiveRows: { path: string; sha256: string; storedPath: string }[],
): Promise<void> {
  for (const item of pageItems) {
    if (item.role !== "subagent" || !item.subagent) continue;
    const row = archiveRows.find((r) => extractAgentId(r.path) === item.subagent?.id);
    if (!row) continue;
    const subKey = `claude:${sessionId}:${item.subagent.id}`;
    try {
      const subItems = await loadItems(subagentCache, subKey, "claude", sessionId, row.storedPath, row.sha256);
      item.subagent.count = subItems.length;
    } catch (e) {
      // Nur die Anzahl-Anzeige betroffen (nicht der Chat-Inhalt selbst) — ein Lesefehler hier
      // (z. B. dieselbe Race wie beim Hauptverlauf) darf die ganze Seite nicht kaputt machen.
      if (!(e instanceof TranscriptReadError)) throw e;
    }
  }
}

export async function getSessionTranscript(db: Db, cache: TranscriptCache, subagentCache: TranscriptCache, req: TranscriptRequest): Promise<TranscriptResult> {
  const where = req.idOrUuid.includes(":") ? eq(sessions.id, req.idOrUuid) : eq(sessions.sessionId, req.idOrUuid);
  const [session] = await db.select({ id: sessions.id, tool: sessions.tool, sessionId: sessions.sessionId }).from(sessions).where(where).limit(1);
  if (!session) return { kind: "not_found" };
  const tool = session.tool as Tool;

  let rows = await fetchArchiveRows(db, session.id);
  if (rows.length === 0) return { kind: "not_found" };

  let target = resolveTarget(rows, tool, session.sessionId, req.subagentId);
  if (!target) return { kind: "not_found" };

  // nur der Hauptverlauf (und die Suche, s. `loadMainTranscriptItems`) belegt den
  // 8er-Cache `cache`. Ein expliziter Sub-Agent-Abruf (Reiter im Chat) läuft über den eigenen,
  // größeren `subagentCache` — so bleibt der Hauptverlauf danach weiter ein Cache-Treffer.
  const targetCache = req.subagentId ? subagentCache : cache;
  const cacheKey = `${tool}:${session.sessionId}:${req.subagentId ?? ""}`;
  let items: TranscriptItem[];
  try {
    items = await loadItems(targetCache, cacheKey, tool, session.sessionId, target.storedPath, target.sha256);
  } catch (e) {
    if (!(e instanceof TranscriptReadError)) throw e;
    // Live-Absturz-Fund (Prüfer): die Datei wurde zwischen DB-Lesen und Öffnen durch eine neue
    // Archiv-Fassung ersetzt/gelöscht (`recordArchive` löscht die alte erst, NACHDEM die DB schon
    // auf die neue zeigt — dazwischen kann eine laufende Anfrage noch den alten `storedPath`
    // halten). Einmal mit der jetzt aktuellen Fassung neu versuchen, statt die Anfrage kaputtgehen
    // zu lassen; scheitert auch das, sauber melden statt den Prozess mitzureißen.
    const freshRows = await fetchArchiveRows(db, session.id);
    const freshTarget = resolveTarget(freshRows, tool, session.sessionId, req.subagentId);
    if (!freshTarget) return { kind: "not_found" };
    try {
      items = await loadItems(targetCache, cacheKey, tool, session.sessionId, freshTarget.storedPath, freshTarget.sha256);
    } catch (e2) {
      if (!(e2 instanceof TranscriptReadError)) throw e2;
      return { kind: "conflict" };
    }
    rows = freshRows;
    target = freshTarget;
  }

  // P2-4b (Such-Sprung): `around` ersetzt cursor/direction, statt sie zu kombinieren.
  if (req.around !== null) {
    const around = paginateAroundTranscript(items, { position: req.around, limit: req.limit });
    if (around === "bad_position") return { kind: "bad_position" };
    if (!req.subagentId && tool === "claude") await annotateSubagentCounts(around.items, subagentCache, session.sessionId, rows);
    return {
      kind: "ok",
      body: {
        items: around.items,
        nextCursor: around.nextCursor,
        prevCursor: around.prevCursor,
        total: around.total,
        archivedAt: target.updatedAt,
        sha256: target.sha256,
        anchorIndex: around.anchorIndex,
      },
    };
  }

  const page = paginateTranscript(items, { cursor: req.cursor, limit: req.limit, direction: req.direction });
  if (page === "bad_cursor") return { kind: "bad_cursor" };
  if (!req.subagentId && tool === "claude") await annotateSubagentCounts(page.items, subagentCache, session.sessionId, rows);
  return {
    kind: "ok",
    body: { items: page.items, nextCursor: page.nextCursor, prevCursor: page.prevCursor, total: page.total, archivedAt: target.updatedAt, sha256: target.sha256 },
  };
}

/**
 * Lädt den Hauptverlauf (keine Sub-Agenten) einer Session für die Suche — dieselbe
 * Aufbau-Funktion wie oben, damit `position` exakt derselbe Index ist wie in `/transcript`.
 * `sessionKey` ist die interne ID (`<tool>:<sessionId>`), nicht die nackte UUID.
 */
export async function loadMainTranscriptItems(db: Db, cache: TranscriptCache, sessionKey: string): Promise<{ tool: Tool; sessionId: string; items: TranscriptItem[] } | null> {
  const [session] = await db.select({ tool: sessions.tool, sessionId: sessions.sessionId }).from(sessions).where(eq(sessions.id, sessionKey)).limit(1);
  if (!session) return null;
  const tool = session.tool as Tool;

  const rows = await db
    .select({ path: archive.path, sha256: archive.sha256, storedPath: archive.storedPath })
    .from(archive)
    .where(eq(archive.sessionKey, sessionKey));
  const target = rows.find((r) => (tool === "claude" ? claudeMainFile(r.path, session.sessionId) : codexSessionIdFromPath(r.path) === session.sessionId));
  if (!target) return null;

  const cacheKey = `${tool}:${session.sessionId}:`;
  const items = await loadItems(cache, cacheKey, tool, session.sessionId, target.storedPath, target.sha256);
  return { tool, sessionId: session.sessionId, items };
}

/**
 * ein Bild aus des Nutzers eigener Eingabe, direkt aus dem Archiv dieser Session (Hauptverlauf).
 * `itemId` ist die Eintrags-ID aus dem Verlauf (`claude:<sessionId>:<uuid>`), `n` zählt ab 1.
 * `null`, wenn es die Session, den Eintrag oder das Bild nicht gibt.
 */
export async function loadPromptImage(db: Db, idOrUuid: string, itemId: string, n: number): Promise<{ mediaType: string; data: Buffer } | null> {
  if (!Number.isInteger(n) || n < 1) return null;
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [session] = await db.select({ id: sessions.id, tool: sessions.tool, sessionId: sessions.sessionId }).from(sessions).where(where).limit(1);
  if (!session || session.tool !== "claude") return null;
  const prefix = `claude:${session.sessionId}:`;
  if (!itemId.startsWith(prefix)) return null;
  const uuid = itemId.slice(prefix.length);
  // leere ID passt auf JEDE Zeile (`includes("")`) → sonst würde das ganze Archiv geparst.
  if (!uuid) return null;
  const target = resolveTarget(await fetchArchiveRows(db, session.id), "claude", session.sessionId, null);
  if (!target) return null;
  try {
    for await (const line of readGzLines(target.storedPath)) {
      if (!line.includes(uuid)) continue;
      const raw = parseJsonLine(line);
      if (!raw || !isObj(raw) || str(raw.uuid) !== uuid) continue;
      const img = claudePromptImages(raw)[n - 1];
      return img ? { mediaType: img.mediaType, data: Buffer.from(img.data, "base64") } : null;
    }
  } catch (e) {
    if (e instanceof TranscriptReadError) return null;
    throw e;
  }
  return null;
}
