// Aufgaben/Bugs/Audit/Ideen/Entscheidungen/Fragen — CRUD, Fortschritt, Verknüpfungen, Reife-Check.
// Eigene Datei je Bereich: Web/MCP/Import bauen alle auf diesen Funktionen auf, nie auf
// rohem Drizzle-SQL in der Route.
import type { EntryKind, EntryStage } from "@nyxos/shared";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { parseSerialId } from "../ids.js";
import { docs, entries, entryEvents, links, sessions, subtasks } from "../db/schema.js";
import { computeMaturity, type MaturityResult } from "./maturity.js";
import type { EntryRow } from "./types.js";
import { one } from "./util.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateEntryOptions {
  /** Voller `EntryKind`-Wertebereich auf Store-Ebene (Aufträge/Audit-Einträge entstehen zwar
   * normalerweise nur über `import.ts`, ein manuelles Anlegen ist aber kein Fehler); die MCP-/
   * API-Schicht schränkt mit `CreateEntrySchema` auf die vier vom GOAL erlaubten Arten ein
   * (bug/idee/frage/problem — s. `routes/entries.ts`). */
  kind: EntryKind;
  title: string;
  description?: string;
  priority?: string;
  baustelleSlug?: string;
  baustelleLabel?: string;
  fileScope?: string[];
  subtasks?: string[];
  sourceType?: string;
  sourceId?: string;
  /** Session, die den Eintrag angelegt hat (Umgebungs-abgeleitet, nie vom Agenten behauptet — s. mcp.ts). */
  sessionKey?: string | null;
  source: string; // 'mcp' | 'api' | 'import'
}

const INITIAL_STAGE: Record<EntryKind, EntryStage> = {
  idee: "eingang",
  bug: "geplant",
  frage: "geplant",
  problem: "geplant",
  aufgabe: "geplant",
  audit: "geplant",
  entscheidung: "geplant",
};

function toDTO(row: EntryRow, maturity?: MaturityResult | null) {
  return {
    id: row.id,
    kind: row.kind as EntryKind,
    title: row.title,
    description: row.description,
    stage: row.stage as EntryStage,
    priority: row.priority,
    baustelle: row.baustelleSlug ? { slug: row.baustelleSlug, label: row.baustelleLabel ?? row.baustelleSlug } : null,
    progressPercent: row.progressPercent,
    progressDoneWeight: row.progressDoneWeight,
    progressTotalWeight: row.progressTotalWeight,
    maturity: maturity ?? (row.maturity as MaturityResult | null) ?? null,
    maturityCheckedAt: row.maturityCheckedAt,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceRemovedAt: row.sourceRemovedAt,
    fileScope: row.fileScope,
    modelSuggestion: row.modelSuggestion,
    estimate: row.estimate,
    worktreePath: row.worktreePath,
    gitBranch: row.gitBranch,
    tmuxName: row.tmuxName,
    startedSessionKey: row.startedSessionKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function logEvent(db: Db | Tx, entryId: number, kind: string, source: string, data: Record<string, unknown> = {}) {
  await db.insert(entryEvents).values({ entryId, kind, source, data });
}

/** Eine Session-Zuordnung kommt über die Umgebung der Brücke (nie vom Agenten behauptet, s.
 * `apps/bridge/src/mcp.ts`) — sie kann trotzdem auf eine inzwischen archivierte/gelöschte Session
 * zeigen. Statt dann mit einem Fremdschlüssel-Fehler abzustürzen, fällt eine unbekannte Session
 * still auf "keine Verknüpfung" zurück (der Fortschritt selbst bleibt echt, nur ohne Herkunfts-Link). */
async function resolveSessionKey(db: Db | Tx, sessionKey: string | null | undefined): Promise<string | null> {
  if (!sessionKey) return null;
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionKey));
  return row ? sessionKey : null;
}

export async function createEntry(db: Db, opts: CreateEntryOptions) {
  return db.transaction(async (tx) => {
    const row = one(
      await tx
        .insert(entries)
        .values({
          kind: opts.kind,
          title: opts.title,
          description: opts.description ?? null,
          stage: INITIAL_STAGE[opts.kind],
          priority: opts.priority ?? null,
          baustelleSlug: opts.baustelleSlug ?? null,
          baustelleLabel: opts.baustelleLabel ?? opts.baustelleSlug ?? null,
          fileScope: opts.fileScope ?? [],
          sourceType: opts.sourceType ?? "manual",
          sourceId: opts.sourceId ?? null,
        })
        .returning(),
    );
    if (opts.subtasks?.length) {
      await tx.insert(subtasks).values(opts.subtasks.map((title) => ({ entryId: row.id, title, weight: 1 })));
      await recomputeProgressTx(tx, row.id);
    }
    const sessionKey = await resolveSessionKey(tx, opts.sessionKey);
    if (sessionKey) {
      await tx
        .insert(links)
        .values({ fromType: "entry", fromId: String(row.id), toType: "session", toId: sessionKey, relation: "entstand_aus" })
        .onConflictDoNothing();
    }
    await logEvent(tx, row.id, "angelegt", opts.source, { sessionKey });
    const fresh = one(await tx.select().from(entries).where(eq(entries.id, row.id)));
    return toDTO(fresh);
  });
}

async function recomputeProgressTx(tx: Tx, entryId: number) {
  const rows = await tx.select({ weight: subtasks.weight, done: subtasks.done }).from(subtasks).where(eq(subtasks.entryId, entryId));
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const done = rows.filter((r) => r.done).reduce((s, r) => s + r.weight, 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  await tx.update(entries).set({ progressDoneWeight: done, progressTotalWeight: total, progressPercent: percent, updatedAt: new Date().toISOString() }).where(eq(entries.id, entryId));
  return { done, total, percent };
}

/** Hebt die Stufe automatisch: erster Fortschritt → "laeuft", alle Teilaufgaben erledigt → "pruefen".
 * Setzt NIE "erledigt" (nur der Nutzer) und NIE "startklar" (nur `applyMaturity`). */
async function autoAdvanceStageTx(tx: Tx, entryId: number, percent: number, total: number) {
  const [row] = await tx.select({ stage: entries.stage }).from(entries).where(eq(entries.id, entryId));
  if (!row) return;
  if (total > 0 && percent === 100 && row.stage !== "erledigt" && row.stage !== "pruefen") {
    await tx.update(entries).set({ stage: "pruefen" }).where(eq(entries.id, entryId));
  } else if ((row.stage === "geplant" || row.stage === "startklar") && percent > 0) {
    await tx.update(entries).set({ stage: "laeuft" }).where(eq(entries.id, entryId));
  }
}

export interface CompleteSubtaskOptions {
  entryId: number;
  subtaskId?: number;
  subtaskTitle?: string;
  sessionKey?: string | null;
  source: string;
}

export async function completeSubtask(db: Db, opts: CompleteSubtaskOptions) {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(subtasks).where(eq(subtasks.entryId, opts.entryId));
    const target = opts.subtaskId
      ? rows.find((r) => r.id === opts.subtaskId)
      : rows.find((r) => !r.done && r.title.trim().toLowerCase() === (opts.subtaskTitle ?? "").trim().toLowerCase());
    if (!target) return null;
    const sessionKey = await resolveSessionKey(tx, opts.sessionKey);
    if (!target.done) {
      await tx.update(subtasks).set({ done: true, doneAt: new Date().toISOString(), doneBySessionKey: sessionKey }).where(eq(subtasks.id, target.id));
    }
    const { percent, total } = await recomputeProgressTx(tx, opts.entryId);
    await autoAdvanceStageTx(tx, opts.entryId, percent, total);
    await logEvent(tx, opts.entryId, "teilaufgabe_erledigt", opts.source, { subtaskId: target.id, title: target.title, sessionKey });
    const fresh = one(await tx.select().from(entries).where(eq(entries.id, opts.entryId)));
    return toDTO(fresh);
  });
}

export interface ReportProgressOptions {
  entryId: number;
  note: string;
  sessionKey?: string | null;
  source: string;
}

export async function reportProgress(db: Db, opts: ReportProgressOptions) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(entries).where(eq(entries.id, opts.entryId));
    if (!row) return null;
    if (row.stage === "geplant" || row.stage === "startklar") {
      await tx.update(entries).set({ stage: "laeuft" }).where(eq(entries.id, opts.entryId));
    }
    const sessionKey = await resolveSessionKey(tx, opts.sessionKey);
    if (sessionKey) {
      await tx.insert(links).values({ fromType: "entry", fromId: String(opts.entryId), toType: "session", toId: sessionKey, relation: "session" }).onConflictDoNothing();
    }
    await logEvent(tx, opts.entryId, "fortschritt", opts.source, { note: opts.note, sessionKey });
    const fresh = one(await tx.select().from(entries).where(eq(entries.id, opts.entryId)));
    return toDTO(fresh);
  });
}

export async function addSubtasks(db: Db, entryId: number, titles: string[], source: string) {
  return db.transaction(async (tx) => {
    if (titles.length === 0) return null;
    await tx.insert(subtasks).values(titles.map((title) => ({ entryId, title, weight: 1 })));
    await recomputeProgressTx(tx, entryId);
    await logEvent(tx, entryId, "teilaufgaben_ergaenzt", source, { titles });
    const [fresh] = await tx.select().from(entries).where(eq(entries.id, entryId));
    return fresh ? toDTO(fresh) : null;
  });
}

export interface LinkOptions {
  fromType: "entry" | "session" | "file" | "commit" | "doc";
  fromId: string;
  toType: "entry" | "session" | "file" | "commit" | "doc";
  toId: string;
  relation: string;
  source: string;
}

export async function linkObjects(db: Db, opts: LinkOptions) {
  const [row] = await db
    .insert(links)
    .values({ fromType: opts.fromType, fromId: opts.fromId, toType: opts.toType, toId: opts.toId, relation: opts.relation })
    .onConflictDoNothing()
    .returning();
  if (opts.fromType === "entry") await logEvent(db, Number(opts.fromId), "verknuepft", opts.source, { toType: opts.toType, toId: opts.toId, relation: opts.relation });
  return row ?? null;
}

export async function getEntry(db: Db, id: number) {
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  return row ? toDTO(row) : null;
}

export interface UpdateEntryFields {
  estimate?: string | null;
  modelSuggestion?: string | null;
  priority?: string | null;
  fileScope?: string[];
  baustelleSlug?: string | null;
  baustelleLabel?: string | null;
}

/** Von Hand nachtragbare Felder (Start-Blatt) — nie `stage` (das setzt nur der
 * Reife-Check bzw. die Automatik) und nie `kind` (das ändert nur `promote`). */
export async function updateEntryFields(db: Db, id: number, fields: UpdateEntryFields) {
  const [row] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id));
  if (!row) return null;
  await db.update(entries).set({ ...fields, updatedAt: new Date().toISOString() }).where(eq(entries.id, id));
  return getEntry(db, id);
}

async function labelFor(db: Db, type: string, id: string): Promise<string> {
  if (type === "entry") {
    const n = parseSerialId(id);
    const [row] = n === null ? [] : await db.select({ title: entries.title }).from(entries).where(eq(entries.id, n));
    return row?.title ?? `Eintrag ${id}`;
  }
  if (type === "session") {
    const [row] = await db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, id));
    return row?.title ?? id;
  }
  if (type === "doc") return id;
  return id;
}

export async function getEntryDetail(db: Db, id: number) {
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  if (!row) return null;
  const subtaskRows = await db.select().from(subtasks).where(eq(subtasks.entryId, id)).orderBy(subtasks.id);
  const linkRows = await db
    .select()
    .from(links)
    .where(or(and(eq(links.fromType, "entry"), eq(links.fromId, String(id))), and(eq(links.toType, "entry"), eq(links.toId, String(id)))));
  const enrichedLinks = await Promise.all(
    linkRows.map(async (l) => {
      const outgoing = l.fromType === "entry" && l.fromId === String(id);
      const otherType = outgoing ? l.toType : l.fromType;
      const otherId = outgoing ? l.toId : l.fromId;
      return { ...l, label: await labelFor(db, otherType, otherId), direction: outgoing ? "out" : ("in" as const) };
    }),
  );
  const eventRows = await db.select().from(entryEvents).where(eq(entryEvents.entryId, id)).orderBy(desc(entryEvents.ts)).limit(100);
  const docLinks = linkRows.filter((l) => l.fromType === "entry" && l.toType === "doc");
  const docRows = docLinks.length ? await db.select({ path: docs.path, updatedAt: docs.updatedAt }).from(docs).where(inArray(docs.path, docLinks.map((d) => d.toId))) : [];
  return {
    entry: toDTO(row),
    subtasks: subtaskRows,
    links: enrichedLinks,
    events: eventRows,
    docs: docRows,
  };
}

export interface ListEntriesOptions {
  q?: string;
  kind?: EntryKind;
  stage?: EntryStage;
  limit?: number;
}

export async function listEntries(db: Db, opts: ListEntriesOptions = {}) {
  const rows = await db.select().from(entries).orderBy(desc(entries.updatedAt)).limit(Math.min(opts.limit ?? 500, 2000));
  const needle = opts.q?.trim().toLowerCase();
  return rows
    .filter((r) => (opts.kind ? r.kind === opts.kind : true))
    .filter((r) => (opts.stage ? r.stage === opts.stage : true))
    .filter((r) => (needle ? `${r.title} ${r.description ?? ""} ${r.baustelleLabel ?? ""}`.toLowerCase().includes(needle) : true))
    .map((r) => toDTO(r));
}

/** Führt den Reife-Check aus und setzt/entfernt "startklar" — die EINZIGE Stelle, die diese Stufe
 * schreibt. Läuft/Prüfen/Erledigt bleiben unangetastet. */
export async function applyMaturity(db: Db, id: number) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(entries).where(eq(entries.id, id));
    if (!row) return null;
    const result = await computeMaturity(tx as unknown as Db, row);
    const nowStr = new Date().toISOString();
    let nextStage = row.stage as EntryStage;
    if (row.stage === "geplant" && result.passed) nextStage = "startklar";
    else if (row.stage === "startklar" && !result.passed) nextStage = "geplant";
    // Voller `MaturityResult` (nicht nur `result.points`!) — die Web-App liest `passed`/
    // `passedCount`/`totalCount` genauso wie die Punkte-Liste (s. `MaturityRing.tsx`); ein
    // Playwright-Lauf gegen den Probe-Stack deckte den ursprünglichen Fehler auf (nur `.points`
    // gespeichert → `entry.maturity.points` beim Neuladen `undefined` → Absturz in der Großansicht).
    await tx.update(entries).set({ maturity: result, maturityCheckedAt: nowStr, stage: nextStage }).where(eq(entries.id, id));
    if (nextStage !== row.stage) await logEvent(tx, id, nextStage === "startklar" ? "startklar" : "reife_verloren", "reife-check", { result });
    const fresh = one(await tx.select().from(entries).where(eq(entries.id, id)));
    return { entry: toDTO(fresh, result), maturity: result };
  });
}

export async function applyMaturityToAllPlanned(db: Db) {
  const rows = await db.select({ id: entries.id }).from(entries).where(inArray(entries.stage, ["geplant", "startklar"]));
  const results = [];
  for (const r of rows) {
    const res = await applyMaturity(db, r.id);
    if (res) results.push(res);
  }
  return results;
}

export { toDTO as entryToDTO, recomputeProgressTx };
