// Build-Wächter — Push nach einem Lauf, gebündelt: Der ERSTE rote Lauf eines Fehlers (der zuerst
// fertige, s. `firstFinished`) löst eine Mitteilung aus. Jeder weitere Lauf mit demselben Fehler (gleiches Projekt + gleiche Signatur, s.
// `groupBuildRuns`) zählt nur den bestehenden Eintrag im Push-Protokoll hoch („4× seit 09:12“), statt
// das Handy erneut klingeln zu lassen. „Nicht eingerichtet“ und grün lösen nie eine Mitteilung aus.
import { formatBuildCount, groupBuildRuns, withoutRepaired, type BuildGroup, type BuildRunRow, type PushNotifyInput } from "@nyxos/shared";
import { and, desc, eq, gte, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buildRuns, pushLog } from "../db/schema.js";
import type { BuildDoneEvent } from "./queue.js";

/** Zeitraum, in dem gleiche Fehler zusammengefasst werden (wie „Braucht dich“). */
export const BUILD_BUNDLE_WINDOW_MS = 24 * 3600_000;

/** Läufe derselben Art im Bündel-Zeitraum (roh + gruppiert; für Push, „Braucht dich“, Briefing).
 * BC: rote Läufe, nach denen derselbe Ordner grün wurde, zählen nicht mehr (behoben) — so beginnt
 * nach einer Reparatur ein neuer Fehler eine neue Gruppe und meldet sich wieder per Push. */
async function recentRuns(db: Db, since: Date, kind?: BuildRunRow["kind"]) {
  const conds = [gte(buildRuns.startedAt, since.toISOString())];
  if (kind) conds.push(eq(buildRuns.kind, kind));
  const rows = withoutRepaired((await db.select().from(buildRuns).where(and(...conds)).orderBy(desc(buildRuns.startedAt)).limit(500)) as BuildRunRow[]);
  return { rows, groups: groupBuildRuns(rows) };
}

export async function recentBuildGroups(db: Db, since: Date, kind?: BuildRunRow["kind"]) {
  return (await recentRuns(db, since, kind)).groups;
}

const endOf = (r: BuildRunRow) => Date.parse((r.endedAt ?? r.startedAt).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

/** Der „erste“ Lauf eines Fehlers ist der, der zuerst FERTIG war (bei Gleichstand die kleinere
 * ID) — nicht der zuerst gestartete: sonst meldet ein früher gestarteter, später fertiger Lauf erneut, und
 * gleichzeitig fertige Läufe sähen alle „Zähler > 1, noch keine Mitteilung“ und schickten je eine. */
function firstFinished(rows: BuildRunRow[], ids: readonly number[]): number | null {
  const inGroup = rows.filter((r) => ids.includes(r.id));
  inGroup.sort((a, b) => endOf(a) - endOf(b) || a.id - b.id);
  return inGroup[0]?.id ?? null;
}

/** Entscheidungen nacheinander (gleichzeitig fertige Läufe sollen den Eintrag des ersten schon sehen). */
let chain: Promise<void> = Promise.resolve();

export function notifyBuildDone(db: Db, event: BuildDoneEvent, send: (input: PushNotifyInput) => Promise<unknown>, now = new Date()): Promise<void> {
  if (event.status !== "red") return Promise.resolve();
  const next = chain.then(() => decide(db, event, send, now));
  chain = next.catch(() => {});
  return next;
}

async function setCount(db: Db, group: BuildGroup): Promise<void> {
  const [existing] = await db
    .select({ id: pushLog.id })
    .from(pushLog)
    .where(and(eq(pushLog.kind, "build_red"), eq(pushLog.title, group.headline), like(pushLog.message, `${group.sentence}%`), gte(pushLog.sentAt, group.firstAt)))
    .orderBy(desc(pushLog.sentAt))
    .limit(1);
  if (existing) {
    await db
      .update(pushLog)
      .set({ bundledCount: group.count, message: `${group.sentence} · ${formatBuildCount(group)}` })
      .where(eq(pushLog.id, existing.id));
  }
}

async function decide(db: Db, event: BuildDoneEvent, send: (input: PushNotifyInput) => Promise<unknown>, now: Date): Promise<void> {
  const { rows, groups } = await recentRuns(db, new Date(now.getTime() - BUILD_BUNDLE_WINDOW_MS), event.kind);
  const group = groups.find((g) => g.ids.includes(event.id));
  if (!group) return;
  if (firstFinished(rows, group.ids) === event.id) {
    await send({ kind: "build_red", title: group.headline, message: group.sentence, sessionKey: event.sessionKey ?? undefined });
    // Waren gleichzeitig schon weitere gleiche Läufe fertig, steht ihr Zähler gleich am neuen Eintrag.
    if (group.count > 1) await setCount(db, group);
    return;
  }
  // Nicht der erste: nur den Zähler am Eintrag DIESES Fehlers hochsetzen (gleiche Überschrift UND gleicher
  // Satz — die Überschrift allein „Build rot: NyxOS“ teilen sich verschiedene Fehler).
  await setCount(db, group);
}
