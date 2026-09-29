// Agents in the session chat — pure helpers (grouping, numbers, colors, links). No React dependency.
import { locale, t, tc, timeZone, type AgentRunInfo, type LiveAgent, type LiveAgentStatus, type SessionAgentsLiveResponse } from "@nyxos/shared";
import { agentPaletteColor } from "../agents/agentTileModel";

export interface AgentGroups {
  /** Running right now — no matter in which run they started. */
  active: LiveAgent[];
  /** Done (or stopped) in the current run. */
  finished: LiveAgent[];
  /** Earlier runs, newest first, each with its finished agents. */
  archive: { run: AgentRunInfo; agents: LiveAgent[] }[];
  /** Agents hidden in the archive that are not shown right now. */
  hiddenCount: number;
  total: number;
}

const byStartDesc = (a: LiveAgent, b: LiveAgent) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "");

export function groupAgents(data: SessionAgentsLiveResponse, showHidden: boolean): AgentGroups {
  const active: LiveAgent[] = [];
  const finished: LiveAgent[] = [];
  const byRun = new Map<string, LiveAgent[]>();
  let hiddenCount = 0;
  for (const a of data.agents) {
    if (a.status === "running") {
      active.push(a);
      continue;
    }
    // Hiding only applies in the archive — in the current run every agent stays visible.
    if (a.runId === data.currentRunId) {
      finished.push(a);
      continue;
    }
    if (a.hidden && !showHidden) {
      hiddenCount++;
      continue;
    }
    byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  }
  const archive = data.runs.filter((r) => !r.current && byRun.has(r.id)).map((run) => ({ run, agents: (byRun.get(run.id) ?? []).sort(byStartDesc) }));
  return { active: active.sort(byStartDesc), finished: finished.sort(byStartDesc), archive, hiddenCount, total: data.agents.length };
}

/** "850", "45,2k", "1,23 Mio." (English "45.2k", "1.23M") — like Claude Code in the terminal. */
export function formatTokensShort(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toLocaleString(locale(), { maximumFractionDigits: n < 100_000 ? 1 : 0 })}k`;
  return t("{n} Mio.", { n: (n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 2 }) });
}

/** Cost in the number format of the language ("0,42 $" / "$0.42"); `null` without a price. */
export function formatCostUsd(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  const fmt = new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return usd < 0.01 ? `< ${fmt.format(0.01)}` : fmt.format(usd);
}

export function statusMeta(status: LiveAgentStatus): { label: string; hint: string; color: string } {
  switch (status) {
    case "running":
      return { label: t("läuft"), hint: t("Arbeitet gerade."), color: "var(--a-ok)" };
    case "done":
      return { label: t("fertig"), hint: t("Hat seinen Bericht bzw. seine Schlussantwort abgegeben."), color: "var(--a-done)" };
    case "stopped":
      return { label: t("ohne Abschluss"), hint: t("Hat kein Ergebnis abgegeben — die Session wurde beendet oder der Agent ist lange still."), color: "var(--a-wait)" };
  }
}

/** Color per agent type (the same as on the tiles of the Agents tab); Codex teammates in the Codex color. */
export function agentColor(a: Pick<LiveAgent, "tool" | "type" | "name">): string {
  if (a.tool === "codex") return "var(--a-codex)";
  return agentPaletteColor(a.type ?? a.name ?? "agent");
}

export function agentLabel(a: Pick<LiveAgent, "name" | "type" | "tool">): string {
  return a.name ?? a.type ?? (a.tool === "codex" ? tc("agent", "Codex-Helfer") : t("Sub-Agent"));
}

export function monogram(label: string): string {
  const parts = label.split(/[-_\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : label.slice(0, 2);
  return letters.toUpperCase();
}

/** "running", "done" with counts — text of the bar at the bottom of the chat. */
export function barSummary(g: Pick<AgentGroups, "active" | "finished" | "archive">): string {
  const n = g.active.length;
  const f = g.finished.length;
  if (n === 0 && f === 0) {
    const old = g.archive.reduce((s, x) => s + x.agents.length, 0);
    return old === 1 ? t("1 Agent aus früheren Läufen") : t("{n} Agenten aus früheren Läufen", { n: old });
  }
  if (n === 0) return f === 1 ? t("1 Agent fertig") : t("{n} Agenten fertig", { n: f });
  const active = n === 1 ? t("1 Agent aktiv") : t("{n} Agenten aktiv", { n });
  return f > 0 ? `${active} · ${t("{n} fertig", { n: f })}` : active;
}

export interface SessionRef {
  id: string;
  art: string;
  baustelle: { slug: string } | null;
}

/** Full-screen route of the agents of a session (optionally one agent directly). */
export function agentsPageHref(s: SessionRef, agentId?: string | null): string {
  const base = `/sessions/${encodeURIComponent(s.art)}/${encodeURIComponent(s.baustelle?.slug ?? "_")}/${encodeURIComponent(s.id)}/agenten`;
  return agentId ? `${base}/${encodeURIComponent(agentId)}` : base;
}

export function chatHref(s: SessionRef): string {
  return `/sessions/${encodeURIComponent(s.art)}/${encodeURIComponent(s.baustelle?.slug ?? "_")}/${encodeURIComponent(s.id)}`;
}

const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timeZone() });

/** "Lauf von 14:32" or "Lauf vom 27.09., 14:32" (other day). */
export function runLabel(run: AgentRunInfo, now: number): string {
  if (!run.startedAt) return t("Vor der ersten Nachricht");
  const d = new Date(run.startedAt);
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
  if (dayKey(new Date(now)) === dayKey(d)) return t("Lauf von {time}", { time });
  return t("Lauf vom {day}, {time}", { day: d.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", timeZone: timeZone() }), time });
}
