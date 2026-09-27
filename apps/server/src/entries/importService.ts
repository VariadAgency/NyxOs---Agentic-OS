// Der Import läuft auf dem Server — ohne Projekt-Checkout im Container.
//
// Entscheidung (s. Bericht): Die Brücke liefert die Quelldateien (GOAL.md-Aufträge und
// MASSNAHMENPLAN.md, nur lesen, Datei-Wächter + Takt) an `POST /ingest/entry-sources`; der Server
// legt sie als Nur-Lese-Spiegel in `import_files` ab und importiert daraus. Ein Checkout auf dem
// Server wäre schlechter: nicht jede Datei liegt in Git, und ein Checkout veraltet, bis jemand
// `git pull` macht.
//
// Import beim Start, Dateien bei jeder Lieferung, dazu „Jetzt importieren“ (`POST /api/entries/import/run`).
// Alle Läufe hintereinander (nie zwei gleichzeitig), jeder Lauf ist idempotent.
import { createHash } from "node:crypto";
import { entrySourceKind, t, type EntryImportSourceStatus, type EntryImportState, type EntryImportStatus, type EntrySourcesIngest } from "@nyxos/shared";
import { eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { importFiles, importStatus } from "../db/schema.js";
import { importAuditTexts, importGoalFiles } from "./import.js";

type Source = "dateien";

/** Einfache Sätze für die Oberfläche — nie Rohfehler (Abnahme 7: keine Technik-Meldungen). */
export const IMPORT_MESSAGES = {
  dateienWartet: "Die Brücke hat die Dateien noch nicht geschickt.",
  dateienLeer: "Die Brücke hat geliefert, aber keine GOAL.md und keinen Maßnahmenplan gefunden.",
  dateienTeilweise: "Die Brücke konnte nicht alle Ordner lesen. Nichts wurde als entfernt markiert.",
  dateienFehler: "Der letzte Import der Dateien ist schiefgegangen. Er wird bei der nächsten Lieferung wiederholt.",
} as const;

export class IngestPathError extends Error {}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Postgres liefert „2026-09-25 11:42:50+01“ — Safari liest das nicht, die Web-App bekommt ISO. */
function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface EntriesImportDeps {
  db: Db;
  /** Nach jedem Lauf mit Änderungen: Web-App + Gehirn nachziehen lassen. */
  onChanged?: () => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class EntriesImportService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly log: NonNullable<EntriesImportDeps["log"]>;

  constructor(private readonly deps: EntriesImportDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Läufe strikt nacheinander (Lieferung, Takt und Knopf können gleichzeitig kommen). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Lieferung der Brücke: Spiegel aktualisieren, dann importieren. Wirft `IngestPathError` bei einem
   * Pfad außerhalb der Quell-Ordner (dieselbe Regel wie in der Brücke, `entrySourceKind`). */
  async ingest(body: EntrySourcesIngest, machineId: string | null) {
    for (const f of body.files) if (!entrySourceKind(f.path)) throw new IngestPathError(`Pfad nicht erlaubt: ${f.path.slice(0, 200)}`);
    return this.serial(async () => {
      const { db } = this.deps;
      const now = new Date().toISOString();
      const existing = await db.select({ path: importFiles.path, sha256: importFiles.sha256, removedAt: importFiles.removedAt }).from(importFiles);
      const byPath = new Map(existing.map((r) => [r.path, r]));
      for (const f of body.files) {
        const hash = sha(f.content);
        const old = byPath.get(f.path);
        if (old && old.sha256 === hash && old.removedAt === null) continue;
        await db
          .insert(importFiles)
          .values({ path: f.path, content: f.content, sha256: hash, sizeBytes: Buffer.byteLength(f.content), machineId, receivedAt: now, removedAt: null })
          .onConflictDoUpdate({ target: importFiles.path, set: { content: f.content, sha256: hash, sizeBytes: Buffer.byteLength(f.content), machineId, receivedAt: now, removedAt: null } });
      }
      // Nur eine vollständige, nicht leere Lieferung darf Dateien als entfernt markieren (eine leere
      // Liste heißt eher „falscher Ordner“ als „alles gelöscht“).
      const complete = body.complete && body.files.length > 0;
      if (complete) {
        const present = new Set(body.files.map((f) => f.path));
        const gone = existing.filter((r) => r.removedAt === null && !present.has(r.path)).map((r) => r.path);
        if (gone.length > 0) await db.update(importFiles).set({ removedAt: now }).where(inArray(importFiles.path, gone));
      }
      await this.writeStatus("dateien", { lastDeliveryAt: now });
      return this.importFilesNow({ complete, delivered: body.files.length, partial: !body.complete });
    });
  }

  /** Import aus dem gespeicherten Spiegel (nach einer Lieferung, beim Start, per Knopf). */
  private async importFilesNow(opts: { complete: boolean; delivered: number | null; partial: boolean }) {
    const { db } = this.deps;
    const runAt = new Date().toISOString();
    try {
      const rows = await db.select({ path: importFiles.path, content: importFiles.content }).from(importFiles).where(isNull(importFiles.removedAt));
      const goalFiles = rows.filter((r) => entrySourceKind(r.path) === "goal").sort((a, b) => a.path.localeCompare(b.path));
      const auditTexts = rows.filter((r) => entrySourceKind(r.path) === "audit").map((r) => r.content);
      // Berichte liegen im selben Spiegel — so gilt der Stand auch bei „Jetzt importieren“.
      const reports = rows.filter((r) => entrySourceKind(r.path) === "report");
      const goals = await importGoalFiles(db, goalFiles, { markMissing: opts.complete, reports });
      const audits = await importAuditTexts(db, auditTexts, { markMissing: opts.complete });
      const created = goals.created + audits.created;
      const updated = goals.updated + audits.updated;
      const completed = goals.completed;
      const removed = goals.removed + audits.removed;
      // Zustand nach der LETZTEN Lieferung: nie geliefert → wartet; Brücke fand nichts → leer (die
      // bisherigen Einträge bleiben, s. oben); sonst ok (ggf. mit Hinweis auf Lesefehler).
      const state: EntryImportState = opts.delivered === null ? (rows.length === 0 ? "wartet" : "ok") : opts.delivered === 0 ? "leer" : "ok";
      const message = state === "wartet" ? IMPORT_MESSAGES.dateienWartet : state === "leer" ? IMPORT_MESSAGES.dateienLeer : opts.partial ? IMPORT_MESSAGES.dateienTeilweise : null;
      await this.writeStatus("dateien", {
        state,
        message,
        lastRunAt: runAt,
        lastOkAt: runAt,
        counts: { aufgaben: goals.found, audits: audits.found, neu: created, geaendert: updated, entfernt: removed, erledigt: completed, geliefert: opts.delivered ?? rows.length },
      });
      if (created + updated + removed + completed > 0) this.deps.onChanged?.();
      this.log("import-dateien", { aufgaben: goals.found, audits: audits.found, neu: created, geaendert: updated, entfernt: removed, erledigt: completed });
      return { created, updated, removed, erledigt: completed, aufgaben: goals.found, audits: audits.found };
    } catch (e) {
      this.log("import-dateien-fehler", { error: String(e) });
      await this.writeStatus("dateien", { state: "fehler", message: IMPORT_MESSAGES.dateienFehler, lastRunAt: runAt });
      throw e;
    }
  }

  /** „Jetzt importieren“ und Start: Dateien aus dem letzten Stand der Brücke. */
  async runAll(): Promise<EntryImportStatus> {
    await this.serial(async () => {
      const [files] = await this.deps.db.select({ lastDeliveryAt: importStatus.lastDeliveryAt, counts: importStatus.counts }).from(importStatus).where(eq(importStatus.source, "dateien"));
      const delivered = files?.lastDeliveryAt ? (files.counts.geliefert ?? null) : null;
      // Ohne neue Lieferung nie etwas als entfernt markieren (`complete: false`).
      await this.importFilesNow({ complete: false, delivered, partial: false }).catch(() => {});
    });
    return this.status();
  }

  /** Beim Start einmal alles (Dateien kommen danach von selbst, wenn die Brücke liefert). */
  start(): void {
    void this.runAll().catch((e: unknown) => this.log("import-start-fehler", { error: String(e) }));
  }

  /** Nichts läuft im Takt — bleibt als Gegenstück zu `start()` für ein sauberes Herunterfahren. */
  stop(): void {}

  async status(): Promise<EntryImportStatus> {
    const rows = await this.deps.db.select().from(importStatus);
    const pick = (source: Source, fallback: Pick<EntryImportSourceStatus, "state" | "message">): EntryImportSourceStatus => {
      const r = rows.find((x) => x.source === source);
      return {
        state: (r?.state as EntryImportState | undefined) ?? fallback.state,
        // gespeichert wird der deutsche Satz; übersetzt wird beim Lesen (Sprache kann sich ändern).
        message: r ? (r.message === null ? null : t(r.message)) : fallback.message === null ? null : t(fallback.message),
        lastRunAt: toIso(r?.lastRunAt),
        lastOkAt: toIso(r?.lastOkAt),
        lastDeliveryAt: toIso(r?.lastDeliveryAt),
        counts: r?.counts ?? {},
      };
    };
    return {
      dateien: pick("dateien", { state: "wartet", message: IMPORT_MESSAGES.dateienWartet }),
    };
  }

  private async writeStatus(source: Source, patch: Partial<{ state: EntryImportState; message: string | null; lastRunAt: string; lastOkAt: string; lastDeliveryAt: string; counts: Record<string, number> }>) {
    const { db } = this.deps;
    await db
      .insert(importStatus)
      .values({ source, state: patch.state ?? "wartet", message: patch.message ?? null, ...patch })
      .onConflictDoUpdate({ target: importStatus.source, set: patch });
  }
}
