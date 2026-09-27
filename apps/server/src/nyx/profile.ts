// Nyx-Profil laden/speichern (Tabelle `nyx_profile`, eine Zeile) und eigene Vorlagen (`nyx_presets`).
// Der Prompt-Abschnitt selbst entsteht rein in `./persona.ts`.
import {
  BUILTIN_NYX_PRESETS,
  DEFAULT_NYX_PROFILE,
  NYX_CUSTOM_PRESETS_MAX,
  NyxPersonalitySchema,
  NyxSlidersSchema,
  NyxUserProfileSchema,
  type NyxChannel,
  type NyxPreset,
  type NyxPresetCreate,
  type NyxProfile,
} from "@nyxos/shared";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nyxPresets, nyxProfile } from "../db/schema.js";
import { loadAppSettings } from "../app-info/settings.js";
import { behaviorHints, withPersona } from "./persona.js";

type Reader = Pick<Db, "select">;

/** Eigene Vorlagen tragen die ID `eigen-<Zeile>`, eingebaute ihren festen Schlüssel. */
const CUSTOM_PREFIX = "eigen-";

export async function loadNyxProfile(db: Reader): Promise<{ profile: NyxProfile; updatedAt: string | null }> {
  const [row] = await db.select().from(nyxProfile).where(eq(nyxProfile.id, 1)).limit(1);
  if (!row) return { profile: DEFAULT_NYX_PROFILE, updatedAt: null };
  // Gespeichertes JSON gegen das Schema lesen; ein kaputtes Teilstück fällt auf den Startwert zurück,
  // statt den Chat zu blockieren.
  const user = NyxUserProfileSchema.safeParse(row.userProfile);
  const personality = NyxPersonalitySchema.safeParse(row.personality);
  const sliders = NyxSlidersSchema.safeParse(row.sliders);
  return {
    profile: {
      user: user.success ? user.data : DEFAULT_NYX_PROFILE.user,
      personality: personality.success ? personality.data : DEFAULT_NYX_PROFILE.personality,
      sliders: sliders.success ? sliders.data : DEFAULT_NYX_PROFILE.sliders,
      activePreset: row.activePreset,
    },
    updatedAt: row.updatedAt,
  };
}

/**
 * der Name für den Gruß (Überblick, Briefing, Vorlesen) aus dem Nyx-Profil. Fehlt er oder ist die
 * Tabelle nicht lesbar, grüßt `greetingLine` mit dem Standardnamen – der Gruß blockiert nie einen Bericht.
 */
/** Name des Nutzers: aus dem Nyx-Profil, sonst aus den App-Einstellungen (Onboarding); `null` = keiner. */
export async function greetingNameOf(db: Reader): Promise<string | null> {
  try {
    const fromProfile = (await loadNyxProfile(db)).profile.user.name.trim();
    if (fromProfile) return fromProfile;
  } catch {
    // Profil-Tabelle fehlt (sehr alte Test-DB): weiter mit den App-Einstellungen
  }
  try {
    return (await loadAppSettings(db)).userName.trim() || null;
  } catch {
    return null;
  }
}

export async function saveNyxProfile(db: Db, p: NyxProfile): Promise<{ profile: NyxProfile; updatedAt: string | null }> {
  const values = { userProfile: p.user, personality: p.personality, sliders: p.sliders, activePreset: p.activePreset };
  await db
    .insert(nyxProfile)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: nyxProfile.id, set: { ...values, updatedAt: sql`now()` } });
  return loadNyxProfile(db);
}

/** Eingebaute zuerst (feste Reihenfolge), dann eigene in Anlege-Reihenfolge. */
export async function listNyxPresets(db: Reader): Promise<NyxPreset[]> {
  const rows = await db.select().from(nyxPresets).orderBy(asc(nyxPresets.id));
  const own: NyxPreset[] = [];
  for (const r of rows) {
    const sliders = NyxSlidersSchema.safeParse(r.sliders);
    if (sliders.success) own.push({ id: `${CUSTOM_PREFIX}${r.id}`, label: r.label, description: r.description, builtin: false, sliders: sliders.data });
  }
  return [...BUILTIN_NYX_PRESETS, ...own];
}

export type CreatePresetResult = { ok: true; preset: NyxPreset } | { ok: false; reason: "duplicate" | "full" };

export async function createNyxPreset(db: Db, input: NyxPresetCreate): Promise<CreatePresetResult> {
  const lower = input.label.toLocaleLowerCase("de");
  if (BUILTIN_NYX_PRESETS.some((p) => p.label.toLocaleLowerCase("de") === lower)) return { ok: false, reason: "duplicate" };
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(nyxPresets);
  if ((count?.n ?? 0) >= NYX_CUSTOM_PRESETS_MAX) return { ok: false, reason: "full" };
  const [row] = await db
    .insert(nyxPresets)
    .values({ label: input.label, description: input.description ?? "", sliders: input.sliders })
    .onConflictDoNothing()
    .returning();
  if (!row) return { ok: false, reason: "duplicate" };
  return { ok: true, preset: { id: `${CUSTOM_PREFIX}${row.id}`, label: row.label, description: row.description, builtin: false, sliders: input.sliders } };
}

export type DeletePresetResult = "deleted" | "builtin" | "missing";

/** Löscht eine eigene Vorlage. War sie aktiv, verliert das Profil nur die Auswahl – die Regler bleiben. */
export async function deleteNyxPreset(db: Db, id: string): Promise<DeletePresetResult> {
  if (BUILTIN_NYX_PRESETS.some((p) => p.id === id)) return "builtin";
  const m = /^eigen-(\d{1,9})$/.exec(id);
  if (!m) return "missing";
  const [gone] = await db
    .delete(nyxPresets)
    .where(eq(nyxPresets.id, Number(m[1])))
    .returning({ id: nyxPresets.id });
  if (!gone) return "missing";
  await db.update(nyxProfile).set({ activePreset: null, updatedAt: sql`now()` }).where(eq(nyxProfile.activePreset, id));
  return "deleted";
}

/**
 * System-Prompt eines Nyx-Laufs = Grund-Prompt + Persönlichkeit aus dem gespeicherten Profil.
 * Kann das Profil nicht gelesen werden (z. B. Migration noch nicht eingespielt), gelten die Startwerte –
 * der Chat darf daran nie scheitern.
 */
export async function nyxSystemPrompt(db: Reader, base: string, channel: NyxChannel = "web"): Promise<string> {
  return (await nyxRunSettings(db, base, channel)).systemPrompt;
}

async function profileOrDefault(db: Reader): Promise<NyxProfile> {
  try {
    return (await loadNyxProfile(db)).profile;
  } catch {
    return DEFAULT_NYX_PROFILE; // Startwerte (s. oben)
  }
}

/**
 * Alles, was ein Nyx-Lauf aus dem Profil bekommt: System-Prompt UND die technische Wirkung der Regler
 * („schnell“ wirkt auch technisch). `thinking: false` = ohne Denkpause (Tempo-Regler ganz
 * schnell); `undefined` = Standard des Motors. Token-Grenze/Modellwahl (`behaviorHints`) übernimmt N5.
 */
export async function nyxRunSettings(db: Reader, base: string, channel: NyxChannel = "web"): Promise<{ systemPrompt: string; thinking: boolean | undefined }> {
  const profile = await profileOrDefault(db);
  const hints = behaviorHints(profile, channel);
  return { systemPrompt: withPersona(base, profile, channel), thinking: hints.thinking === "low" ? false : undefined };
}
