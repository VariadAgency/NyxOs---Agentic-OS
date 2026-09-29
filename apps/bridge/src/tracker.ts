import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  ClaudeSessionParser,
  CodexSessionParser,
  codexSessionIdFromPath,
  parseClaudeSubagentMeta,
  parseCodexIndex,
  type IngestItem,
  type SessionEvent,
  type Tool,
} from "@nyxos/shared";
import { claudeDirInProjects, inProjects, type BridgeConfig } from "./config.js";
import type { Outbox } from "./outbox.js";
import { Slicer, yieldNow } from "./yield.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NL = 0x0a;
/** Einträge je Puffer-Transaktion, danach darf die Ereignisschleife kurz dran. */
const ENQUEUE_CHUNK = 500;

export type FileKind =
  | { tool: "claude"; kind: "main"; sessionId: string }
  | { tool: "claude"; kind: "subagent"; sessionId: string; agentId: string }
  | { tool: "claude"; kind: "submeta"; sessionId: string; agentId: string }
  | { tool: "claude"; kind: "extra"; sessionId: string }
  | { tool: "codex"; kind: "rollout"; sessionId: string }
  | { tool: "codex"; kind: "index" };

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Ordnet eine Datei einer Session zu – oder `null`, wenn sie uns nichts angeht. */
export function classify(path: string, cfg: Pick<BridgeConfig, "claudeDir" | "codexDir" | "projectRoots">): FileKind | null {
  const projects = join(cfg.claudeDir, "projects");
  const codexSessions = join(cfg.codexDir, "sessions");
  if (path === join(cfg.codexDir, "session_index.jsonl")) return { tool: "codex", kind: "index" };

  if (path.startsWith(codexSessions + sep)) {
    const sessionId = codexSessionIdFromPath(path);
    return sessionId && path.endsWith(".jsonl") ? { tool: "codex", kind: "rollout", sessionId } : null;
  }
  if (!path.startsWith(projects + sep)) return null;
  const parts = relative(projects, path).split(sep);
  if (!claudeDirInProjects(parts[0] ?? "", cfg.projectRoots)) return null;

  const second = parts[1] ?? "";
  if (parts.length === 2) {
    const id = second.replace(/\.jsonl$/, "");
    return second.endsWith(".jsonl") && UUID.test(id) ? { tool: "claude", kind: "main", sessionId: id } : null;
  }
  if (parts.length < 3 || !UUID.test(second)) return null;
  const file = parts.at(-1) ?? "";
  if (parts.length === 4 && parts[2] === "subagents") {
    const m = /^agent-([A-Za-z0-9_-]+)\.(jsonl|meta\.json)$/.exec(file);
    if (m?.[1] && m[2] === "jsonl") return { tool: "claude", kind: "subagent", sessionId: second, agentId: m[1] };
    if (m?.[1]) return { tool: "claude", kind: "submeta", sessionId: second, agentId: m[1] };
  }
  if (file === ".DS_Store") return null;
  return { tool: "claude", kind: "extra", sessionId: second };
}

/** Relativer Archivpfad je Werkzeug-Stamm. */
export function archiveRelPath(path: string, tool: Tool, cfg: Pick<BridgeConfig, "claudeDir" | "codexDir">): string {
  return tool === "claude" ? relative(join(cfg.claudeDir, "projects"), path) : relative(join(cfg.codexDir, "sessions"), path);
}

interface FileState {
  memOffset: number;
  partial: Buffer;
  agentId?: string;
}

interface Tracked {
  tool: Tool;
  sessionId: string;
  key: string;
  parser: ClaudeSessionParser | CodexSessionParser;
  files: Map<string, FileState>;
  /** null = Arbeitsordner noch unbekannt, dann werden Events zurückgehalten. */
  allowed: boolean | null;
  pending: { path: string; endOffset: number; events: SessionEvent[] }[];
  lastMtimeMs: number;
  lastSummary: string | null;
  /** Schon gemeldet, dass die Datei nur Zeilen einer anderen Session enthält (einmal je Session). */
  foreignReported?: boolean;
}

export interface TrackerHooks {
  /** Wird nach jeder Änderung einer Session-Datei aufgerufen (für das Archiv). */
  onFileChanged?: (path: string, tool: Tool, sessionId: string) => void;
  /** Neue Einträge im Puffer. */
  onEnqueued?: () => void;
}

export class Tracker {
  private readonly sessions = new Map<string, Tracked>();
  private codexIndex = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly outbox: Outbox,
    private readonly log: Log,
    private readonly hooks: TrackerHooks = {},
  ) {}

  /** Serialisiert alle Dateiverarbeitungen: nie zwei gleichzeitig. */
  handle(path: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const run = this.queue.then(() => this.process(path)).catch((e: unknown) => this.log("tracker-fehler", { path, error: String(e) }));
    this.queue = run;
    return run;
  }

  /** Keine neuen Aufträge mehr annehmen und laufende abschließen. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
  }

  isAllowed(tool: Tool, sessionId: string): boolean | null {
    return this.sessions.get(`${tool}:${sessionId}`)?.allowed ?? null;
  }

  /** Bekannte, erlaubte Sessions für das Lebenszeichen. `path` (nur Codex):
   * die Rollout-Datei, damit die Brücke per `lsof` prüfen kann, ob ein `codex`-Prozess sie noch offen
   * hält — auch wenn schon lange nicht mehr hineingeschrieben wurde (langer Befehl, Freigabe-Frage). */
  known(): { tool: Tool; sessionId: string; lastMtimeMs: number; path: string | null }[] {
    return [...this.sessions.values()]
      .filter((s) => s.allowed === true)
      .map((s) => ({ tool: s.tool, sessionId: s.sessionId, lastMtimeMs: s.lastMtimeMs, path: s.tool === "codex" ? ([...s.files.keys()][0] ?? null) : null }));
  }

  /** Einmaliger Durchlauf über alle vorhandenen Dateien (Nachimport und Neustart). */
  async scanAll(): Promise<number> {
    const files = [...(await this.collect(join(this.cfg.claudeDir, "projects"))), ...(await this.collect(join(this.cfg.codexDir, "sessions")))];
    await this.handle(join(this.cfg.codexDir, "session_index.jsonl"));
    return this.importFiles(files);
  }

  /**
   * Einmal alles unter einer Quelle einlesen, die erst nach dem Start entstanden ist (`~/.claude/projects`,
   * `~/.codex/sessions` oder der Codex-Index). Bereits Gelesenes liest der Tracker nicht doppelt.
   */
  async scanTree(target: string): Promise<number> {
    if (target === join(this.cfg.codexDir, "session_index.jsonl")) {
      await this.handle(target);
      return 0;
    }
    return this.importFiles(await this.collect(target));
  }

  /** Alle Dateien unter `dir` (unter `~/.claude/projects` nur die Ordner der Projektordner). */
  private async collect(dir: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory() && depth < 6) await walk(p, depth + 1);
        else if (e.isFile()) files.push(p);
      }
    };
    const projects = join(this.cfg.claudeDir, "projects");
    if (dir === projects) {
      for (const d of await readdir(projects).catch(() => [] as string[])) {
        if (claudeDirInProjects(d, this.cfg.projectRoots)) await walk(join(projects, d), 1);
      }
    } else {
      await walk(dir, 0);
    }
    return files;
  }

  private async importFiles(files: string[]): Promise<number> {
    const relevant = files.filter((f) => classify(f, this.cfg) !== null);
    // Hauptdateien zuerst, damit der Arbeitsordner bekannt ist, bevor Nebendateien kommen.
    const rank = (f: string) => {
      const k = classify(f, this.cfg)?.kind;
      return k === "main" || k === "rollout" ? 0 : k === "subagent" ? 1 : 2;
    };
    relevant.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const f of relevant) await this.handle(f);
    return relevant.length;
  }

  private session(tool: Tool, sessionId: string): Tracked {
    const key = `${tool}:${sessionId}`;
    let s = this.sessions.get(key);
    if (!s) {
      const parser = tool === "claude" ? new ClaudeSessionParser(sessionId) : new CodexSessionParser(sessionId);
      if (parser instanceof CodexSessionParser) parser.setIndexTitle(this.codexIndex.get(sessionId) ?? null);
      s = { tool, sessionId, key, parser, files: new Map(), allowed: null, pending: [], lastMtimeMs: 0, lastSummary: null };
      this.sessions.set(key, s);
    }
    return s;
  }

  private async process(path: string): Promise<void> {
    if (this.stopped) return;
    const kind = classify(path, this.cfg);
    if (!kind) return;
    if (kind.kind === "index") return this.reloadIndex(path);
    if (this.outbox.file(path)?.ignored) return;

    const s = this.session(kind.tool, kind.sessionId);
    if (s.allowed === false) {
      this.outbox.upsertFile(path, s.tool, s.sessionId);
      this.outbox.setIgnored(path);
      return;
    }
    this.outbox.upsertFile(path, s.tool, s.sessionId);

    if (kind.kind === "submeta") {
      const text = await readFile(path, "utf8").catch(() => null);
      if (text !== null && s.parser instanceof ClaudeSessionParser) s.parser.addSubagentMeta(kind.agentId, parseClaudeSubagentMeta(text));
    } else if (kind.kind !== "extra") {
      const agentId = kind.kind === "subagent" ? kind.agentId : undefined;
      const fresh = await this.readLines(s, path, agentId);
      if (fresh === "rebuild") return this.rebuild(s, path);
      if (kind.kind === "main") this.reportForeign(s, path);
    }
    const st = await stat(path).catch(() => null);
    if (st) s.lastMtimeMs = Math.max(s.lastMtimeMs, st.mtimeMs);
    this.decide(s);
    if (s.allowed === true) {
      await this.flush(s);
      this.hooks.onFileChanged?.(path, s.tool, s.sessionId);
    }
  }

  /** Liest nur neue, vollständige Zeilen. Eine halb geschriebene letzte Zeile bleibt liegen. */
  private async readLines(s: Tracked, path: string, agentId?: string): Promise<"ok" | "rebuild"> {
    let fs = s.files.get(path);
    if (!fs) {
      fs = { memOffset: 0, partial: Buffer.alloc(0), ...(agentId ? { agentId } : {}) };
      s.files.set(path, fs);
    }
    const fh = await open(path, "r").catch(() => null);
    if (!fh) return "ok";
    try {
      const { size } = await fh.stat();
      if (size < fs.memOffset) return "rebuild";
      if (size === fs.memOffset) return "ok";
      const chunk = Buffer.alloc(size - fs.memOffset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, fs.memOffset);
      const buf = Buffer.concat([fs.partial, chunk.subarray(0, bytesRead)]);
      const base = fs.memOffset - fs.partial.length;
      const emitted = this.outbox.file(path)?.emitted_offset ?? 0;
      const fresh: SessionEvent[] = [];
      let start = 0;
      let end = -1;
      // Eine 16-MB-Verlaufsdatei am Stück zu parsen blockierte die Ereignisschleife (Pong, Tunnel,
      // Terminal) — jetzt in Scheiben. Der Tracker ist serialisiert; niemand sonst fasst `s` dazwischen an.
      const slicer = new Slicer();
      for (let i = buf.indexOf(NL); i !== -1; i = buf.indexOf(NL, start)) {
        if (slicer.due()) await slicer.yield();
        const line = buf.toString("utf8", start, i);
        const events =
          s.parser instanceof ClaudeSessionParser ? s.parser.push(line, agentId ? { agentId } : {}) : s.parser.push(line);
        end = base + i + 1;
        if (end > emitted) fresh.push(...events);
        start = i + 1;
      }
      fs.partial = Buffer.from(buf.subarray(start));
      fs.memOffset = fs.memOffset + bytesRead;
      if (end !== -1) s.pending.push({ path, endOffset: end, events: fresh });
      return "ok";
    } finally {
      await fh.close();
    }
  }

  /** Datei wurde kürzer (neu geschrieben): Session komplett neu einlesen. Der Server dedupliziert. */
  private async rebuild(s: Tracked, changed: string): Promise<void> {
    this.log("neu-einlesen", { session: s.key, path: changed });
    const paths = new Set([...s.files.keys(), changed]);
    this.sessions.delete(s.key);
    for (const p of paths) {
      this.outbox.setEmittedOffset(p, 0);
      await this.process(p);
    }
  }

  /**
   * Eine Claude-Datei, deren Zeilen (bisher) alle eine andere `sessionId` tragen als ihr Dateiname, ergibt keine
   * Session — der Parser verwirft fremde Zeilen absichtlich (abgezweigte Kopie, sonst doppelt). Das einmal ins
   * Log schreiben, statt still nichts zu tun (z. B. eine umbenannt kopierte Datei beim Testen).
   */
  private reportForeign(s: Tracked, path: string): void {
    if (s.foreignReported || !(s.parser instanceof ClaudeSessionParser)) return;
    const foreign = s.parser.onlyForeignLines();
    if (!foreign) return;
    s.foreignReported = true;
    this.log("fremde-session", { session: s.key, path, zeilenVon: foreign.sessionId, zeilen: foreign.lines, grund: "Dateiname passt nicht zur sessionId der Zeilen" });
  }

  private decide(s: Tracked): void {
    if (s.allowed !== null) return;
    const cwd = s.parser.summary().cwd;
    if (!cwd) return;
    s.allowed = inProjects(cwd, this.cfg.projectRoots);
    if (!s.allowed) {
      for (const p of s.files.keys()) this.outbox.setIgnored(p);
      s.pending = [];
      s.files.clear();
      this.log("ignoriert", { session: s.key, grund: "Arbeitsordner außerhalb des Projekts" });
    }
  }

  private async flush(s: Tracked): Promise<void> {
    const items: IngestItem[] = s.pending.flatMap((p) => p.events.map((event) => ({ type: "event" as const, event })));
    const summary = s.parser.summary();
    const json = JSON.stringify(summary);
    const summaryChanged = json !== s.lastSummary;
    if (summaryChanged) items.push({ type: "summary", summary });
    const offsets = new Map<string, number>();
    for (const p of s.pending) offsets.set(p.path, Math.max(offsets.get(p.path) ?? 0, p.endOffset));
    if (items.length === 0 && offsets.size === 0) return;
    // Große Mengen (Nachimport: zehntausende Events) in Teilen, mit Pause dazwischen. Die Offsets
    // kommen erst in der letzten Transaktion: stürzt die Brücke vorher ab, wird neu gelesen — doppelte
    // Einträge verwirft der Puffer (Schlüssel = Event-ID) und der Server dedupliziert ohnehin.
    let i = 0;
    for (; i + ENQUEUE_CHUNK < items.length; i += ENQUEUE_CHUNK) {
      this.outbox.enqueue(items.slice(i, i + ENQUEUE_CHUNK));
      await yieldNow(); // Tracker ist serialisiert: `s` ändert sich solange nicht
    }
    const rest = items.slice(i);
    this.outbox.db.transaction(() => {
      if (rest.length > 0) this.outbox.enqueue(rest);
      for (const [path, off] of offsets) {
        if (off > (this.outbox.file(path)?.emitted_offset ?? 0)) this.outbox.setEmittedOffset(path, off);
      }
    });
    s.pending = [];
    s.lastSummary = json;
    if (items.length > 0) this.hooks.onEnqueued?.();
  }

  private async reloadIndex(path: string): Promise<void> {
    const text = await readFile(path, "utf8").catch(() => "");
    this.codexIndex = parseCodexIndex(text);
    for (const s of this.sessions.values()) {
      if (!(s.parser instanceof CodexSessionParser)) continue;
      s.parser.setIndexTitle(this.codexIndex.get(s.sessionId) ?? null);
      if (s.allowed === true) await this.flush(s);
    }
  }
}
