// Agenten-Läufe aus den Events — KEINE eigene Tabelle: Claude-Subagenten
// stecken als `data.agentId` in `session_events` derselben Eltern-Session (s.
// `packages/shared/src/parse/claude.ts` `emit`), Codex-Subagenten sind eigene `sessions`-Zeilen mit
// `parent_id`. Beides wird hier zu einer gemeinsamen Liste verdichtet.
import type { AgentRun, AgentVerdict } from "@nyxos/shared";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { visibleSession, visibleSessionSql } from "../db/visible.js";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

/** Erkennt ein Urteil NUR, wenn der Agent es selbst ausgibt: ein eigenständiges Wort in einer
 * Antwort dieses Agenten (`\b` schließt "PASS_WITH_NOTES" von einem bloßen "PASS"-Treffer aus,
 * da `_` ein Wortzeichen ist). Der letzte Treffer gewinnt (Schlussfazit zählt mehr als ein Zitat). */
export function detectVerdict(texts: string[]): AgentVerdict | null {
  let verdict: AgentVerdict | null = null;
  for (const t of texts) {
    if (/\bBLOCK\b/.test(t)) verdict = "BLOCK";
    else if (/\bPASS_WITH_NOTES\b/.test(t)) verdict = "PASS_WITH_NOTES";
    else if (/\bPASS\b/.test(t)) verdict = "PASS";
  }
  return verdict;
}

interface ClaudeAgentAgg {
  session_key: string;
  agent_id: string;
  started_at: string;
  ended_at: string;
  tool_calls: string;
  last_kind: string | null;
  last_tool: string | null;
  handed_back: boolean;
}

/** So lange darf ein Sub-Agent still sein und trotzdem „laufen“ (Denken, Antwort schreiben). */
export const AGENT_QUIET_MS = 2 * 60_000;
/** Wartet der Agent auf ein Werkzeug (letztes Ereignis ist ein Aufruf ohne Ergebnis, z. B. ein langer
 * Testlauf), gilt er länger als laufend — ein Bash-Aufruf darf bis zu 10 Min dauern. */
export const AGENT_TOOL_WAIT_MS = 15 * 60_000;
/** Werkzeug, mit dem ein Sub-Agent seinen Abschlussbericht abgibt — danach ist er fertig. */
const HANDBACK_TOOL = "SubagentHandback";

export interface ClaudeAgentSignals {
  /** Eltern-Session: Prozess lebt und nicht vom Nutzer geschlossen. */
  parentAlive: boolean;
  /** Abschlussbericht per `SubagentHandback` abgegeben. */
  handedBack: boolean;
  /** Art und Werkzeug des letzten Ereignisses dieses Agenten. */
  lastKind: string | null;
  lastToolName: string | null;
  lastTs: string | null;
}

/**
 * „läuft gerade“ aus echten Signalen statt fest `false`:
 * - Eltern-Session tot/geschlossen → kein Agent läuft (ein Sub-Agent lebt im Prozess der Eltern-Session).
 * - Abschlussbericht abgegeben, oder das letzte Ereignis ist eine Text-Antwort (die Schlussantwort) → fertig.
 * - sonst läuft er, solange er nicht länger als `AGENT_QUIET_MS` still ist
 *   (beim Warten auf ein Werkzeug: `AGENT_TOOL_WAIT_MS`).
 */
export function isClaudeAgentRunning(s: ClaudeAgentSignals, now: number): boolean {
  if (!s.parentAlive || s.handedBack) return false;
  if (s.lastKind === "assistant") return false;
  if (s.lastKind === "tool_call" && s.lastToolName === HANDBACK_TOOL) return false;
  const last = s.lastTs === null ? Number.NaN : Date.parse(s.lastTs);
  if (Number.isNaN(last)) return false;
  const limit = s.lastKind === "tool_call" ? AGENT_TOOL_WAIT_MS : AGENT_QUIET_MS;
  return now - last < limit;
}

/** Teil-SQL: Kennzahlen je (Eltern-Session, agentId) inkl. letztem Ereignis und Abgabe. */
const AGENT_AGG_COLUMNS = sql`e.session_key, e.data->>'agentId' as agent_id, min(e.ts) as started_at, max(e.ts) as ended_at,
        count(*) filter (where e.kind = 'tool_call') as tool_calls,
        (array_agg(e.kind order by e.ts desc, e.id desc))[1] as last_kind,
        (array_agg(e.data->>'name' order by e.ts desc, e.id desc))[1] as last_tool,
        coalesce(bool_or(e.kind = 'tool_call' and e.data->>'name' = ${HANDBACK_TOOL}), false) as handed_back`;

function signalsOf(a: ClaudeAgentAgg, parent: { status: string; closedAt: string | null } | undefined): ClaudeAgentSignals {
  return {
    parentAlive: parent !== undefined && parent.status === "running" && parent.closedAt === null,
    handedBack: a.handed_back === true || String(a.handed_back) === "true",
    lastKind: a.last_kind,
    lastToolName: a.last_tool,
    lastTs: a.ended_at ? new Date(a.ended_at).toISOString() : null,
  };
}

/** Kennungen der gerade laufenden Claude-Sub-Agenten EINER Session (Session-Seite „N von M fertig“). */
export async function runningClaudeAgentIds(db: Db, sessionKey: string, now = Date.now()): Promise<Set<string>> {
  const [parent] = await db.select({ status: sessions.status, closedAt: sessions.closedAt }).from(sessions).where(eq(sessions.id, sessionKey));
  if (!parent || parent.status !== "running" || parent.closedAt !== null) return new Set();
  const agg = rowsOf<ClaudeAgentAgg>(
    await db.execute(sql`
      select ${AGENT_AGG_COLUMNS}
      from session_events e
      where e.session_key = ${sessionKey} and e.data ? 'agentId'
      group by e.session_key, e.data->>'agentId'
    `),
  );
  return new Set(agg.filter((a) => isClaudeAgentRunning(signalsOf(a, parent), now)).map((a) => a.agent_id));
}

/** Claude-Subagenten: gruppiert `session_events` nach (Eltern-Session, `agentId`). `limit` begrenzt
 * die Gruppen (nicht die Rohzeilen) — für die Übersicht reichen die letzten N Läufe. nur
 * Agenten sichtbarer (nicht archivierter) Eltern-Sessions (Test-Sessions blieben sichtbar). */
async function claudeAgentRuns(db: Db, limit: number): Promise<AgentRun[]> {
  const agg = rowsOf<ClaudeAgentAgg>(
    await db.execute(sql`
      select ${AGENT_AGG_COLUMNS}
      from session_events e
      join sessions s on s.id = e.session_key
      where e.data ? 'agentId' and ${visibleSessionSql("s")}
      group by e.session_key, e.data->>'agentId'
      order by max(e.ts) desc
      limit ${limit}
    `),
  );
  if (agg.length === 0) return [];

  // Nur Antworten der Agenten, deren (Session, agentId) auch in `agg` steckt (s. `textsByAgent`
  // unten) — die Abfrage selbst holt bewusst alle "assistant"-Zeilen MIT agentId (kleine Menge:
  // je Subagent-Lauf wenige Antworten), keine zweite Gruppierung nötig.
  const texts = rowsOf<{ session_key: string; agent_id: string; text: string }>(
    await db.execute(sql`
      select session_key, data->>'agentId' as agent_id, coalesce(data->>'text', '') as text
      from session_events
      where kind = 'assistant' and data ? 'agentId'
      order by ts asc
    `),
  );
  const textsByAgent = new Map<string, string[]>();
  for (const t of texts) {
    const key = `${t.session_key}\u0000${t.agent_id}`;
    const arr = textsByAgent.get(key) ?? [];
    arr.push(t.text);
    textsByAgent.set(key, arr);
  }

  const parentKeys = [...new Set(agg.map((a) => a.session_key))];
  const parents = parentKeys.length
    ? await db.select({ id: sessions.id, title: sessions.title, subagents: sessions.subagents, status: sessions.status, closedAt: sessions.closedAt }).from(sessions).where(inArray(sessions.id, parentKeys))
    : [];
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const now = Date.now();
  return agg.map((a) => {
    const parent = parentById.get(a.session_key);
    const meta = (parent?.subagents as { id: string; name: string | null; type: string | null }[] | undefined)?.find((s) => s.id === a.agent_id);
    const startedAt = new Date(a.started_at).toISOString();
    const endedAt = new Date(a.ended_at).toISOString();
    return {
      id: `${a.session_key}:${a.agent_id}`,
      tool: "claude",
      parentSessionKey: a.session_key,
      parentTitle: parent?.title ?? null,
      agentName: meta?.name ?? null,
      agentType: meta?.type ?? null,
      startedAt,
      endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      toolCalls: Number(a.tool_calls),
      verdict: detectVerdict(textsByAgent.get(`${a.session_key}\u0000${a.agent_id}`) ?? []),
      // vorher fest `false` — „Laufen gerade 0“, obwohl 4 Agenten liefen.
      running: isClaudeAgentRunning(signalsOf(a, parent), now),
    };
  });
}

/** Codex-Kind-Session „läuft“: Runde offen (läuft oder ruht). „wartet“ = Runde zu = fertig. */
const CODEX_RUNNING_STATES = ["running", "idle"] as const;

/** Laufende Sub-Agenten einer Session: Claude aus den Ereignissen (s. `isClaudeAgentRunning`),
 * Codex aus dem Zustand der Kind-Sessions — dieselbe Regel wie `listAgentRuns`. */
export async function runningAgentIdsOf(db: Db, session: { id: string; tool: string }, now = Date.now()): Promise<Set<string>> {
  if (session.tool !== "codex") return runningClaudeAgentIds(db, session.id, now);
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.parentId, session.id), inArray(sessions.state, [...CODEX_RUNNING_STATES])));
  return new Set(rows.map((r) => r.id));
}

/** Codex-Subagenten sind eigene `sessions`-Zeilen mit `parent_id`. */
async function codexAgentRuns(db: Db, limit: number): Promise<AgentRun[]> {
  const rows = await db
    .select({
      id: sessions.id,
      parentId: sessions.parentId,
      title: sessions.title,
      startedAt: sessions.startedAt,
      lastActivityAt: sessions.lastActivityAt,
      endedAt: sessions.endedAt,
      toolCalls: sessions.toolCalls,
      state: sessions.state,
      limits: sessions.limits,
    })
    .from(sessions)
    // Sub-Agenten archivierter Sessions sind mitarchiviert (`temporary.ts`) und erscheinen nicht.
    .where(and(eq(sessions.tool, "codex"), isNotNull(sessions.parentId), visibleSession))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(limit);
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => !!x))];
  const parents = parentIds.length ? await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(inArray(sessions.id, parentIds)) : [];
  const parentById = new Map(parents.map((p) => [p.id, p]));
  return rows.map((r) => {
    const started = r.startedAt ? new Date(r.startedAt).toISOString() : null;
    const ended = r.endedAt ?? r.lastActivityAt ? new Date((r.endedAt ?? r.lastActivityAt) as string).toISOString() : null;
    const toolCalls = Object.values(r.toolCalls as Record<string, number>).reduce((a, b) => a + b, 0);
    return {
      id: r.id,
      tool: "codex" as const,
      parentSessionKey: r.parentId,
      parentTitle: r.parentId ? (parentById.get(r.parentId)?.title ?? null) : null,
      agentName: r.title,
      agentType: null,
      startedAt: started,
      endedAt: ended,
      durationMs: started && ended ? new Date(ended).getTime() - new Date(started).getTime() : null,
      toolCalls,
      verdict: null, // Codex-Sub-Agenten geben (Stand P6) kein PASS/BLOCK im Text aus — s. BERICHT
      // derselbe Zustand wie überall — „wartet“ heißt bei einem Sub-Agenten „Runde zu“,
      // beendet/abgestürzt (null/crashed) läuft nicht. Vorher zählte jede nicht geschlossene Kind-Session ohne `endedAt`.
      running: (CODEX_RUNNING_STATES as readonly (string | null)[]).includes(r.state),
    };
  });
}

export async function listAgentRuns(db: Db, limit = 200): Promise<AgentRun[]> {
  const [claude, codex] = await Promise.all([claudeAgentRuns(db, limit), codexAgentRuns(db, limit)]);
  return [...claude, ...codex].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}
