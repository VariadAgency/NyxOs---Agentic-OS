// Demo mode: turns the invented sessions into exactly what the bridge would deliver — transcript
// files for the archive and ingest items (events, summary, liveness) parsed by the real parsers.
import { ClaudeSessionParser, CodexSessionParser, type IngestItem, type Lang, type SessionEvent, type SessionSummary } from "@nyxos/shared";
import { REPOS, SESSIONS, WORKTREES, worktreePath, type DemoSession } from "./sessions.js";
import { pick, uuid } from "./text.js";
import { buildTranscript, type BuiltTranscript } from "./transcripts.js";

export interface BuiltSession {
  spec: DemoSession;
  /** `sessions.id`, e.g. `claude:<uuid>`. */
  key: string;
  sessionId: string;
  cwd: string;
  branch: string;
  transcript: BuiltTranscript;
  items: IngestItem[];
  summary: SessionSummary;
  events: SessionEvent[];
  /** Only for state "closed": when the user closed it. */
  closedAt: string | null;
}

export const demoSessionId = (key: string) => uuid(`nyxos-demo:${key}`);
export const demoSessionKey = (key: string) => {
  const spec = SESSIONS.find((s) => s.key === key);
  if (!spec) throw new Error(`Unbekannte Demo-Session: ${key}`);
  return `${spec.tool}:${demoSessionId(key)}`;
};

export function sessionCwd(spec: DemoSession): string {
  if (spec.worktree) {
    const w = WORKTREES.find((x) => x.slug === spec.worktree);
    if (w) return worktreePath(w);
  }
  return REPOS[spec.repo].root;
}

export function sessionBranch(spec: DemoSession): string {
  if (spec.worktree) return WORKTREES.find((x) => x.slug === spec.worktree)?.branch ?? "main";
  return spec.branch ?? "main";
}

function hookEvent(tool: "claude" | "codex", sessionId: string, cwd: string, i: number, ts: string, event: string, extra: Record<string, string>): SessionEvent {
  return { id: `hook:${tool}:${sessionId}:demo${i}-${event}`, tool, sessionId, ts, kind: "hook", source: "hook", data: { event, cwd, ...extra } };
}

export function buildSession(spec: DemoSession, now: number, lang: Lang): BuiltSession {
  const sessionId = demoSessionId(spec.key);
  const cwd = sessionCwd(spec);
  const branch = sessionBranch(spec);
  const start = now - spec.startMin * 60_000;
  const end = start + spec.durMin * 60_000;
  const transcript = buildTranscript(
    {
      tool: spec.tool,
      sessionId,
      cwd,
      branch,
      model: spec.model,
      subModel: spec.subModel,
      title: spec.title,
      parentSessionId: spec.parent ? demoSessionId(spec.parent) : undefined,
      nickname: spec.nickname,
      start,
      end,
      contextFrac: spec.contextFrac,
      limits: spec.limits,
      childIds: Object.fromEntries(SESSIONS.filter((c) => c.parent === spec.key).map((c) => [c.nickname ?? "explorer", demoSessionId(c.key)])),
      turns: spec.turns,
    },
    lang,
  );

  // Same parsing as the bridge: main file first, then sub-agent files with their agent id.
  const events: SessionEvent[] = [];
  let summary: SessionSummary;
  if (spec.tool === "claude") {
    const parser = new ClaudeSessionParser(sessionId);
    for (const f of transcript.files) if (f.agentId && f.meta) parser.addSubagentMeta(f.agentId, f.meta);
    for (const f of transcript.files) for (const line of f.text.split("\n")) events.push(...parser.push(line, f.agentId ? { agentId: f.agentId } : {}));
    summary = parser.summary();
  } else {
    const parser = new CodexSessionParser(sessionId);
    // Codex keeps its own thread names in `session_index.jsonl`; the bridge passes them on like this.
    if (spec.title) parser.setIndexTitle(pick(spec.title, lang));
    for (const f of transcript.files) for (const line of f.text.split("\n")) events.push(...parser.push(line));
    summary = parser.summary();
  }

  // Hooks (Claude) and liveness: the state column follows from these like for a real session.
  const hooks = transcript.hooks.map((h, i) => hookEvent(spec.tool, sessionId, cwd, i, h.ts, h.event, h.extra));
  const alive = spec.state === "running" || spec.state === "waiting" || spec.state === "idle";
  const lastMs = Date.parse(transcript.lastTs);
  if (spec.tool === "claude" && (spec.state === "ended" || spec.state === "closed")) {
    hooks.push(hookEvent(spec.tool, sessionId, cwd, hooks.length, new Date(lastMs + 20_000).toISOString(), "SessionEnd", { reason: "prompt_input_exit" }));
  }
  const all = [...events, ...hooks].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const items: IngestItem[] = [
    ...all.map((event) => ({ type: "event" as const, event })),
    { type: "summary", summary },
    { type: "state", state: { tool: spec.tool, sessionId, running: alive, observedAt: new Date(lastMs + (alive ? 0 : 30_000)).toISOString() } },
  ];

  return {
    spec,
    key: `${spec.tool}:${sessionId}`,
    sessionId,
    cwd,
    branch,
    transcript,
    items,
    summary,
    events: all,
    closedAt: spec.state === "closed" ? new Date(lastMs + 25 * 60_000).toISOString() : null,
  };
}

/** All demo sessions, parents before their sub-agent sessions. */
export function buildSessions(now: number, lang: Lang): BuiltSession[] {
  const ordered = [...SESSIONS.filter((s) => !s.parent), ...SESSIONS.filter((s) => s.parent)];
  return ordered.map((s) => buildSession(s, now, lang));
}
