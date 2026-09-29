// Lernbuch (Einstellungen → Lernbuch). Verallgemeinert `sort_rules` auf weitere Arten
// (reservierung/konflikt/freigabe). Erste lernende Regel: 3 Konflikte in 7 Tagen
// im selben Ordner → "dort nur eine Session gleichzeitig".
import type { LearnedRule, ReservationCheckResult, RuleKind } from "@nyxos/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conflictEvents, rules } from "../db/schema.js";
import { localDayOf, t } from "@nyxos/shared";

export const CONFLICT_THRESHOLD = 3;
export const CONFLICT_WINDOW_DAYS = 7;

function toDTO(r: typeof rules.$inferSelect): LearnedRule {
  return {
    id: r.id,
    kind: r.kind as RuleKind,
    condition: r.condition as Record<string, unknown>,
    action: r.action as Record<string, unknown>,
    origin: r.origin,
    active: r.active,
    hitCount: r.hitCount,
    createdAt: r.createdAt,
    lastHitAt: r.lastHitAt,
  };
}

export async function listRules(db: Db): Promise<LearnedRule[]> {
  const rows = await db.select().from(rules).orderBy(desc(rules.createdAt));
  return rows.map(toDTO);
}

export async function setRuleActive(db: Db, id: number, active: boolean): Promise<boolean> {
  const rows = await db.update(rules).set({ active }).where(eq(rules.id, id)).returning({ id: rules.id });
  return rows.length > 0;
}

/**
 * Prüft, ob ein Ordner in den letzten {@link CONFLICT_WINDOW_DAYS} Tagen
 * {@link CONFLICT_THRESHOLD}+ **Kollisions**-Konflikte hatte (bewusst NICHT `kind = "merge"`,
 * Kritiker-Fund B3: ein Probe-Merge-Konflikt trägt als "Ordner" die ganze Repo-Wurzel — eine Regel
 * daraus würde das GANZE Repo sperren, weit über "im selben Ordner" hinaus, und `folder` wäre dazu
 * ein absoluter Pfad, während Reservierungen relative Globs sind — der `startsWith`-Vergleich in
 * `checkAgainstLearnedRules` würde also nie greifen), und legt dann die Regel "dort nur eine
 * Session gleichzeitig" an. Wird nach jedem `recordConflictEvent`-Aufruf getriggert.
 *
 * Kritiker-Fund B2: eine ABGESCHALTETE Regel für denselben Ordner darf NICHT sofort durch eine neue
 * aktive Regel ersetzt werden (sonst wirkt "abschalten" nur bis zum nächsten Konflikt) — die Suche
 * nach einer schon vorhandenen Regel prüft deshalb JEDE Regel für den Ordner, nicht nur aktive.
 *
 * Kritiker-Fund B5: zwei gleichzeitige Aufrufe (Überblick + Konflikte-Tab lesen beide parallel)
 * könnten sonst doppelte Regeln anlegen — ein Advisory-Lock auf den Ordner-Namen serialisiert das
 * (gleiches Muster wie `search.ts` `pg_advisory_xact_lock`).
 */
export async function checkFolderConflictRule(db: Db, folder: string, now = new Date()): Promise<LearnedRule | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"rule:" + folder}, 0))`);

    const since = new Date(now.getTime() - CONFLICT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const hits = await tx
      .select({ id: conflictEvents.id })
      .from(conflictEvents)
      .where(and(eq(conflictEvents.kind, "kollision"), eq(conflictEvents.folder, folder), gte(conflictEvents.detectedAt, since)));
    const n = hits.length;
    if (n < CONFLICT_THRESHOLD) return null;

    const existing = await tx.select().from(rules).where(eq(rules.kind, "konflikt"));
    const already = existing.find((r) => (r.condition as { folder?: string }).folder === folder);
    if (already) return toDTO(already); // gilt egal ob aktiv oder abgeschaltet — kein Wiederbeleben

    const origin = `gelernt am ${localDayOf(now)} aus ${n} Konflikten in ${CONFLICT_WINDOW_DAYS} Tagen (${folder})`;
    const [row] = await tx
      .insert(rules)
      .values({
        kind: "konflikt",
        condition: { folder },
        action: { message: "dort nur eine Session gleichzeitig", type: "single-session-per-folder" },
        origin,
      })
      .returning();
    if (!row) throw new Error("Regel konnte nicht angelegt werden");
    return toDTO(row);
  });
}

/**
 * Wird von `reserveArea` (conflicts/store.ts) VOR jeder neuen Reservierung geprüft —
 * Kritiker-Fund B1: ohne einen echten Aufrufer wäre die Regel reine Dekoration ("wirkt beim Start"
 * wäre nie wahr gewesen). Der volle Reife-Check-Anschluss bleibt P4, aber ab sofort
 * hat "abschalten" einen echten, im laufenden Betrieb sichtbaren Effekt.
 */
export async function checkAgainstLearnedRules(db: Db, pathGlob: string): Promise<ReservationCheckResult | null> {
  const active = await db.select().from(rules).where(and(eq(rules.kind, "konflikt"), eq(rules.active, true)));
  // Pfad-Trenner-sicherer Präfix-Vergleich (Kritiker-Fund B6): "App/backend" darf "App/backend-alt"
  // nicht treffen.
  const hit = active.find((r) => {
    const folder = (r.condition as { folder?: string }).folder;
    return folder !== undefined && (pathGlob === folder || pathGlob.startsWith(folder.endsWith("/") ? folder : folder + "/"));
  });
  if (!hit) return null;
  await db.update(rules).set({ hitCount: hit.hitCount + 1, lastHitAt: new Date().toISOString() }).where(eq(rules.id, hit.id));
  return { blocked: true, reason: t("Gelernte Regel: {message}", { message: t((hit.action as { message?: string }).message ?? "in diesem Ordner nur eine Session") }), conflictingReservation: null };
}
