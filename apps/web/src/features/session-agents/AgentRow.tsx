// One agent row in the style of the tiles of the Agents tab — monogram in the agent color, name/type, task in one
// line, status; to the right the elapsed time (ticking) and tokens (+ cost). The whole row is clickable.
import { agentElapsedMs, formatAgentElapsed, locale, t, type LiveAgent } from "@nyxos/shared";
import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { agentColor, agentLabel, formatCostUsd, formatTokensShort, monogram, statusMeta } from "./model";

export function StatusPill({ agent }: { agent: Pick<LiveAgent, "status" | "verdict"> }) {
  const s = statusMeta(agent.status);
  const label = agent.status === "done" && agent.verdict ? (agent.verdict === "PASS_WITH_NOTES" ? t("PASS mit Hinweisen") : agent.verdict) : s.label;
  const color = agent.verdict === "BLOCK" ? "var(--a-bad)" : agent.verdict === "PASS_WITH_NOTES" ? "var(--a-wait)" : s.color;
  return (
    <span title={s.hint} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium whitespace-nowrap" style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", agent.status === "running" && "cc-pulse")} style={{ background: color }} />
      {label}
    </span>
  );
}

export function AgentAvatar({ agent, size = 32 }: { agent: LiveAgent; size?: number }) {
  const color = agentColor(agent);
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-xl font-display text-caption font-semibold"
      style={{ width: size, height: size, background: `color-mix(in srgb, ${color} 20%, var(--a-p2))`, color }}
    >
      {monogram(agentLabel(agent))}
    </span>
  );
}

export function AgentRow({ agent, now, onOpen, index = 0 }: { agent: LiveAgent; now: number; onOpen: () => void; index?: number }) {
  const running = agent.status === "running";
  const tokens = agent.tokens ? formatTokensShort(agent.tokens.total) : null;
  const cost = formatCostUsd(agent.costUsd);
  const label = agentLabel(agent);
  const typeChip = agent.type && agent.type !== label ? agent.type : agent.tool === "codex" ? "Codex" : null;
  const tokenTitle = agent.tokens
    ? `${t("{n} Tokens", { n: agent.tokens.total.toLocaleString(locale()) })}${agent.model ? ` · ${agent.model}` : ""}`
    : t("Noch keine Token-Angabe");
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`agent-row-${agent.id}`}
      style={{ "--c": agentColor(agent), animationDelay: `${Math.min(index, 8) * 25}ms` } as CSSProperties}
      className={cn(
        "cc-stagger grid min-h-[56px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors duration-150 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc",
        running ? "border-(--c)/35 bg-a-p2/40" : "border-a-line",
        agent.hidden && "opacity-60",
      )}
    >
      <AgentAvatar agent={agent} />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-callout font-medium text-a-ink">{label}</span>
          {typeChip && <span className="hidden shrink-0 rounded bg-a-p3 px-1.5 py-px text-label text-a-mut sm:inline">{typeChip}</span>}
          <StatusPill agent={agent} />
        </span>
        {agent.task && <span className="truncate text-caption text-a-mut">{agent.task}</span>}
        {running && agent.lastAction && (
          <span className="truncate font-mono text-label text-a-mut">
            <span className="text-a-ink">{agent.lastAction.tool ?? t("schreibt")}</span>
            {agent.lastAction.label && ` · ${agent.lastAction.label}`}
          </span>
        )}
      </span>
      <span className="grid justify-items-end gap-0.5 text-right">
        <span data-testid="agent-elapsed" className={cn("font-mono text-caption tabular-nums", running ? "text-a-ink" : "text-a-mut")} title={t("Laufzeit")}>
          {formatAgentElapsed(agentElapsedMs(agent, now))}
        </span>
        <span className="font-mono text-label whitespace-nowrap tabular-nums text-a-mut" title={tokenTitle}>
          {tokens ? t("{n} Tok.", { n: tokens }) : "—"}
          {cost && <span className="hidden sm:inline"> · {cost}</span>}
        </span>
      </span>
    </button>
  );
}
