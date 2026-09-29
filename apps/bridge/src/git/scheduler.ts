// Takt der Git-Erfassung in der Brücke. Scan sofort beim Start, danach bei jeder Änderung
// in einem `.git`-Ordner (Datei-Wächter) und zusätzlich im Takt (ungesicherte Änderungen hinterlassen
// in `.git` keine Spur). Probe-Merges und Nachziehen laufen im langsameren eigenen Takt. Nie zwei
// Läufe gleichzeitig; eine Änderung während eines Laufs löst genau einen weiteren aus.
import { newCollectorState, runGitCollector, type Log } from "./collector.js";
import { GitWatcher } from "./watch.js";

export interface GitSchedulerOptions {
  projectRoots: readonly string[];
  serverUrl: string;
  token: string;
  log: Log;
  fetchImpl?: typeof fetch;
  applyCatchups?: boolean;
  /** Voller Scan im Takt (Standard 3 Min). */
  intervalMs?: number;
  /** Probe-Merges + Nachziehen höchstens so oft (Standard 10 Min). */
  probeIntervalMs?: number;
  watchDebounceMs?: number;
  /** Mindestabstand zwischen zwei Läufen, die der Wächter auslöst (Standard 30 s). */
  minGapMs?: number;
  /** Nach einem gescheiterten Lauf (Server/Tunnel nicht da) so bald wieder versuchen (Standard 20 s,
   * verdoppelt sich bis zum normalen Takt). */
  retryMs?: number;
  /** Nach jedem Lauf, den der Server angenommen hat (Status für die Verbindungs-Prüfung). */
  onScanned?: () => void;
}

export class GitScheduler {
  private readonly state = newCollectorState();
  private readonly watcher: GitWatcher;
  private readonly timers: NodeJS.Timeout[] = [];
  private busy: Promise<void> | null = null;
  private again = false;
  private lastProbeAt = 0;
  private lastRunEndedAt = 0;
  private gapTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 0;
  private closed = false;

  constructor(private readonly o: GitSchedulerOptions) {
    this.watcher = new GitWatcher(() => this.trigger("aenderung"), { debounceMs: o.watchDebounceMs ?? 1500, log: o.log });
  }

  start(): void {
    void this.trigger("start");
    this.timers.push(setInterval(() => void this.trigger("takt"), this.o.intervalMs ?? 3 * 60_000));
  }

  /** Einen Lauf anstoßen. Läuft schon einer, folgt genau ein weiterer danach. */
  trigger(reason: "start" | "takt" | "aenderung"): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    if (reason === "aenderung") {
      // Last: viele Agenten-Worktrees committen oft — ohne spürbaren Mindestabstand
      // liefe der volle Scan (Hunderte git-Aufrufe) fast ununterbrochen.
      const wait = this.lastRunEndedAt + (this.o.minGapMs ?? 30_000) - Date.now();
      if (wait > 0) {
        if (!this.gapTimer) {
          this.gapTimer = setTimeout(() => {
            this.gapTimer = null;
            void this.trigger("aenderung");
          }, wait);
        }
        return Promise.resolve();
      }
    }
    this.busy = this.loop(reason).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async loop(reason: string): Promise<void> {
    let why = reason;
    do {
      this.again = false;
      const probe = Date.now() - this.lastProbeAt >= (this.o.probeIntervalMs ?? 10 * 60_000);
      try {
        const { gitDirs, ok } = await runGitCollector({
          projectRoots: this.o.projectRoots,
          serverUrl: this.o.serverUrl,
          token: this.o.token,
          log: this.o.log,
          fetchImpl: this.o.fetchImpl,
          applyCatchups: this.o.applyCatchups ?? false,
          probe,
          state: this.state,
        });
        if (probe && ok) this.lastProbeAt = Date.now();
        if (ok) this.o.onScanned?.();
        if (gitDirs) this.watcher.update(gitDirs);
        this.scheduleRetry(ok);
      } catch (e) {
        this.o.log("git-lauf-fehler", { grund: why, error: String(e) });
        this.scheduleRetry(false);
      }
      this.lastRunEndedAt = Date.now();
      why = "aenderung-waehrend-lauf";
    } while (this.again && !this.closed);
  }

  /** Der erste Lauf nach dem Brücken-Start scheitert oft, weil der Tunnel noch nicht steht
   * (die Brücke startet den Scheduler zwar erst, wenn Tunnel und Kanal stehen — höchstens 15 s
   * gewartet, der Server kann aber gerade weg sein). Dann nicht 3 Min bis zum Takt warten, sondern bald wieder
   * versuchen — billig, denn ohne erreichbaren Server scannt der Lauf nichts (s. collector.ts). */
  private scheduleRetry(ok: boolean): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (ok || this.closed) {
      this.retryDelay = 0;
      return;
    }
    const base = this.o.retryMs ?? 20_000;
    this.retryDelay = Math.min(this.retryDelay > 0 ? this.retryDelay * 2 : base, this.o.intervalMs ?? 3 * 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.trigger("takt");
    }, this.retryDelay);
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.watcher.close();
    await this.busy;
  }
}
