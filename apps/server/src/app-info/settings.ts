// App-wide settings (language, name, onboarding, automatic updates). One row, `id = 1`.
import { DEFAULT_APP_SETTINGS, isLang, setLang, type AppSettings, type AppSettingsPatch } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

type Reader = Pick<Db, "select">;

export async function loadAppSettings(db: Reader): Promise<AppSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!row) return { ...DEFAULT_APP_SETTINGS };
  return {
    lang: isLang(row.lang) ? row.lang : DEFAULT_APP_SETTINGS.lang,
    userName: row.userName,
    onboardingDone: row.onboardingDone,
    autoUpdate: row.autoUpdate,
  };
}

export async function saveAppSettings(db: Db, patch: AppSettingsPatch): Promise<AppSettings> {
  const next = { ...(await loadAppSettings(db)), ...patch };
  await db
    .insert(appSettings)
    .values({ id: 1, ...next })
    .onConflictDoUpdate({ target: appSettings.id, set: { ...next, updatedAt: sql`now()` } });
  setLang(next.lang);
  return next;
}

/** Apply the stored language to the server process (texts in API answers, Telegram, prompts). */
export async function applyStoredLanguage(db: Reader): Promise<void> {
  try {
    setLang((await loadAppSettings(db)).lang);
  } catch {
    // table missing in very old test databases: keep the default
  }
}
