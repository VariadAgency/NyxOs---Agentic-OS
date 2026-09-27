// Automatisches Nachziehen. Reine Entscheidung (`decideCatchup`) + Ausführung
// (`runCatchup`, nur für den klaren "merge"-Fall — alles andere fasst die Worktree nicht an).
import { t, type CatchupOutcome, type CatchupRecord } from "@nyxos/shared";
import { runGit } from "./exec.js";
import { probeMerge } from "./probeMerge.js";

export interface CatchupInput {
  probeStatus: "clean" | "conflict";
  /** Aus `tracker.known()` der Brücke: arbeitet gerade eine Session unter diesem Worktree-Pfad? */
  hasActiveSession: boolean;
  /** Arbeitskopie sauber (keine ungesicherten Änderungen)? Nur dann automatisch mergen. */
  workingTreeClean: boolean;
}

/**
 * Regel: "Probe-Merge sauber UND keine laufende Session darin → automatisch mergen.
 * Probe-Merge mit Konflikt ODER Session läuft → nichts anfassen, Nachzieh-Session."
 * Zusätzliche, im GOAL-Text implizite Bedingung: eine schmutzige Arbeitskopie wird nie angefasst
 * (sonst könnte ein Merge unbemerkte lokale Änderungen überschreiben/vermischen).
 */
export function decideCatchup(input: CatchupInput): { action: "merge" | "nachzieh-session" | "skip"; reason: string } {
  if (input.probeStatus === "conflict") return { action: "nachzieh-session", reason: t("Probe-Merge zeigt einen Konflikt") };
  if (input.hasActiveSession) return { action: "nachzieh-session", reason: t("eine Session arbeitet gerade in dieser Worktree") };
  if (!input.workingTreeClean) return { action: "skip", reason: t("Arbeitskopie nicht sauber (ungesicherte Änderungen)") };
  return { action: "merge", reason: t("Probe-Merge sauber, Worktree ruht") };
}

function outcomeFor(action: ReturnType<typeof decideCatchup>["action"]): CatchupOutcome {
  if (action === "merge") return "merged";
  if (action === "nachzieh-session") return "nachzieh-session";
  return "skipped-dirty";
}

/**
 * Führt das Nachziehen für EINE Worktree aus. Merged NUR im "merge"-Fall (`git merge --no-edit`,
 * die einzige schreibende Ausnahme neben `merge-tree`, s. exec.ts) — sonst wird die Worktree nicht
 * angefasst und der Aufrufer legt stattdessen eine Nachzieh-Session an.
 *
 * **Sicherheits-Standard (`apply`, Default `false`):** Ohne ausdrückliches `apply: true` wird NIE
 * gemergt, auch wenn die Entscheidung "merge" lautet — nur die Entscheidung wird berichtet
 * (`outcome: "nachzieh-session"`, `detail` erklärt "wäre sauber mergebar"). Grund: `decideCatchup`
 * kennt nur EIGENE Reservierungen/Sessions der NyxOS, nicht jede denkbare Bedeutung einer
 * Worktree für einen Menschen oder ein anderes Werkzeug — ein echter, automatischer Merge im
 * echten App-Repo braucht darum eine bewusste Freigabe (Umgebungsvariable
 * `NYXOS_GIT_CATCHUP_APPLY=1`, s. collector.ts), nicht nur "keine bekannte Session drin". Tests
 * gegen TEMPORÄRE Repos dürfen `apply: true` setzen (dort ist "echt mergen" genau das, was geprüft wird).
 */
export async function runCatchup(opts: { repoId: string; worktreePath: string; branch: string; mainBranch: string; hasActiveSession: boolean; apply?: boolean }): Promise<CatchupRecord> {
  const apply = opts.apply ?? false;
  const probe = await probeMerge(opts.worktreePath, opts.mainBranch, opts.branch);
  const statusText = (await runGit(opts.worktreePath, ["status", "--porcelain=v2"])).stdout.split("\n").filter((l) => l && !l.startsWith("#"));
  const workingTreeClean = statusText.length === 0;
  const decision = decideCatchup({ probeStatus: probe.status, hasActiveSession: opts.hasActiveSession, workingTreeClean });

  const mainShaBefore = (await runGit(opts.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const at = new Date().toISOString();

  if (decision.action !== "merge") {
    return { repoId: opts.repoId, worktreePath: opts.worktreePath, branch: opts.branch, outcome: outcomeFor(decision.action), mainShaBefore, mainShaAfter: null, detail: decision.reason, at };
  }
  if (!apply) {
    return {
      repoId: opts.repoId,
      worktreePath: opts.worktreePath,
      branch: opts.branch,
      outcome: "nachzieh-session",
      mainShaBefore,
      mainShaAfter: null,
      detail: t("wäre sauber mergebar (Probe-Merge sauber, Worktree ruht) — automatisches Anwenden ist per Sicherheits-Standard ausgeschaltet (NYXOS_GIT_CATCHUP_APPLY=1 zum Aktivieren, nach Freigabe)"),
      at,
    };
  }

  const merge = await runGit(opts.worktreePath, ["merge", "--no-edit", opts.mainBranch]);
  if (!merge.ok) {
    const detail = await abortAndVerifyClean(opts.worktreePath, merge.stderr);
    return { repoId: opts.repoId, worktreePath: opts.worktreePath, branch: opts.branch, outcome: "nachzieh-session", mainShaBefore, mainShaAfter: null, detail, at };
  }
  const mainShaAfter = (await runGit(opts.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return { repoId: opts.repoId, worktreePath: opts.worktreePath, branch: opts.branch, outcome: "merged", mainShaBefore, mainShaAfter, detail: t("automatisch nachgezogen"), at };
}

/**
 * Ein `git merge`, der trotz sauberem Probe-Merge fehlschlägt (z. B. ein
 * Zeitfenster-Race — neue Commits zwischen Probe und echtem Merge — oder eine Situation, die
 * `merge-tree` nicht sieht, etwa im Weg stehende ungetrackte Dateien), durfte die Worktree bisher
 * mit Konfliktmarkern/`MERGE_HEAD` HALB gemergt zurücklassen — jeder folgende Git-Aufruf dort wäre
 * verwirrt, und ein Mensch müsste von Hand aufräumen. `git merge --abort` kehrt zum Stand vor dem
 * Merge-Versuch zurück; sein eigener Fehler wird bewusst verschluckt (kein Merge lief z. B., wenn
 * Git den Versuch schon VOR dem Start abgelehnt hat) — DANACH wird der Status GEPRÜFT, nicht nur
 * angenommen, damit ein Aufrufer nie eine „halbe" Worktree bekommt.
 */
export async function abortAndVerifyClean(worktreePath: string, mergeStderr: string): Promise<string> {
  await runGit(worktreePath, ["merge", "--abort"]);
  const statusText = (await runGit(worktreePath, ["status", "--porcelain=v2"])).stdout.split("\n").filter((l) => l && !l.startsWith("#"));
  const clean = statusText.length === 0;
  const failMsg = mergeStderr.trim().slice(0, 200);
  return clean
    ? t("Merge trotz sauberem Probe-Merge fehlgeschlagen ({error}) — Sicherheitsnetz, geht an eine Nachzieh-Session", { error: failMsg })
    : t("Merge trotz sauberem Probe-Merge fehlgeschlagen ({error}) — ACHTUNG: Arbeitskopie nach 'git merge --abort' NICHT sauber, bitte von Hand prüfen — Sicherheitsnetz, geht an eine Nachzieh-Session", { error: failMsg });
}
