// Was hat welche Session an EINER Datei geändert? Quelle ist der archivierte Verlauf
// (gzip auf dem Volume): Claude `Edit`/`MultiEdit`/`Write`/`NotebookEdit` (mit `toolUseResult.
// structuredPatch` = echte Zeilennummern), Codex `FileChange` (unified diff). Nur lesend, streamend,
// mit Vorfilter (Zeile enthält den Pfad), damit große Verläufe nicht ganz geparst werden.
// abgelehnte/gescheiterte Edits zählen nicht (5), Umlaute in beiden Unicode-Formen
// bzw. als \u-Escape und Codex-Umbenennungen werden gefunden (10), gleiche Suchen laufen nur einmal
// und höchstens zwei gleichzeitig (9), der Zwischenspeicher ist nach Zeilen begrenzt (15).
import {
  addedLines,
  isObj,
  lineDiff,
  parseJsonLine,
  parseUnifiedDiff,
  removedLines,
  structuredPatchToLines,
  type DiffLine,
  type FileEdit,
  type Json,
  type SessionFileChanges,
  type StructuredHunk,
  t,
} from "@nyxos/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { archive, sessions } from "../db/schema.js";
import { readGzLines } from "../transcript.js";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_EDITS = 200;
const MAX_LINES_PER_EDIT = 4000;
/** Rückfall-Diff aus zwei Textständen auf dem Server: kleine Tabelle (synchron, blockiert sonst). */
const SERVER_LCS_CELLS = 250_000;
/** Zwischenspeicher: höchstens so viele Diff-Zeilen insgesamt. */
const CACHE_MAX_LINES = 200_000;
/** Höchstens so viele Verläufe gleichzeitig entpacken. */
const MAX_PARALLEL_SCANS = 2;

/** Archiv-Fassung (id + Prüfsumme) + Pfad → Änderungen. Neue Fassung = neuer Schlüssel. */
const cache = new Map<string, { edits: FileEdit[]; lines: number }>();
let cachedLines = 0;
const inflight = new Map<string, Promise<FileEdit[]>>();

function remember(key: string, edits: FileEdit[]): void {
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cachedLines -= old.lines;
  }
  const lines = edits.reduce((n, e) => n + e.lines.length, 0);
  if (lines > CACHE_MAX_LINES) return;
  cache.set(key, { edits, lines });
  cachedLines += lines;
  for (const [k, v] of cache) {
    if (cachedLines <= CACHE_MAX_LINES) break;
    cache.delete(k);
    cachedLines -= v.lines;
  }
}

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_SCANS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function cap(lines: DiffLine[]): { lines: DiffLine[]; truncated: boolean } {
  return lines.length > MAX_LINES_PER_EDIT ? { lines: lines.slice(0, MAX_LINES_PER_EDIT), truncated: true } : { lines, truncated: false };
}

function edit(at: string | null, tool: string, kind: FileEdit["kind"], exactLines: boolean, lines: DiffLine[]): FileEdit {
  return { at, tool, kind, exactLines, ...cap(lines) };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const samePath = (a: string | null, path: string): boolean => a !== null && a.normalize("NFC") === path;

/** Wie der Pfad in einer Rohzeile stehen kann: NFC/NFD, roh oder mit \u-Escapes (JSON). */
function needles(path: string): string[] {
  const out = new Set<string>();
  for (const form of [path.normalize("NFC"), path.normalize("NFD")]) {
    const json = JSON.stringify(form).slice(1, -1);
    out.add(json);
    out.add(json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  }
  return [...out];
}

interface PendingClaude {
  at: string | null;
  name: string;
  input: Json;
}

/** Rückfall ohne strukturiertes Ergebnis: aus der Eingabe (Zeilennummern nur im Ausschnitt). */
function fromInput(p: PendingClaude): FileEdit | null {
  const i = p.input;
  const diff = (a: string, b: string) => lineDiff(a, b, 1, SERVER_LCS_CELLS);
  if (p.name === "Write") return edit(p.at, p.name, "write", true, addedLines(str(i.content) ?? ""));
  if (p.name === "Edit") return edit(p.at, p.name, "edit", false, diff(str(i.old_string) ?? "", str(i.new_string) ?? ""));
  if (p.name === "MultiEdit" && Array.isArray(i.edits)) {
    const lines: DiffLine[] = [];
    for (const e of i.edits.filter(isObj)) lines.push({ kind: "hunk", oldNo: null, newNo: null, text: t("@@ Teiländerung @@") }, ...diff(str(e.old_string) ?? "", str(e.new_string) ?? ""));
    return edit(p.at, p.name, "edit", false, lines);
  }
  if (p.name === "NotebookEdit") return edit(p.at, p.name, "edit", false, addedLines(str(i.new_source) ?? ""));
  return null;
}

function fromResult(p: PendingClaude, result: Json): FileEdit | null {
  const patch = Array.isArray(result.structuredPatch) ? (result.structuredPatch.filter(isObj) as unknown as StructuredHunk[]) : [];
  if (result.type === "create") return edit(p.at, p.name, "create", true, addedLines(str(result.content) ?? str(p.input.content) ?? ""));
  if (patch.length > 0) return edit(p.at, p.name, p.name === "Write" ? "write" : "edit", true, structuredPatchToLines(patch));
  return fromInput(p);
}

async function claudeEdits(storedPath: string, path: string): Promise<FileEdit[]> {
  const find = needles(path);
  const pending = new Map<string, PendingClaude>();
  const out: FileEdit[] = [];
  for await (const line of readGzLines(storedPath)) {
    // Ergebnis-Zeilen enthalten den Pfad nicht immer (abgelehnt → nur Text) — die zu einem offenen
    // Aufruf gehören, müssen trotzdem gelesen werden.
    const hit = find.some((n) => line.includes(n));
    if (!hit && (pending.size === 0 || !line.includes('"tool_result"'))) continue;
    const obj = parseJsonLine(line);
    if (!isObj(obj)) continue;
    const at = str(obj.timestamp);
    const msg = isObj(obj.message) ? obj.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
    if (obj.type === "assistant") {
      for (const b of content) {
        if (b.type !== "tool_use" || !EDIT_TOOLS.has(str(b.name) ?? "")) continue;
        const input = isObj(b.input) ? b.input : {};
        if (!samePath(str(input.file_path), path) && !samePath(str(input.notebook_path), path)) continue;
        const id = str(b.id);
        if (id) pending.set(id, { at, name: str(b.name) ?? "Edit", input });
      }
    } else if (obj.type === "user") {
      for (const b of content) {
        const id = b.type === "tool_result" ? str(b.tool_use_id) : null;
        const p = id ? pending.get(id) : undefined;
        if (!id || !p) continue;
        pending.delete(id);
        // Abgelehnt oder gescheitert (Fehler-Ergebnis bzw. nur Text statt Ergebnis-Objekt): nichts geändert.
        if (b.is_error === true || !isObj(obj.toolUseResult)) continue;
        const e = fromResult(p, obj.toolUseResult);
        if (e) out.push(e);
      }
    }
  }
  // Aufrufe ohne jedes Ergebnis (Verlauf endet mittendrin) sind unsicher — bewusst nicht gezeigt.
  return out;
}

async function codexEdits(storedPath: string, path: string): Promise<FileEdit[]> {
  const find = needles(path);
  const out: FileEdit[] = [];
  for await (const line of readGzLines(storedPath)) {
    if (!find.some((n) => line.includes(n))) continue;
    const obj = parseJsonLine(line);
    if (!isObj(obj) || !isObj(obj.payload)) continue;
    const item = isObj(obj.payload.item) ? obj.payload.item : null;
    if (!item || item.type !== "FileChange" || !isObj(item.changes)) continue;
    // Direkt unter dem Pfad oder als Ziel einer Umbenennung (`move_path`).
    const match = Object.entries(item.changes).find(([p, c]) => samePath(p, path) || (isObj(c) && samePath(str(c.move_path), path)));
    const change = match?.[1];
    if (!isObj(change)) continue;
    const at = str(obj.timestamp);
    if (change.type === "add") out.push(edit(at, "apply_patch", "create", true, addedLines(str(change.content) ?? "")));
    else if (change.type === "delete") out.push(edit(at, "apply_patch", "delete", true, removedLines(str(change.content) ?? "")));
    else out.push(edit(at, "apply_patch", "patch", true, parseUnifiedDiff(str(change.unified_diff) ?? "").flatMap((f) => f.lines)));
  }
  return out;
}

function scan(row: { id: number; tool: string; sha256: string; storedPath: string }, path: string): Promise<FileEdit[]> {
  const key = `${row.id}:${row.sha256}:${path}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit.edits);
  const running = inflight.get(key);
  if (running) return running;
  const p = limited(() => (row.tool === "codex" ? codexEdits(row.storedPath, path) : claudeEdits(row.storedPath, path)))
    .catch(() => [] as FileEdit[]) // Fassung gerade ersetzt/kaputt — beim nächsten Abruf mit der neuen Fassung
    .then((edits) => {
      remember(key, edits);
      return edits;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Änderungen der genannten Sessions an `path`, in Reihenfolge der Sessions. */
export async function sessionFileEdits(db: Db, sessionKeys: string[], rawPath: string): Promise<SessionFileChanges[]> {
  if (sessionKeys.length === 0) return [];
  const path = rawPath.normalize("NFC");
  const [sessionRows, archiveRows] = await Promise.all([
    db.select({ id: sessions.id, title: sessions.title, tool: sessions.tool }).from(sessions).where(inArray(sessions.id, sessionKeys)),
    db.select({ id: archive.id, sessionKey: archive.sessionKey, tool: archive.tool, sha256: archive.sha256, storedPath: archive.storedPath }).from(archive).where(inArray(archive.sessionKey, sessionKeys)),
  ]);
  const out: SessionFileChanges[] = [];
  for (const key of sessionKeys) {
    const s = sessionRows.find((r) => r.id === key);
    const rows = archiveRows.filter((r) => r.sessionKey === key);
    const edits = (await Promise.all(rows.map((row) => scan(row, path)))).flat();
    edits.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    out.push({ sessionKey: key, title: s?.title ?? null, tool: s?.tool ?? null, edits: edits.slice(-MAX_EDITS), missingArchive: rows.length === 0 });
  }
  return out;
}
