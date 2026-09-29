// Datei-Wächter auf die `.git`-Ordner der gescannten Repos. Reagiert nur auf das, was
// eine echte Git-Aktion hinterlässt (HEAD, refs/, logs/, packed-refs, HEAD/logs einer Worktree) —
// nicht auf `index` (den frischt schon ein `git status` auf) und nicht auf `objects/`. Mehrere
// Ereignisse kurz hintereinander (ein Commit schreibt mehrere Dateien) werden gebündelt.
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

export interface GitWatcherOptions {
  /** Ruhezeit nach dem letzten Ereignis, bevor gemeldet wird. */
  debounceMs?: number;
  /** Spätestens nach dieser Zeit wird gemeldet, auch wenn weiter Ereignisse kommen. */
  maxWaitMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Ist diese Datei (relativ zum `.git`-Ordner) ein Zeichen für eine Git-Aktion? */
export function isRelevantGitPath(rel: string): boolean {
  const p = rel.split(sep).join("/");
  if (p.endsWith(".lock")) return false;
  if (p === "HEAD" || p === "packed-refs") return true;
  if (p.startsWith("refs/") || p.startsWith("logs/")) return true;
  return /^worktrees\/[^/]+\/(HEAD|logs\/)/.test(p);
}

export class GitWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly onChange: () => void,
    private readonly opts: GitWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 1500;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
  }

  /** Beobachtet genau diese `.git`-Ordner (neue kommen dazu, weggefallene werden beendet). */
  update(gitDirs: string[]): void {
    if (this.closed) return;
    const wanted = new Set(gitDirs);
    for (const [dir, w] of this.watchers) {
      if (wanted.has(dir)) continue;
      w.close();
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        // macOS: rekursiv über FSEvents (ein Stream je Ordner, billig).
        const w = watch(dir, { recursive: true }, (_event, name) => {
          if (name && isRelevantGitPath(String(name))) this.poke();
        });
        w.on("error", (e) => {
          this.opts.log?.("git-waechter-fehler", { dir, error: String(e) });
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch (e) {
        this.opts.log?.("git-waechter-fehler", { dir, error: String(e) });
      }
    }
  }

  private poke(): void {
    if (this.closed) return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.onChange();
    }, wait);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
