// Dünner, NUR LESENDER Git-Aufruf für die Brücke. Niemals `add`/`commit`/`checkout`/`push` —
// die einzigen schreibenden Ausnahmen sind `merge-tree` (Plumbing, rührt die Arbeitskopie nie an)
// Und, für das automatische Nachziehen, ein `merge --ff-only`/`merge --no-edit` in
// einer RUHENDEN, KONFLIKTFREIEN Worktree (s. catchup.ts) — beides bewusst getrennt von diesem
// generischen Read-Runner über einen eigenen, benannten Aufruf (kein "beliebige Argumente" API).
import { execFile } from "node:child_process";

export interface GitResult {
  ok: boolean;
  /** Exit-Code (0 = ok, -1 = abgebrochen/nicht startbar). */
  code: number;
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = 10_000;

/**
 * `git status`/`git log` etc. schreiben NEBENBEI den Index neu (Refresh-Stat-
 * Cache) und nehmen dafür kurz `.git/index.lock` — läuft das alle 10 Minuten in einer Worktree, in
 * der gerade eine Session `git add`/`git commit` ausführt, kann DEREN Befehl mit "index.lock
 * exists" scheitern. `--no-optional-locks` (Git ≥ 2.20) unterdrückt genau das: Befehle, die die
 * Sperre nur optional bräuchten, überspringen sie und liefern ggf. leicht veraltete (aber nie
 * falsche) Werte — für einen reinen Anzeige-Scan der richtige Kompromiss.
 */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  await acquireSlot();
  try {
    return await new Promise<GitResult>((resolve) => {
      execFile("git", ["--no-optional-locks", "-c", "core.quotePath=false", ...args], { cwd, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1;
        resolve({ ok: !err, code, stdout: stdout ?? "", stderr: stderr ?? String(err ?? "") });
      });
    });
  } finally {
    releaseSlot();
  }
}

/**
 * Höchstens so viele `git`-Prozesse der Brücke gleichzeitig. Vorher startete
 * `scanRepo` je Zweig zwei Prozesse auf einmal (NyxOS: 45 Zweige → 90 parallel, dazu die übrigen
 * Repos) — das Starten selbst hält auf macOS den Event-Loop an und verdrängt Lebenszeichen und
 * Kanal der ohnehin überlasteten Brücke. Gilt für jeden Aufruf (Scan, Probe-Merge, Nachziehen).
 */
const MAX_PARALLEL_GIT = 4;
let running = 0;
const waiting: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (running < MAX_PARALLEL_GIT) {
    running++;
    return Promise.resolve();
  }
  // Der Platz wird beim Freigeben direkt übergeben (`running` bleibt gleich).
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** Wie `runGit`, wirft aber bei Fehler (für Stellen, an denen ein Fehlschlag den ganzen Scan
 * dieses Repos ungültig macht, z. B. "ist das überhaupt ein Git-Repo?"). */
export async function runGitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} in ${cwd} fehlgeschlagen: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}
