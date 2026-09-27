// Digest je Archiv-Datei (Haupt-Verlauf oder `subagents/agent-*.jsonl`) — die Grundlage
// für „Geänderte Dateien" mit +/−, die Inhaltssuche im Reiter „Änderungen", die Agenten-Kacheln
// (Auftrag, Ergebnis, Tokens, Dauer, Werkzeuge) und die Bezüge „erledigt/behoben/offen".
//
// Entwurfsentscheidungen:
// - **Einmal rechnen, dann speichern** (`archive_digests` + `session_change_ops`): eine echte Session
//   hat 190 Sub-Agent-Dateien mit zusammen 318 MB — bei jedem Öffnen neu lesen wäre zu langsam. Der
//   Digest gilt, solange die Prüfsumme der Archiv-Fassung gleich bleibt; `DIGEST_VERSION` erzwingt
//   bei geänderter Auswertung ein Neurechnen beim nächsten Zugriff.
// - **Rechnen nach dem Upload** (Brücke lädt eine neue Fassung hoch → im Hintergrund, blockiert den
//   Upload nie) **und bei Bedarf** (Bestand ohne Digest, z. B. nach dem Deploy) — beide Wege teilen
//   sich eine Warteschlange je Archiv-Fassung (`DigestService.inflight`), damit nie doppelt gerechnet wird.
// - **Rohzeilen statt Parser-Events** für Auftrag/Ergebnis/Patches: die Parser-Events sind auf
//   `EVENT_TEXT_MAX` gekürzt und tragen keine Werkzeug-Eingaben. Tokens, Modelle, Werkzeug-Zähler und
//   Zeitraum kommen dagegen aus demselben Parser wie `sessions.*` (`ClaudeSessionParser`/
//   `CodexSessionParser`), damit die Zahlen mit Kopfzeile und Nutzung übereinstimmen.
import {
  ClaudeSessionParser,
  CodexSessionParser,
  codexSessionIdFromPath,
  isObj,
  isoTs,
  parseJsonLine,
  str,
  type AgentTokens,
  type AgentVerdict,
  type Json,
  type Tool,
} from "@nyxos/shared";
import { and, eq, sql } from "drizzle-orm";
import { detectVerdict } from "./agents/runs.js";
import type { Db } from "./db/client.js";
import { archive, archiveDigests, sessionChangeOps } from "./db/schema.js";
import { readGzLines, TranscriptReadError } from "./transcript.js";

/** Anheben, wenn sich die Auswertung ändert — gespeicherte Digests werden dann neu gerechnet. */
export const DIGEST_VERSION = 3;
/** Auftrag/Ergebnis: praktisch ungekürzt, nur gegen Ausreißer (ganze Dateien im Prompt) begrenzt. */
const LONG_TEXT_MAX = 200_000;
/** Text je Datei-Änderung für die Suche (s. `session_change_ops`). */
const OP_TEXT_MAX = 64_000;
const MAX_COMMITS = 200;
/** Länge von Auftrag/Ergebnis beim leichten Laden (Listen brauchen nur die erste Zeile). */
const LIGHT_TEXT_MAX = 400;
const MAX_TEST_RUNS = 300;

export interface DigestTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface DigestCommit {
  sha: string;
  subject: string;
  branch: string | null;
  ts: string | null;
}

export interface DigestTestRun {
  /** Vergleichsschlüssel (normalisierter Befehl) — rot → grün gilt nur für denselben Befehl. */
  key: string;
  command: string;
  ok: boolean;
  ts: string | null;
}

export interface ArchiveDigest {
  v: number;
  prompt: string | null;
  result: string | null;
  models: string[];
  tokens: AgentTokens | null;
  startedAt: string | null;
  endedAt: string | null;
  tools: Record<string, number>;
  toolErrors: number;
  /** Letzter Stand der Aufgabenliste (TodoWrite / Codex `update_plan`), `null` = nie benutzt. */
  todos: DigestTodo[] | null;
  commits: DigestCommit[];
  tests: DigestTestRun[];
  verdict: AgentVerdict | null;
}

export interface ChangeOp {
  filePath: string;
  tool: string;
  ts: string | null;
  added: number;
  removed: number;
  addedText: string;
  removedText: string;
}

// ---------------------------------------------------------------------------------------------
// Reine Helfer
// ---------------------------------------------------------------------------------------------

const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Test-Runner als AUSGEFÜHRTES Programm eines Befehls-Abschnitts (nicht irgendwo im Text — sonst
 * zählt z. B. ein `sed`, das eine Test-Datei bearbeitet, als Testlauf). */
const TEST_RUNNER = String.raw`(?:vitest|jest|playwright\s+test|pytest|go\s+test|cargo\s+test|swift\s+test|xcodebuild\b.*\btest\b)`;
const PKG_MANAGER = String.raw`(?:npx|pnpm|npm|yarn|bun|bunx)(?:\s+(?:exec|run|dlx|-r|--recursive|--filter[= ]\S+|-F\s+\S+|--dir[= ]\S+|-C\s+\S+|--project\s+\S+))*`;
const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const TEST_SEGMENT_RE = new RegExp(String.raw`^\s*${ENV_PREFIX}(?:(?:${PKG_MANAGER}\s+)?${TEST_RUNNER}\b|${PKG_MANAGER}\s+(?:test|e2e)\b)`);

/** Ist einer der Abschnitte (`&&`, `||`, `;`, `|`, Zeilenumbruch) ein Test-Lauf? Liefert ihn zurück. */
export function testSegment(command: string): string | null {
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    if (TEST_SEGMENT_RE.test(seg)) return seg.trim();
  }
  return null;
}

/** Deutliche Fehl-Signale in der Ausgabe eines Test-Laufs. */
const TEST_FAIL_RE = /\b[1-9]\d* (?:failed|failing)\b|^\s*FAIL\b|\bTests? failed\b|\*\* TEST FAILED \*\*|\bFAILED\b/m;
const GIT_COMMIT_RE = /\bgit\b(?:\s+-C\s+\S+)?[^\n|;&]*?\bcommit\b/;
/** `[main abc1234] Betreff` bzw. `[main (root-commit) abc1234] Betreff`. */
const COMMIT_LINE_RE = /^\[(\S+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;

function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Zeilen eines ganzen Datei-Inhalts (ohne leere Schlusszeile). */
function textLines(s: string): string[] {
  return s ? s.replace(/\n$/, "").split("\n") : [];
}

/** Zeilen-Diff ohne LCS: gemeinsamen Anfang und gemeinsames Ende abschneiden, der Rest ist geändert. */
function trimmedDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { removed: a.slice(start, endA), added: b.slice(start, endB) };
}

function opFromLines(filePath: string, tool: string, ts: string | null, added: string[], removed: string[]): ChangeOp {
  return {
    filePath,
    tool,
    ts,
    added: added.length,
    removed: removed.length,
    addedText: capText(added.join("\n"), OP_TEXT_MAX),
    removedText: capText(removed.join("\n"), OP_TEXT_MAX),
  };
}

/** Vorläufige Änderung aus der Werkzeug-Eingabe (Claude) — wird durch `structuredPatch` ersetzt, falls vorhanden. */
function opFromClaudeInput(name: string, input: Json, ts: string | null): ChangeOp | null {
  const filePath = str(input.file_path) ?? str(input.notebook_path);
  if (!filePath) return null;
  if (name === "Write") return opFromLines(filePath, name, ts, textLines(str(input.content) ?? ""), []);
  if (name === "Edit") {
    const d = trimmedDiff(str(input.old_string) ?? "", str(input.new_string) ?? "");
    return opFromLines(filePath, name, ts, d.added, d.removed);
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const added: string[] = [];
    const removed: string[] = [];
    for (const e of input.edits.filter(isObj)) {
      const d = trimmedDiff(str(e.old_string) ?? "", str(e.new_string) ?? "");
      added.push(...d.added);
      removed.push(...d.removed);
    }
    return opFromLines(filePath, name, ts, added, removed);
  }
  if (name === "NotebookEdit") return opFromLines(filePath, name, ts, textLines(str(input.new_source) ?? ""), []);
  return null;
}

/** Exakte +/− aus Claudes `toolUseResult.structuredPatch` (`[{lines: ["-alt", "+neu", " kontext"]}]`). */
function patchLines(patch: unknown): { added: string[]; removed: string[] } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of patch.filter(isObj)) {
    if (!Array.isArray(hunk.lines)) continue;
    for (const l of hunk.lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added.push(l.slice(1));
      else if (l.startsWith("-")) removed.push(l.slice(1));
    }
  }
  return { added, removed };
}

/** +/− aus einem Unified Diff (Codex `FileChange.update.unified_diff`). */
function unifiedDiffLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Kopfzeilen (`--- a/…`, `+++ b/…`) stehen nur VOR dem ersten Abschnitt — danach ist „---" Inhalt.
    if (!inHunk) continue;
    if (l.startsWith("+")) added.push(l.slice(1));
    else if (l.startsWith("-")) removed.push(l.slice(1));
  }
  return { added, removed };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .map((b) => str(b.text) ?? "")
    .join("\n");
}

function testKey(segment: string): string {
  // Nur der Test-Abschnitt zählt (`cd x && pnpm test | tail` = `pnpm test`); Leerraum vereinheitlichen.
  return segment
    .replace(/\s+\d*>>?&?\s*\S+/g, "") // Umleitungen (`2>&1`, `> log`) sind nicht Teil des Tests
    .replace(/\s+/g, " ")
    .trim();
}

function parseCommits(output: string, ts: string | null): DigestCommit[] {
  const out: DigestCommit[] = [];
  for (const m of output.matchAll(COMMIT_LINE_RE)) {
    const [, branch, sha, subject] = m;
    if (sha && subject) out.push({ sha, subject: subject.trim(), branch: branch ?? null, ts });
  }
  return out;
}

function normalizeTodoStatus(v: unknown): DigestTodo["status"] | null {
  if (v === "pending" || v === "in_progress" || v === "completed") return v;
  return null;
}

function tokensOf(t: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number }): AgentTokens | null {
  if (t.total === 0 && t.input === 0 && t.output === 0) return null;
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation, total: t.total };
}

// ---------------------------------------------------------------------------------------------
// Auswertung einer Verlaufsdatei
// ---------------------------------------------------------------------------------------------

interface PendingCall {
  name: string;
  input: Json;
  ts: string | null;
  opIndex: number | null;
}

class DigestBuilder {
  prompt: string | null = null;
  result: string | null = null;
  /** Abschlussbericht per `SubagentHandback` — das eigentliche Ergebnis eines Sub-Agenten. */
  handback: string | null = null;
  readonly texts: string[] = [];
  toolErrors = 0;
  todos: DigestTodo[] | null = null;
  /** Neuere Aufgabenliste (`TaskCreate`/`TaskUpdate`), je Kennung der letzte Stand. */
  readonly tasks = new Map<string, DigestTodo>();
  readonly commits: DigestCommit[] = [];
  readonly tests: DigestTestRun[] = [];
  readonly ops: (ChangeOp | null)[] = [];

  seePrompt(text: string): void {
    const t = text.trim();
    if (!t || this.prompt !== null) return;
    this.prompt = capText(t, LONG_TEXT_MAX);
  }

  seeAssistantText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.result = capText(t, LONG_TEXT_MAX);
    this.texts.push(t);
  }

  seeCommand(command: string, output: string, ok: boolean, ts: string | null): void {
    const test = testSegment(command);
    if (test && this.tests.length < MAX_TEST_RUNS) {
      this.tests.push({ key: testKey(test), command: capText(test, 300), ok: ok && !TEST_FAIL_RE.test(output), ts });
    }
    if (GIT_COMMIT_RE.test(command) && ok) {
      for (const c of parseCommits(output, ts)) if (this.commits.length < MAX_COMMITS) this.commits.push(c);
    }
  }

  finish(models: string[], tokens: AgentTokens | null, startedAt: string | null, endedAt: string | null, tools: Record<string, number>): { digest: ArchiveDigest; ops: ChangeOp[] } {
    return {
      digest: {
        v: DIGEST_VERSION,
        prompt: this.prompt,
        result: this.handback ?? this.result,
        models,
        tokens,
        startedAt,
        endedAt,
        tools,
        toolErrors: this.toolErrors,
        todos: this.tasks.size > 0 ? [...(this.todos ?? []), ...this.tasks.values()] : this.todos,
        commits: this.commits,
        tests: this.tests,
        verdict: detectVerdict(this.texts),
      },
      ops: this.ops.filter((o): o is ChangeOp => o !== null),
    };
  }
}

function claudeLine(b: DigestBuilder, pending: Map<string, PendingCall>, o: Json): void {
  const ts = isoTs(o.timestamp);
  const msg = isObj(o.message) ? o.message : {};
  const content = msg.content;
  if (o.type === "user") {
    if (o.isMeta === true) return;
    if (typeof content === "string") {
      if (!content.trimStart().startsWith("<")) b.seePrompt(content);
      return;
    }
    if (!Array.isArray(content)) return;
    const blocks = content.filter(isObj);
    const results = blocks.filter((x) => x.type === "tool_result");
    if (results.length === 0) {
      const text = blocks
        .filter((x) => x.type === "text")
        .map((x) => str(x.text) ?? "")
        .join("\n");
      if (!text.trimStart().startsWith("<")) b.seePrompt(text);
      return;
    }
    const tur = isObj(o.toolUseResult) ? o.toolUseResult : {};
    for (const r of results) {
      const id = str(r.tool_use_id);
      const call = id ? pending.get(id) : undefined;
      if (!id || !call) continue;
      pending.delete(id);
      const isError = r.is_error === true;
      if (isError) b.toolErrors++;
      if (call.opIndex !== null) {
        if (isError) b.ops[call.opIndex] = null;
        else {
          // `toolUseResult` gehört zur ganzen Zeile — nur eindeutig, wenn sie genau EIN Ergebnis trägt.
          const exact = results.length === 1 ? patchLines(tur.structuredPatch) : null;
          const prev = b.ops[call.opIndex];
          if (exact && prev) b.ops[call.opIndex] = opFromLines(prev.filePath, prev.tool, prev.ts, exact.added, exact.removed);
        }
      }
      if (call.name === "Bash") {
        const command = str(call.input.command) ?? "";
        b.seeCommand(command, toolResultText(r.content), !isError, ts ?? call.ts);
      }
      if (call.name === "TaskCreate" && !isError) {
        // Kennung aus der Antwort („Task #3 created …") bzw. `toolUseResult.task.id`.
        const task = isObj(tur.task) ? tur.task : {};
        const taskId = str(task.id) ?? /#(\w+)/.exec(toolResultText(r.content))?.[1] ?? null;
        const content = str(call.input.subject) ?? str(call.input.content) ?? str(call.input.description);
        if (taskId && content) b.tasks.set(taskId, { content, status: normalizeTodoStatus(call.input.status) ?? "pending" });
      }
    }
    return;
  }
  if (o.type !== "assistant") return;
  if (typeof content === "string") {
    b.seeAssistantText(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content.filter(isObj)) {
    if (block.type === "text") {
      b.seeAssistantText(str(block.text) ?? "");
      continue;
    }
    if (block.type !== "tool_use") continue;
    const name = str(block.name) ?? "unbekannt";
    const id = str(block.id);
    const input = isObj(block.input) ? block.input : {};
    let opIndex: number | null = null;
    if (FILE_WRITE_TOOLS.has(name)) {
      const op = opFromClaudeInput(name, input, ts);
      if (op) {
        b.ops.push(op);
        opIndex = b.ops.length - 1;
      }
    }
    const handback = name === "SubagentHandback" ? str(input.message) : null;
    if (handback) {
      b.handback = capText(handback.trim(), LONG_TEXT_MAX);
      b.texts.push(handback);
    }
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      b.todos = input.todos.filter(isObj).flatMap((t) => {
        const text = str(t.content);
        const status = normalizeTodoStatus(t.status);
        return text && status ? [{ content: text, status }] : [];
      });
    }
    if (name === "TaskUpdate") {
      const taskId = str(input.taskId) ?? (typeof input.taskId === "number" ? String(input.taskId) : null);
      const known = taskId ? b.tasks.get(taskId) : undefined;
      if (taskId && known) {
        if (input.status === "deleted") b.tasks.delete(taskId);
        else b.tasks.set(taskId, { content: str(input.subject) ?? known.content, status: normalizeTodoStatus(input.status) ?? known.status });
      }
    }
    if (id) pending.set(id, { name, input, ts, opIndex });
  }
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .map((c) => str(c.text) ?? "")
    .join("\n");
}

function codexLine(b: DigestBuilder, o: Json): void {
  const ts = isoTs(o.timestamp);
  const p = isObj(o.payload) ? o.payload : null;
  if (!p || o.type !== "event_msg" || p.type !== "item_completed" || !isObj(p.item)) return;
  const item = p.item;
  switch (item.type) {
    case "UserMessage":
      b.seePrompt(codexText(item.content));
      return;
    case "AgentMessage":
      b.seeAssistantText(codexText(item.content));
      return;
    case "CommandExecution": {
      const cmd = Array.isArray(item.command) ? (item.command.filter((x): x is string => typeof x === "string").at(-1) ?? "") : "";
      const ok = item.exit_code === 0;
      if (typeof item.exit_code === "number" && !ok) b.toolErrors++;
      b.seeCommand(cmd, str(item.aggregated_output) ?? str(item.stdout) ?? "", ok, ts);
      return;
    }
    case "FileChange": {
      if (!isObj(item.changes)) return;
      for (const [path, change] of Object.entries(item.changes)) {
        if (!isObj(change)) continue;
        if (change.type === "update") {
          const d = unifiedDiffLines(str(change.unified_diff) ?? "");
          b.ops.push(opFromLines(str(change.move_path) ?? path, "apply_patch", ts, d.added, d.removed));
        } else if (change.type === "add") {
          b.ops.push(opFromLines(path, "apply_patch", ts, textLines(str(change.content) ?? ""), []));
        } else if (change.type === "delete") {
          b.ops.push(opFromLines(path, "apply_patch", ts, [], []));
        }
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Wertet die Zeilen EINER Verlaufsdatei aus. `agentId` (Claude-Sub-Agent) sorgt dafür, dass der
 * Parser die Zeilen als Sub-Agent-Zeilen behandelt (wie die Brücke) — Tokens/Modelle zählen trotzdem.
 */
export async function digestArchiveLines(tool: Tool, sessionId: string, agentId: string | null, lines: Iterable<string> | AsyncIterable<string>): Promise<{ digest: ArchiveDigest; ops: ChangeOp[] }> {
  const b = new DigestBuilder();
  if (tool === "claude") {
    const parser = new ClaudeSessionParser(sessionId);
    const pending = new Map<string, PendingCall>();
    const seen = new Set<string>();
    for await (const line of lines) {
      parser.push(line, agentId ? { agentId } : {});
      const o = parseJsonLine(line);
      if (!o || !isObj(o)) continue;
      // Dieselben Filter wie der Parser: fremde Session raus, jede Zeile (`uuid`) nur einmal.
      if (typeof o.sessionId === "string" && o.sessionId !== sessionId) continue;
      const uuid = str(o.uuid);
      if (uuid) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
      }
      claudeLine(b, pending, o);
    }
    const s = parser.summary();
    return b.finish(s.models, tokensOf(s.tokens), s.startedAt, s.lastActivityAt, s.toolCalls);
  }
  const parser = new CodexSessionParser(sessionId);
  const seen = new Set<string>();
  for await (const line of lines) {
    parser.push(line);
    const o = parseJsonLine(line);
    if (!o || !isObj(o)) continue;
    // Wie der Parser: Zeilen eines fremden Threads raus, jedes `item` nur einmal.
    const p = isObj(o.payload) ? o.payload : null;
    if (p && typeof p.thread_id === "string" && p.thread_id !== sessionId) continue;
    const itemId = p && isObj(p.item) ? str(p.item.id) : null;
    if (itemId) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
    }
    codexLine(b, o);
  }
  const s = parser.summary();
  return b.finish(s.models, tokensOf(s.tokens), s.startedAt, s.lastActivityAt, s.toolCalls);
}

// ---------------------------------------------------------------------------------------------
// Speichern + Laden
// ---------------------------------------------------------------------------------------------

const SUBAGENT_PATH_RE = /\/subagents\/agent-([A-Za-z0-9_-]+)\.jsonl$/;

/** Welche Rolle eine Archiv-Datei für ihre Session spielt — `undefined` = keine (wird ignoriert). */
export function archiveRole(tool: Tool, sessionId: string, path: string): { agentId: string | null } | undefined {
  if (tool === "claude") {
    const sub = SUBAGENT_PATH_RE.exec(path)?.[1];
    if (sub) return { agentId: sub };
    return path.split("/").pop() === `${sessionId}.jsonl` ? { agentId: null } : undefined;
  }
  return codexSessionIdFromPath(path) === sessionId ? { agentId: null } : undefined;
}

export interface StoredDigest {
  archiveId: number;
  sessionKey: string;
  agentId: string | null;
  digest: ArchiveDigest;
}

interface ArchiveRow {
  id: number;
  sessionKey: string;
  tool: string;
  path: string;
  sha256: string;
  storedPath: string;
}

const OP_INSERT_CHUNK = 500;

/** Eine wachsende Datei (laufende Session) wird im Hintergrund höchstens so oft neu gerechnet. */
const DEFAULT_MIN_INTERVAL_MS = 120_000;
/** Gleichzeitige Rechnungen: Hintergrund bzw. Anfrage (der DB-Pool hat nur 5 Verbindungen). */
const BACKGROUND_CONCURRENCY = 1;
const REQUEST_CONCURRENCY = 2;

/**
 * Rechnet und speichert Digests. Zwei Wege:
 * - **Anfrage** (Datei hat noch gar keinen Digest): sofort, höchstens 2 gleichzeitig.
 * - **Hintergrund** (Upload einer neuen Fassung bzw. veralteter Digest beim Abruf): eine Warteschlange
 *   je Datei, nur die neueste Fassung zählt, eine Rechnung zur Zeit, je Datei höchstens alle
 *   `minIntervalMs` — sonst läse eine laufende 15-MB-Session alle 30 s komplett neu.
 * `inflight` (`archiveId:sha256`) sorgt dafür, dass beide Wege nie dieselbe Fassung doppelt rechnen.
 * Eine Instanz je App (`createApp`).
 */
export class DigestService {
  private readonly inflight = new Map<string, Promise<StoredDigest | null>>();
  private readonly pending = new Map<number, ArchiveRow>();
  private readonly lastStart = new Map<number, number>();
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly minIntervalMs: number;

  constructor(
    private readonly db: Db,
    private readonly log: (event: string, data: Record<string, unknown>) => void = () => {},
    opts: { minIntervalMs?: number } = {},
  ) {
    const envRaw = process.env.NYXOS_DIGEST_MIN_INTERVAL_MS;
    const fromEnv = envRaw ? Number(envRaw) : Number.NaN;
    this.minIntervalMs = opts.minIntervalMs ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_MIN_INTERVAL_MS);
  }

  /** Nach einem Archiv-Upload: Digest dieser Datei im Hintergrund neu rechnen (gedrosselt). */
  async refreshPath(tool: Tool, path: string): Promise<void> {
    const [row] = await this.db
      .select({ id: archive.id, sessionKey: archive.sessionKey, tool: archive.tool, path: archive.path, sha256: archive.sha256, storedPath: archive.storedPath })
      .from(archive)
      .where(and(eq(archive.tool, tool), eq(archive.path, path)))
      .limit(1);
    if (row) this.schedule(row);
  }

  private schedule(row: ArchiveRow): void {
    this.pending.set(row.id, row); // neueste Fassung gewinnt
    this.pump();
  }

  private pump(): void {
    while (this.running < BACKGROUND_CONCURRENCY) {
      const now = Date.now();
      let next: ArchiveRow | undefined;
      let wait = Number.POSITIVE_INFINITY;
      for (const r of this.pending.values()) {
        const due = (this.lastStart.get(r.id) ?? 0) + this.minIntervalMs;
        if (due <= now) {
          next = r;
          break;
        }
        wait = Math.min(wait, due - now);
      }
      if (!next) {
        if (Number.isFinite(wait) && !this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, wait);
          this.timer.unref?.();
        }
        return;
      }
      const row = next;
      this.pending.delete(row.id);
      this.lastStart.set(row.id, now);
      this.running++;
      void this.compute(row)
        .catch((e) => this.log("digest-fehlgeschlagen", { path: row.path, error: String(e) }))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Voller Digest (ungekürzter Auftrag/Ergebnis) einer Archiv-Datei — für die große Agenten-Kachel. */
  async fullDigest(archiveId: number): Promise<ArchiveDigest | null> {
    const [row] = await this.db.select({ digest: archiveDigests.digest }).from(archiveDigests).where(eq(archiveDigests.archiveId, archiveId)).limit(1);
    return (row?.digest as ArchiveDigest | undefined) ?? null;
  }

  /**
   * Alle Digests einer Session (Haupt-Verlauf + Sub-Agenten), fehlende/veraltete werden gerechnet.
   * Auftrag/Ergebnis sind hier auf den Anfang gekürzt (s. `ensureRows`), außer frisch gerechnete.
   */
  async forSession(sessionKey: string): Promise<StoredDigest[]> {
    const rows = await this.db
      .select({ id: archive.id, sessionKey: archive.sessionKey, tool: archive.tool, path: archive.path, sha256: archive.sha256, storedPath: archive.storedPath })
      .from(archive)
      .where(eq(archive.sessionKey, sessionKey));
    return this.ensureRows(rows);
  }

  private async ensureRows(rows: ArchiveRow[]): Promise<StoredDigest[]> {
    if (rows.length === 0) return [];
    // Leicht laden: Auftrag/Ergebnis können je Agent 100 000+ Zeichen lang sein — für Listen reicht
    // der Anfang (erste Zeile, „hat ein Ergebnis"). Den vollen Text holt `fullDigest` für EINEN Agenten.
    const light = sql`(${archiveDigests.digest} - 'prompt' - 'result') || jsonb_build_object('prompt', left(${archiveDigests.digest}->>'prompt', ${LIGHT_TEXT_MAX}), 'result', left(${archiveDigests.digest}->>'result', ${LIGHT_TEXT_MAX}))`;
    const stored = await this.db
      .select({ archiveId: archiveDigests.archiveId, sha256: archiveDigests.sha256, version: archiveDigests.version, agentId: archiveDigests.agentId, digest: light.mapWith(archiveDigests.digest) })
      .from(archiveDigests)
      .where(sql`${archiveDigests.archiveId} in (${sql.join(
        rows.map((r) => sql`${r.id}`),
        sql`, `,
      )})`);
    const byId = new Map(stored.map((s) => [s.archiveId, s]));
    const out: StoredDigest[] = [];
    const todo: ArchiveRow[] = [];
    for (const row of rows) {
      const sessionId = row.sessionKey.slice(row.sessionKey.indexOf(":") + 1);
      if (!archiveRole(row.tool as Tool, sessionId, row.path)) continue;
      const hit = byId.get(row.id);
      if (hit && hit.version === DIGEST_VERSION) {
        out.push({ archiveId: row.id, sessionKey: row.sessionKey, agentId: hit.agentId, digest: hit.digest as ArchiveDigest });
        // Laufende Session: die Archiv-Fassung wächst alle ~30 s. Der letzte Stand wird sofort
        // geliefert, der neue im Hintergrund gerechnet (sonst wartet jedes Öffnen Sekunden auf den
        // 15-MB-Hauptverlauf). Der Upload-Hintergrund hat ihn meist ohnehin schon angestoßen.
        if (hit.sha256 !== row.sha256) this.schedule(row);
      } else {
        todo.push(row);
      }
    }
    for (let i = 0; i < todo.length; i += REQUEST_CONCURRENCY) {
      const batch = await Promise.all(todo.slice(i, i + REQUEST_CONCURRENCY).map((row) => this.compute(row)));
      for (const d of batch) if (d) out.push(d);
    }
    return out;
  }

  private compute(row: ArchiveRow): Promise<StoredDigest | null> {
    const key = `${row.id}:${row.sha256}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.computeNow(row).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async computeNow(row: ArchiveRow): Promise<StoredDigest | null> {
    const tool = row.tool as Tool;
    const sessionId = row.sessionKey.slice(row.sessionKey.indexOf(":") + 1);
    const role = archiveRole(tool, sessionId, row.path);
    if (!role) return null;
    let result: Awaited<ReturnType<typeof digestArchiveLines>>;
    try {
      result = await digestArchiveLines(tool, sessionId, role.agentId, readGzLines(row.storedPath));
    } catch (e) {
      // Fassung wurde während des Lesens ersetzt (s. transcript.ts) — die neue Fassung bekommt
      // ihren eigenen Lauf über den Upload-Hintergrund bzw. den nächsten Zugriff.
      if (e instanceof TranscriptReadError) {
        this.log("digest-lesefehler", { path: row.path, error: e.message });
        return null;
      }
      throw e;
    }
    const saved = await this.db.transaction(async (tx) => {
      // Nur speichern, wenn die DB noch auf genau diese Fassung zeigt (sonst überschreibt ein
      // langsamer, alter Lauf einen neueren).
      const [current] = await tx.select({ sha256: archive.sha256 }).from(archive).where(eq(archive.id, row.id)).for("update");
      if (!current || current.sha256 !== row.sha256) return false;
      await tx.delete(sessionChangeOps).where(eq(sessionChangeOps.archiveId, row.id));
      const values = result.ops.map((op) => ({ archiveId: row.id, sessionKey: row.sessionKey, agentId: role.agentId, ...op }));
      for (let i = 0; i < values.length; i += OP_INSERT_CHUNK) await tx.insert(sessionChangeOps).values(values.slice(i, i + OP_INSERT_CHUNK));
      await tx
        .insert(archiveDigests)
        .values({ archiveId: row.id, sessionKey: row.sessionKey, agentId: role.agentId, sha256: row.sha256, version: DIGEST_VERSION, digest: result.digest })
        .onConflictDoUpdate({
          target: archiveDigests.archiveId,
          set: { sessionKey: row.sessionKey, agentId: role.agentId, sha256: row.sha256, version: DIGEST_VERSION, digest: result.digest, computedAt: sql`now()` },
        });
      return true;
    });
    if (!saved) return null;
    return { archiveId: row.id, sessionKey: row.sessionKey, agentId: role.agentId, digest: result.digest };
  }
}
