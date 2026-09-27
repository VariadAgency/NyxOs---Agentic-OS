// Onboarding (first start): contract between the server (`apps/server/src/routes/onboarding.ts`) and the web wizard
// (`apps/web/src/features/onboarding/`). The wizard reuses the existing APIs for everything else
// (`/api/access`, `/api/app/settings`, `/api/nyx/profile`, `/api/setup`, `/api/haiku/selftest`).
import { z } from "zod";
import type { NyxProfile } from "./nyx-persona.js";

/** Providers the wizard offers directly (API key or local app). */
export const ONBOARDING_PROVIDERS = ["anthropic", "openai", "openrouter", "ollama", "lmstudio"] as const;
export const OnboardingProviderSchema = z.enum(ONBOARDING_PROVIDERS);
export type OnboardingProvider = z.infer<typeof OnboardingProviderSchema>;

export interface OnboardingProviderState {
  kind: OnboardingProvider;
  /** Key/address saved. */
  configured: boolean;
  /** Result of the last test: `null` = never tested. */
  ok: boolean | null;
  /** Plain words from the last test. */
  message: string | null;
  /** Number of models the provider listed at the last test. */
  models: number;
}

/** `GET /api/onboarding/ai`: can Nyx answer right now, and over which access? */
export interface OnboardingAiState {
  /** Nyx could start a run right now (engine there, budget left). */
  ready: boolean;
  /** Why not, in plain words (`null` when ready). */
  reason: string | null;
  /** What Nyx' chat runs on: the Claude program (Claude account) or a provider (API key / local model). */
  via: "claude-cli" | "provider" | "off";
  /** Readable name of the model Nyx uses for the chat. */
  modelLabel: string | null;
  cli: {
    /** The `claude` program was found on this computer (or the server's engine). */
    found: boolean;
    version: string | null;
    /** A token from `claude setup-token` is set (server mode). */
    token: boolean;
  };
  /** Last time Nyx really answered (proves the login), `null` = never. */
  lastAnswerAt: string | null;
  providers: OnboardingProviderState[];
  /** Daily budget cap in USD (API equivalent). */
  budgetUsd: number;
  /** Spent today in USD. */
  spentTodayUsd: number;
}

/** `POST /api/onboarding/ai/use`: let Nyx (chat, briefing, voice) run on this provider. */
export const OnboardingUseProviderSchema = z
  .object({
    provider: OnboardingProviderSchema,
    /** Optional exact model id; otherwise a small, cheap default is picked. */
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type OnboardingUseProvider = z.infer<typeof OnboardingUseProviderSchema>;

export interface OnboardingUseProviderResult {
  provider: OnboardingProvider;
  model: string;
  label: string;
}

const answer = z.string().trim().max(2000);

/** `POST /api/onboarding/interview`: the three answers from the interview. */
export const OnboardingInterviewSchema = z
  .object({
    name: z.string().trim().max(60).default(""),
    /** Who are you? */
    who: answer.default(""),
    /** What do you work on? */
    work: answer.default(""),
    /** How should Nyx behave? */
    style: answer.default(""),
  })
  .strict();
export type OnboardingInterview = z.infer<typeof OnboardingInterviewSchema>;

export interface OnboardingInterviewResult {
  /** Suggested full profile (not saved yet – the wizard shows it for editing and saves it with `PUT /api/nyx/profile`). */
  profile: NyxProfile;
  /** `nyx` = Nyx understood the answers, `rules` = simple mapping without AI. */
  source: "nyx" | "rules";
  /** Short sentences: what was understood (shown above the form). */
  understood: string[];
}

/** `POST /api/onboarding/finish`. */
export const OnboardingFinishSchema = z
  .object({
    userName: z.string().trim().min(1).max(60),
    lang: z.enum(["de", "en"]).optional(),
    /** Start a first briefing in the background (only if Nyx is ready). */
    briefing: z.boolean().optional(),
  })
  .strict();
export type OnboardingFinish = z.infer<typeof OnboardingFinishSchema>;

export interface OnboardingFinishResult {
  userName: string;
  onboardingDone: true;
  briefing: "started" | "skipped";
}

/** The five steps of the wizard, top to bottom. */
export const ONBOARDING_STEPS = ["welcome", "ai", "interview", "setup", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
