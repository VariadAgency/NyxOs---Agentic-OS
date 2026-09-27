// Kollisionskarte (wer schreibt/liest welche Datei) + Reservierungen + Lernbuch-Rohdaten.
import { globOverlaps, t, type CollisionEntry, type CollisionState, type Reservation, type ReservationCheckResult } from "@nyxos/shared";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conflictEvents, reservations, sessionFiles, sessions } from "../db/schema.js";
import { isLiveSession } from "../db/live.js";
import { countedSession } from "../db/visible.js";
import { checkAgainstLearnedRules, checkFolderConflictRule } from "../lessons/learn.js";

/** Ordner-Teil eines Pfades (für die Lernregel "3 Konflikte in 7 Tagen im selben Ordner"). */
export function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "." : path.slice(0, idx);
}

/** Protokolliert einen Konflikt fürs Lernbuch — dedupliziert über ein 1h-Fenster je (kind, folder,
 * path), damit ein dauerhaft anhaltender Konflikt (z. B. zwei Sessions schreiben 30 Min lang
 * dieselbe Datei) nicht bei jedem Abruf/Scan erneut gezählt wird. Löst danach den Lernbuch-Check
 * aus (3 Konflikte in 7 Tagen im selben Ordner → neue Regel). Bewusst NICHT
 * innerhalb einer Transaktion aufgerufen (einfache Typen, kein Tx/Db-Zweig) — wird nach dem
 * Commit der jeweiligen Aufrufer-Transaktion aufgerufen (s. git/store.ts).                     */
export async function recordConflictEvent(db: Db, kind: "kollision" | "merge", folder: string, path: string): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const existing = await db
    .select({ id: conflictEvents.id })
    .from(conflictEvents)
    .where(and(eq(conflictEvents.kind, kind), eq(conflictEvents.folder, folder), eq(conflictEvents.path, path), gte(conflictEvents.detectedAt, since)))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(conflictEvents).values({ kind, folder, path });
  await checkFolderConflictRule(db, folder);
}

/** Zeitstempel aus der DB (ISO oder Postgres-Text „2026-09-25 10:03:24.667+00“) → ms. */
function timeMs(s: string): number {
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return direct;
  const iso = Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(iso) ? 0 : iso;
}

/** Glob-Vergleich: seit R1 in `@nyxos/shared` (die Entscheidungs-Logik braucht ihn auch). */
export { globOverlaps };

/** Ein zweiter Auftrag mit überlappendem Bereich ist nicht startbar, mit Begründung.
 * Prüft zusätzlich gegen das Lernbuch ("Regel wirkt beim Start" — Kritiker-Fund B1:
 * ohne diese Verdrahtung hätte eine gelernte Regel nie eine echte Wirkung gehabt). */
export async function checkReservationConflict(db: Db, pathGlob: string, now = new Date(), opts: { skipLearnedRules?: boolean } = {}): Promise<ReservationCheckResult> {
  if (!opts.skipLearnedRules) {
    const learned = await checkAgainstLearnedRules(db, pathGlob);
    if (learned?.blocked) return learned;
  }

  const active = await db.select().from(reservations).where(or(isNull(reservations.until), gte(reservations.until, now.toISOString())));
  const hit = active.find((r) => globOverlaps(r.pathGlob, pathGlob));
  if (!hit) return { blocked: false, reason: null, conflictingReservation: null };
  return {
    blocked: true,
    reason: t("Überlappt mit Reservierung \"{label}\" ({glob})", { label: hit.label, glob: hit.pathGlob }),
    conflictingReservation: toReservationDTO(hit),
  };
}

function toReservationDTO(r: typeof reservations.$inferSelect): Reservation {
  return { id: r.id, pathGlob: r.pathGlob, label: r.label, sessionKey: r.sessionKey, createdAt: r.createdAt, until: r.until };
}

/** `bereich_reservieren` — REST statt MCP, bis der MCP-Anschluss steht;
 * 409 bei Überlappung, s. `checkReservationConflict`.
 * `skipLearnedRules` nur für des Nutzers eigene Konflikt-Entscheidung („A zuerst“/„Bereich
 * reservieren“) — die gelernte Regel „dort nur eine Session“ würde sonst genau die Reservierung
 * verbieten, die diese Regel umsetzt (in einem Ordner mit vielen Konflikten gibt es sie immer). */
export async function reserveArea(
  db: Db,
  input: { pathGlob: string; label: string; sessionKey?: string | null; untilMinutes?: number | null },
  opts: { skipLearnedRules?: boolean } = {},
): Promise<{ ok: true; reservation: Reservation } | { ok: false; check: ReservationCheckResult }> {
  const check = await checkReservationConflict(db, input.pathGlob, new Date(), opts);
  if (check.blocked) return { ok: false, check };
  const until = input.untilMinutes ? new Date(Date.now() + input.untilMinutes * 60_000).toISOString() : null;
  const [row] = await db.insert(reservations).values({ pathGlob: input.pathGlob, label: input.label, sessionKey: input.sessionKey ?? null, until }).returning();
  if (!row) throw new Error("Reservierung konnte nicht gespeichert werden");
  return { ok: true, reservation: toReservationDTO(row) };
}

/** `bereich_freigeben`. */
export async function releaseArea(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(reservations).where(eq(reservations.id, id)).returning({ id: reservations.id });
  return rows.length > 0;
}

export async function listReservations(db: Db): Promise<Reservation[]> {
  const rows = await db.select().from(reservations).orderBy(desc(reservations.createdAt));
  return rows.map(toReservationDTO);
}

/**
 * Kollisionskarte aus `session_files` (geschrieben/gelesen je Session) + Reservierungen
 *. Ein Pfad ist "conflict", wenn ≥ 2 LEBENDE Sessions ihn schreiben, oder eine
 * lebende Session außerhalb ihrer eigenen Reservierung in einen reservierten Bereich schreibt.
 * Lebend = `db/live.ts` (läuft/wartet/ruht, dieselbe Zustandsspalte wie der
 * Schnappschuss). Sessions, die von selbst enden, werden nie „geschlossen“ — vorher fragte die Seite
 * darum „dringend … ändern gerade gleichzeitig“ für Sessions, die seit Tagen beendet waren. Haben
 * mehrere Sessions die Datei geändert, lebt aber höchstens eine davon noch → "past" (Rückblick).
 * Neue Konflikte werden fürs Lernbuch protokolliert (`recordConflictEvent`).
 */
export async function computeCollisionMap(db: Db): Promise<CollisionEntry[]> {
  const [fileRows, reservationRows] = await Promise.all([
    db
      .select({
        path: sessionFiles.path,
        mode: sessionFiles.mode,
        sessionKey: sessionFiles.sessionKey,
        title: sessions.title,
        firstSeenAt: sessionFiles.firstSeenAt,
        state: sessions.state,
        closedAt: sessions.closedAt,
      })
      .from(sessionFiles)
      .innerJoin(sessions, eq(sessions.id, sessionFiles.sessionKey))
      // archivierte Wegwerf-Sessions zählen nicht als Schreiber (kein Konflikt, keine Kachel-Zahl).
      // ebenso automatisch erkannte Test-Sessions (`countedSession`, dieselbe Regel wie `db/live.ts`).
      .where(and(isNull(sessions.closedAt), countedSession)),
    listReservations(db),
  ]);

  const byPath = new Map<string, { writers: CollisionEntry["writers"]; readers: CollisionEntry["readers"] }>();
  for (const row of fileRows) {
    const entry = byPath.get(row.path) ?? { writers: [], readers: [] };
    const who = { sessionKey: row.sessionKey, title: row.title, firstSeenAt: row.firstSeenAt, alive: isLiveSession(row) };
    if (row.mode === "write") {
      if (!entry.writers.some((w) => w.sessionKey === who.sessionKey)) entry.writers.push(who);
    } else if (!entry.readers.some((w) => w.sessionKey === who.sessionKey)) {
      entry.readers.push(who);
    }
    byPath.set(row.path, entry);
  }

  const out: CollisionEntry[] = [];
  for (const [path, entry] of byPath) {
    const reservation = reservationRows.find((r) => globOverlaps(r.pathGlob, path)) ?? null;
    let state: CollisionState = "ok";
    let reason: string | null = null;
    const liveWriters = entry.writers.filter((w) => w.alive);
    if (liveWriters.length >= 2) {
      state = "conflict";
      reason = t("{n} Sessions schreiben gleichzeitig", { n: liveWriters.length });
    } else if (reservation && liveWriters.some((w) => w.sessionKey !== reservation.sessionKey && timeMs(w.firstSeenAt) > timeMs(reservation.createdAt))) {
      // nur Schreiben NACH der Reservierung unterläuft sie — sonst machte ein Klick auf
      // „Bereich reservieren“ aus jeder schon vorher bearbeiteten Datei sofort eine neue offene Frage.
      state = "conflict";
      reason = t("Schreibt in reservierten Bereich \"{label}\" (fremde Session)", { label: reservation.label });
    } else if (entry.writers.length >= 2) {
      state = "past";
      reason = liveWriters.length === 0 ? t("{n} Sessions haben die Datei geändert, alle sind beendet", { n: entry.writers.length }) : t("{n} Sessions haben die Datei geändert, nur eine läuft noch", { n: entry.writers.length });
    } else if (entry.writers.length === 1 && entry.readers.length > 0) {
      state = "shared-read";
    }
    out.push({ path, writers: entry.writers, readers: entry.readers, reservation, state, reason });
  }
  await recordCollisionEvents(
    db,
    out.filter((e) => e.state === "conflict").map((e) => ({ folder: folderOf(e.path), path: e.path })),
  );
  out.sort((a, b) => (a.state === b.state ? a.path.localeCompare(b.path) : a.state === "conflict" ? -1 : b.state === "conflict" ? 1 : a.path.localeCompare(b.path)));
  return out;
}

/** wie `recordConflictEvent`, aber gebündelt — vorher lief je Konflikt-Datei eine eigene
 * Abfrage (+ Einfügen + Regel-Prüfung); bei 3.000+ Konflikten waren das tausende Abfragen je Abruf. */
async function recordCollisionEvents(db: Db, items: { folder: string; path: string }[]): Promise<void> {
  if (items.length === 0) return;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await db
    .select({ folder: conflictEvents.folder, path: conflictEvents.path })
    .from(conflictEvents)
    .where(and(eq(conflictEvents.kind, "kollision"), gte(conflictEvents.detectedAt, since)));
  const seen = new Set(recent.map((r) => `${r.folder}\u0000${r.path}`));
  const fresh = items.filter((i) => !seen.has(`${i.folder}\u0000${i.path}`));
  if (fresh.length === 0) return;
  for (let i = 0; i < fresh.length; i += 500) {
    await db.insert(conflictEvents).values(fresh.slice(i, i + 500).map((f) => ({ kind: "kollision", folder: f.folder, path: f.path })));
  }
  for (const folder of new Set(fresh.map((f) => f.folder))) await checkFolderConflictRule(db, folder);
}

export async function countActiveConflicts(db: Db): Promise<number> {
  const map = await computeCollisionMap(db);
  return map.filter((e) => e.state === "conflict").length;
}
