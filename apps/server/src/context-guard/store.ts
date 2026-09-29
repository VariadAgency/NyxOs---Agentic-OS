// Kontext-Wächter — Einstellungen lesen/schreiben (DB-Zugriff). Reine Auflösung (Session >
// Modell > Standard, Haiku separat) liegt in `packages/shared/src/context-guard.ts` (`resolveContextGuardThresholds`,
// kein DB-Zugriff, pur getestet). Hier nur das Laden der Zeilen + Lazy-Init wie bei `push_settings`.
import {
  CONTEXT_GUARD_DEFAULT,
  resolveContextGuardThresholds,
  type ContextGuardModelRow,
  type ContextGuardSessionRow,
  type ContextGuardSettingsSnapshot,
  type ContextGuardThresholdsInput,
  type ContextGuardThresholdsRow,
  type ResolvedContextGuardThresholds,
} from "@nyxos/shared";
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contextGuardDefaults, contextGuardOverrides } from "../db/schema.js";

const SINGLETON_ID = 1;

type DefaultsRow = typeof contextGuardDefaults.$inferSelect;
type OverrideRow = typeof contextGuardOverrides.$inferSelect;

function toDefault(row: DefaultsRow): ContextGuardThresholdsRow {
  return { hinweisPct: row.defaultHinweisPct, erzwingenEnabled: row.defaultErzwingenEnabled, erzwingenPct: row.defaultErzwingenPct, updatedAt: row.updatedAt };
}
function toHaiku(row: DefaultsRow): ContextGuardThresholdsRow {
  return { hinweisPct: row.haikuHinweisPct, erzwingenEnabled: row.haikuErzwingenEnabled, erzwingenPct: row.haikuErzwingenPct, updatedAt: row.updatedAt };
}
function toOverride(row: OverrideRow): ContextGuardThresholdsRow {
  return { hinweisPct: row.hinweisPct, erzwingenEnabled: row.erzwingenEnabled, erzwingenPct: row.erzwingenPct, updatedAt: row.updatedAt };
}

async function loadOrInitDefaultsRow(db: Db): Promise<DefaultsRow> {
  const [row] = await db.select().from(contextGuardDefaults).where(eq(contextGuardDefaults.id, SINGLETON_ID)).limit(1);
  if (row) return row;
  const inserted = await db
    .insert(contextGuardDefaults)
    .values({
      id: SINGLETON_ID,
      defaultHinweisPct: CONTEXT_GUARD_DEFAULT.hinweisPct,
      defaultErzwingenEnabled: CONTEXT_GUARD_DEFAULT.erzwingenEnabled,
      defaultErzwingenPct: CONTEXT_GUARD_DEFAULT.erzwingenPct,
      haikuHinweisPct: CONTEXT_GUARD_DEFAULT.hinweisPct,
      haikuErzwingenEnabled: CONTEXT_GUARD_DEFAULT.erzwingenEnabled,
      haikuErzwingenPct: CONTEXT_GUARD_DEFAULT.erzwingenPct,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const [again] = await db.select().from(contextGuardDefaults).where(eq(contextGuardDefaults.id, SINGLETON_ID)).limit(1);
  if (!again) throw new Error("context_guard_defaults konnte nicht angelegt werden");
  return again;
}

export const loadOrInitDefault = (db: Db) => loadOrInitDefaultsRow(db).then(toDefault);
export const loadOrInitHaiku = (db: Db) => loadOrInitDefaultsRow(db).then(toHaiku);

export async function loadModelOverride(db: Db, model: string): Promise<ContextGuardThresholdsRow | null> {
  const [row] = await db.select().from(contextGuardOverrides).where(eq(contextGuardOverrides.model, model)).limit(1);
  return row ? toOverride(row) : null;
}

export async function loadSessionOverride(db: Db, sessionKey: string): Promise<ContextGuardThresholdsRow | null> {
  const [row] = await db.select().from(contextGuardOverrides).where(eq(contextGuardOverrides.sessionKey, sessionKey)).limit(1);
  return row ? toOverride(row) : null;
}

/** Alle gesetzten Model-/Session-Overrides + Standard + Haiku (`GET /api/context-guard/settings`). */
export async function loadSnapshot(db: Db): Promise<ContextGuardSettingsSnapshot> {
  const [defaultsRow, modelRows, sessionRows] = await Promise.all([
    loadOrInitDefaultsRow(db),
    db.select().from(contextGuardOverrides).where(isNotNull(contextGuardOverrides.model)),
    db.select().from(contextGuardOverrides).where(isNotNull(contextGuardOverrides.sessionKey)),
  ]);
  const models: ContextGuardModelRow[] = modelRows.map((r) => ({ model: r.model as string, ...toOverride(r) }));
  const sessionsOut: ContextGuardSessionRow[] = sessionRows.map((r) => ({ sessionKey: r.sessionKey as string, ...toOverride(r) }));
  return { default: toDefault(defaultsRow), haiku: toHaiku(defaultsRow), models, sessions: sessionsOut };
}

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`context_guard: ${what} nicht gefunden`);
  return row;
}

function overrideValues(input: ContextGuardThresholdsInput) {
  return { hinweisPct: input.hinweisPct, erzwingenEnabled: input.erzwingenEnabled, erzwingenPct: input.erzwingenPct, updatedAt: new Date().toISOString() };
}

export async function saveDefault(db: Db, input: ContextGuardThresholdsInput): Promise<ContextGuardThresholdsRow> {
  await loadOrInitDefaultsRow(db); // sicherstellen, dass die Zeile existiert
  const [row] = await db
    .update(contextGuardDefaults)
    .set({ defaultHinweisPct: input.hinweisPct, defaultErzwingenEnabled: input.erzwingenEnabled, defaultErzwingenPct: input.erzwingenPct, updatedAt: new Date().toISOString() })
    .where(eq(contextGuardDefaults.id, SINGLETON_ID))
    .returning();
  return toDefault(must(row, "Standard"));
}

export async function saveHaiku(db: Db, input: ContextGuardThresholdsInput): Promise<ContextGuardThresholdsRow> {
  await loadOrInitDefaultsRow(db);
  const [row] = await db
    .update(contextGuardDefaults)
    .set({ haikuHinweisPct: input.hinweisPct, haikuErzwingenEnabled: input.erzwingenEnabled, haikuErzwingenPct: input.erzwingenPct, updatedAt: new Date().toISOString() })
    .where(eq(contextGuardDefaults.id, SINGLETON_ID))
    .returning();
  return toHaiku(must(row, "Haiku"));
}

export async function saveModelOverride(db: Db, model: string, input: ContextGuardThresholdsInput): Promise<ContextGuardThresholdsRow> {
  const [existing] = await db.select({ id: contextGuardOverrides.id }).from(contextGuardOverrides).where(eq(contextGuardOverrides.model, model)).limit(1);
  if (existing) {
    const [row] = await db.update(contextGuardOverrides).set(overrideValues(input)).where(eq(contextGuardOverrides.id, existing.id)).returning();
    return toOverride(must(row, `Modell ${model}`));
  }
  const [row] = await db
    .insert(contextGuardOverrides)
    .values({ scope: "model", model, ...overrideValues(input) })
    .returning();
  return toOverride(must(row, `Modell ${model}`));
}

export async function deleteModelOverride(db: Db, model: string): Promise<boolean> {
  const rows = await db.delete(contextGuardOverrides).where(eq(contextGuardOverrides.model, model)).returning({ id: contextGuardOverrides.id });
  return rows.length > 0;
}

export async function saveSessionOverride(db: Db, sessionKey: string, input: ContextGuardThresholdsInput): Promise<ContextGuardThresholdsRow> {
  const [existing] = await db.select({ id: contextGuardOverrides.id }).from(contextGuardOverrides).where(eq(contextGuardOverrides.sessionKey, sessionKey)).limit(1);
  if (existing) {
    const [row] = await db.update(contextGuardOverrides).set(overrideValues(input)).where(eq(contextGuardOverrides.id, existing.id)).returning();
    return toOverride(must(row, `Session ${sessionKey}`));
  }
  const [row] = await db
    .insert(contextGuardOverrides)
    .values({ scope: "session", sessionKey, ...overrideValues(input) })
    .returning();
  return toOverride(must(row, `Session ${sessionKey}`));
}

export async function deleteSessionOverride(db: Db, sessionKey: string): Promise<boolean> {
  const rows = await db.delete(contextGuardOverrides).where(eq(contextGuardOverrides.sessionKey, sessionKey)).returning({ id: contextGuardOverrides.id });
  return rows.length > 0;
}

/** Auflösung für eine konkrete Session (DB-Zugriff + reine Funktion aus `@nyxos/shared`). */
export async function resolveForSession(db: Db, opts: { sessionKey: string | null; model: string | null; isHaiku: boolean }): Promise<ResolvedContextGuardThresholds> {
  const [defaultsRow, modelOverride, sessionOverride] = await Promise.all([
    loadOrInitDefaultsRow(db),
    opts.model ? loadModelOverride(db, opts.model) : Promise.resolve(null),
    opts.sessionKey ? loadSessionOverride(db, opts.sessionKey) : Promise.resolve(null),
  ]);
  return resolveContextGuardThresholds({ defaults: toDefault(defaultsRow), haiku: toHaiku(defaultsRow), modelOverride, sessionOverride, isHaiku: opts.isHaiku });
}
