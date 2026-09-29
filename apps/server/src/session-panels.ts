// Daten der Session-Seitenpanels aus den Digests (`session-digest.ts`) und der DB.
// Nichts wird geschätzt: fehlt eine Angabe, bleibt sie `null` bzw. die Liste leer.
import type {
  AgentVerdict,
  ChangeFileHit,
  ChangeFileStat,
  ChangeSnippetLine,
  FileChangeOp,
  OutcomeConfidence,
  OutcomeItem,
  SessionAgentDetail,
  SessionAgentSummary,
  SessionChangesResponse,
  SessionFileChangesResponse,
  SessionOutcomesResponse,
  SimilarSession,
  Tool,
} from "@nyxos/shared";
import { FILE_OP_LINES_MAX, t } from "@nyxos/shared";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { runningAgentIdsOf } from "./agents/runs.js";
import type { Db } from "./db/client.js";
import { entries, links, sessionChangeOps, sessionFiles, sessions, subtasks } from "./db/schema.js";
import { visibleSession } from "./db/visible.js";
import type { ArchiveDigest, DigestService, StoredDigest } from "./session-digest.js";

type SessionRow = typeof sessions.$inferSelect;

export async function findSession(db: Db, idOrUuid: string): Promise<SessionRow | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select().from(sessions).where(where).limit(1);
  return row ?? null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------------------------
// geänderte Dateien, Suche
// ---------------------------------------------------------------------------------------------

interface OpStatRow {
  file_path: string;
  edits: number | string;
  added: number | string | null;
  removed: number | string | null;
  last_ts: string | Date | null;
  agent_ids: (string | null)[] | null;
}

async function fileStats(db: Db, sessionKey: string, archiveId?: number): Promise<Map<string, ChangeFileStat>> {
  const rows = rowsOf<OpStatRow>(
    await db.execute(sql`
      select file_path, count(*) as edits, sum(added) as added, sum(removed) as removed, max(ts) as last_ts,
        array_agg(distinct agent_id) as agent_ids
      from session_change_ops
      where session_key = ${sessionKey} ${archiveId !== undefined ? sql`and archive_id = ${archiveId}` : sql``}
      group by file_path
    `),
  );
  const out = new Map<string, ChangeFileStat>();
  for (const r of rows) {
    out.set(r.file_path, {
      path: r.file_path,
      edits: Number(r.edits),
      added: r.added === null ? null : Number(r.added),
      removed: r.removed === null ? null : Number(r.removed),
      lastTs: iso(r.last_ts),
      agentIds: (r.agent_ids ?? []).filter((a): a is string => typeof a === "string").sort(),
    });
  }
  return out;
}

function byRecent(a: ChangeFileStat, b: ChangeFileStat): number {
  if (a.lastTs && b.lastTs && a.lastTs !== b.lastTs) return b.lastTs.localeCompare(a.lastTs);
  if (a.lastTs && !b.lastTs) return -1;
  if (!a.lastTs && b.lastTs) return 1;
  return a.path.localeCompare(b.path);
}

const SNIPPET_MAX = 3;
const SNIPPET_LINE_MAX = 220;
const SEARCH_OP_ROWS_MAX = 1000;

function snippetText(line: string, needle: string): string {
  if (line.length <= SNIPPET_LINE_MAX) return line;
  const at = line.toLocaleLowerCase("de").indexOf(needle);
  const start = Math.max(0, at - 60);
  const piece = line.slice(start, start + SNIPPET_LINE_MAX);
  return `${start > 0 ? "…" : ""}${piece}${start + SNIPPET_LINE_MAX < line.length ? "…" : ""}`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function getSessionChanges(db: Db, digests: DigestService, session: SessionRow, rawQuery: string | null): Promise<SessionChangesResponse> {
  await digests.forSession(session.id);
  const [stats, written] = await Promise.all([
    fileStats(db, session.id),
    db.select({ path: sessionFiles.path }).from(sessionFiles).where(and(eq(sessionFiles.sessionKey, session.id), eq(sessionFiles.mode, "write"))),
  ]);
  const all = new Map(stats);
  for (const w of written) {
    if (!all.has(w.path)) all.set(w.path, { path: w.path, edits: null, added: null, removed: null, lastTs: null, agentIds: [] });
  }
  const list = [...all.values()].sort(byRecent);
  const query = rawQuery?.trim() ? rawQuery.trim() : null;
  if (!query) {
    return { files: list.map((f) => ({ ...f, matchedPath: false, contentMatches: 0, snippets: [] })), total: list.length, query: null };
  }

  const needle = query.toLocaleLowerCase("de");
  const pattern = `%${escapeLike(query)}%`;
  const opRows = await db
    .select({ filePath: sessionChangeOps.filePath, addedText: sessionChangeOps.addedText, removedText: sessionChangeOps.removedText })
    .from(sessionChangeOps)
    .where(and(eq(sessionChangeOps.sessionKey, session.id), or(sql`${sessionChangeOps.addedText} ilike ${pattern} escape '\\'`, sql`${sessionChangeOps.removedText} ilike ${pattern} escape '\\'`)))
    .orderBy(sessionChangeOps.ts)
    .limit(SEARCH_OP_ROWS_MAX);
  const content = new Map<string, { matches: number; snippets: ChangeSnippetLine[] }>();
  for (const op of opRows) {
    const acc = content.get(op.filePath) ?? { matches: 0, snippets: [] };
    for (const [kind, text] of [
      ["-", op.removedText],
      ["+", op.addedText],
    ] as const) {
      for (const line of text.split("\n")) {
        if (!line.toLocaleLowerCase("de").includes(needle)) continue;
        acc.matches++;
        if (acc.snippets.length < SNIPPET_MAX) acc.snippets.push({ kind, text: snippetText(line, needle) });
      }
    }
    content.set(op.filePath, acc);
  }
  const files: ChangeFileHit[] = [];
  for (const f of list) {
    const matchedPath = f.path.toLocaleLowerCase("de").includes(needle);
    const hit = content.get(f.path);
    if (!matchedPath && !hit?.matches) continue;
    files.push({ ...f, matchedPath, contentMatches: hit?.matches ?? 0, snippets: hit?.snippets ?? [] });
  }
  return { files, total: list.length, query };
}

const FILE_OPS_MAX = 50;

/** Alle Änderungen an EINER Datei (neueste zuerst), mit den geänderten Zeilen. */
/** `agent`: nur die Änderungen EINES Sub-Agenten (große Agenten-Kachel), `"main"` = nur die Haupt-Session. */
export async function getFileChanges(db: Db, digests: DigestService, session: SessionRow, path: string, agent: string | null = null): Promise<SessionFileChangesResponse> {
  await digests.forSession(session.id);
  const agentFilter = agent === null ? undefined : agent === "main" ? isNull(sessionChangeOps.agentId) : eq(sessionChangeOps.agentId, agent);
  const where = and(eq(sessionChangeOps.sessionKey, session.id), eq(sessionChangeOps.filePath, path), agentFilter);
  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(sessionChangeOps)
      .where(where)
      .orderBy(sql`${sessionChangeOps.ts} desc nulls last`, sql`${sessionChangeOps.id} desc`)
      .limit(FILE_OPS_MAX),
    db.select({ n: sql<number>`count(*)::int` }).from(sessionChangeOps).where(where),
  ]);
  const ops: FileChangeOp[] = rows.map((r) => {
    // Zeilen nur, wenn es welche gibt — eine einzelne leere Zeile ist `added=1` mit Text "".
    const removed = r.removed > 0 ? r.removedText.split("\n") : [];
    const added = r.added > 0 ? r.addedText.split("\n") : [];
    const all: ChangeSnippetLine[] = [...removed.map((text) => ({ kind: "-" as const, text })), ...added.map((text) => ({ kind: "+" as const, text }))];
    return {
      ts: iso(r.ts),
      tool: r.tool,
      agentId: r.agentId,
      added: r.added,
      removed: r.removed,
      lines: all.slice(0, FILE_OP_LINES_MAX),
      truncated: all.length > FILE_OP_LINES_MAX || added.length < r.added || removed.length < r.removed,
    };
  });
  return { path, ops, total: Number(countRow?.n ?? 0) };
}

// ---------------------------------------------------------------------------------------------
// Agenten
// ---------------------------------------------------------------------------------------------

interface SubagentMeta {
  id: string;
  name: string | null;
  type: string | null;
}

function subagentMetas(session: SessionRow): SubagentMeta[] {
  const raw = Array.isArray(session.subagents) ? session.subagents : [];
  return raw.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    if (typeof o.id !== "string") return [];
    return [{ id: o.id, name: typeof o.name === "string" ? o.name : null, type: typeof o.type === "string" ? o.type : null }];
  });
}

function sumTools(tools: Record<string, number>): number {
  return Object.values(tools).reduce((a, b) => a + b, 0);
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const d = Date.parse(end) - Date.parse(start);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function summaryFrom(base: { id: string; tool: Tool; name: string | null; type: string | null; sessionKey: string | null }, digest: ArchiveDigest | null, filesWritten: number): SessionAgentSummary {
  return {
    ...base,
    model: digest?.models.at(-1) ?? null,
    startedAt: digest?.startedAt ?? null,
    endedAt: digest?.endedAt ?? null,
    durationMs: digest ? durationMs(digest.startedAt, digest.endedAt) : null,
    toolCalls: digest ? sumTools(digest.tools) : 0,
    tokens: digest?.tokens ?? null,
    filesWritten,
    verdict: digest?.verdict ?? null,
    hasTranscript: digest !== null,
  };
}

interface AgentSource {
  base: { id: string; tool: Tool; name: string | null; type: string | null; sessionKey: string | null };
  stored: StoredDigest | null;
}

async function filesPerArchive(db: Db, archiveIds: number[]): Promise<Map<number, number>> {
  if (archiveIds.length === 0) return new Map();
  const rows = await db
    .select({ archiveId: sessionChangeOps.archiveId, n: sql<number>`count(distinct ${sessionChangeOps.filePath})::int` })
    .from(sessionChangeOps)
    .where(inArray(sessionChangeOps.archiveId, archiveIds))
    .groupBy(sessionChangeOps.archiveId);
  return new Map(rows.map((r) => [r.archiveId, Number(r.n)]));
}

/** Claude: Sub-Agent-Dateien der Session. Codex: Kind-Sessions (`parent_id`) mit ihrem Haupt-Verlauf. */
async function agentSources(db: Db, digests: DigestService, session: SessionRow): Promise<AgentSource[]> {
  if (session.tool === "codex") {
    const children = await db.select().from(sessions).where(eq(sessions.parentId, session.id));
    const out: AgentSource[] = [];
    // In kleinen Gruppen parallel (nicht 100 Runden nacheinander, aber auch nicht alle auf einmal).
    const GROUP = 4;
    for (let i = 0; i < children.length; i += GROUP) {
      const group = children.slice(i, i + GROUP);
      const stored = await Promise.all(group.map(async (child) => (await digests.forSession(child.id)).find((d) => d.agentId === null) ?? null));
      group.forEach((child, j) => out.push({ base: { id: child.id, tool: "codex", name: child.title, type: null, sessionKey: child.id }, stored: stored[j] ?? null }));
    }
    return out;
  }
  const stored = (await digests.forSession(session.id)).filter((d) => d.agentId !== null);
  const byAgent = new Map(stored.map((d) => [d.agentId as string, d]));
  const out: AgentSource[] = [];
  const seen = new Set<string>();
  for (const meta of subagentMetas(session)) {
    seen.add(meta.id);
    out.push({ base: { id: meta.id, tool: "claude", name: meta.name, type: meta.type, sessionKey: null }, stored: byAgent.get(meta.id) ?? null });
  }
  for (const d of stored) {
    if (d.agentId === null || seen.has(d.agentId)) continue;
    out.push({ base: { id: d.agentId, tool: "claude", name: null, type: null, sessionKey: null }, stored: d });
  }
  return out;
}

function newestFirst(a: SessionAgentSummary, b: SessionAgentSummary): number {
  return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
}

export async function listSessionAgents(db: Db, digests: DigestService, session: SessionRow): Promise<SessionAgentSummary[]> {
  const sources = await agentSources(db, digests, session);
  const files = await filesPerArchive(
    db,
    sources.flatMap((s) => (s.stored ? [s.stored.archiveId] : [])),
  );
  return sources.map((s) => summaryFrom(s.base, s.stored?.digest ?? null, s.stored ? (files.get(s.stored.archiveId) ?? 0) : 0)).sort(newestFirst);
}

export async function getSessionAgent(db: Db, digests: DigestService, session: SessionRow, agentId: string): Promise<SessionAgentDetail | null> {
  const source = (await agentSources(db, digests, session)).find((s) => s.base.id === agentId);
  if (!source) return null;
  const stored = source.stored;
  const files = stored ? [...(await fileStats(db, stored.sessionKey, stored.archiveId)).values()].sort(byRecent) : [];
  // Die Liste lädt Auftrag/Ergebnis gekürzt — für die große Kachel der volle Text.
  const digest = stored ? ((await digests.fullDigest(stored.archiveId)) ?? stored.digest) : null;
  return {
    ...summaryFrom(source.base, digest, files.length),
    prompt: digest?.prompt ?? null,
    result: digest?.result ?? null,
    tools: digest
      ? Object.entries(digest.tools)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      : [],
    toolErrors: digest?.toolErrors ?? 0,
    files,
  };
}

// ---------------------------------------------------------------------------------------------
// erledigt / behoben / offen / vergleichbar
// ---------------------------------------------------------------------------------------------

const VERDICT_LABEL: Record<AgentVerdict, string> = { PASS: "PASS", PASS_WITH_NOTES: "PASS mit Hinweisen", BLOCK: "BLOCK" };
const FIX_RE = /\b(fix|fixes|fixed|bugfix|hotfix|behoben|behebt|repariert|korrigiert)\b/i;
const CONFIDENCE_ORDER: Record<OutcomeConfidence, number> = { sicher: 0, wahrscheinlich: 1, moeglich: 2 };
const BUG_KINDS = new Set(["bug", "problem"]);

function firstLine(s: string | null, max = 90): string | null {
  if (!s) return null;
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed || null;
}

function byConfidenceThenTime(a: OutcomeItem, b: OutcomeItem): number {
  return CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || (b.ts ?? "").localeCompare(a.ts ?? "");
}

async function linkedEntries(db: Db, sessionKey: string) {
  const linkRows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(and(eq(links.fromType, "entry"), eq(links.toType, "session"), eq(links.toId, sessionKey)));
  const ids = new Set(linkRows.map((l) => Number(l.fromId)).filter((n) => Number.isInteger(n)));
  const started = await db.select({ id: entries.id }).from(entries).where(eq(entries.startedSessionKey, sessionKey));
  for (const s of started) ids.add(s.id);
  if (ids.size === 0) return [];
  return db
    .select({ id: entries.id, kind: entries.kind, title: entries.title, stage: entries.stage, updatedAt: entries.updatedAt })
    .from(entries)
    .where(inArray(entries.id, [...ids]));
}

interface OutcomeAgent {
  id: string;
  name: string | null;
  digest: ArchiveDigest | null;
}

export async function getSessionOutcomes(db: Db, digests: DigestService, session: SessionRow): Promise<SessionOutcomesResponse> {
  const own = await digests.forSession(session.id);
  const sources = await agentSources(db, digests, session);
  const agents: OutcomeAgent[] = sources.map((s) => ({ id: s.base.id, name: s.base.name, digest: s.stored?.digest ?? null }));
  // Alle Verläufe der Session: Haupt-Verlauf + Sub-Agenten (Claude) bzw. Kind-Sessions (Codex).
  const allDigests: ArchiveDigest[] = [...own.map((d) => d.digest), ...(session.tool === "codex" ? agents.flatMap((a) => (a.digest ? [a.digest] : [])) : [])];

  const done: OutcomeItem[] = [];
  const fixed: OutcomeItem[] = [];
  const open: OutcomeItem[] = [];

  // Aufgabenliste: letzter Stand je Verlauf, gleiche Einträge nur einmal.
  const todoSeen = new Set<string>();
  for (const d of allDigests) {
    for (const todo of d.todos ?? []) {
      const key = `${todo.status === "completed" ? "done" : "open"}:${todo.content}`;
      if (todoSeen.has(key)) continue;
      todoSeen.add(key);
      const item: OutcomeItem = {
        id: `todo:${key}`,
        kind: "todo",
        title: todo.content,
        detail: todo.status === "in_progress" ? t("war zuletzt in Arbeit") : null,
        ts: d.endedAt,
        confidence: "sicher",
        why: todo.status === "completed" ? t("In der Aufgabenliste der Session abgehakt") : t("In der Aufgabenliste am Ende noch nicht abgehakt"),
        link: null,
      };
      (todo.status === "completed" ? done : open).push(item);
    }
  }

  // Sub-Agenten: fertig = hat ein Ergebnis geliefert UND läuft nicht mehr (ein laufender
  // Agent hat im Archiv oft schon Zwischentext — vorher stand dort „122 von 122 fertig“); BLOCK = offen.
  const runningAgents = await runningAgentIdsOf(db, session);
  const finished = (a: OutcomeAgent) => Boolean(a.digest?.result) && !runningAgents.has(a.id);
  for (const a of agents) {
    if (!a.digest?.result || !finished(a)) continue;
    const title = a.name ?? firstLine(a.digest.prompt) ?? "Sub-Agent";
    const item: OutcomeItem = {
      id: `agent:${a.id}`,
      kind: "agent",
      title,
      detail: a.digest.verdict ? t("Urteil: {verdict}", { verdict: t(VERDICT_LABEL[a.digest.verdict]) }) : firstLine(a.digest.result, 120),
      ts: a.digest.endedAt,
      // Urteil und „fertig" sind aus dem Text abgeleitet (s. `detectVerdict`) — daher nie „sicher".
      confidence: "wahrscheinlich",
      why: a.digest.verdict ? t("Sub-Agent hat sein Urteil {verdict} abgegeben", { verdict: a.digest.verdict }) : t("Sub-Agent hat ein Ergebnis geliefert"),
      link: { type: "agent", id: a.id },
    };
    if (a.digest.verdict === "BLOCK") open.push({ ...item, why: t("Prüf-Agent hat zuletzt BLOCK gemeldet — Nacharbeit nötig") });
    else done.push(item);
  }

  // Commits (Haupt-Verlauf + Sub-Agenten), je Commit einmal (auch bei Kurz-/Langkennung und bei
  // „--amend“/Rebase mit gleicher Nachricht auf demselben Zweig).
  const allCommitDigests = [...own.map((d) => d.digest), ...agents.flatMap((a) => (a.digest ? [a.digest] : []))];
  const commits = uniqueCommits(allCommitDigests.flatMap((d) => d.commits));
  const commitCount = commits.length;
  {
    for (const c of commits) {
      const detail = [c.sha.slice(0, 7), c.branch].filter(Boolean).join(" · ");
      done.push({ id: `commit:${c.sha}`, kind: "commit", title: c.subject, detail, ts: c.ts, confidence: "sicher", why: t("Commit aus dieser Session"), link: null });
      if (FIX_RE.test(c.subject)) {
        fixed.push({ id: `fix-commit:${c.sha}`, kind: "commit", title: c.subject, detail, ts: c.ts, confidence: "wahrscheinlich", why: t("Commit-Nachricht nennt eine Fehlerbehebung"), link: null });
      }
    }
  }

  // Tests, je Verlauf (Haupt-Session und jeder Agent für sich): rot → grün mit demselben Befehl =
  // möglicherweise behoben. War der LETZTE Testlauf eines Verlaufs rot, bleibt das offen — einzelne
  // rote Läufe mittendrin sind normal („erst roter Test, dann Fix") und zählen nicht.
  const transcripts: { agent: OutcomeAgent | null; digest: ArchiveDigest }[] = [
    ...own.filter((d) => d.agentId === null).map((d) => ({ agent: null, digest: d.digest })),
    ...agents.flatMap((a) => (a.digest ? [{ agent: a, digest: a.digest }] : [])),
  ];
  let testRuns = 0;
  for (const { agent, digest } of transcripts) {
    const runs = [...digest.tests].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    testRuns += runs.length;
    const who = agent ? t(" (Agent „{name}“)", { name: agent.name ?? agent.id }) : "";
    const link = agent ? { type: "agent" as const, id: agent.id } : null;
    const byKey = new Map<string, typeof runs>();
    for (const r of runs) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    for (const [key, list] of byKey) {
      const firstRed = list.findIndex((r) => !r.ok);
      const greenAfter = firstRed >= 0 ? list.slice(firstRed + 1).find((r) => r.ok) : undefined;
      if (!greenAfter) continue;
      fixed.push({
        id: `test:${agent?.id ?? "main"}:${key}`,
        kind: "test",
        title: t("Test erst rot, danach grün{who}", { who }),
        detail: greenAfter.command,
        ts: greenAfter.ts,
        confidence: "moeglich",
        why: t("Derselbe Test-Befehl schlug erst fehl und lief später durch"),
        link,
      });
    }
    const last = runs.at(-1);
    if (last && !last.ok) {
      open.push({
        id: `test-red:${agent?.id ?? "main"}`,
        kind: "test",
        title: t("Letzter Testlauf rot{who}", { who }),
        detail: last.command,
        ts: last.ts,
        confidence: "wahrscheinlich",
        why: t("Der letzte Testlauf in diesem Verlauf schlug fehl — danach lief kein Test mehr"),
        link,
      });
    }
  }

  // Verknüpfte Einträge (Aufgaben, Bugs …) und von dieser Session erledigte Teilaufgaben.
  for (const e of await linkedEntries(db, session.id)) {
    const link = { type: "entry" as const, id: e.id };
    if (e.stage === "erledigt") {
      done.push({ id: `entry:${e.id}`, kind: "entry", title: e.title, detail: null, ts: iso(e.updatedAt), confidence: "sicher", why: t("Verknüpfter Eintrag ist erledigt"), link });
      if (BUG_KINDS.has(e.kind)) {
        fixed.push({ id: `bug:${e.id}`, kind: "entry", title: e.title, detail: e.kind === "bug" ? t("Bug") : t("Problem"), ts: iso(e.updatedAt), confidence: "sicher", why: t("Verknüpfter Bug ist als erledigt markiert"), link });
      }
    } else {
      open.push({ id: `entry:${e.id}`, kind: "entry", title: e.title, detail: t("Stand: {stage}", { stage: e.stage.replace("_", " ") }), ts: iso(e.updatedAt), confidence: "sicher", why: t("Verknüpfter Eintrag ist noch nicht erledigt"), link });
    }
  }
  const subs = await db
    .select({ id: subtasks.id, title: subtasks.title, doneAt: subtasks.doneAt, entryId: subtasks.entryId })
    .from(subtasks)
    .where(and(eq(subtasks.doneBySessionKey, session.id), eq(subtasks.done, true)));
  for (const s of subs) {
    done.push({ id: `subtask:${s.id}`, kind: "subtask", title: s.title, detail: null, ts: iso(s.doneAt), confidence: "sicher", why: t("Teilaufgabe wurde von dieser Session abgehakt"), link: { type: "entry", id: s.entryId } });
  }

  const agentsFinished = agents.filter(finished).length;
  return {
    done: done.sort(byConfidenceThenTime),
    fixed: fixed.sort(byConfidenceThenTime),
    open: open.sort(byConfidenceThenTime),
    similar: await similarSessions(db, session),
    stats: { commits: commitCount, testRuns, agentsFinished, agentsTotal: agents.length },
  };
}

// ---------------------------------------------------------------------------------------------
// Vergleichbare Sessions
// ---------------------------------------------------------------------------------------------

const SIMILAR_MAX = 10;
const TITLE_WEIGHT = 1.5;
const PROMPT_WEIGHT = 1;
const BAUSTELLE_BONUS = 0.5;
const MAX_QUERY_WORDS = 12;

interface Candidate {
  files: Set<string>;
  fileScore: number;
  textScore: number;
  textReason: string | null;
}

function queryWords(text: string): string[] {
  const words = (text.toLocaleLowerCase("de").match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 200);
  return [...new Set(words)].slice(0, MAX_QUERY_WORDS);
}

async function similarSessions(db: Db, session: SessionRow): Promise<SimilarSession[]> {
  const candidates = new Map<string, Candidate>();
  const get = (key: string): Candidate => {
    let c = candidates.get(key);
    if (!c) {
      c = { files: new Set(), fileScore: 0, textScore: 0, textReason: null };
      candidates.set(key, c);
    }
    return c;
  };

  // 1) Gemeinsam geschriebene Dateien, gewichtet: eine Datei, die fast jede Session anfasst
  //    (z. B. `package.json`), zählt weniger als eine seltene.
  const written = await db.select({ path: sessionFiles.path }).from(sessionFiles).where(and(eq(sessionFiles.sessionKey, session.id), eq(sessionFiles.mode, "write")));
  const paths = [...new Set(written.map((w) => w.path))];
  if (paths.length > 0) {
    const shared = await db
      .select({ sessionKey: sessionFiles.sessionKey, path: sessionFiles.path })
      .from(sessionFiles)
      .where(and(inArray(sessionFiles.path, paths), eq(sessionFiles.mode, "write"), sql`${sessionFiles.sessionKey} <> ${session.id}`));
    const df = new Map<string, number>();
    for (const r of shared) df.set(r.path, (df.get(r.path) ?? 0) + 1);
    for (const r of shared) {
      const c = get(r.sessionKey);
      if (c.files.has(r.path)) continue;
      c.files.add(r.path);
      c.fileScore += 1 / Math.log2(1 + (df.get(r.path) ?? 1));
    }
  }

  // 2) Ähnlicher Titel/Auftrag über den Volltext-Index (`search_docs`, deutsche Wortstämme).
  const [myPrompt] = await db.execute(sql`select text from search_docs where session_key = ${session.id} and field = 'prompt' order by id limit 1`).then((r) => rowsOf<{ text: string }>(r));
  const words = queryWords(`${session.title ?? ""} ${myPrompt?.text ?? ""}`);
  if (words.length > 0) {
    const tsq = words.join(" | ");
    const rows = rowsOf<{ session_key: string; field: string; text: string; common: number | string; mine: number | string }>(
      await db.execute(sql`
        with me as (select tsvector_to_array(to_tsvector('german', ${`${session.title ?? ""} ${myPrompt?.text ?? ""}`})) as lex)
        select d.session_key, d.field, d.text,
          (select count(*) from unnest(tsvector_to_array(d.tsv_german)) x where x = any(me.lex)) as common,
          coalesce(array_length(me.lex, 1), 0) as mine
        from search_docs d, me
        where d.field in ('title', 'prompt') and d.session_key <> ${session.id}
          and d.tsv_german @@ to_tsquery('german', ${tsq})
        order by ts_rank(d.tsv_german, to_tsquery('german', ${tsq})) desc
        limit 400
      `),
    );
    for (const r of rows) {
      const mine = Number(r.mine);
      const common = Number(r.common);
      if (mine === 0 || common === 0) continue;
      const weight = r.field === "title" ? TITLE_WEIGHT : PROMPT_WEIGHT;
      const score = Math.min(1, common / Math.min(mine, 6)) * weight;
      const c = get(r.session_key);
      if (score > c.textScore) {
        c.textScore = score;
        const snippet = r.text.replace(/\s+/g, " ").trim();
        const quoted = snippet.length > 50 ? `${snippet.slice(0, 49)}…` : snippet;
        c.textReason = r.field === "title" ? t("ähnlicher Titel („{text}“)", { text: quoted }) : t("ähnlicher Auftrag („{text}“)", { text: quoted });
      }
    }
  }

  const keys = [...candidates.keys()];
  if (keys.length === 0) return [];
  // archivierte Wegwerf-Sessions nicht als „ähnlich“ vorschlagen.
  const rows = await db.select().from(sessions).where(and(inArray(sessions.id, keys), visibleSession));
  const out: SimilarSession[] = [];
  for (const row of rows) {
    if (row.id === session.id || row.id === session.parentId || row.parentId === session.id) continue; // stehen schon oben als Eltern/Kind
    const c = candidates.get(row.id);
    if (!c) continue;
    const reasons: string[] = [];
    if (c.files.size > 0) reasons.push(c.files.size === 1 ? t("1 gemeinsame Datei") : t("{n} gemeinsame Dateien", { n: c.files.size }));
    if (c.textReason) reasons.push(c.textReason);
    const sameBaustelle = !!session.categoryBaustelleSlug && row.categoryBaustelleSlug === session.categoryBaustelleSlug;
    if (sameBaustelle) reasons.push(t("gleiche Baustelle „{name}“", { name: row.categoryBaustelleLabel ?? row.categoryBaustelleSlug }));
    const score = c.fileScore + c.textScore + (sameBaustelle ? BAUSTELLE_BONUS : 0);
    out.push({
      sessionKey: row.id,
      sessionId: row.sessionId,
      title: row.title,
      tool: row.tool as Tool,
      state: row.state,
      art: row.categoryArt ?? "unsortiert",
      baustelle: row.categoryBaustelleSlug ? { slug: row.categoryBaustelleSlug, label: row.categoryBaustelleLabel ?? row.categoryBaustelleSlug } : null,
      lastActivityAt: iso(row.lastActivityAt),
      score: Math.round(score * 100) / 100,
      reasons,
      sharedFiles: [...c.files].sort().slice(0, 5),
    });
  }
  return out.sort((a, b) => b.score - a.score || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")).slice(0, SIMILAR_MAX);
}

/**
 * (D7 zeigte denselben Commit doppelt): ein Commit zählt einmal, wenn die Kennungen
 * gleich sind oder eine die Kurzform der anderen ist — und ebenso, wenn dieselbe Nachricht auf demselben
 * Zweig mehrfach auftaucht (`git commit --amend`, Rebase, erneuter Versuch nach Hook-Fehler). Der
 * jüngste Stand gewinnt, die Reihenfolge des ersten Auftretens bleibt.
 */
export function uniqueCommits<T extends { sha: string; subject: string; branch: string | null; ts: string | null }>(list: T[]): T[] {
  const out: T[] = [];
  for (const c of list) {
    const i = out.findIndex((o) => o.sha.startsWith(c.sha) || c.sha.startsWith(o.sha) || (o.subject.trim() === c.subject.trim() && (o.branch ?? "") === (c.branch ?? "")));
    if (i < 0) out.push(c);
    else if ((c.ts ?? "") > (out[i]?.ts ?? "")) out[i] = c;
  }
  return out;
}
