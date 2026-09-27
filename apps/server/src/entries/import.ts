// Import aus Aufträgen (GOAL.md) und Audit-Befunden (MASSNAHMENPLAN.md). Läuft
// wiederholbar (Quell-ID eindeutig, `entries_source_idx`) und ändert nie von Hand gepflegte Felder bei
// einem erneuten Lauf — nur `title`/`description`/`fileScope`-Hinweise werden aus der Quelle
// nachgezogen, `stage`/`priority`/`estimate` etc. bleiben unangetastet, sobald sie einmal gesetzt sind
// (s. `upsertImported`). Liest NUR (nie Quell-Dateien verändern).
//
// Der Kern arbeitet ohne Dateisystem (`importGoalFiles`/`importAuditTexts`) — die Quelle ist
// die Lieferung der Brücke (`POST /ingest/entry-sources`), denn im Server-Container gibt es kein
// Projekt-Checkout. Ein zweiter Lauf mit derselben Quelle ändert nichts (auch nicht `updatedAt`), und
// was in einer vollständigen Lieferung fehlt, wird „Quelle entfernt“ markiert statt gelöscht.
//
// Liegt neben einer GOAL.md ein `BERICHT.md`, ist der Auftrag fertig. Der Import setzt ihn dann
// EINMAL auf „Erledigt“ (s. `markDoneByReport`), verknüpft den Bericht und spiegelt ihn, damit die
// Großansicht ihn zeigt. Vorher standen fertige Pakete auf „Geplant 0 %“ mit „Agent starten“.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ENTRY_SOURCE_GOAL_DIRS, ENTRY_SOURCE_REPORT_FILE, ENTRY_SOURCE_SKIP_DIRS } from "@nyxos/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries, entryEvents, links } from "../db/schema.js";
import { mirrorDocs } from "./docMirror.js";
import type { EntryRow } from "./types.js";
import { one } from "./util.js";

function walk(root: string, filter: (p: string) => boolean, out: string[] = []): string[] {
  let items: string[];
  try {
    items = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of items) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!ENTRY_SOURCE_SKIP_DIRS.has(name)) walk(p, filter, out);
    } else if (filter(p)) out.push(p);
  }
  return out;
}

type UpsertOutcome = "created" | "updated" | "unchanged";

/** Legt einen Eintrag idempotent an (per `sourceType`+`sourceId`) oder zieht nur die Import-Rohdaten
 * (Titel/Beschreibung/Dateibereich-Hinweis) nach — und das NUR, wenn sie sich wirklich geändert haben
 * (sonst springt bei jedem Lauf jeder Eintrag in der Liste nach oben). `stage`/`priority`/
 * `estimate` bleiben unberührt, sobald ein Mensch/Agent sie einmal gesetzt hat. War der Eintrag als
 * „Quelle entfernt“ markiert und ist die Quelle wieder da, wird die Markierung zurückgenommen. */
async function upsertImported(
  db: Db,
  input: {
    kind: string;
    title: string;
    description: string;
    sourceType: string;
    sourceId: string;
    fileScope: string[];
    baustelleSlug?: string;
    baustelleLabel?: string;
    priority?: string;
    estimate?: string;
    stage?: string;
  },
): Promise<{ id: number; outcome: UpsertOutcome; row: EntryRow | null }> {
  const [row] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.sourceType, input.sourceType), eq(entries.sourceId, input.sourceId)));
  if (row) {
    const changed =
      row.title !== input.title ||
      (row.description ?? "") !== input.description ||
      JSON.stringify(row.fileScope) !== JSON.stringify(input.fileScope) ||
      row.sourceRemovedAt !== null;
    if (!changed) return { id: row.id, outcome: "unchanged", row };
    await db
      .update(entries)
      .set({ title: input.title, description: input.description, fileScope: input.fileScope, sourceRemovedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(entries.id, row.id));
    return { id: row.id, outcome: "updated", row };
  }
  const created = one(
    await db
      .insert(entries)
      .values({
        kind: input.kind,
        title: input.title,
        description: input.description,
        stage: input.stage ?? "geplant",
        priority: input.priority,
        baustelleSlug: input.baustelleSlug,
        baustelleLabel: input.baustelleLabel ?? input.baustelleSlug,
        fileScope: input.fileScope,
        estimate: input.estimate,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      })
      .returning({ id: entries.id }),
  );
  return { id: created.id, outcome: "created", row: null };
}

/** Einträge einer Quelle, die in einer VOLLSTÄNDIGEN Lieferung nicht mehr vorkommen, als
 * „Quelle entfernt“ markieren — nie löschen (Löschen bleibt beim Nutzer). `onlyKind` begrenzt das
 * auf eine Art (Ideen: schon in Aufgaben übernommene Einträge leben unabhängig vom Postfach weiter). */
async function markMissingSources(db: Db, sourceType: string, presentIds: Set<string>, onlyKind?: string): Promise<number> {
  const rows = await db
    .select({ id: entries.id, sourceId: entries.sourceId, kind: entries.kind })
    .from(entries)
    .where(and(eq(entries.sourceType, sourceType), isNull(entries.sourceRemovedAt)));
  const gone = rows.filter((r) => r.sourceId !== null && !presentIds.has(r.sourceId) && (!onlyKind || r.kind === onlyKind)).map((r) => r.id);
  if (gone.length === 0) return 0;
  const now = new Date().toISOString();
  await db.update(entries).set({ sourceRemovedAt: now, updatedAt: now }).where(inArray(entries.id, gone));
  return gone.length;
}

export interface ImportCounts {
  found: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Neu als „Quelle entfernt“ markiert (nur bei vollständiger Lieferung). */
  removed: number;
}

function tally(outcomes: UpsertOutcome[], found: number, removed: number): ImportCounts {
  return {
    found,
    created: outcomes.filter((o) => o === "created").length,
    updated: outcomes.filter((o) => o === "updated").length,
    unchanged: outcomes.filter((o) => o === "unchanged").length,
    removed,
  };
}

const PATH_HINT_RE = /`([\w][\w./-]*\/[\w][\w./*-]*)`/g;

function deriveFileScope(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(PATH_HINT_RE)) {
    const p = m[1];
    if (!p || p.includes("http") || p.length > 80) continue;
    hits.add(p);
    if (hits.size >= 12) break;
  }
  return [...hits];
}

function deriveTitle(text: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  const group = m?.[1];
  return group ? group.trim() : fallback;
}

function deriveDescription(text: string): string {
  const m = /##\s*ZIEL\s*\n+([\s\S]{0,600}?)(?=\n##|\n---|$)/i.exec(text);
  const group = m?.[1];
  return (group ?? text.slice(0, 400)).trim();
}

/** "Dauer: 8–10 Std" aus der Kopfzeile mancher GOAL.md (z. B. NyxOS-Phasen) → Schätzung (Reife-
 * Check Punkt 6). Fehlt sie (viele echte GOAL.md haben keine Dauer-Angabe), bleibt `estimate` leer —
 * keine erfundene Zahl. */
function deriveEstimate(text: string): string | undefined {
  return /Dauer:\s*([^\n·]+)/.exec(text)?.[1]?.trim();
}

export interface ImportGoalsOptions {
  /** Projekt-Ordner (Repo-Wurzel). */
  root: string;
  /** Repo-relative Ordner, die durchsucht werden (canonical, keine Worktree-Kopien/Archiv). */
  includeDirs?: string[];
}

export interface ImportGoalsResult extends ImportCounts {
  paths: string[];
  /** in diesem Lauf wegen eines BERICHT.md auf „Erledigt“ gesetzt. */
  completed: number;
}

// ---------------------------------------------------------------------------
// BERICHT.md neben der GOAL.md → Auftrag erledigt
// ---------------------------------------------------------------------------

/** Ereignis im Verlauf des Eintrags — zugleich die Sperre gegen ein zweites Setzen. */
export const REPORT_DONE_EVENT = "erledigt_durch_bericht";
/** Nur aus diesen Stufen setzt ein Bericht „Erledigt“. Was läuft oder auf Abnahme wartet, kommt aus einer
 * echten Session in NyxOS; dort entscheidet der Nutzer über „Erledigt“, nicht die Datei. */
const REPORT_FROM_STAGES = new Set(["geplant", "startklar"]);

/** `…/P1-fundament/GOAL.md` → `…/P1-fundament/BERICHT.md` (nur direkt daneben, kein Unterordner). */
export function reportPathFor(goalPath: string): string {
  const cut = goalPath.lastIndexOf("/");
  return `${cut === -1 ? "" : goalPath.slice(0, cut + 1)}${ENTRY_SOURCE_REPORT_FILE}`;
}

/** Setzt einen Auftrag wegen seines Berichts auf „Erledigt“ — genau einmal je Eintrag: Gibt es das
 * Ereignis schon, bleibt alles, wie es ist (hat der Nutzer den Auftrag danach wieder geöffnet, gilt das).
 * `updatedAt` bleibt bewusst stehen: wann der Bericht kam, wissen wir nicht — sonst stünde jeder alte
 * Auftrag beim ersten Import unter „heute fertig“. */
async function markDoneByReport(db: Db, entryId: number, reportPath: string): Promise<boolean> {
  const [row] = await db.select({ stage: entries.stage }).from(entries).where(eq(entries.id, entryId));
  if (!row || !REPORT_FROM_STAGES.has(row.stage)) return false;
  const [seen] = await db
    .select({ id: entryEvents.id })
    .from(entryEvents)
    .where(and(eq(entryEvents.entryId, entryId), eq(entryEvents.kind, REPORT_DONE_EVENT)))
    .limit(1);
  if (seen) return false;
  await db.transaction(async (tx) => {
    await tx.update(entries).set({ stage: "erledigt" }).where(eq(entries.id, entryId));
    await tx.insert(entryEvents).values({ entryId, kind: REPORT_DONE_EVENT, source: "import", data: { bericht: reportPath, vorher: row.stage } });
  });
  return true;
}

/** Eine Quelldatei, repo-relativ ab dem Projekt-Ordner (so, wie die Brücke sie schickt). */
export interface SourceFile {
  path: string;
  content: string;
}

/** Schritt 3 „Aufträge“, Kern ohne Dateisystem: jede GOAL.md → Eintrag „aufgabe“. `markMissing` nur
 * bei einer vollständigen Lieferung (dann werden fehlende GOAL.md als „Quelle entfernt“ markiert).
 * `reports`: die mitgelieferten `BERICHT.md`; einer direkt neben einer GOAL.md macht den
 * Auftrag fertig (s. `markDoneByReport`), lose Berichte werden ignoriert. */
export async function importGoalFiles(db: Db, files: SourceFile[], opts: { markMissing: boolean; reports?: SourceFile[] }): Promise<ImportGoalsResult> {
  const outcomes: UpsertOutcome[] = [];
  const reportsByPath = new Map((opts.reports ?? []).map((r) => [r.path, r]));
  const usedReports: SourceFile[] = [];
  let completed = 0;
  const idsByPath = new Map<string, number>();
  const predByPath = new Map<string, string>();
  for (const file of files) {
    const rel = file.path;
    const text = file.content;
    const baustelleSlug = rel.split("/")[0];
    const { id, outcome } = await upsertImported(db, {
      kind: "aufgabe",
      title: deriveTitle(text, rel),
      description: deriveDescription(text),
      sourceType: "goal",
      sourceId: rel,
      fileScope: deriveFileScope(text),
      estimate: deriveEstimate(text),
      baustelleSlug,
      baustelleLabel: baustelleSlug,
    });
    outcomes.push(outcome);
    idsByPath.set(rel, id);
    await db.insert(links).values({ fromType: "entry", fromId: String(id), toType: "doc", toId: rel, relation: "dokument" }).onConflictDoNothing();
    const report = reportsByPath.get(reportPathFor(rel));
    if (report) {
      usedReports.push(report);
      await db.insert(links).values({ fromType: "entry", fromId: String(id), toType: "doc", toId: report.path, relation: "bericht" }).onConflictDoNothing();
      if (await markDoneByReport(db, id, report.path)) completed++;
    }
    // Best-effort: Vorgänger-Phase per Präfix (z. B. "Vorgänger: P3" → …/P3-terminal/GOAL.md).
    const predToken = /Vorgänger:\s*([^\n·(]+)/.exec(text)?.[1]?.trim();
    const phasePrefix = predToken && predToken !== "keiner" ? predToken.match(/^P\d+/)?.[0] : null;
    if (phasePrefix) predByPath.set(rel, phasePrefix);
  }
  // Vorgänger erst nach allen Anlagen verknüpfen — sonst hängt der Treffer von der Datei-Reihenfolge ab.
  if (predByPath.size > 0) {
    const candidates = await db.select({ id: entries.id, sourceId: entries.sourceId }).from(entries).where(eq(entries.sourceType, "goal"));
    for (const [rel, prefix] of predByPath) {
      const id = idsByPath.get(rel);
      const match = candidates.find((c) => c.sourceId?.includes(`/${prefix}-`));
      if (id !== undefined && match && match.id !== id) {
        await db.insert(links).values({ fromType: "entry", fromId: String(id), toType: "entry", toId: String(match.id), relation: "vorgaenger" }).onConflictDoNothing();
      }
    }
  }
  await mirrorDocs(db, [...files, ...usedReports]);
  const removed = opts.markMissing ? await markMissingSources(db, "goal", new Set(files.map((f) => f.path))) : 0;
  return { ...tally(outcomes, files.length, removed), paths: files.map((f) => f.path), completed };
}

/** Wie `importGoalFiles`, aber aus einem lokalen Ordner (Tests, Betreiber-Aufruf). Markiert nie etwas
 * als entfernt — ein Teil-Ordner ist keine vollständige Lieferung. Arbeitskopien (`.worktrees/**`) und
 * Abhängigkeiten werden übersprungen (`ENTRY_SOURCE_SKIP_DIRS`). */
export async function importGoals(db: Db, opts: ImportGoalsOptions): Promise<ImportGoalsResult> {
  const dirs = opts.includeDirs ?? [...ENTRY_SOURCE_GOAL_DIRS];
  const abs = dirs.flatMap((d) => walk(join(opts.root, d), (p) => p.endsWith("GOAL.md")));
  const files = abs.map((a) => ({ path: relative(opts.root, a), content: readFileSync(a, "utf8") }));
  return importGoalFiles(db, files, { markMissing: false });
}

// ---------------------------------------------------------------------------
// Audit-Import (Schritt 3 „Audit")
// ---------------------------------------------------------------------------

const AUDIT_ROW_RE = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\[([^—\]]+?)\s*—\s*([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

export type ImportAuditResult = ImportCounts;

/** Parst die Tabelle „Gesamtreihenfolge sämtlicher Befunde“ eines oder mehrerer Maßnahmenpläne (382
 * Befunde). Jede Zeile → Eintrag „audit“. „Pakete als Eltern“ (GOAL
 * Schritt 3) ist für P4 vereinfacht: das Paket wird als Baustelle am Fund selbst gespeichert. */
export async function importAuditTexts(db: Db, texts: string[], opts: { markMissing: boolean }): Promise<ImportAuditResult> {
  const outcomes: UpsertOutcome[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const m = AUDIT_ROW_RE.exec(line);
      if (!m) continue;
      const stufe = m[2] ?? "3";
      const id = (m[3] ?? "").trim();
      const title = (m[4] ?? "").trim();
      const schwere = (m[6] ?? "").trim();
      const paket = (m[9] ?? "").trim();
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      const priority = stufe === "0" ? "p0" : stufe === "1" ? "p1" : stufe === "2" ? "p2" : "p3";
      const { outcome } = await upsertImported(db, {
        kind: "audit",
        title: `${id} — ${title}`,
        description: `Schwere: ${schwere} · Stufe ${stufe} · Paket ${paket}`,
        sourceType: "audit",
        sourceId: id,
        fileScope: [],
        baustelleSlug: paket,
        baustelleLabel: paket,
        priority,
      });
      outcomes.push(outcome);
    }
  }
  const removed = opts.markMissing ? await markMissingSources(db, "audit", seen) : 0;
  return tally(outcomes, seen.size, removed);
}

/** Lokale Datei (Tests, Betreiber-Aufruf) — markiert nie etwas als entfernt. */
export async function importAudit(db: Db, massnahmenplanPath: string): Promise<ImportAuditResult> {
  return importAuditTexts(db, [readFileSync(massnahmenplanPath, "utf8")], { markMissing: false });
}

export { deriveDescription, deriveEstimate, deriveFileScope, deriveTitle };
