// What the notification pipeline needs to know about a session: name (never the raw prompt), workstream,
// sub-agent yes/no (`parent_id`, e.g. Codex workers "Locke: …") and for "Ausführlich"/Nyx the last steps
// (last question, last answer). One query per notification, no transcript files.
import { isAgentWorktree, notificationName, t } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { redactSecrets } from "../push/log.js";

export interface NotifySessionInfo {
  id: string;
  name: string;
  baustelle: string | null;
  tool: string;
  title: string | null;
  parentId: string | null;
  parentName: string | null;
  /** Started by an agent in its worktree (`…/.claude/worktrees/agent-<id>`), see `isAgentWorktree`. */
  agentWorktree: boolean;
  state: string | null;
  lastPrompt: string | null;
  lastAnswer: string | null;
}

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Text of a `prompt`/`assistant` event (like `haiku/latestActivity.ts`). */
function textOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string" && d.text.trim()) return d.text;
  if (typeof d.command === "string" && d.command.trim()) return `${d.command} ${typeof d.args === "string" ? d.args : ""}`.trim();
  return null;
}

export const clipText = (s: string | null, n: number): string | null => {
  if (!s) return null;
  const text = s.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
};

export async function loadSessionInfo(db: Db, sessionKey: string): Promise<NotifySessionInfo | null> {
  const rows = rowsOf(
    await db.execute(sql`
      select s.id, s.tool, s.title, s.title_source, s.cwd, s.category_baustelle_label, s.started_at, s.last_activity_at, s.parent_id, s.state,
        p.title as parent_title, p.title_source as parent_title_source, p.category_baustelle_label as parent_baustelle, p.cwd as parent_cwd, p.tool as parent_tool,
        (select e.data from session_events e where e.session_key = s.id and e.kind = 'prompt' order by e.ts asc limit 1) as first_prompt,
        (select e.data from session_events e where e.session_key = s.id and e.kind = 'prompt' order by e.ts desc limit 1) as last_prompt,
        (select e.data from session_events e where e.session_key = s.id and e.kind = 'assistant' order by e.ts desc limit 1) as last_answer
      from sessions s left join sessions p on p.id = s.parent_id
      where s.id = ${sessionKey}
      limit 1`),
  );
  const r = rows[0];
  if (!r) return null;
  const baustelle = str(r.category_baustelle_label);
  const name = notificationName({
    title: str(r.title),
    titleSource: str(r.title_source),
    tool: str(r.tool),
    cwd: str(r.cwd),
    baustelleLabel: baustelle,
    startedAt: iso(r.started_at),
    lastActivityAt: iso(r.last_activity_at),
    firstPrompt: textOf(r.first_prompt),
  });
  const parentId = str(r.parent_id);
  const parentName = parentId
    ? notificationName({ title: str(r.parent_title), titleSource: str(r.parent_title_source), tool: str(r.parent_tool), cwd: str(r.parent_cwd), baustelleLabel: str(r.parent_baustelle) })
    : null;
  return {
    id: String(r.id),
    name,
    baustelle,
    tool: String(r.tool),
    title: str(r.title),
    parentId,
    parentName,
    agentWorktree: isAgentWorktree(str(r.cwd)),
    state: str(r.state),
    // Redacted: goes into notifications ("Ausführlich") and into Nyx' prompt.
    lastPrompt: clipText(redactSecrets(textOf(r.last_prompt) ?? ""), 400),
    lastAnswer: clipText(redactSecrets(textOf(r.last_answer) ?? ""), 600),
  };
}

/** "Zuletzt: …" for the style "Ausführlich" (without Nyx): start of the last answer, otherwise the last question. */
export function detailsFrom(info: NotifySessionInfo | null): string | null {
  if (!info) return null;
  const answer = clipText(info.lastAnswer, 140);
  if (answer) return t("Zuletzt: {text}", { text: answer });
  const prompt = clipText(info.lastPrompt, 120);
  return prompt ? t("Zuletzt gefragt: {text}", { text: prompt }) : null;
}
