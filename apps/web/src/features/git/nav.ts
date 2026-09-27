// Großansichten der Git-Seite stehen in der Adresse (`/git?g=commit&r=app&k=<sha>`) — jede
// Ansicht ist verlinkbar, die Browser-Zurück-Taste geht eine Ebene zurück, „Schließen“ springt über
// alle geöffneten Ebenen zurück (Tiefe steht im History-State, wie bei der Aufgaben-Großansicht).
import { useLocation, useNavigate, useSearchParams } from "react-router";

export type GitTargetKind = "commit" | "branch" | "worktree" | "day";

export interface GitTarget {
  t: GitTargetKind;
  /** Repo (commit/branch/worktree); bei „day“ leer. */
  repoId?: string;
  /** SHA, Zweigname oder Tag (YYYY-MM-DD). */
  key?: string;
}

export function targetHref(target: GitTarget): string {
  const p = new URLSearchParams({ g: target.t });
  if (target.repoId) p.set("r", target.repoId);
  if (target.key) p.set("k", target.key);
  return `/git?${p.toString()}`;
}

export function useGitNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const depth = (location.state as { gDepth?: number } | null)?.gDepth ?? 0;
  const g = params.get("g");
  const current: GitTarget | null = g === "commit" || g === "branch" || g === "worktree" || g === "day" ? { t: g, repoId: params.get("r") ?? undefined, key: params.get("k") ?? undefined } : null;
  return {
    current,
    depth,
    open(target: GitTarget) {
      navigate(targetHref(target), { state: { gDepth: depth + 1 } });
    },
    back() {
      if (depth > 0) navigate(-1);
      else navigate("/git", { replace: true });
    },
    close() {
      if (depth > 0) navigate(-depth);
      else navigate("/git", { replace: true });
    },
  };
}
