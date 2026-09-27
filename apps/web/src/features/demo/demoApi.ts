// Demo: start one from the onboarding (`POST /api/demo/start` → one-time sign-in URL of a separate demo instance),
// and inside the demo the facts from `/api/app/info` (demo, way back home, how Nyx answers) plus the questions
// Nyx can answer there (`GET /api/demo/questions`).
import { NYXOS_REPO, t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useAppInfo } from "../../hooks/useAppInfo";
import { ApiError, getJson } from "../../lib/http";
import { authFetch } from "../terminal/authClient";

export interface DemoFacts {
  demo: boolean;
  /** The user's real installation (its onboarding) — null for a standalone demo. */
  homeUrl: string | null;
  engine: "ai" | "scripted" | null;
  repo: string;
}

/** Demo facts; `demo` stays false while the app info is loading or failed (never blocks the real app). */
export function useDemo(): DemoFacts {
  const info = useAppInfo().data;
  const demo = info?.demo === true;
  return { demo, homeUrl: demo ? (info?.demoHomeUrl ?? null) : null, engine: demo ? (info?.demoEngine ?? null) : null, repo: info?.repo || NYXOS_REPO };
}

/** Starts a demo instance and returns its one-time sign-in URL. Errors carry the server's sentence. */
export async function startDemo(): Promise<string> {
  const res = await authFetch("/api/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
  if (!res.ok || typeof data.url !== "string" || !data.url) {
    throw new ApiError(typeof data.error === "string" && data.error ? data.error : t("Die Demo ließ sich gerade nicht starten – bitte gleich noch einmal versuchen."), res.status);
  }
  return data.url;
}

export const DEMO_QUESTIONS_KEY = ["demo", "questions"] as const;

/** Suggested questions for Nyx — only fetched inside the demo. */
export function useDemoQuestions(enabled: boolean) {
  return useQuery({
    queryKey: DEMO_QUESTIONS_KEY,
    queryFn: async () => (await getJson<{ questions: string[] }>("/api/demo/questions")).questions.filter((q) => typeof q === "string" && q.trim()),
    enabled,
    staleTime: Infinity,
  });
}

/** One-line installer for a standalone demo (no installation to go back to). */
export function installCommand(repo: string): string {
  return `curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | bash`;
}

/** Page changes of the demo flow (into the demo, back home). An object so tests can replace `go`. */
export const demoNav = {
  go(url: string): void {
    window.location.assign(url);
  },
};

/** Back to the real installation (its onboarding; the user is still signed in there). */
export function goHome(url: string): void {
  demoNav.go(url);
}
