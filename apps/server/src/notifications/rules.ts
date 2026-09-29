// Notification rules: read/write. They live as JSON in `push_settings.rules` (migration 0043); missing or broken
// values = default (`normalizeNotifyRules`). On the first read the earlier switches are taken over: a kind that was
// switched off before (push occasion or "Wenn ich weg bin" event) stays "never".
import { normalizeNotifyRules, NOTIFY_KINDS, NOTIFY_OCCASIONS, type NotifyRules, type NotifyRulesPatch } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { awaySettings, pushSettings } from "../db/schema.js";
import { loadOrInitSettings } from "../push/settings.js";

export async function loadNotifyRules(db: Db): Promise<NotifyRules> {
  const [row] = await db.select({ rules: pushSettings.rules, enabledKinds: pushSettings.enabledKinds }).from(pushSettings).where(eq(pushSettings.id, 1)).limit(1);
  const [away] = await db.select({ settings: awaySettings.settings }).from(awaySettings).where(eq(awaySettings.id, 1)).limit(1);
  const awayEvents = (away?.settings as { events?: Record<string, boolean> } | undefined)?.events ?? null;
  return normalizeNotifyRules(row?.rules ?? {}, { enabledKinds: row?.enabledKinds ?? null, awayEvents });
}

/** Only the switches that really change compared to the stored state. */
export function changedToggles(before: Record<string, boolean | undefined>, patch: Record<string, boolean | undefined>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(patch)) if (typeof v === "boolean" && v !== (before[k] ?? true)) out[k] = v;
  return out;
}

/**
 * Map the old on/off switches (`enabledKinds` of `/api/push/settings`, `events` of `/api/away/settings`) onto the
 * levels, for clients that still use those routes: off → "never", on → default level (only if it is "never" now).
 */
export async function mirrorLegacyKinds(db: Db, toggles: Partial<Record<string, boolean | undefined>>, now = new Date()): Promise<void> {
  const current = await loadNotifyRules(db);
  const when: NotifyRulesPatch["when"] = {};
  for (const k of NOTIFY_KINDS) {
    const v = toggles[k];
    if (v === false && current.when[k] !== "never") when[k] = "never";
    if (v === true && current.when[k] === "never") when[k] = NOTIFY_OCCASIONS[k].defaultWhen;
  }
  if (Object.keys(when).length > 0) await patchNotifyRules(db, { when }, now);
}

/** Change rules (merge, don't replace). Remembers when a level changed (for rule suggestions). */
export async function patchNotifyRules(db: Db, patch: NotifyRulesPatch, now = new Date()): Promise<NotifyRules> {
  await loadOrInitSettings(db); // create the row if it doesn't exist yet
  const current = await loadNotifyRules(db);
  const stamp = now.toISOString();
  const next: NotifyRules = { ...current, when: { ...current.when }, templates: { ...current.templates }, whenChangedAt: { ...current.whenChangedAt }, dismissedAt: { ...current.dismissedAt } };
  if (patch.when) {
    for (const k of NOTIFY_KINDS) {
      const v = patch.when[k];
      if (v && v !== current.when[k]) {
        next.when[k] = v;
        next.whenChangedAt[k] = stamp;
      }
    }
  }
  if (patch.templates) {
    for (const k of NOTIFY_KINDS) {
      if (!(k in patch.templates)) continue;
      const tpl = patch.templates[k];
      // null = back to the default (normalizeNotifyRules drops empty/null templates).
      next.templates[k] = tpl && (tpl.title.trim() || tpl.body.trim()) ? { title: tpl.title.trim(), body: tpl.body.trim() } : null;
    }
  }
  if (patch.skipSubAgents !== undefined) next.skipSubAgents = patch.skipSubAgents;
  if (patch.minGapMinutes !== undefined) next.minGapMinutes = patch.minGapMinutes;
  if (patch.style !== undefined) next.style = patch.style;
  if (patch.nyxReview !== undefined) next.nyxReview = patch.nyxReview;
  if (patch.nyxWrite !== undefined) next.nyxWrite = patch.nyxWrite;
  if (patch.important !== undefined) next.important = patch.important.trim();
  if (patch.protectUrgent !== undefined) next.protectUrgent = patch.protectUrgent;
  if (patch.dismissSuggestion) next.dismissedAt[patch.dismissSuggestion] = stamp;
  // Store the whole (normalized) version: afterwards nothing depends on the old switches any more.
  const stored = normalizeNotifyRules(next);
  await db
    .update(pushSettings)
    .set({ rules: stored as unknown as Record<string, unknown>, updatedAt: stamp })
    .where(eq(pushSettings.id, 1));
  return stored;
}
