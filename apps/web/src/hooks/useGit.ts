import { useQuery } from "@tanstack/react-query";
import { fetchGit, fetchGitBranch, fetchGitCatchups, fetchGitCommit, fetchGitDashboard, fetchGitDay, fetchGitWorktree } from "../lib/api";

/** Git-Stand aller Repos (Rohform, u. a. für das Konflikte-Tab). */
export function useGit() {
  return useQuery({ queryKey: ["git"], queryFn: fetchGit, refetchInterval: 30_000 });
}

export function useGitCatchups(repoId?: string) {
  return useQuery({ queryKey: ["git-catchups", repoId ?? null], queryFn: () => fetchGitCatchups(repoId), refetchInterval: 30_000 });
}

/** Alles für die Git-Seite. Solange die Brücke scannt, öfter nachsehen (Fortschritt). */
export function useGitDashboard() {
  return useQuery({
    queryKey: ["git-dashboard"],
    queryFn: fetchGitDashboard,
    refetchInterval: (q) => {
      const scan = q.state.data?.scan;
      const waitingForFirst = scan?.state === "never" && scan.bridge.state !== "offline";
      return scan?.state === "scanning" || waitingForFirst ? 3_000 : 20_000;
    },
  });
}

export function useGitCommit(repoId: string | null, sha: string | null) {
  return useQuery({ queryKey: ["git-commit", repoId, sha], queryFn: () => fetchGitCommit(repoId ?? "", sha ?? ""), enabled: !!repoId && !!sha });
}

export function useGitBranch(repoId: string | null, name: string | null) {
  return useQuery({ queryKey: ["git-branch", repoId, name], queryFn: () => fetchGitBranch(repoId ?? "", name ?? ""), enabled: !!repoId && !!name });
}

export function useGitWorktree(repoId: string | null) {
  return useQuery({ queryKey: ["git-worktree", repoId], queryFn: () => fetchGitWorktree(repoId ?? ""), enabled: !!repoId, refetchInterval: 20_000 });
}

export function useGitDay(day: string | null) {
  return useQuery({ queryKey: ["git-day", day], queryFn: () => fetchGitDay(day ?? ""), enabled: !!day });
}
