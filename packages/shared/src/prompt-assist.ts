// Prompt verbessern (Sessions-Tab): Der Nutzer tippt/diktiert einen Entwurf, Sonnet 5 (Denkstufe hoch)
// schreibt daraus mit dem Stand der Session einen klaren Prompt – auf Wunsch mit 1–5 Rückfragen.
// Server: `POST /api/sessions/:id/prompt-assist` (apps/server/src/routes/prompt-assist.ts).
import { z } from "zod";

/** Feste Modellwahl der Rolle `prompt.improve` – nie Haiku (Wunsch vom Nutzer, Server-Test). */
export const PROMPT_IMPROVE_MODEL = "claude-sonnet-5";
/** Denkstufe (Claude-Programm `--effort`). */
export const PROMPT_IMPROVE_EFFORT = "high" as const;
export const PROMPT_IMPROVE_LABEL = "Claude Sonnet 5 · claude-sonnet-5 · Reasoning hoch (Claude-Programm)";

export const PROMPT_DRAFT_MAX = 20_000;

export const PromptAssistAnswerSchema = z.object({
  frage: z.string().trim().min(1).max(1_000),
  auswahl: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
  text: z.string().trim().max(2_000).optional(),
});
export type PromptAssistAnswer = z.infer<typeof PromptAssistAnswerSchema>;

export const PromptAssistRequestSchema = z.object({
  entwurf: z.string().trim().min(1).max(PROMPT_DRAFT_MAX),
  /** Zuletzt verbesserter Prompt (Grundlage für Ergänzungen/Antworten). */
  bisher: z.string().trim().max(PROMPT_DRAFT_MAX).optional(),
  zusaetze: z.array(z.string().trim().min(1).max(4_000)).max(20).optional(),
  antworten: z.array(PromptAssistAnswerSchema).max(10).optional(),
  modus: z.enum(["verbessern", "fragen"]),
});
export type PromptAssistRequest = z.infer<typeof PromptAssistRequestSchema>;

export type PromptUnderstanding = "hoch" | "mittel" | "niedrig";

export interface PromptAssistQuestion {
  id: string;
  frage: string;
  optionen: string[];
  mehrfach: boolean;
}

export interface PromptAssistResult {
  prompt: string;
  aenderungen: string[];
  verstaendnis: PromptUnderstanding;
  fragen: PromptAssistQuestion[];
  /** Modell, das wirklich geantwortet hat (Anzeige „Sonnet 5 · hoch“). */
  model: string;
  effort: typeof PROMPT_IMPROVE_EFFORT;
  costUsd: number;
  durationMs: number;
}

/** Wie viele Rückfragen je Verständnis erlaubt sind (Wunsch der Nutzer: hoch 1–2, mittel 3, niedrig 5). */
export const QUESTION_RANGE: Record<PromptUnderstanding, { min: number; max: number }> = {
  hoch: { min: 1, max: 2 },
  mittel: { min: 3, max: 3 },
  niedrig: { min: 5, max: 5 },
};
