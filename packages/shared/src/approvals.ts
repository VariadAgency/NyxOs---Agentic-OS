// Leitplanken + Freigabe-Anfragen. Vertrag zwischen Hook-Skript der Brücke
// (`apps/bridge/src/guard/`), Server (`apps/server/src/routes/approvals.ts`) und Web (`features/inbox`).
import { z } from "zod";
import { lazyRecord } from "./lazy-text.js";

/** Jede Regel, die ein Befehl verletzen kann. Eine Freigabe gilt immer für GENAU einen Befehl. */
export const GuardRuleSchema = z.enum([
  "git_push",
  "merge_main",
  "deploy",
  "migration",
  "delete_outside_worktree",
  "session_close",
  "entry_done",
  /** Grundsatz „nicht prüfbar → fragen“: Skript/Interpreter/Alias mit unbekanntem Inhalt. */
  "unchecked",
  /** Schreibender Zugriff auf GitHub (API, gh-Befehle), außer Merge (→ merge_main). */
  "github_write",
]);
export type GuardRule = z.infer<typeof GuardRuleSchema>;

export const GUARD_RULE_LABELS: Record<GuardRule, string> = lazyRecord({
  git_push: "git push",
  merge_main: "Merge/Rebase auf main",
  deploy: "Deploy",
  migration: "DB-Migration",
  delete_outside_worktree: "Löschen außerhalb der Worktree",
  session_close: "Session endgültig schließen",
  entry_done: "Aufgabe auf „Erledigt“",
  unchecked: "Nicht prüfbarer Befehl",
  github_write: "Änderung auf GitHub",
});

export const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "consumed", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.number().int(),
  status: ApprovalStatusSchema,
  rule: GuardRuleSchema,
  reason: z.string(),
  tool: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  sessionKey: z.string().nullable(),
  auftrag: z.string().nullable(),
  worktree: z.string().nullable(),
  /** Wie oft die Session denselben Befehl erneut versucht hat, solange die Anfrage offen war. */
  attempts: z.number().int(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  consumedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalDecisionSchema = z.object({ decision: z.enum(["approve", "deny"]) });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Hook → Server (`POST /guard/check`, Maschinen-Token). Nur blockierte Befehle kommen hier an. */
export const GuardCheckSchema = z.object({
  tool: z.string().min(1).max(64),
  command: z.string().min(1).max(8000),
  cwd: z.string().max(2000).nullable(),
  sessionId: z.string().max(200).nullable(),
  auftrag: z.string().max(200).nullable(),
  worktree: z.string().max(2000).nullable(),
  rule: GuardRuleSchema,
  reason: z.string().max(500),
});
export type GuardCheck = z.infer<typeof GuardCheckSchema>;

export const GuardCheckResultSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  approvalId: z.number().int().nullable(),
  message: z.string(),
});
export type GuardCheckResult = z.infer<typeof GuardCheckResultSchema>;
