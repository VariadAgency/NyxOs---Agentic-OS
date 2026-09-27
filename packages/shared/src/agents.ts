// Typen für den Tab "Agenten & Skills".
import { z } from "zod";

/** Nur, wenn der Agent selbst so ein Urteil ausgibt (Gate-Agenten tun das) — sonst `null` ("ohne
 * Urteil"). */
export const AgentVerdictSchema = z.enum(["PASS", "PASS_WITH_NOTES", "BLOCK"]);
export type AgentVerdict = z.infer<typeof AgentVerdictSchema>;

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
  verdict: AgentVerdict | null;
  running: boolean;
}

/** Obergrenze für den Prompt eines Agenten (Zeichen). Längere Prompts kürzt die Brücke. */
export const AGENT_PROMPT_MAX_CHARS = 20_000;
/** Grenzen der übrigen Felder — die Brücke kürzt auf genau diese Werte. */
export const AGENT_MODEL_MAX = 100;
export const AGENT_COLOR_MAX = 40;
export const AGENT_TOOLS_MAX = 200;
export const AGENT_TOOL_NAME_MAX = 200;

/** Was eine Agenten-Kachel über den Agenten zeigt — aus dem Frontmatter (`model`, `tools`,
 * `color`) und dem Text danach (`prompt`). Nur für `kind: "agent"`. */
export const AgentDetailsSchema = z.object({
  model: z.string().max(AGENT_MODEL_MAX).nullable(),
  tools: z.array(z.string().max(AGENT_TOOL_NAME_MAX)).max(AGENT_TOOLS_MAX),
  color: z.string().max(AGENT_COLOR_MAX).nullable(),
  prompt: z.string().max(AGENT_PROMPT_MAX_CHARS),
});
export type AgentDetails = z.infer<typeof AgentDetailsSchema>;

/** Bestand: Name/Beschreibung/Pfad, gemeldet von der Brücke bei Änderung. */
export const CatalogEntrySchema = z.object({
  kind: z.enum(["agent", "skill"]),
  name: z.string().min(1),
  description: z.string().nullable(),
  path: z.string().min(1),
  source: z.string().min(1),
  /** optional, damit ältere Brücken gültig bleiben. */
  details: AgentDetailsSchema.nullable().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogBatchSchema = z.object({ items: z.array(CatalogEntrySchema).min(1).max(2000) });
export type CatalogBatch = z.infer<typeof CatalogBatchSchema>;

export interface SkillUsageStat {
  skill: string;
  runs7d: number;
  lastUsedAt: string | null;
}

export type Anomaly =
  | { kind: "skill_unused"; skill: string; sinceDays: number }
  | { kind: "skill_missing_required"; skill: string; expectedPer7d: number; actual: number }
  | { kind: "gate_repeated_block"; agentName: string; sessionKey: string; count: number };
