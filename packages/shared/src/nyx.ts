// Nyx-Kern: Vertrag zwischen Server (`apps/server/src/nyx`) und Web/Telegram.
// Gedächtnis, Lern-Vorschläge, Plan/To-do, geplante Aufgaben, Ablage (Bilder/Links) und die
// Live-Ereignisse `nyx.state` / `nyx.task` / `nyx.ui` / `nyx.notify` über den bestehenden WebSocket `/live`.
import { z } from "zod";
import { t } from "./i18n/index.js";
import type { NyxStateEvent, NyxTaskEventOut } from "./nyx-live.js";

// ───────────────────────────── Kanäle ─────────────────────────────

/** Woher eine Frage kommt: Web-Chat, gesprochen (Nyx-Tab/Begleiter) oder Telegram. Definiert in nyx-persona.ts. */
import { NyxChannelSchema, type NyxChannel } from "./nyx-persona.js";
import { lazyRecord } from "./lazy-text.js";
export { NyxChannelSchema, type NyxChannel };

// ───────────────────────────── Gedächtnis ─────────────────────────────

/** user = wer der Nutzer ist · project = Fakten über Projekte/NyxOS/Umgebung · preference = wie er es haben will. */
export const NyxMemoryCategorySchema = z.enum(["user", "project", "preference"]);
export type NyxMemoryCategory = z.infer<typeof NyxMemoryCategorySchema>;

export const NYX_MEMORY_CATEGORY_LABELS: Record<NyxMemoryCategory, string> = lazyRecord({
  user: "Über dich",
  project: "Projekt",
  preference: "Vorlieben",
});

/** Festes Zeichen-Budget je Kategorie (Hermes: user 1.375, memory 2.200) – das Gedächtnis geht in jeden Prompt. */
export const NYX_MEMORY_LIMITS: Record<NyxMemoryCategory, number> = {
  user: 1400,
  project: 2200,
  preference: 1100,
};

export interface NyxMemoryEntry {
  id: number;
  category: NyxMemoryCategory;
  fact: string;
  /** Herkunft: Faden/Nachricht, in der Nyx es gelernt hat (null = vom Nutzer im Tab eingetragen). */
  sourceThreadId: number | null;
  sourceMessageId: number | null;
  createdBy: "nyx" | "user" | "vorschlag";
  createdAt: string;
  updatedAt: string;
}

export interface NyxMemoryUsage {
  category: NyxMemoryCategory;
  label: string;
  chars: number;
  limit: number;
}

/** Vorschlag der Hintergrund-Lernprüfung – nie still gespeichert, der Nutzer hakt ab. */
export interface NyxMemorySuggestion {
  id: number;
  action: "add" | "replace" | "remove";
  category: NyxMemoryCategory;
  fact: string;
  /** Bei replace/remove: welcher Eintrag betroffen ist. */
  memoryId: number | null;
  reason: string | null;
  sourceThreadId: number | null;
  status: "open" | "accepted" | "rejected";
  createdAt: string;
}

export interface NyxMemoryView {
  entries: NyxMemoryEntry[];
  usage: NyxMemoryUsage[];
  suggestions: NyxMemorySuggestion[];
}

export const NyxMemoryCreateSchema = z.object({
  category: NyxMemoryCategorySchema,
  fact: z.string().trim().min(3).max(600),
});

export const NyxMemoryPatchSchema = z
  .object({
    category: NyxMemoryCategorySchema.optional(),
    fact: z.string().trim().min(3).max(600).optional(),
  })
  .refine((v) => v.category !== undefined || v.fact !== undefined, { error: () => t("Nichts zu ändern") });

export const NyxSuggestionDecisionSchema = z.object({ accept: z.boolean() });

// ───────────────────────────── Plan / To-do ─────────────────────────────

export const NyxTodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type NyxTodoStatus = z.infer<typeof NyxTodoStatusSchema>;

export interface NyxTodoItem {
  id: string;
  content: string;
  status: NyxTodoStatus;
  /** Pflicht bei „completed“: womit geprüft wurde, dass es wirklich erledigt ist. */
  evidence?: string;
}

export interface NyxTodoList {
  threadId: number;
  revision: number;
  items: NyxTodoItem[];
  updatedAt: string;
}

// ───────────────────────────── Geplante Aufgaben ─────────────────────────────

/** Ereignisse, auf die „wenn X passiert“ hören kann (deterministisch geprüft, ohne Modell). */
export const NyxScheduleEventSchema = z.enum(["build_red", "session_waiting", "session_closed", "approval_open"]);
export type NyxScheduleEvent = z.infer<typeof NyxScheduleEventSchema>;

export const NYX_SCHEDULE_EVENT_LABELS: Record<NyxScheduleEvent, string> = lazyRecord({
  build_red: "Build wird rot",
  session_waiting: "Session ist fertig und wartet",
  session_closed: "Session wurde geschlossen",
  approval_open: "Neue Freigabe-Anfrage",
});

/** Vorab-Prüfung ohne Modellaufruf: nur wenn sie zutrifft, läuft Nyx überhaupt. */
export const NyxPrecheckSchema = z.enum(["build_red", "sessions_waiting", "approvals_open", "inbox_open"]);
export type NyxPrecheck = z.infer<typeof NyxPrecheckSchema>;

export const NyxDeliverSchema = z.enum(["web", "telegram", "both"]);
export type NyxDeliver = z.infer<typeof NyxDeliverSchema>;

/** remind = nur erinnern (Text wird zugestellt, KEIN Modellaufruf) · run = Nyx führt die Aufgabe aus und berichtet. */
export const NyxScheduleModeSchema = z.enum(["remind", "run"]);
export type NyxScheduleMode = z.infer<typeof NyxScheduleModeSchema>;

export const NyxScheduleWhenSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.string().datetime({ offset: true }).optional(), inMinutes: z.number().int().min(1).max(60 * 24 * 60).optional() }),
  z.object({ type: z.literal("cron"), cron: z.string().min(9).max(100) }),
  z.object({ type: z.literal("event"), event: NyxScheduleEventSchema, filter: z.string().max(120).optional() }),
]);
export type NyxScheduleWhen = z.infer<typeof NyxScheduleWhenSchema>;

/** Uhrzeit „HH:MM“ (00:00–23:59) oder „24:00“ = bis Mitternacht. */
export const NYX_HHMM_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const HHMM = z.string().regex(NYX_HHMM_RE);

export const NyxScheduleCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(2).max(2000),
  mode: NyxScheduleModeSchema.default("remind"),
  when: NyxScheduleWhenSchema,
  precheck: NyxPrecheckSchema.nullable().optional(),
  activeHours: z.object({ start: HHMM, end: HHMM }).nullable().optional(),
  deliver: NyxDeliverSchema.default("web"),
});
export type NyxScheduleCreate = z.infer<typeof NyxScheduleCreateSchema>;

export const NyxSchedulePatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  prompt: z.string().trim().min(2).max(2000).optional(),
  paused: z.boolean().optional(),
  precheck: NyxPrecheckSchema.nullable().optional(),
  activeHours: z.object({ start: HHMM, end: HHMM }).nullable().optional(),
  deliver: NyxDeliverSchema.optional(),
});

export interface NyxSchedule {
  id: number;
  name: string;
  prompt: string;
  mode: NyxScheduleMode;
  kind: "once" | "cron" | "event";
  runAt: string | null;
  cron: string | null;
  event: NyxScheduleEvent | null;
  eventFilter: string | null;
  precheck: NyxPrecheck | null;
  activeHours: { start: string; end: string } | null;
  deliver: NyxDeliver;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** ok · silent (nichts Neues) · skipped (Vorab-Prüfung negativ) · failed · delivered (Erinnerung). */
  lastStatus: string | null;
  lastOutput: string | null;
  runCount: number;
  /** In einfachen Worten: „täglich 07:00“, „einmal am 26.09., 15:00“, „wenn ein Build rot wird“. */
  describe: string;
  createdAt: string;
}

// ───────────────────────────── Live-Ereignisse (WebSocket `/live`) ─────────────────────────────
// `nyx.state` / `nyx.task` haben EIN Format – `NyxStateEventSchema` / `NyxTaskEventSchema` in
// nyx-live.ts, verteilt nur über `publishNyxState` / `publishNyxTask` (apps/server/src/nyx/live.ts).
// Bilder liegen in der Ablage `nyx_files` (`NyxFile`, `/api/nyx/files`).

/** Plattform steuern (Nyx-Cursor). */
export type NyxUiEvent =
  | { type: "nyx.ui"; action: "navigate"; route: string }
  | { type: "nyx.ui"; action: "click" | "focus" | "type" | "scroll" | "highlight"; target: string; text?: string };

/** N1 → Web/Telegram: Nyx meldet sich von selbst (Erinnerung, geplante Aufgabe). */
export interface NyxNotifyEvent {
  type: "nyx.notify";
  title: string;
  text: string;
  speak: string;
  threadId: number | null;
  scheduleId: number | null;
  link?: { url: string; title: string };
  image?: { fileId: number; url: string; title: string };
}

export type NyxLiveEvent = ({ type: "nyx.state"; at: string } & NyxStateEvent) | ({ type: "nyx.task" } & NyxTaskEventOut) | NyxUiEvent | NyxNotifyEvent;

// ───────────────────────────── Persönlichkeit ─────────────────────────────

/** Technische Folgen des Profils (`behaviorHints`): fließen an EINER Stelle in den Modellaufruf. */
export interface NyxBehaviorHints {
  maxTokens?: number;
  thinking?: boolean;
  preferFastModel?: boolean;
}

// ───────────────────────────── Brücke: Simulator ─────────────────────────────

/** Fähigkeit, die die Brücke im `hello` meldet, wenn sie Simulator-Screenshots kann. */
export const BRIDGE_CAP_SIMULATOR = "simulator";

export type SimulatorScreenshotResult =
  | { ok: true; pngB64: string; device: string | null; bytes: number }
  | { ok: false; reason: "no_simulator" | "xcrun_missing" | "failed"; detail: string };
