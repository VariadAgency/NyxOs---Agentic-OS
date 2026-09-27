// Datenzugriff für `BuildStatusPill` (Session-Kopf/Überblick).
// Zustand immer über `describeBuildRun` (alte „spawn … ENOENT“-Läufe gelten als „nicht
// eingerichtet“, nicht als rot); „Letzte Builds“ kommen gebündelt (`useBuildGroups`).
import { describeBuildRun, groupBuildRuns, t, type BuildGroup, type BuildView, type BuildRunRow as SharedBuildRunRow } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import type { BuildRunLite } from "./BuildStatusPill";
import { authFetch } from "../terminal/authClient";

export interface BuildRunRow extends BuildRunLite {
  id: number;
  sessionKey: string | null;
  kind: "ios" | "backend" | "nyxos";
  command: string;
  exitCode: number | null;
  logExcerpt: string | null;
  /** Einordnung des ORIGINAL-Laufs (alte „spawn … ENOENT“-Läufe bekommen hier ihren
   * erklärenden Satz statt der Rohmeldung) — für Tooltip/Detail der Plakette. */
  view?: BuildView;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("Build-Läufe konnten nicht geladen werden ({status})", { status: res.status }));
  return (await res.json()) as T;
}

async function fetchRuns(sessionKey?: string): Promise<BuildRunRow[]> {
  const url = sessionKey ? `/api/builds?sessionKey=${encodeURIComponent(sessionKey)}` : "/api/builds/summary";
  const body = await fetchJson<{ runs?: BuildRunRow[]; recent?: BuildRunRow[] }>(url);
  return (body.runs ?? body.recent ?? []).map((r) => {
    const view = describeBuildRun(r);
    return { ...r, status: view.state, view };
  });
}

/** Ohne `sessionKey`: die letzten Läufe insgesamt (Überblick-Einzeiler). Mit `sessionKey`: nur diese Session. */
export function useBuilds(sessionKey?: string) {
  return useQuery({
    queryKey: ["builds", sessionKey ?? "alle"],
    queryFn: () => fetchRuns(sessionKey),
    refetchInterval: 15_000,
  });
}

/** Gleiche Fehler zu einem Eintrag gebündelt (vom Server; ältere Server ohne `groups` → hier gebündelt). */
export function useBuildGroups() {
  return useQuery({
    queryKey: ["builds", "gruppen"],
    queryFn: async () => {
      const body = await fetchJson<{ recent?: SharedBuildRunRow[]; groups?: BuildGroup[] }>("/api/builds/summary");
      return body.groups ?? groupBuildRuns(body.recent ?? []);
    },
    refetchInterval: 15_000,
  });
}

export async function triggerBuild(sessionKey: string | null, cwd: string): Promise<{ id: number; kind: string; command: string[] }> {
  const res = await authFetch("/api/builds/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, cwd }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: t("Fehler {status}", { status: res.status }) }))).error ?? t("Fehler {status}", { status: res.status }));
  return res.json();
}
