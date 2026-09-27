// Wegwerf-Chats: temporäre Sessions und Haiku-Fäden. Eine Quelle für die Ablauf-Regel, damit
// Server (Ticker, Listen) und Web (Marke „⏳ 4 Std“) dieselbe Restzeit rechnen.
import { z } from "zod";
import { pick, t } from "./i18n/index.js";
import { lazyRecord } from "./lazy-text.js";

export const TEMPORARY_HOURS_DEFAULT = 6;
export const TEMPORARY_HOURS_MIN = 1;
export const TEMPORARY_HOURS_MAX = 72;

export const TemporarySettingsSchema = z.object({
  hours: z.number().int().min(TEMPORARY_HOURS_MIN).max(TEMPORARY_HOURS_MAX),
});
export type TemporarySettings = z.infer<typeof TemporarySettingsSchema>;

export const SessionTemporaryPatchSchema = z.object({ temporary: z.boolean() });
/** temporär umschalten, N7a archivieren/zurückholen – mindestens eins von beiden. */
export const HaikuThreadPatchSchema = z
  .object({ temporary: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((p) => p.temporary !== undefined || p.archived !== undefined, { error: () => t("temporary oder archived nötig") });

/**
 * Warum eine Session temporär ist. Die Auto-Regeln stammen aus der DB-Stichprobe vom 25.09.2026
 * (80 Haupt-Sessions, davon 38 Test-/Hilfsläufe), Begründung im Bericht B3.
 */
export const TEMPORARY_REASONS = ["manual", "probe_tmux", "probe_folder", "haiku_run", "selftest"] as const;
export type TemporaryReason = (typeof TEMPORARY_REASONS)[number];

export const TEMPORARY_REASON_LABEL: Record<TemporaryReason, string> = lazyRecord({
  manual: "Beim Start als temporär markiert",
  probe_tmux: "Test-Session der Probe",
  probe_folder: "Läuft in einem Test-Ordner der Probe",
  haiku_run: "Nyx-Lauf (Motor oder Selbsttest)",
  selftest: "Selbsttest von NyxOS",
});

/** tmux-Socket der echten Brücke (`apps/bridge/src/config.ts`). Jeder andere Socket ist eine Probe (`scripts/probe.mjs`). */
export const PRODUCTION_TMUX_SOCKET = "nyxos";

const HOUR_MS = 3_600_000;

/**
 * Ablauf = X Stunden nach der letzten Aktivität, frühestens X Stunden nach dem Markieren. So verschwindet
 * nichts, während daran gearbeitet wird, und eine frisch (auto-)markierte alte Session bleibt noch X Stunden
 * sichtbar – Zeit für „Behalten“.
 */
export function temporaryExpiresAt(since: string, lastActivity: string | null, hours: number): string {
  const base = Math.max(Date.parse(since), lastActivity ? Date.parse(lastActivity) : 0);
  return new Date(base + hours * HOUR_MS).toISOString();
}

/** Restzeit kurz und deutsch: „4 Std“, „35 Min“, „gleich“. Aufgerundet, damit „0“ nie erscheint. */
export function formatRemaining(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 60_000) return pick({ de: "gleich", en: "a moment" }); // „gleich“ as a key already means “same”
  if (ms < HOUR_MS) return t("{n} Min", { n: Math.ceil(ms / 60_000) });
  return t("{n} Std", { n: Math.round(ms / HOUR_MS) });
}
