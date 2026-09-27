import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IngestItem, Tool } from "@nyxos/shared";
import { inProjects } from "./config.js";
import type { Outbox } from "./outbox.js";
import { findBin, IS_LINUX } from "./platform.js";

const run = promisify(execFile);
/** Codex führt kein Register laufender Sessions: aktiv = kürzlich geschrieben UND ein codex-Prozess läuft. */
export const CODEX_ACTIVE_MS = 10 * 60 * 1000;
/** Harte Obergrenze für `pgrep`/`lsof` im Lebenszeichen-Takt — ein hängender Aufruf darf den Takt nie
 * blockieren; `execFile` killt den Kindprozess danach. */
const PROBE_TIMEOUT_MS = 2000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Claude schreibt je laufender Instanz `~/.claude/sessions/<pid>.json` mit Session-ID und Arbeitsordner. */
export async function runningClaude(claudeDir: string, projectRoots: readonly string[]): Promise<Set<string>> {
  return new Set((await claudePidMap(claudeDir, projectRoots)).values());
}

/**
 * Wann ist der Prozess laut Claude-Register gestartet? Claude schreibt `procStart` (Format wie
 * `ps -o lstart`, in UTC, z. B. „Fri Sep 25 08:49:41 2026") und `startedAt` (ms, wenn Claude selbst lief).
 */
export interface RecordedStart {
  procStartMs: number | null;
  startedAtMs: number | null;
}

export function recordedStart(o: { procStart?: unknown; startedAt?: unknown }): RecordedStart {
  const ps = typeof o.procStart === "string" && /^\w{3} \w{3} [ \d]?\d \d\d:\d\d:\d\d \d{4}$/.test(o.procStart) ? Date.parse(`${o.procStart} UTC`) : NaN;
  return {
    procStartMs: Number.isNaN(ps) ? null : ps,
    startedAtMs: typeof o.startedAt === "number" && Number.isFinite(o.startedAt) ? o.startedAt : null,
  };
}

/**
 * Passt die Startzeit laut `ps` zu der im Register? `lstart` hat Sekunden-Auflösung (±1 s). Ohne `procStart`
 * (ältere Claude-Fassungen): `startedAt` muss kurz nach dem Prozessstart liegen. Ohne beides: nein.
 */
export function sameStart(psStartMs: number, rec: RecordedStart | null): boolean {
  if (!rec) return false;
  if (rec.procStartMs !== null) return Math.abs(rec.procStartMs - psStartMs) <= 1000;
  if (rec.startedAtMs !== null) return rec.startedAtMs >= psStartMs - 1000 && rec.startedAtMs - psStartMs <= 120_000;
  return false;
}

/** Register-Startzeit eines Claude-Prozesses dieser Session (null = unbekannt/andere Session). */
export async function claudeRecordedStart(claudeDir: string, pid: number, sessionId: string): Promise<RecordedStart | null> {
  try {
    const o = JSON.parse(await readFile(join(claudeDir, "sessions", `${pid}.json`), "utf8")) as { pid?: unknown; sessionId?: unknown; procStart?: unknown; startedAt?: unknown };
    if (o.pid !== pid || o.sessionId !== sessionId) return null;
    return recordedStart(o);
  } catch {
    return null;
  }
}

/** pid → Session-ID aller lebenden Claude-Prozesse in den Projektordnern (für die tmux-Zuordnung
 * und die Start-Sperre „noch ein Prozess an der Session"). */
export async function claudePidMap(claudeDir: string, projectRoots: readonly string[]): Promise<Map<number, string>> {
  const dir = join(claudeDir, "sessions");
  const out = new Map<number, string>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const o = JSON.parse(await readFile(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown; cwd?: unknown };
      if (typeof o.pid !== "number" || typeof o.sessionId !== "string") continue;
      if (!inProjects(typeof o.cwd === "string" ? o.cwd : null, projectRoots)) continue;
      if (alive(o.pid)) out.set(o.pid, o.sessionId);
    } catch {
      // halb geschrieben oder gerade gelöscht
    }
  }
  return out;
}

export async function codexProcessRunning(): Promise<boolean> {
  if (IS_LINUX && !findBin("pgrep")) return (await codexPids()).length > 0;
  try {
    // `pgrep -x` gibt es in macOS und procps (Linux) gleich: Exit 0 = gefunden, 1 = keiner.
    await run(findBin("pgrep") ?? "pgrep", ["-x", "codex"], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Linux ohne pgrep/lsof: `codex`-Prozesse direkt aus /proc (Name steht in /proc/<pid>/comm). */
async function codexPids(): Promise<number[]> {
  const out: number[] = [];
  for (const name of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const comm = await readFile(`/proc/${name}/comm`, "utf8").catch(() => "");
    if (comm.trim() === "codex") out.push(Number(name));
  }
  return out;
}

/**
 * Offene Dateien der `codex`-Prozesse im Ausgabeformat von `lsof -Fpn` (`p<pid>`, dann `n<pfad>`-Zeilen).
 * macOS: immer `lsof`. Linux: `lsof`, falls installiert (fehlt auf vielen Minimal-Systemen), sonst /proc.
 */
async function codexOpenFiles(execFileImpl: ExecFileImpl): Promise<string> {
  const lsof = findBin("lsof");
  if (lsof || !IS_LINUX) {
    try {
      return (await execFileImpl(lsof ?? "/usr/sbin/lsof", ["-c", "codex", "-Fpn"], { timeout: PROBE_TIMEOUT_MS })).stdout;
    } catch (e) {
      // Exit-Code 1 heißt „kein `codex`-Prozess hat irgendetwas offen" — kein Fehler, nur „nichts offen".
      // Bei Zeitüberschreitung/echtem Fehler bleibt die Ausgabe leer — dann gilt keine Datei als offen.
      return (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
    }
  }
  const lines: string[] = [];
  for (const pid of await codexPids()) {
    lines.push(`p${pid}`);
    const fdDir = `/proc/${pid}/fd`;
    for (const fd of await readdir(fdDir).catch(() => [] as string[])) {
      const target = await readlink(join(fdDir, fd)).catch(() => null);
      if (target?.startsWith("/")) lines.push(`n${target}`);
    }
  }
  return lines.join("\n");
}

/**
 * „Beendet" darf für Codex nicht allein aus 10 Minuten Schreibstille folgen, solange ein `codex`-Prozess
 * die Rollout-Datei der Session noch offen hält (langer Befehl, Freigabe-Frage — Codex schreibt dann lange
 * nichts, ist aber nicht weg).
 *
 * Kosten: ein eigenes `lsof -- <Datei>` je still gewordener Datei scannt jedes Mal das gesamte
 * Dateihandle-Register des Systems — bei vielen Sessions fast ein ganzer Kern, dauerhaft. Darum genau EIN
 * `lsof -c codex` je Takt (alle offenen Dateien ALLER `codex`-Prozesse in einem Rutsch); der Abgleich
 * „welche Kandidaten-Datei ist offen" läuft rein lokal gegen die zurückgegebene Pfad-Menge. Jede offene
 * Datei steht als Zeile `n<Pfad>` in der Ausgabe.
 */
export function parseLsofOpenPaths(lsofOutput: string): Set<string> {
  const out = new Set<string>();
  for (const line of lsofOutput.split("\n")) if (line.startsWith("n")) out.add(line.slice(1));
  return out;
}

/** Signatur von `run` (= `promisify(execFile)`) — als eigener Typ, damit Tests einen Zähl-/Fake-
 * Aufrufer injizieren können, ohne einen echten `codex`-Prozess zu brauchen. */
type ExecFileImpl = typeof run;

/**
 * Genau EIN `lsof`-Aufruf je Aufruf dieser Funktion, unabhängig von `candidates.length`.
 * `execFileImpl` ist nur für Tests gedacht (Vorgabe = echter `execFile`).
 */
export async function codexOpenSessions(candidates: { sessionId: string; path: string }[], execFileImpl: ExecFileImpl = run): Promise<Set<string>> {
  const out = new Set<string>();
  if (candidates.length === 0) return out;
  const openPaths = parseLsofOpenPaths(await codexOpenFiles(execFileImpl));
  for (const { sessionId, path } of candidates) if (openPaths.has(path)) out.add(sessionId);
  return out;
}

/** `lsof -Fpn` → PIDs, die genau diese Datei offen halten (`p<pid>`-Zeile, danach `n<pfad>`-Zeilen). */
export function parseLsofPidsForPath(lsofOutput: string, path: string): number[] {
  const out = new Set<number>();
  let pid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("n") && pid !== null && line.slice(1) === path) out.add(pid);
  }
  return [...out];
}

/** Welche `codex`-Prozesse halten die Rollout-Datei dieser Session offen? (ein `lsof`-Aufruf) */
export async function codexPidsFor(path: string, execFileImpl: ExecFileImpl = run): Promise<number[]> {
  return parseLsofPidsForPath(await codexOpenFiles(execFileImpl), path);
}

export interface LivenessInput {
  known: { tool: Tool; sessionId: string; lastMtimeMs: number; path?: string | null }[];
  claudeRunning: Set<string>;
  codexProcess: boolean;
  /** Codex-Sessions, deren Rollout-Datei gerade von einem `codex`-Prozess offen gehalten wird
   * — s. {@link codexOpenSessions}. Nur diese dürfen die 10-Minuten-Schwelle überstimmen. */
  codexOpenSessions?: Set<string>;
  now: number;
}

/** Berechnet Statuswechsel gegenüber dem zuletzt gemeldeten Stand. */
export function stateChanges(outbox: Outbox, input: LivenessInput): IngestItem[] {
  const items: IngestItem[] = [];
  const observedAt = new Date(input.now).toISOString();
  const seen = new Set<string>();
  const consider = (tool: Tool, sessionId: string, running: boolean) => {
    const key = `${tool}:${sessionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (outbox.lastState(key) === running) return;
    outbox.setState(key, running);
    items.push({ type: "state", state: { tool, sessionId, running, observedAt } });
  };
  for (const id of input.claudeRunning) consider("claude", id, true);
  for (const k of input.known) {
    if (k.tool === "claude") consider("claude", k.sessionId, input.claudeRunning.has(k.sessionId));
    else {
      const recentWrite = input.now - k.lastMtimeMs < CODEX_ACTIVE_MS;
      const stillOpen = input.codexOpenSessions?.has(k.sessionId) ?? false;
      consider("codex", k.sessionId, input.codexProcess && (recentWrite || stillOpen));
    }
  }
  return items;
}
