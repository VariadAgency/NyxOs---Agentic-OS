// Zustand des Telegram-Zugangs (eine Zeile `telegram_state`, id = 1).
import type { TelegramSettings } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { telegramState } from "../db/schema.js";

export type TelegramRow = typeof telegramState.$inferSelect;
export type TelegramPatch = Partial<Omit<TelegramRow, "id">>;

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  voiceReply: "voice_only",
  echoTranscript: true,
  notifyApprovals: true,
  notifySessions: true,
  respectQuietHours: true,
};

export async function loadTelegramState(db: Db): Promise<TelegramRow> {
  const [row] = await db.select().from(telegramState).where(eq(telegramState.id, 1)).limit(1);
  if (row) return row;
  await db.insert(telegramState).values({ id: 1 }).onConflictDoNothing();
  const [again] = await db.select().from(telegramState).where(eq(telegramState.id, 1)).limit(1);
  if (!again) throw new Error("telegram_state konnte nicht angelegt werden");
  return again;
}

export async function patchTelegramState(db: Db, patch: TelegramPatch): Promise<TelegramRow> {
  await loadTelegramState(db);
  const [row] = await db
    .update(telegramState)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(telegramState.id, 1))
    .returning();
  if (!row) throw new Error("telegram_state-Zeile fehlt");
  return row;
}

export function settingsOf(row: Pick<TelegramRow, "settings">): TelegramSettings {
  const s = row.settings as Partial<TelegramSettings>;
  return {
    voiceReply: s.voiceReply === "always" || s.voiceReply === "never" ? s.voiceReply : DEFAULT_TELEGRAM_SETTINGS.voiceReply,
    echoTranscript: typeof s.echoTranscript === "boolean" ? s.echoTranscript : DEFAULT_TELEGRAM_SETTINGS.echoTranscript,
    notifyApprovals: typeof s.notifyApprovals === "boolean" ? s.notifyApprovals : DEFAULT_TELEGRAM_SETTINGS.notifyApprovals,
    notifySessions: typeof s.notifySessions === "boolean" ? s.notifySessions : DEFAULT_TELEGRAM_SETTINGS.notifySessions,
    respectQuietHours: typeof s.respectQuietHours === "boolean" ? s.respectQuietHours : DEFAULT_TELEGRAM_SETTINGS.respectQuietHours,
  };
}
