// Skill-Bibliothek: Fetch-Helfer (eigene Datei je Bereich).
import type { SkillDetail, SkillJob, SkillJobRequest, SkillsOverview, SkillSource, SkillVersion } from "@nyxos/shared";
import { writeJson } from "../../lib/api";
import { getJson } from "../../lib/http";

export const skillsKey = ["skills"] as const;
export const skillKey = (key: string) => ["skills", "detail", key] as const;

const enc = encodeURIComponent;

export const fetchSkills = (): Promise<SkillsOverview> => getJson<SkillsOverview>("/api/skills");
export const fetchSkill = (key: string): Promise<SkillDetail> => getJson<SkillDetail>(`/api/skills/${enc(key)}`);
export const fetchSkillVersion = (key: string, id: number): Promise<{ content: string; previous: string | null }> => getJson(`/api/skills/${enc(key)}/versions/${id}`);
export const fetchSkillFile = (key: string, rel: string): Promise<{ content: string | null; truncated: boolean }> => getJson(`/api/skills/${enc(key)}/file?rel=${enc(rel)}`);

export const syncSkills = (): Promise<{ bridge: SkillsOverview["bridge"] }> => writeJson("POST", "/api/skills/sync", {});
export const startSkillJob = (req: SkillJobRequest): Promise<{ job: SkillJob }> => writeJson("POST", "/api/skills/jobs", req);
export const restoreSkillVersion = (key: string, id: number): Promise<{ version: SkillVersion }> => writeJson("POST", `/api/skills/${enc(key)}/versions/${id}/restore`, {});
export const pinSkill = (key: string, pinned: boolean): Promise<{ pinned: boolean }> => writeJson("POST", `/api/skills/${enc(key)}/pin`, { pinned });
export const setSuggestionStatus = (id: number, status: "open" | "verworfen"): Promise<unknown> => writeJson("PATCH", `/api/skills/suggestions/${id}`, { status });

/** Farbe je Herkunft – Kategorien bunt, nie grau (AGENT-REGELN). */
export const SOURCE_COLOR: Record<SkillSource, string> = {
  user: "var(--a-acc)",
  project: "var(--a-violet)",
  nyxos: "var(--a-lime)",
  plugin: "var(--a-conf)",
  synced: "var(--a-claude)",
  builtin: "var(--a-done)",
};

/** Hintergrund in der Farbe der Herkunft (dezent). */
export const tint = (color: string, pct = 14): string => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
