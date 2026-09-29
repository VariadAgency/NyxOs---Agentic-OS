// Fetch-Helfer für den Tab "Agenten & Skills" (eigene Datei je Bereich).
import type { Anomaly, CatalogEntry } from "@nyxos/shared";
import { getJson } from "../../lib/http";

export interface AgentRun {
  id: string;
  tool: "claude" | "codex";
  parentSessionKey: string | null;
  parentTitle: string | null;
  agentName: string | null;
  agentType: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  toolCalls: number;
  verdict: "PASS" | "PASS_WITH_NOTES" | "BLOCK" | null;
  running: boolean;
}

export interface SkillUsageStat {
  skill: string;
  runs7d: number;
  lastUsedAt: string | null;
}

export type CatalogRow = CatalogEntry & { seenAt: string };

/** `limit=1000` (Server-Höchstwert) — mit dem Standard 200 fehlten in „Alle Agenten" ältere Läufe. */
export const fetchAgentRuns = (filter?: "running" | "today"): Promise<AgentRun[]> => getJson<{ runs: AgentRun[] }>(`/api/agents/runs?limit=1000${filter ? `&filter=${filter}` : ""}`).then((r) => r.runs);

export const fetchCatalog = (): Promise<CatalogRow[]> => getJson<{ catalog: CatalogRow[] }>("/api/agents/catalog").then((r) => r.catalog);

export const fetchSkillUsage = (): Promise<SkillUsageStat[]> => getJson<{ skills: SkillUsageStat[] }>("/api/agents/skills/usage").then((r) => r.skills);

export const fetchAnomalies = (): Promise<Anomaly[]> => getJson<{ anomalies: Anomaly[] }>("/api/agents/anomalies").then((r) => r.anomalies);
