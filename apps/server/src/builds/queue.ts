// Build-Wächter — die Warteschlange. Höchstens `BUILD_MAX_CONCURRENT[kind]` Läufe je Art
// gleichzeitig (iOS: 1 — Xcode/Simulator vertragen keinen parallelen Zugriff auf denselben Cache).
//
// Die AUSFÜHRUNG läuft in der Produktion über die Brücke (`BridgeBuildRunner`,
// `builds/bridgeRunner.ts`) — im Server-Container gibt es weder die Mac-Arbeitsordner noch Xcode;
// genau daran scheiterten die alten Läufe mit „spawn pnpm ENOENT“ (Node meldet ENOENT auch, wenn nur
// der `cwd` fehlt). `ProcessBuildRunner` bleibt für Tests. Fehlt ein Werkzeug
// oder Ordner, meldet der Runner `unavailable` (ein Satz, was fehlt) — der Lauf ist dann nicht rot.
import { BUILD_LOG_EXCERPT_LINES, BUILD_MAX_CONCURRENT, t, unavailableSentence, type BuildKind, type BuildTrigger } from "@nyxos/shared";
import { and, eq, inArray, lt } from "drizzle-orm";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Db } from "../db/client.js";
import { buildRuns } from "../db/schema.js";

export interface BuildJob {
  sessionKey: string | null;
  kind: BuildKind;
  command: string[];
  cwd: string;
  derivedDataPath?: string | null;
  trigger: BuildTrigger;
  env?: Record<string, string>;
}

export interface BuildRunOutcome {
  exitCode: number | null;
  log: string;
  /** Gesetzt = Build-Prüfung nicht eingerichtet (ein Satz in einfacher Sprache, was fehlt) — kein Rot. */
  unavailable?: string;
}

export interface BuildRunner {
  run(job: BuildJob): Promise<BuildRunOutcome>;
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Echter Lauf über `node:child_process` — Stdout+Stderr zusammen (Reihenfolge egal, es geht nur
 * um die letzten Zeilen für den Einzeiler/das Panel, s. `BUILD_LOG_EXCERPT_LINES`). */
export class ProcessBuildRunner implements BuildRunner {
  run(job: BuildJob): Promise<BuildRunOutcome> {
    return new Promise((resolve) => {
      const [cmd, ...args] = job.command;
      if (!cmd) {
        resolve({ exitCode: -1, log: t("Kein Befehl angegeben") });
        return;
      }
      if (!isDir(job.cwd)) {
        resolve({ exitCode: null, log: t("Ordner fehlt: {folder}", { folder: job.cwd }), unavailable: unavailableSentence("folder_missing") });
        return;
      }
      const proc = spawn(cmd, args, { cwd: job.cwd, env: { ...process.env, ...job.env } });
      let log = "";
      proc.stdout.on("data", (d: Buffer) => {
        log += d.toString("utf8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        log += d.toString("utf8");
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        // ENOENT beim Start = Programm nicht gefunden (der Ordner ist oben schon geprüft) → nicht eingerichtet.
        if (err.code === "ENOENT") resolve({ exitCode: null, log: `${log}${err.message}`.trim(), unavailable: unavailableSentence("tool_missing", cmd) });
        else resolve({ exitCode: -1, log: `${log}\n${t("Fehler beim Starten: {error}", { error: err.message })}` });
      });
      proc.on("close", (code) => resolve({ exitCode: code ?? -1, log }));
    });
  }
}

const INTERRUPTED_SENTENCE = "Die Prüfung wurde durch einen Neustart von NyxOS unterbrochen – geprüft wird beim nächsten Mal.";

export interface BuildDoneEvent {
  id: number;
  sessionKey: string | null;
  kind: BuildKind;
  status: "green" | "red" | "unavailable";
  exitCode: number | null;
  logExcerpt: string;
}

export class BuildQueue {
  private readonly activeCount: Record<BuildKind, number> = { ios: 0, backend: 0, nyxos: 0 };
  private readonly waiting: Record<BuildKind, Array<() => void>> = { ios: [], backend: [], nyxos: [] };
  /** Stop-Hook-Läufe, die noch auf einen freien Platz warten, je Art+Ordner: endet eine
   * Session-Runde mehrmals schnell hintereinander, reicht EIN wartender Lauf — er prüft ohnehin den
   * neuesten Stand. Laufende Prüfungen werden nie zusammengelegt. */
  private readonly waitingByFolder = new Map<string, number>();
  private readonly createdAt = new Date().toISOString();

  constructor(
    private readonly db: Db,
    private readonly runner: BuildRunner = new ProcessBuildRunner(),
    private readonly onDone?: (event: BuildDoneEvent) => void | Promise<void>,
  ) {}

  /** Legt sofort eine `build_runs`-Zeile an (Status `queued`) und startet den Lauf, sobald die Art
   * Kapazität hat. Gibt die ID sofort zurück — der Aufrufer muss nicht auf das Ergebnis warten. */
  async submit(job: BuildJob): Promise<number> {
    const folderKey = job.trigger === "stop_hook" ? `${job.kind}:${job.cwd}` : null;
    const already = folderKey ? this.waitingByFolder.get(folderKey) : undefined;
    if (already !== undefined) return already;
    const [row] = await this.db
      .insert(buildRuns)
      .values({
        sessionKey: job.sessionKey,
        kind: job.kind,
        command: job.command.join(" "),
        status: "queued",
        derivedDataPath: job.derivedDataPath ?? null,
        trigger: job.trigger,
        // BC: Ordner merken — ein späterer grüner Lauf hier behebt diesen roten.
        folder: job.cwd,
      })
      .returning({ id: buildRuns.id });
    if (!row) throw new Error("build_runs-Zeile konnte nicht angelegt werden");
    if (folderKey) this.waitingByFolder.set(folderKey, row.id);
    void this.runWhenFree(job, row.id, folderKey);
    return row.id;
  }

  /** Läufe, die vor dem Start dieses Prozesses noch warteten/liefen (Neustart/Deploy), kommen
   * nie mehr zu Ende — sonst stünden sie ewig auf „läuft“. Sie gelten als „nicht eingerichtet“ mit Satz. */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.db
      .update(buildRuns)
      .set({ status: "unavailable", logExcerpt: t(INTERRUPTED_SENTENCE), endedAt: new Date().toISOString() })
      .where(and(inArray(buildRuns.status, ["queued", "running"]), lt(buildRuns.startedAt, this.createdAt)))
      .returning({ id: buildRuns.id });
    return rows.length;
  }

  /** Nur für Tests: wartet, bis genau dieser Lauf grün/rot ist. */
  async waitFor(id: number, pollMs = 20): Promise<void> {
    for (;;) {
      const [row] = await this.db.select({ status: buildRuns.status }).from(buildRuns).where(eq(buildRuns.id, id)).limit(1);
      if (row && (row.status === "green" || row.status === "red" || row.status === "unavailable")) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async runWhenFree(job: BuildJob, id: number, folderKey: string | null): Promise<void> {
    await this.acquire(job.kind);
    if (folderKey && this.waitingByFolder.get(folderKey) === id) this.waitingByFolder.delete(folderKey);
    try {
      await this.db.update(buildRuns).set({ status: "running" }).where(eq(buildRuns.id, id));
      let outcome: BuildRunOutcome;
      try {
        outcome = await this.runner.run(job);
      } catch (e) {
        outcome = { exitCode: -1, log: t("Fehler beim Starten: {error}", { error: String(e) }) };
      }
      const { exitCode, log, unavailable } = outcome;
      const status = unavailable ? ("unavailable" as const) : exitCode === 0 ? ("green" as const) : ("red" as const);
      const tail = log.split("\n").slice(-BUILD_LOG_EXCERPT_LINES).join("\n").trim();
      // „nicht eingerichtet“: erste Zeile = der Satz für den Nutzer, darunter die Rohmeldung (Details).
      const logExcerpt = unavailable ? [unavailable, tail].filter(Boolean).join("\n") : tail;
      await this.db.update(buildRuns).set({ status, exitCode, logExcerpt, endedAt: new Date().toISOString() }).where(eq(buildRuns.id, id));
      if (this.onDone) await this.onDone({ id, sessionKey: job.sessionKey, kind: job.kind, status, exitCode, logExcerpt });
    } finally {
      this.release(job.kind);
    }
  }

  private acquire(kind: BuildKind): Promise<void> {
    const max = BUILD_MAX_CONCURRENT[kind];
    if (this.activeCount[kind] < max) {
      this.activeCount[kind] += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting[kind].push(() => {
        this.activeCount[kind] += 1;
        resolve();
      });
    });
  }

  private release(kind: BuildKind): void {
    this.activeCount[kind] -= 1;
    const next = this.waiting[kind].shift();
    if (next) next();
  }

  /** Für Tests/Anzeige: wie viele Läufe dieser Art gerade wirklich laufen. */
  runningCount(kind: BuildKind): number {
    return this.activeCount[kind];
  }
}
