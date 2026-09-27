import type { IngestItem, SessionEvent, SessionState, SessionSummary, TerminalInfo, Tool } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  buildCorrectionCondition,
  categorize,
  computeDominantFolder,
  describeCondition,
  describeRuleCondition,
  extractWords,
  type Art,
  type Baustelle,
  type CategorizeFeatures,
  type CategorizeReason,
  type CategoryUndo,
  type CorrectionStats,
  type RuleCondition,
  type RuleDimension,
  type SortRule,
} from "./categorize.js";
import type { Db } from "./db/client.js";
import { archive, sessionEvents, sessionFiles, sessions, sortRules } from "./db/schema.js";
import { indexSessionsMetaDocsTx } from "./search.js";
import { computeSessionState, deriveTurnSignal, type ComputedSessionState } from "./state.js";
import { stateOptions } from "./state-settings.js";
import { visibleSession } from "./db/visible.js";

export const sessionKey = (tool: Tool, sessionId: string) => `${tool}:${sessionId}`;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface IngestOutcome {
  accepted: number;
  duplicates: number;
  touched: Set<string>;
}

const CHUNK = 500;
function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Inhaltliche Event-Arten — Rahmen-Events wie `system`/`attachment`/
 * `compaction`/`hook`/`subagent`/`session_meta` sagen nichts darüber aus, ob eine Runde offen ist. */
const CONTENT_EVENT_KINDS = new Set(["prompt", "assistant", "tool_call", "tool_result"]);

/**
 * Zwischenspeicher für Skill-Namen je Session: `loadCategorizeFeatures`
 * scannte bisher bei JEDEM Ingest-Aufruf ALLE `tool_call`-Events der Session neu, um Skill-Aufrufe zu
 * finden — bei 20.000 Events ein voller Tabellen-Scan je Hook. Ein Zwischenspeicher-Treffer erspart
 * das: nur neue Batch-Events (`add`) werden noch geprüft, statt die ganze Geschichte neu zu lesen.
 * Ein Fehltreffer (Server-Neustart, `resort`/CLI-Pfad) löst wieder den vollen Scan aus, der den
 * Speicher dann neu befüllt (`seed`) — kein Datenverlust möglich, nur ein Fehltreffer kostet erneut
 * den vollen Scan. Klein und beschränkt wie `TranscriptCache` (Prozess-Zwischenspeicher, kein Bestand).
 */
export class SkillsCache {
  private readonly map = new Map<string, Set<string>>();
  constructor(private readonly maxEntries = 200) {}

  get(key: string): Set<string> | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key);
    this.map.set(key, hit); // an das Ende (zuletzt genutzt)
    return hit;
  }

  /** Legt den Zwischenspeicher für `key` aus einem vollen Scan neu an. */
  seed(key: string, skills: Iterable<string>): Set<string> {
    const set = new Set(skills);
    this.map.delete(key);
    this.map.set(key, set);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return set;
  }

  /** Ergänzt neu gesehene Skill-Namen — nur wirksam bei einem Treffer, sonst holt der nächste
   * `loadCategorizeFeatures`-Aufruf ohnehin den vollen Scan (der auch diese Namen findet). */
  add(key: string, skills: Iterable<string>): void {
    const hit = this.get(key);
    if (!hit) return;
    for (const s of skills) hit.add(s);
  }
}

/** Legt fehlende Session-Zeilen an, damit Events nie an einer fehlenden Session scheitern. */
async function ensureSessions(tx: Tx, machineId: string, items: IngestItem[]): Promise<void> {
  const rows = new Map<string, { tool: Tool; sessionId: string; ts: string | null }>();
  const add = (tool: Tool, sessionId: string, ts: string | null) => {
    const key = sessionKey(tool, sessionId);
    const prev = rows.get(key);
    if (!prev || (ts && (!prev.ts || ts < prev.ts))) rows.set(key, { tool, sessionId, ts });
  };
  for (const it of items) {
    if (it.type === "event") add(it.event.tool, it.event.sessionId, it.event.ts);
    else if (it.type === "summary") add(it.summary.tool, it.summary.sessionId, it.summary.startedAt);
    else if (it.type === "terminal") add(it.terminal.tool, it.terminal.sessionId, null);
    else add(it.state.tool, it.state.sessionId, null);
  }
  const values = [...rows].map(([id, r]) => ({
    id,
    tool: r.tool,
    sessionId: r.sessionId,
    machineId,
    startedAt: r.ts,
    lastActivityAt: r.ts,
  }));
  for (const part of chunks(values)) await tx.insert(sessions).values(part).onConflictDoNothing();
}

async function insertEvents(tx: Tx, events: SessionEvent[], touched: Set<string>, skillsCache: SkillsCache): Promise<number> {
  let accepted = 0;
  for (const part of chunks(events)) {
    const inserted = await tx
      .insert(sessionEvents)
      .values(
        part.map((e) => ({
          id: e.id,
          sessionKey: sessionKey(e.tool, e.sessionId),
          ts: e.ts,
          kind: e.kind,
          source: e.source,
          data: e.data,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: sessionEvents.id });
    const fresh = new Set(inserted.map((r) => r.id));
    accepted += fresh.size;

    // Pro Session: Zähler und Aktivität nur für wirklich neue Events fortschreiben.
    const perSession = new Map<string, { n: number; min: string; max: string }>();
    for (const e of part) {
      if (!fresh.has(e.id)) continue;
      const key = sessionKey(e.tool, e.sessionId);
      const s = perSession.get(key) ?? { n: 0, min: e.ts, max: e.ts };
      s.n++;
      if (e.ts < s.min) s.min = e.ts;
      if (e.ts > s.max) s.max = e.ts;
      perSession.set(key, s);
    }
    for (const [key, s] of perSession) {
      touched.add(key);
      await tx
        .update(sessions)
        .set({
          eventCount: sql`${sessions.eventCount} + ${s.n}`,
          startedAt: sql`least(${sessions.startedAt}, ${s.min}::timestamptz)`,
          lastActivityAt: sql`greatest(${sessions.lastActivityAt}, ${s.max}::timestamptz)`,
          updatedAt: sql`now()`,
        })
        .where(eq(sessions.id, key));
    }

    // Hook-Ereignisse steuern den Status, aber nur wenn sie jünger sind als der letzte Statuswechsel.
    for (const e of part) {
      if (!fresh.has(e.id)) continue;
      const key = sessionKey(e.tool, e.sessionId);
      if (e.source === "hook") {
        const hook = e.data.event;
        if (hook === "SessionStart" || hook === "SessionEnd") {
          await applyStatus(tx, key, hook === "SessionStart", e.ts, hook === "SessionEnd" ? e.ts : null, hook === "SessionEnd");
        }
      }
      // Codex `turn_end`/`turn_aborted` (task_complete/Abbruch durch den Nutzer): die Runde ist zu, der Nutzer
      // ist gefragt (wie Claudes Stop-Hook). Gemeinsame Ableitung mit `backfillStates` (state.ts).
      const turn = deriveTurnSignal(e);
      if (turn !== null) await applyTurn(tx, key, turn, e.ts);
      //: auch im Live-Pfad, nicht nur in
      // `backfillStates` — solange eine Session NOCH NIE ein echtes Runden-Signal bekommen hat (z. B.
      // Brücke ohne Hooks, `pnpm probe`), bliebe `turn_open` sonst für immer beim Vorgabewert `true`
      // stehen; verschwindet der Prozess, gilt die Session dann fälschlich als „abgestürzt" statt
      // sauber beendet (gemessen im Probe-Stack: 7/8 hookloser Coding-Sessions betroffen).
      else if (CONTENT_EVENT_KINDS.has(e.kind)) await applyContentFallbackTurn(tx, key, e.kind !== "assistant");

      //: Skill-Namen aus frischen Batch-Events direkt in den Zwischen-
      // speicher ergänzen — spart den vollen `tool_call`-Scan in `loadCategorizeFeatures` für JEDEN
      // weiteren Hook derselben Session (nur der erste Fehltreffer scannt noch voll).
      if (e.kind === "tool_call") {
        const data = e.data as Record<string, unknown>;
        if (data.name === "Skill" && typeof data.target === "string" && data.target) skillsCache.add(key, [data.target]);
      }
    }
  }
  return accepted;
}

async function applyStatus(
  tx: Tx,
  key: string,
  running: boolean,
  observedAt: string,
  endedAt: string | null,
  sessionEndHook = false,
): Promise<void> {
  await tx
    .update(sessions)
    .set(
      running
        ? //: ein SessionStart macht ein früheres SessionEnd ungültig — sonst
          // sähe /exit → resume → Absturz ohne neues SessionEnd fälschlich „sauber beendet" statt
          // „abgestürzt" aus (das alte session_end_received_at würde weiterhin gelten).
          { status: "running", endedAt: null, stateObservedAt: observedAt, sessionEndReceivedAt: null, updatedAt: sql`now()` }
        : {
            status: "ended",
            endedAt: endedAt ?? sql`coalesce(${sessions.endedAt}, ${sessions.lastActivityAt}, ${observedAt}::timestamptz)`,
            stateObservedAt: observedAt,
            updatedAt: sql`now()`,
          },
    )
    .where(
      and(eq(sessions.id, key), sql`coalesce(${sessions.stateObservedAt}, '-infinity'::timestamptz) <= ${observedAt}::timestamptz`),
    );

  // session_end_received_at: unabhängig vom Verspätungsschutz oben
  // schreiben — der schützt nur `status`/`stateObservedAt` vor einem zu alten Ereignis, ein
  // verspätet zugestelltes, aber echtes SessionEnd (z. B. weil ein „weg"-Lebenszeichen aus der
  // Brücke schneller ankam als der gepufferte Hook) soll trotzdem zählen. Einzige Ausnahme: ein
  // SessionStart ist inzwischen bekannt, das jünger ist als dieses SessionEnd (Resume danach —
  // das alte Ende ist dann nicht mehr die Wahrheit über die aktuelle Runde).
  if (sessionEndHook) {
    await tx
      .update(sessions)
      .set({ sessionEndReceivedAt: observedAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(sessions.id, key),
          sql`coalesce(${sessions.sessionEndReceivedAt}, '-infinity'::timestamptz) < ${observedAt}::timestamptz`,
          sql`not (${sessions.turnOpen} and coalesce(${sessions.turnObservedAt}, '-infinity'::timestamptz) > ${observedAt}::timestamptz)`,
        ),
      );
  }
}

/** Wie `applyStatus`, aber für „ist die aktuelle Runde offen?" — dieselbe Verspätungs-Absicherung. */
async function applyTurn(tx: Tx, key: string, open: boolean, observedAt: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ turnOpen: open, turnObservedAt: observedAt, updatedAt: sql`now()` })
    .where(
      and(eq(sessions.id, key), sql`coalesce(${sessions.turnObservedAt}, '-infinity'::timestamptz) <= ${observedAt}::timestamptz`),
    );
}

/**
 * Live-Gegenstück zum Rückfall in `backfillStates`:
 * solange eine Session noch nie ein echtes Runden-Signal bekommen hat (Hook oder Codex `turn_*`),
 * bestimmt das jüngste INHALTLICHE Datei-Event (prompt/assistant/tool_call/tool_result), ob die
 * Runde offen ist — `assistant` schließt sie, alles andere hält sie offen. Schreibt bewusst NUR
 * `turn_open`, NIE `turn_observed_at`: dessen `NULL`-Zustand ist genau das Signal „bis jetzt kam noch
 * kein echtes Runden-Ereignis" und schaltet diesen Rückfall endgültig ab, sobald `applyTurn` einmal
 * ein echtes Signal geschrieben hat (danach bleibt `turn_observed_at` für immer gesetzt).
 */
async function applyContentFallbackTurn(tx: Tx, key: string, open: boolean): Promise<void> {
  await tx
    .update(sessions)
    .set({ turnOpen: open, updatedAt: sql`now()` })
    .where(and(eq(sessions.id, key), isNull(sessions.turnObservedAt)));
}

const STATE_ROW_COLUMNS = {
  id: sessions.id,
  status: sessions.status,
  turnOpen: sessions.turnOpen,
  sessionEndReceivedAt: sessions.sessionEndReceivedAt,
  lastActivityAt: sessions.lastActivityAt,
  closedAt: sessions.closedAt,
  state: sessions.state,
  screenWaiting: sessions.screenWaiting,
} as const;

/** Berechnet `sessions.state` für die übergebenen Sessions neu und schreibt nur echte Wechsel. */
async function recomputeStates(tx: Tx, keys: Set<string>, now: number): Promise<void> {
  if (keys.size === 0) return;
  const rows = await tx.select(STATE_ROW_COLUMNS).from(sessions).where(inArray(sessions.id, [...keys]));
  const opts = await stateOptions(tx);
  for (const row of rows) {
    const next = computeSessionState(row, now, opts);
    if (next !== row.state) await tx.update(sessions).set({ state: next, updatedAt: sql`now()` }).where(eq(sessions.id, row.id));
  }
}

function extractPromptText(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string" && d.text.trim()) return d.text;
  if (typeof d.command === "string" && d.command.trim()) return `${d.command} ${typeof d.args === "string" ? d.args : ""}`.trim();
  return null;
}

/** Skill-Namen aus einem vollen Scan aller `tool_call`-Events der Session (Fehltreffer im Cache). */
async function scanSkills(tx: Tx, key: string): Promise<string[]> {
  const toolCalls = await tx
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionKey, key), eq(sessionEvents.kind, "tool_call")));
  return toolCalls
    .map((r) => r.data as Record<string, unknown>)
    .filter((d) => d.name === "Skill" && typeof d.target === "string" && d.target)
    .map((d) => d.target as string);
}

/** Lädt die Merkmale einer Session aus `session_files`/`session_events` für `categorize()`.
 *: Skill-Namen kommen aus dem `SkillsCache` statt bei jedem Aufruf alle `tool_call`-
 * Events neu zu scannen — nur ein Fehltreffer (erste Berührung nach Server-Start) scannt noch voll. */
async function loadCategorizeFeatures(tx: Tx, key: string, cwd: string | null, title: string | null, skillsCache: SkillsCache): Promise<CategorizeFeatures> {
  const files = await tx.select({ path: sessionFiles.path, mode: sessionFiles.mode }).from(sessionFiles).where(eq(sessionFiles.sessionKey, key));
  const cached = skillsCache.get(key);
  const skills = [...(cached ?? skillsCache.seed(key, await scanSkills(tx, key)))];
  const [firstPromptRow] = await tx
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionKey, key), eq(sessionEvents.kind, "prompt")))
    .orderBy(sessionEvents.ts)
    .limit(1);
  const firstPrompt = firstPromptRow ? extractPromptText(firstPromptRow.data) : null;
  return {
    dominantFolder: computeDominantFolder(files, cwd),
    cwd,
    skills,
    title,
    firstPrompt,
    writeFileCount: files.filter((f) => f.mode === "write").length,
  };
}

/**
 * Bereits bekannte Baustellen (aus vorher einsortierten Sessions), für den Titel-Rückfall in
 * `categorize()`: ohne jede Datei-Evidenz wird ein Titel-Wort gegen diese Liste geprüft,
 * bevor die Baustelle `null` bleibt. Keine feste Themenliste — die Liste entsteht live.
 */
async function loadKnownBaustellen(tx: Tx): Promise<Baustelle[]> {
  const rows = await tx
    .selectDistinct({ slug: sessions.categoryBaustelleSlug, label: sessions.categoryBaustelleLabel })
    .from(sessions)
    .where(isNotNull(sessions.categoryBaustelleSlug));
  return rows.filter((r): r is { slug: string; label: string | null } => r.slug !== null).map((r) => ({ slug: r.slug, label: r.label ?? r.slug }));
}

async function loadActiveSortRules(tx: Tx): Promise<SortRule[]> {
  const rows = await tx.select().from(sortRules).where(eq(sortRules.active, true)).orderBy(desc(sortRules.id));
  return rows.map((r) => ({
    id: r.id,
    condition: r.condition as SortRule["condition"],
    dimension: r.dimension as RuleDimension,
    targetArt: r.targetArt as Art | null,
    targetBaustelleSlug: r.targetBaustelleSlug,
    targetBaustelleLabel: r.targetBaustelleLabel,
    origin: r.origin as SortRule["origin"],
    active: r.active,
  }));
}

/**
 * Häufigkeiten aus dem echten Bestand für `buildCorrectionCondition`: wie
 * oft ein Ordner der dominante Ordner einer Haupt-Session ist, wie oft ein Titel-Wort in einem Titel
 * vorkommt (je Session höchstens einmal gezählt). N+1-Abfrage über `session_files`, aber der Bestand
 * ist klein (Dutzende Sessions) — dieselbe Größenordnung wie `recomputeCategories` schon heute läuft.
 */
async function loadCorrectionStats(tx: Tx): Promise<CorrectionStats> {
  const rows = await tx.select({ id: sessions.id, title: sessions.title, cwd: sessions.cwd }).from(sessions).where(isNull(sessions.parentId));
  const total = rows.length;
  const folderCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  for (const row of rows) {
    const files = await tx.select({ path: sessionFiles.path, mode: sessionFiles.mode }).from(sessionFiles).where(eq(sessionFiles.sessionKey, row.id));
    const folder = computeDominantFolder(files, row.cwd);
    if (folder) folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    for (const w of new Set(extractWords(row.title).map((x) => x.toLowerCase()))) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }
  return {
    folderShare: (folder) => (total === 0 ? 0 : (folderCounts.get(folder) ?? 0) / total),
    titleWordShare: (word) => (total === 0 ? 0 : (wordCounts.get(word.toLowerCase()) ?? 0) / total),
  };
}

/**
 * Berechnet `category_*` für die übergebenen Sessions neu und schreibt nur echte Wechsel.
 * `scope: "all"` prüft jede Session mit mindestens einer freien Dimension (CLI `resort`,
 * Regel-Änderung per PATCH, Korrektur per `assignSession`); eine `Set` beschränkt auf die vom
 * Ingest berührten Sessions. Art und Baustelle werden **getrennt** geschützt (
 * "getrennte Dimensionen"): `category_manual_art`/`category_manual_baustelle` frieren nur ihre
 * eigene Dimension ein, die jeweils andere wird weiter automatisch nachgeführt.
 */
export async function recomputeCategories(tx: Tx, scope: "all" | Set<string>, skillsCache: SkillsCache = new SkillsCache()): Promise<string[]> {
  const dbRules = await loadActiveSortRules(tx);
  const knownBaustellen = await loadKnownBaustellen(tx);
  const notFullyManual = or(eq(sessions.categoryManualArt, false), eq(sessions.categoryManualBaustelle, false));
  const filter = scope === "all" ? notFullyManual : and(inArray(sessions.id, [...scope]), notFullyManual);
  const rows = await tx
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      title: sessions.title,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      categoryBaustelleLabel: sessions.categoryBaustelleLabel,
      categoryReason: sessions.categoryReason,
      categoryManualArt: sessions.categoryManualArt,
      categoryManualBaustelle: sessions.categoryManualBaustelle,
    })
    .from(sessions)
    .where(filter);

  const changed: string[] = [];
  for (const row of rows) {
    const features = await loadCategorizeFeatures(tx, row.id, row.cwd, row.title, skillsCache);
    const result = categorize(features, dbRules, knownBaustellen);
    const oldReason = (row.categoryReason as CategorizeReason[] | null) ?? [];

    const art = row.categoryManualArt ? row.categoryArt : result.art;
    const slug = row.categoryManualBaustelle ? row.categoryBaustelleSlug : (result.baustelle?.slug ?? null);
    const label = row.categoryManualBaustelle ? row.categoryBaustelleLabel : (result.baustelle?.label ?? null);
    const artReason = row.categoryManualArt ? oldReason.filter((r) => r.dim === "art") : result.reason.filter((r) => r.dim === "art");
    const baustelleReason = row.categoryManualBaustelle
      ? oldReason.filter((r) => r.dim === "baustelle")
      : result.reason.filter((r) => r.dim === "baustelle");
    const reason = [...baustelleReason, ...artReason];

    if (art !== row.categoryArt || slug !== row.categoryBaustelleSlug || label !== row.categoryBaustelleLabel) {
      await tx
        .update(sessions)
        .set({
          categoryArt: art,
          categoryBaustelleSlug: slug,
          categoryBaustelleLabel: label,
          categoryReason: reason,
          categoryRuleId: result.ruleId,
          updatedAt: sql`now()`,
        })
        .where(eq(sessions.id, row.id));
      changed.push(row.id);
    }
  }
  return changed;
}

/** Wie `recomputeCategories`, aber öffnet selbst eine Transaktion (für CLI `resort` / PATCH-Route).
 * `skillsCache`: s. Kommentar an `ingest()` — ohne Übergabe der App-weiten Instanz verpufft ihr
 * Vorteil. */
export async function resortAll(db: Db, skillsCache: SkillsCache = new SkillsCache()): Promise<string[]> {
  return db.transaction((tx) => recomputeCategories(tx, "all", skillsCache));
}

export interface AssignRuleRow {
  id: number;
  dimension: RuleDimension;
  condition: unknown;
  targetArt: string | null;
  targetBaustelleSlug: string | null;
  targetBaustelleLabel: string | null;
  origin: string;
  active: boolean;
}

/** Nur die Dimensionen, die im Body tatsächlich mitgeschickt wurden ("Ziehen auf einen
 * BAUSTELLEN-Tab korrigiert nur die Baustelle, Ziehen auf einen ART-Tab nur die Art"). */
function targetDims(target: { art?: Art; baustelle?: Baustelle | null }): RuleDimension[] {
  const dims: RuleDimension[] = [];
  if ("art" in target) dims.push("art");
  if ("baustelle" in target) dims.push("baustelle");
  return dims;
}

export interface AssignOutcome {
  rules: AssignRuleRow[];
  resorted: string[];
  /** Dimensionen, für die keine tragfähige Bedingung gefunden wurde (oder `asRule = false`) —
   * nur diese Session wurde zugeordnet, keine neue Regel. */
  manualOnly: RuleDimension[];
}

/**
 * `POST /api/sessions/:id/assign`: Der Nutzer ordnet eine Session direkt einer Art und/oder Baustelle
 * zu — **getrennt**: nur die Dimensionen, die im Body vorkommen (`"art" in
 * target` / `"baustelle" in target`), werden korrigiert, die jeweils andere bleibt unangetastet und
 * läuft weiter durch die normale Ableitung. Mit `asRule = true` legt jede korrigierte Dimension eine
 * eigene Regel an (`buildCorrectionCondition`, dimensionsscharf — nie ein Ordner für Art); findet
 * sich keine tragfähige Bedingung (zu breiter Ordner, kein Skill/Titel-Wort unter der Schwelle),
 * bleibt es bei einer reinen Einzel-Zuordnung dieser Session (`manualOnly`). `asRule = false`
 * korrigiert immer nur diese eine Session. Die korrigierte(n) Dimension(en) werden `category_manual_*
 * = true` gesetzt (nie wieder automatisch überschrieben); danach werden alle nicht vollständig
 * manuellen Sessions neu sortiert, damit Bestandssessions mit derselben Bedingung mitziehen.
 */
export async function assignSession(
  db: Db,
  idOrUuid: string,
  target: { art?: Art; baustelle?: Baustelle | null },
  asRule: boolean,
  skillsCache: SkillsCache = new SkillsCache(),
): Promise<AssignOutcome | null> {
  const dims = targetDims(target);
  if (dims.length === 0) return null;

  return db.transaction(async (tx) => {
    const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
    const [row] = await tx
      .select({
        id: sessions.id,
        cwd: sessions.cwd,
        title: sessions.title,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        categoryBaustelleLabel: sessions.categoryBaustelleLabel,
        categoryReason: sessions.categoryReason,
        categoryManualArt: sessions.categoryManualArt,
        categoryManualBaustelle: sessions.categoryManualBaustelle,
        categoryUndo: sessions.categoryUndo,
      })
      .from(sessions)
      .where(where)
      .limit(1);
    if (!row) return null;

    const features = await loadCategorizeFeatures(tx, row.id, row.cwd, row.title, skillsCache);
    const stats = asRule ? await loadCorrectionStats(tx) : null;
    const oldReason = (row.categoryReason as CategorizeReason[] | null) ?? [];

    const rules: AssignRuleRow[] = [];
    const manualOnly: RuleDimension[] = [];
    let artReason = oldReason.filter((r) => r.dim === "art");
    let baustelleReason = oldReason.filter((r) => r.dim === "baustelle");
    let categoryManualArt = row.categoryManualArt;
    let categoryManualBaustelle = row.categoryManualBaustelle;
    let lastRuleId: number | null = null;
    // Vorzustand JEDER hier korrigierten Dimension sichern, BEVOR er
    // überschrieben wird — `unassignSession` liest das, um genau diesen Stand wiederherzustellen
    // (auch eine vorherige manuelle Zuordnung + ihren Grund), statt immer auf die Automatik zu
    // fallen. Undo-Einträge anderer, hier NICHT berührter Dimensionen bleiben unangetastet.
    const categoryUndo: CategoryUndo = { ...(row.categoryUndo ?? {}) };

    for (const dim of dims) {
      let condition: RuleCondition | null = null;
      if (asRule && stats) condition = buildCorrectionCondition(features, dim, stats);

      let ruleId: number | null = null;
      if (condition) {
        const [rule] = await tx
          .insert(sortRules)
          .values({
            condition,
            dimension: dim,
            targetArt: dim === "art" ? (target.art ?? null) : null,
            targetBaustelleSlug: dim === "baustelle" ? (target.baustelle?.slug ?? null) : null,
            targetBaustelleLabel: dim === "baustelle" ? (target.baustelle?.label ?? null) : null,
            origin: "korrektur",
            active: true,
          })
          .returning();
        if (!rule) throw new Error("Regel konnte nicht angelegt werden");
        rules.push({ ...rule, dimension: dim });
        ruleId = rule.id;
        lastRuleId = rule.id;
      } else {
        manualOnly.push(dim);
      }

      categoryUndo[dim] =
        dim === "art"
          ? { createdRuleId: ruleId, manual: row.categoryManualArt, art: row.categoryArt as Art | null, reason: oldReason.filter((r) => r.dim === "art") }
          : {
              createdRuleId: ruleId,
              manual: row.categoryManualBaustelle,
              baustelleSlug: row.categoryBaustelleSlug,
              baustelleLabel: row.categoryBaustelleLabel,
              reason: oldReason.filter((r) => r.dim === "baustelle"),
            };

      const detail = condition ? describeCondition(condition) : dim === "art" ? `Manuell: ${target.art}` : `Manuell: ${target.baustelle?.label ?? "Ohne Baustelle"}`;
      const entry: CategorizeReason = { stage: condition ? "korrektur" : "manuell", detail, ruleId, dim };
      if (dim === "art") {
        artReason = [entry];
        categoryManualArt = true;
      } else {
        baustelleReason = [entry];
        categoryManualBaustelle = true;
      }
    }

    const patch: Record<string, unknown> = {
      categoryReason: [...baustelleReason, ...artReason],
      categoryManualArt,
      categoryManualBaustelle,
      categoryManual: categoryManualArt || categoryManualBaustelle,
      categoryUndo,
      updatedAt: sql`now()`,
    };
    if (dims.includes("art")) patch.categoryArt = target.art;
    if (dims.includes("baustelle")) {
      patch.categoryBaustelleSlug = target.baustelle?.slug ?? null;
      patch.categoryBaustelleLabel = target.baustelle?.label ?? null;
    }
    if (lastRuleId !== null) patch.categoryRuleId = lastRuleId;

    await tx.update(sessions).set(patch).where(eq(sessions.id, row.id));

    const resorted = await recomputeCategories(tx, "all", skillsCache);
    return { rules, resorted, manualOnly };
  });
}

export interface PreviewDimensionResult {
  condition: { text: string; structured: RuleCondition } | null;
  /** Nur gesetzt, wenn `condition === null`: erklärt, warum keine Regel möglich ist. */
  reason: string | null;
}

export interface AssignPreviewAffected {
  sessionId: string;
  title: string | null;
  fromArt: string;
  toArt: string;
  fromBaustelle: Baustelle | null;
  toBaustelle: Baustelle | null;
}

export interface AssignPreview {
  art: PreviewDimensionResult | null;
  baustelle: PreviewDimensionResult | null;
  affected: AssignPreviewAffected[];
  affectedCount: number;
}

const PREVIEW_AFFECTED_LIMIT = 20;

/**
 * `POST /api/sessions/:id/assign/preview`: wie `assignSession`, aber schreibt nichts. Zeigt die
 * Bedingung, die eine Regel bekäme (lesbar + strukturiert), und simuliert, welche ANDEREN
 * Haupt-Sessions sich dadurch ändern würden (MoveDialog soll die Bedingung
 * vorher zeigen, nicht erst hinterher). Session selbst zählt nicht zu `affected` — deren Änderung
 * zeigt der Dialog direkt über die gewählte Art/Baustelle.
 */
export async function previewAssign(
  db: Db,
  idOrUuid: string,
  target: { art?: Art; baustelle?: Baustelle | null },
  skillsCache: SkillsCache = new SkillsCache(),
): Promise<AssignPreview | null> {
  const dims = targetDims(target);
  if (dims.length === 0) return null;

  return db.transaction(async (tx) => {
    const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
    const [row] = await tx.select({ id: sessions.id, cwd: sessions.cwd, title: sessions.title }).from(sessions).where(where).limit(1);
    if (!row) return null;

    const features = await loadCategorizeFeatures(tx, row.id, row.cwd, row.title, skillsCache);
    const stats = await loadCorrectionStats(tx);
    const dbRules = await loadActiveSortRules(tx);
    const knownBaustellen = await loadKnownBaustellen(tx);

    const built: Partial<Record<RuleDimension, RuleCondition>> = {};
    const dimResult: { art: PreviewDimensionResult | null; baustelle: PreviewDimensionResult | null } = { art: null, baustelle: null };
    for (const dim of dims) {
      const condition = buildCorrectionCondition(features, dim, stats);
      if (condition) {
        built[dim] = condition;
        dimResult[dim] = { condition: { text: describeRuleCondition(dim, condition), structured: condition }, reason: null };
      } else {
        dimResult[dim] = {
          condition: null,
          reason:
            dim === "baustelle"
              ? t("Kein spezifischer Ordner (fehlende Datei-Evidenz oder zu breit) — nur diese Session wird zugeordnet.")
              : t("Kein Skill und kein Titel-Wort unter der Häufigkeits-Schwelle — nur diese Session wird zugeordnet."),
        };
      }
    }

    const hypothetical: SortRule[] = [
      ...dbRules,
      ...(built.art ? [{ id: -1, condition: built.art, dimension: "art" as const, targetArt: target.art ?? null, targetBaustelleSlug: null, targetBaustelleLabel: null, origin: "korrektur" as const, active: true }] : []),
      ...(built.baustelle
        ? [{ id: -2, condition: built.baustelle, dimension: "baustelle" as const, targetArt: null, targetBaustelleSlug: target.baustelle?.slug ?? null, targetBaustelleLabel: target.baustelle?.label ?? null, origin: "korrektur" as const, active: true }]
        : []),
    ];

    const others = await tx
      .select({
        id: sessions.id,
        title: sessions.title,
        cwd: sessions.cwd,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        categoryBaustelleLabel: sessions.categoryBaustelleLabel,
        categoryManualArt: sessions.categoryManualArt,
        categoryManualBaustelle: sessions.categoryManualBaustelle,
      })
      .from(sessions)
      .where(and(isNull(sessions.parentId), sql`${sessions.id} <> ${row.id}`));

    const affected: AssignPreviewAffected[] = [];
    for (const o of others) {
      if (o.categoryManualArt && o.categoryManualBaustelle) continue; // beide Dimensionen gesperrt: kann sich nicht ändern
      const feat = await loadCategorizeFeatures(tx, o.id, o.cwd, o.title, skillsCache);
      const result = categorize(feat, hypothetical, knownBaustellen);
      const newArt = o.categoryManualArt ? o.categoryArt : result.art;
      const newSlug = o.categoryManualBaustelle ? o.categoryBaustelleSlug : (result.baustelle?.slug ?? null);
      const newLabel = o.categoryManualBaustelle ? o.categoryBaustelleLabel : (result.baustelle?.label ?? null);
      if (newArt !== o.categoryArt || newSlug !== o.categoryBaustelleSlug) {
        affected.push({
          sessionId: o.id,
          title: o.title,
          fromArt: o.categoryArt ?? "unsortiert",
          toArt: newArt ?? "unsortiert",
          fromBaustelle: o.categoryBaustelleSlug ? { slug: o.categoryBaustelleSlug, label: o.categoryBaustelleLabel ?? o.categoryBaustelleSlug } : null,
          toBaustelle: newSlug ? { slug: newSlug, label: newLabel ?? newSlug } : null,
        });
      }
    }

    return { art: dimResult.art, baustelle: dimResult.baustelle, affected: affected.slice(0, PREVIEW_AFFECTED_LIMIT), affectedCount: affected.length };
  });
}

/**
 * `POST /api/sessions/:id/unassign`: Rückgängig für eine `assignSession` (Toast-Knopf,
 * 2: "in der UI gibt es kein Rückgängig").
 *
 * Die ursprüngliche Fassung hob `category_manual_*` für die übergebenen
 * Dimensionen einfach auf und ließ `recomputeCategories` den AUTOMATIK-Wert einsetzen — eine
 * VORHERIGE manuelle Zuordnung (samt ihrem Grund) ging dabei verloren, und jede beliebige, vom
 * Aufrufer genannte `ruleId` wurde ungeprüft abgeschaltet. Jetzt: (1) nur `ruleIds`, die tatsächlich
 * als `createdRuleId` im `category_undo`-Eintrag EINER der angefragten Dimensionen stehen (also GENAU
 * durch diese eine Korrektur entstanden sind), werden abgeschaltet — alles andere wird ignoriert;
 * (2) jede Dimension mit einem Undo-Eintrag bekommt exakt ihren Vorzustand zurück (Wert, `manual`-Flag
 * und Grund) statt pauschal `manual = false`; Dimensionen ohne Undo-Eintrag (z. B. zweiter Klick auf
 * "Rückgängig") bleiben unangetastet. Nach dem Wiederherstellen wird der verbrauchte Undo-Eintrag
 * gelöscht (kein Mehrfach-Undo derselben Korrektur).
 */
export async function unassignSession(
  db: Db,
  idOrUuid: string,
  ruleIds: number[],
  dims: RuleDimension[],
  skillsCache: SkillsCache = new SkillsCache(),
): Promise<{ resorted: string[] } | null> {
  return db.transaction(async (tx) => {
    const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
    const [row] = await tx
      .select({
        id: sessions.id,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        categoryBaustelleLabel: sessions.categoryBaustelleLabel,
        categoryReason: sessions.categoryReason,
        categoryManualArt: sessions.categoryManualArt,
        categoryManualBaustelle: sessions.categoryManualBaustelle,
        categoryUndo: sessions.categoryUndo,
      })
      .from(sessions)
      .where(where)
      .limit(1);
    if (!row) return null;

    const categoryUndo: CategoryUndo = { ...(row.categoryUndo ?? {}) };
    const oldReason = (row.categoryReason as CategorizeReason[] | null) ?? [];
    let artReason = oldReason.filter((r) => r.dim === "art");
    let baustelleReason = oldReason.filter((r) => r.dim === "baustelle");
    let categoryManualArt = row.categoryManualArt;
    let categoryManualBaustelle = row.categoryManualBaustelle;
    let categoryArt = row.categoryArt;
    let categoryBaustelleSlug = row.categoryBaustelleSlug;
    let categoryBaustelleLabel = row.categoryBaustelleLabel;
    const toDeactivate = new Set<number>();
    let categoryRuleId: number | null | undefined;
    let restoredAny = false;

    for (const dim of dims) {
      const entry = categoryUndo[dim];
      if (!entry) continue; // nichts (mehr) rückgängig zu machen für diese Dimension — unangetastet lassen
      restoredAny = true;
      if (entry.createdRuleId !== null) toDeactivate.add(entry.createdRuleId);
      if (dim === "art") {
        categoryManualArt = entry.manual;
        categoryArt = entry.art ?? null;
        artReason = entry.reason;
      } else {
        categoryManualBaustelle = entry.manual;
        categoryBaustelleSlug = entry.baustelleSlug ?? null;
        categoryBaustelleLabel = entry.baustelleLabel ?? null;
        baustelleReason = entry.reason;
      }
      categoryRuleId = entry.reason.at(-1)?.ruleId ?? null;
      categoryUndo[dim] = undefined; // verbraucht — kein Mehrfach-Undo derselben Korrektur (JSON verwirft `undefined`-Felder beim Schreiben)
    }

    // Nur Regeln abschalten, die GENAU durch die rückgängig gemachte(n) Dimension(en) entstanden
    // sind — vom Aufrufer genannte, aber nicht zutreffende `ruleIds` werden stillschweigend ignoriert.
    const ruleIdsToDeactivate = ruleIds.filter((id) => toDeactivate.has(id));
    if (ruleIdsToDeactivate.length > 0) await tx.update(sortRules).set({ active: false }).where(inArray(sortRules.id, ruleIdsToDeactivate));

    const patch: Record<string, unknown> = {
      categoryArt,
      categoryBaustelleSlug,
      categoryBaustelleLabel,
      categoryReason: [...baustelleReason, ...artReason],
      categoryManualArt,
      categoryManualBaustelle,
      categoryManual: categoryManualArt || categoryManualBaustelle,
      categoryUndo,
      updatedAt: sql`now()`,
    };
    if (categoryRuleId !== undefined) patch.categoryRuleId = categoryRuleId;
    await tx.update(sessions).set(patch).where(eq(sessions.id, row.id));

    const resorted = new Set(await recomputeCategories(tx, "all", skillsCache));
    // Die Session selbst hat sich immer geändert, wenn mindestens eine Dimension wiederhergestellt
    // wurde — auch wenn der wiederhergestellte Wert zufällig mit dem frischen Automatik-Ergebnis
    // übereinstimmt und `recomputeCategories` deshalb keinen Unterschied mehr feststellt.
    if (restoredAny) resorted.add(row.id);
    return { resorted: [...resorted] };
  });
}

export interface CategoryCount {
  art: string;
  count: number;
  baustellen: { slug: string | null; label: string; count: number }[];
}

/**
 * `GET /api/categories`: Arten mit Anzahl offener (nicht geschlossener) Haupt-Sessions, je Art die
 * Baustellen. mit `tool` zählen Art- UND Baustellen-Zeile nur Sessions dieses Werkzeugs –
 * vorher wirkte der Claude/Codex-Filter nur auf die Liste, die Zähler blieben bei „Alle“.
 */
export async function listCategories(db: Db, tool: Tool | null = null): Promise<CategoryCount[]> {
  const rows = await db
    .select({
      art: sessions.categoryArt,
      slug: sessions.categoryBaustelleSlug,
      label: sessions.categoryBaustelleLabel,
      n: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .where(and(isNull(sessions.parentId), isNull(sessions.closedAt), visibleSession, tool ? eq(sessions.tool, tool) : undefined))
    .groupBy(sessions.categoryArt, sessions.categoryBaustelleSlug, sessions.categoryBaustelleLabel);

  const byArt = new Map<string, CategoryCount>();
  for (const r of rows) {
    const art = r.art ?? "unsortiert";
    let entry = byArt.get(art);
    if (!entry) {
      entry = { art, count: 0, baustellen: [] };
      byArt.set(art, entry);
    }
    entry.count += r.n;
    // je Slug EINE Gruppe — „Ohne Baustelle“ (Slug leer, evtl. mit altem Label) erschien sonst doppelt.
    const same = entry.baustellen.find((b) => b.slug === r.slug);
    if (same) same.count += r.n;
    else entry.baustellen.push({ slug: r.slug, label: r.slug ? (r.label ?? r.slug) : "Ohne Baustelle", count: r.n });
  }
  return [...byArt.values()];
}

type RetickRow = Pick<typeof sessions.$inferSelect, "id" | "status" | "turnOpen" | "sessionEndReceivedAt" | "lastActivityAt" | "closedAt" | "state" | "screenWaiting">;

/** Nur die Zeilen, die für „ruht" infrage kommen — bewusst getrennt von {@link applyRetickUpdate}
 *, damit ein Test gezielt einen gleichzeitigen Ingest in die Lücke
 * zwischen Lesen und Schreiben legen kann. Exportiert nur dafür. */
export async function selectRetickCandidates(db: Db): Promise<RetickRow[]> {
  return db
    .select(STATE_ROW_COLUMNS)
    .from(sessions)
    .where(and(eq(sessions.status, "running"), isNull(sessions.closedAt)));
}

/**
 * Schreibt `state` nur, wenn die Zeile seit dem Lesen unverändert ist — derselbe `status`, weiterhin
 * kein `closedAt`, derselbe alte `state` UND dieselbe `lastActivityAt`
 *. Ein gleichzeitiger Ingest kann die Session zwischen Lesen und
 * Schreiben schon beendet/geschlossen/neu berechnet haben — das fängt der `status`/`state`-Vergleich
 * ab. Er fängt aber NICHT den engeren Fall ab, dass zwischen Lesen und Schreiben ein Ereignis ankommt,
 * das `lastActivityAt` erneuert, ohne `status`/`state` selbst zu ändern (z. B. ein lokaler Befehl wie
 * `/model` — zählt im Parser bewusst nicht mehr als Runden-Inhalt, verschiebt aber die
 * reine aktivitäts-Zeit trotzdem nach vorn): Der Ticker hätte dann `next = "ruht"` aus einer schon 31
 * Minuten alten `lastActivityAt` berechnet, obwohl die Session inzwischen wieder ganz frisch aktiv
 * ist — ohne diesen zusätzlichen Vergleich würde er dieses veraltete „ruht" trotzdem schreiben (der
 * `state`-Vergleich allein sieht keinen Unterschied, wenn `state` zufällig gleich bleibt). Gibt
 * zurück, ob wirklich geschrieben wurde. Exportiert nur für den Wettlauf-Test.
 */
export async function applyRetickUpdate(db: Db, row: RetickRow, next: ComputedSessionState | null): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set({ state: next, updatedAt: sql`now()` })
    .where(
      and(
        eq(sessions.id, row.id),
        eq(sessions.status, row.status),
        isNull(sessions.closedAt),
        row.state === null ? isNull(sessions.state) : eq(sessions.state, row.state),
        row.lastActivityAt === null ? isNull(sessions.lastActivityAt) : eq(sessions.lastActivityAt, row.lastActivityAt),
      ),
    )
    .returning({ id: sessions.id });
  return result.length > 0;
}

/** Sessions ohne Prozess, ohne SessionEnd, mit offener Runde — genau die, bei denen allein die
 * Altersgrenze entscheidet, ob sie „abgestürzt“ oder beendet sind (in beide Richtungen, wenn der Nutzer
 * die Schwelle ändert). */
async function selectCrashWindowCandidates(db: Db): Promise<RetickRow[]> {
  return db
    .select(STATE_ROW_COLUMNS)
    .from(sessions)
    .where(and(ne(sessions.status, "running"), isNull(sessions.closedAt), isNull(sessions.sessionEndReceivedAt), eq(sessions.turnOpen, true)));
}

/**
 * Läuft periodisch (Server-Ticker, s. `createApp`): erkennt „ruht" nach 30 Minuten Stille, wofür
 * kein neues Ereignis eintrifft, das den Zustand sonst anstoßen würde. Nur laufende, offene,
 * nicht geschlossene Sessions werden geprüft — das sind wenige Zeilen, die Abfrage ist günstig.
 * dazu die Altersgrenze für „abgestürzt“ (ein Absturz wird nach N Stunden zu „beendet“).
 */
export async function retickIdleStates(db: Db, now: number): Promise<string[]> {
  const opts = await stateOptions(db);
  const rows = [...(await selectRetickCandidates(db)), ...(await selectCrashWindowCandidates(db))];
  const changed: string[] = [];
  for (const row of rows) {
    const next = computeSessionState(row, now, opts);
    if (next !== row.state && (await applyRetickUpdate(db, row, next))) changed.push(row.id);
  }
  return changed;
}

/** Zwei Zeitpunkte gelten als gleich, wenn sie denselben Moment meinen (Stringformate können abweichen). */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

export interface BackfillStatesOutcome {
  /** Anzahl Sessions je neu berechnetem Zustand (Label `"kein_zustand"` für `null`). */
  byState: Record<string, number>;
  /** Anzahl Zeilen, bei denen sich `state`, `turn_open`, `turn_observed_at` oder `session_end_received_at` geändert hat. */
  changed: number;
}

const NULL_STATE_LABEL = "kein_zustand";

/**
 * Rückrechnung für Bestandsdaten: Migration 0001 legt `turn_open = true` und
 * `session_end_received_at = null` für ALLE vorhandenen Sessions an, weil die Zustände sonst nur bei
 * einem neuen Event neu berechnet werden (`recomputeStates`). Für Sessions, die nie wieder ein Event
 * bekommen, bleiben diese Vorgabewerte falsch stehen. Dieser Befehl berechnet für ALLE Sessions aus
 * den vorhandenen `session_events` neu: `session_end_received_at` (jüngster `SessionEnd`-Hook),
 * `turn_open`/`turn_observed_at` (jüngstes Runden-Signal, dieselbe Ableitung `deriveTurnSignal` wie
 * der Live-Pfad), dann `state` per `computeSessionState`. Rückfall nur für Sessions ganz ohne
 * Runden-Signal (Claude ohne Hooks): ist das letzte Datei-Event vom Typ `assistant`, gilt die Runde
 * als zu, sonst offen. `closedAt`/`closedBy` werden nie angefasst — eine geschlossene Session bleibt
 * über die Vorrang-Regel in `computeSessionState` geschlossen. Idempotent, eine Transaktion.
 */
export async function backfillStates(db: Db, now: number): Promise<BackfillStatesOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: sessions.id,
        status: sessions.status,
        closedAt: sessions.closedAt,
        lastActivityAt: sessions.lastActivityAt,
        turnOpen: sessions.turnOpen,
        turnObservedAt: sessions.turnObservedAt,
        sessionEndReceivedAt: sessions.sessionEndReceivedAt,
        state: sessions.state,
      })
      .from(sessions);

    let changed = 0;
    const byState: Record<string, number> = {};
    const opts = await stateOptions(tx);

    for (const row of rows) {
      const events = await tx
        .select({ ts: sessionEvents.ts, kind: sessionEvents.kind, source: sessionEvents.source, data: sessionEvents.data })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionKey, row.id))
        .orderBy(desc(sessionEvents.ts));

      //: ein SessionEnd zählt nur, wenn danach kein SessionStart mehr kam
      // (sonst /exit → resume → Absturz ohne neues SessionEnd sähe fälschlich sauber beendet aus,
      // weil der SessionEnd von VOR dem Resume noch stünde). `events` ist absteigend nach `ts`.
      const sessionEndEvent = events.find((e) => e.source === "hook" && (e.data as Record<string, unknown> | null)?.event === "SessionEnd");
      const supersededByNewerStart =
        sessionEndEvent !== undefined &&
        events.some((e) => e.source === "hook" && (e.data as Record<string, unknown> | null)?.event === "SessionStart" && e.ts > sessionEndEvent.ts);
      const sessionEndReceivedAt = sessionEndEvent && !supersededByNewerStart ? sessionEndEvent.ts : null;

      let turnOpen = row.turnOpen;
      let turnObservedAt = row.turnObservedAt;
      const turnSignalEvent = events.find((e) => deriveTurnSignal(e) !== null);
      if (turnSignalEvent) {
        turnOpen = deriveTurnSignal(turnSignalEvent) as boolean;
        turnObservedAt = turnSignalEvent.ts;
      } else {
        // Claude ohne Hooks (vor Hook-Installation / nur per Datei-Wächter erkannt): kein Runden-Signal
        // im engeren Sinn vorhanden — Rückfall auf das letzte INHALTLICHE Datei-Event der Session
        //: echte Claude-Dateien enden fast immer mit einem `system`-Event
        // (turn_duration/away_summary/stop_hook_summary o. ä.), danach oft noch `attachment`/
        // `compaction`. Diese Rahmen-Events sagen nichts über offen/zu aus und werden übersprungen —
        // sonst gilt praktisch jede beendete Bestands-Session fälschlich als „abgestürzt" (gemessen:
        // 30/30 echte Hauptdateien enden nicht mit `assistant`, s. Bericht). `events` ist absteigend
        // nach `ts` sortiert (s. Abfrage oben), `events.find` liefert also das jüngste inhaltliche Event.
        const lastContent = events.find((e) => CONTENT_EVENT_KINDS.has(e.kind));
        if (lastContent) {
          turnOpen = lastContent.kind !== "assistant";
          turnObservedAt = lastContent.ts;
        }
      }

      const next = computeSessionState({ status: row.status, turnOpen, sessionEndReceivedAt, lastActivityAt: row.lastActivityAt, closedAt: row.closedAt }, now, opts);

      const rowChanged =
        next !== row.state || turnOpen !== row.turnOpen || !sameInstant(turnObservedAt, row.turnObservedAt) || !sameInstant(sessionEndReceivedAt, row.sessionEndReceivedAt);
      if (rowChanged) {
        await tx.update(sessions).set({ state: next, turnOpen, turnObservedAt, sessionEndReceivedAt, updatedAt: sql`now()` }).where(eq(sessions.id, row.id));
        changed++;
      }

      const label = next ?? NULL_STATE_LABEL;
      byState[label] = (byState[label] ?? 0) + 1;
    }

    return { byState, changed };
  });
}

/** `POST /api/sessions/:id/close`: hat Vorrang vor jedem berechneten Zustand. */
export async function closeSession(db: Db, idOrUuid: string, by: string, now: number): Promise<{ id: string } | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(where).limit(1);
  if (!row) return null;
  await db
    .update(sessions)
    .set({ closedAt: new Date(now).toISOString(), closedBy: by, state: "closed", updatedAt: sql`now()` })
    .where(eq(sessions.id, row.id));
  return row;
}

/** `POST /api/sessions/:id/reopen`: hebt das Schließen auf und berechnet den Zustand sofort neu. */
export async function reopenSession(db: Db, idOrUuid: string, now: number): Promise<{ id: string } | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db
    .select({ id: sessions.id, status: sessions.status, turnOpen: sessions.turnOpen, sessionEndReceivedAt: sessions.sessionEndReceivedAt, lastActivityAt: sessions.lastActivityAt })
    .from(sessions)
    .where(where)
    .limit(1);
  if (!row) return null;
  const next = computeSessionState({ ...row, closedAt: null }, now, await stateOptions(db));
  await db.update(sessions).set({ closedAt: null, closedBy: null, state: next, updatedAt: sql`now()` }).where(eq(sessions.id, row.id));
  return { id: row.id };
}

async function applySummary(tx: Tx, s: SessionSummary): Promise<void> {
  const key = sessionKey(s.tool, s.sessionId);
  await tx
    .update(sessions)
    .set({
      parentId: s.parentSessionId ? sessionKey(s.tool, s.parentSessionId) : null,
      title: s.title,
      titleSource: s.titleSource,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      cliVersion: s.cliVersion,
      startedAt: s.startedAt ? sql`least(${sessions.startedAt}, ${s.startedAt}::timestamptz)` : sessions.startedAt,
      lastActivityAt: s.lastActivityAt
        ? sql`greatest(${sessions.lastActivityAt}, ${s.lastActivityAt}::timestamptz)`
        : sessions.lastActivityAt,
      models: s.models,
      tokens: s.tokens,
      tokensTotal: s.tokens.total,
      toolCalls: s.toolCalls,
      subagents: s.subagents,
      limits: s.limits ?? null,
      parsedEventCount: s.eventCount,
      parseErrors: s.parseErrors,
      // Grundlage für den Kontext-Anteil (`contextPct` in app.ts `toSessionDTO`).
      lastUsage: s.lastUsage ?? null,
      lastUsageModel: s.lastUsageModel ?? null,
      modelContextWindow: s.modelContextWindow ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(sessions.id, key));

  const files = [
    ...s.filesWritten.map((path) => ({ sessionKey: key, path, mode: "write" })),
    ...s.filesRead.map((path) => ({ sessionKey: key, path, mode: "read" })),
  ];
  for (const part of chunks(files)) await tx.insert(sessionFiles).values(part).onConflictDoNothing();
}

/** tmux-Zuordnung von der Brücke. Verspätete, ältere Meldungen überschreiben nie eine neuere
 * (`terminal_observed_at`, wie `state_observed_at`). */
async function applyTerminal(tx: Tx, t: TerminalInfo): Promise<void> {
  await tx
    .update(sessions)
    .set({ tmuxName: t.tmuxName, attachable: t.attachable, screenWaiting: t.screenWaiting ?? null, terminalObservedAt: t.observedAt, updatedAt: sql`now()` })
    .where(
      and(
        eq(sessions.id, sessionKey(t.tool, t.sessionId)),
        sql`(${sessions.terminalObservedAt} is null or ${sessions.terminalObservedAt} <= ${t.observedAt}::timestamptz)`,
      ),
    );
}

async function applyState(tx: Tx, s: SessionState): Promise<void> {
  await applyStatus(tx, sessionKey(s.tool, s.sessionId), s.running, s.observedAt, null);
}

/**
 * `skillsCache`: standardmäßig ein frischer, verworfener Zwischenspeicher (sicher, aber ohne Vorteil
 * über Aufrufe hinweg). `app.ts` übergibt eine EINE, über die Prozesslaufzeit gehaltene Instanz, damit
 * wirkt: erst dadurch spart ein zweiter Hook derselben Session den vollen
 * `tool_call`-Scan. Tests, die `ingest()` direkt/parallel mit unterschiedlichen Datenbanken aufrufen,
 * bleiben mit dem Vorgabewert unberührt (keine Verwechslungsgefahr zwischen Test-DBs).
 */
export async function ingest(db: Db, machineId: string, items: IngestItem[], skillsCache: SkillsCache = new SkillsCache()): Promise<IngestOutcome> {
  return db.transaction(async (tx) => {
    const touched = new Set<string>();
    await ensureSessions(tx, machineId, items);
    const events = items.flatMap((it) => (it.type === "event" ? [it.event] : []));
    const accepted = await insertEvents(tx, events, touched, skillsCache);
    for (const it of items) {
      if (it.type === "summary") {
        await applySummary(tx, it.summary);
        touched.add(sessionKey(it.summary.tool, it.summary.sessionId));
      } else if (it.type === "state") {
        await applyState(tx, it.state);
        touched.add(sessionKey(it.state.tool, it.state.sessionId));
      } else if (it.type === "terminal") {
        await applyTerminal(tx, it.terminal);
        touched.add(sessionKey(it.terminal.tool, it.terminal.sessionId));
      }
    }
    await recomputeStates(tx, touched, Date.now());
    await recomputeCategories(tx, touched, skillsCache);
    // Titel/erster Prompt/Dateipfade neu indizieren (ersetzt, hängt nicht an) — Chat-Text
    // kommt separat pro Archiv-Upload der Hauptdatei (s. app.ts, search.ts `indexChatDocs`). Befund
    //: sortiert sperren (s. `indexSessionsMetaDocsTx`), sonst Deadlock-Gefahr bei
    // zwei Ingests mit vertauschter Session-Reihenfolge.
    await indexSessionsMetaDocsTx(tx, touched);
    return { accepted, duplicates: events.length - accepted, touched };
  });
}

export async function recordArchive(
  db: Db,
  machineId: string,
  row: { tool: Tool; sessionId: string; path: string; sha256: string; size: number; gzSize: number; storedPath: string },
): Promise<{ key: string; previousPath: string | null }> {
  const key = sessionKey(row.tool, row.sessionId);
  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select({ storedPath: archive.storedPath })
      .from(archive)
      .where(and(eq(archive.tool, row.tool), eq(archive.path, row.path)))
      .for("update");
    await tx.insert(sessions).values({ id: key, tool: row.tool, sessionId: row.sessionId, machineId }).onConflictDoNothing();
    await tx
      .insert(archive)
      .values({ sessionKey: key, tool: row.tool, path: row.path, sha256: row.sha256, size: row.size, gzSize: row.gzSize, storedPath: row.storedPath })
      .onConflictDoUpdate({
        target: [archive.tool, archive.path],
        set: { sessionKey: key, sha256: row.sha256, size: row.size, gzSize: row.gzSize, storedPath: row.storedPath, updatedAt: sql`now()` },
      });
    return { key, previousPath: prev && prev.storedPath !== row.storedPath ? prev.storedPath : null };
  });
}

export async function listSessions(db: Db, limit: number) {
  return db
    .select()
    .from(sessions)
    .where(visibleSession)
    .orderBy(sql`coalesce(${sessions.lastActivityAt}, ${sessions.startedAt}) desc nulls last`)
    .limit(limit);
}

export async function getSessions(db: Db, keys: string[]) {
  if (keys.length === 0) return [];
  return db.select().from(sessions).where(inArray(sessions.id, keys));
}

export async function getSessionDetail(db: Db, idOrUuid: string, eventLimit: number) {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [session] = await db.select().from(sessions).where(where).limit(1);
  if (!session) return null;
  const [files, archived, events] = await Promise.all([
    db.select().from(sessionFiles).where(eq(sessionFiles.sessionKey, session.id)),
    db.select().from(archive).where(eq(archive.sessionKey, session.id)),
    db.select().from(sessionEvents).where(eq(sessionEvents.sessionKey, session.id)).orderBy(desc(sessionEvents.ts)).limit(eventLimit),
  ]);
  return { session, files, archive: archived, events: events.reverse() };
}

export interface RelatedSameFileRow {
  session: typeof sessions.$inferSelect;
  sharedFiles: string[];
  sharedCount: number;
}

export interface RelatedResult {
  parent: typeof sessions.$inferSelect | null;
  children: (typeof sessions.$inferSelect)[];
  sameFiles: RelatedSameFileRow[];
}

const MAX_SAME_FILES_SESSIONS = 20;
const MAX_SHARED_FILES_SHOWN = 5;

/**
 * `GET /api/sessions/:id/related`: Eltern-/Kind-Sessions (aus `sessions.parent_id`, wie bisher
 * clientseitig in `RefsPanel.tsx` berechnet) plus Sessions, die mindestens eine derselben Dateien
 * **geschrieben** haben (`session_files`, `mode = 'write'`) — der bisher offene Punkt aus P2-5.
 * Sortiert nach Anzahl gemeinsamer Dateien absteigend, höchstens 20 Treffer, je Treffer höchstens
 * 5 Dateipfade als Beispiel (`sharedCount` trägt die echte Gesamtzahl).
 */
export async function getRelatedSessions(db: Db, idOrUuid: string): Promise<RelatedResult | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [session] = await db.select().from(sessions).where(where).limit(1);
  if (!session) return null;

  const [parent, children, writtenFiles] = await Promise.all([
    session.parentId ? db.select().from(sessions).where(eq(sessions.id, session.parentId)).limit(1) : Promise.resolve([]),
    db.select().from(sessions).where(eq(sessions.parentId, session.id)),
    db.select({ path: sessionFiles.path }).from(sessionFiles).where(and(eq(sessionFiles.sessionKey, session.id), eq(sessionFiles.mode, "write"))),
  ]);

  const paths = [...new Set(writtenFiles.map((f) => f.path))];
  let sameFiles: RelatedSameFileRow[] = [];
  if (paths.length > 0) {
    const rows = await db
      .select({ sessionKey: sessionFiles.sessionKey, path: sessionFiles.path })
      .from(sessionFiles)
      .where(and(inArray(sessionFiles.path, paths), eq(sessionFiles.mode, "write"), sql`${sessionFiles.sessionKey} <> ${session.id}`));

    const byKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = byKey.get(r.sessionKey) ?? new Set<string>();
      set.add(r.path);
      byKey.set(r.sessionKey, set);
    }

    const keys = [...byKey.keys()];
    if (keys.length > 0) {
      const otherSessions = await db.select().from(sessions).where(and(inArray(sessions.id, keys), visibleSession));
      const byId = new Map(otherSessions.map((s) => [s.id, s]));
      sameFiles = keys
        .map((key) => {
          const row = byId.get(key);
          const shared = byKey.get(key);
          if (!row || !shared) return null;
          const sortedShared = [...shared].sort();
          return { session: row, sharedFiles: sortedShared.slice(0, MAX_SHARED_FILES_SHOWN), sharedCount: sortedShared.length };
        })
        .filter((x): x is RelatedSameFileRow => x !== null)
        .sort((a, b) => b.sharedCount - a.sharedCount)
        .slice(0, MAX_SAME_FILES_SESSIONS);
    }
  }

  return { parent: parent[0] ?? null, children, sameFiles };
}

export async function listArchive(db: Db, tool?: Tool) {
  const q = db
    .select({ tool: archive.tool, path: archive.path, sha256: archive.sha256, size: archive.size, sessionKey: archive.sessionKey, updatedAt: archive.updatedAt })
    .from(archive);
  return tool ? q.where(eq(archive.tool, tool)) : q;
}
