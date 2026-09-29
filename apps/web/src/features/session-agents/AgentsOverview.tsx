// List of the agents of a session — tabs "This run" (active + done) and "Archive" (earlier runs, grouped by run).
// The same view in the chat popup and in full screen; a click opens the agent in detail.
import { AGENTS_FULLSCREEN_SUGGEST_AT, quote, t, type SessionAgentsLiveResponse } from "@nyxos/shared";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { AgentRow } from "./AgentRow";
import { useNow } from "./api";
import { agentsPageHref, groupAgents, runLabel, type SessionRef } from "./model";

type View = "lauf" | "archiv";

function Heading({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h3 className="flex items-center gap-2 font-mono text-label font-semibold tracking-wider text-a-mut uppercase">
      {children}
      <span className="rounded-full bg-a-p3 px-1.5 py-0.5 text-label tabular-nums">{count}</span>
    </h3>
  );
}

interface AgentsOverviewProps {
  session: SessionRef;
  data: SessionAgentsLiveResponse;
  onOpenAgent: (id: string) => void;
  /** Popup: show the full-screen suggestion. */
  inPopup?: boolean;
}

export function AgentsOverview({ session, data, onOpenAgent, inPopup }: AgentsOverviewProps) {
  const [showHidden, setShowHidden] = useState(false);
  const g = groupAgents(data, showHidden);
  const archiveCount = g.archive.reduce((s, x) => s + x.agents.length, 0);
  const [view, setView] = useState<View>(() => (g.active.length === 0 && g.finished.length === 0 && archiveCount > 0 ? "archiv" : "lauf"));
  const now = useNow(g.active.length > 0);
  const currentRun = data.runs.find((r) => r.id === data.currentRunId) ?? null;

  const baseId = useId();
  const tab = (id: View, label: string, n: number) => (
    <button
      type="button"
      role="tab"
      id={`${baseId}-${id}-tab`}
      aria-selected={view === id}
      aria-controls={`${baseId}-${id}`}
      tabIndex={view === id ? 0 : -1}
      onClick={() => setView(id)}
      onKeyDown={(e) => {
        // Arrow keys switch the tab (two tabs: either direction toggles).
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next: View = view === "lauf" ? "archiv" : "lauf";
        setView(next);
        document.getElementById(`${baseId}-${next}-tab`)?.focus();
      }}
      className={cn("inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-3 text-caption sm:min-h-8", view === id ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
    >
      {label}
      <span className="font-mono tabular-nums">{n}</span>
    </button>
  );

  return (
    <div className="grid min-w-0 content-start gap-3">
      {inPopup && g.active.length >= AGENTS_FULLSCREEN_SUGGEST_AT && (
        <div data-testid="fullscreen-hint" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-a-acc/35 bg-a-acc/8 px-3 py-2 text-caption text-a-ink">
          <span>{t("{n} Agenten laufen gleichzeitig – im Vollbild behältst du den Überblick.", { n: g.active.length })}</span>
          <Link to={agentsPageHref(session)} className="inline-flex min-h-[44px] items-center rounded-md bg-a-primary px-2.5 font-semibold text-a-on-primary sm:min-h-8">
            {t("Im Vollbild öffnen")}
          </Link>
        </div>
      )}

      <div role="tablist" aria-label={t("Agenten-Ansicht")} className="flex gap-1 border-b border-a-line pb-1.5">
        {tab("lauf", t("Dieser Lauf"), g.active.length + g.finished.length)}
        {tab("archiv", t("Archiv"), archiveCount)}
      </div>

      {view === "lauf" ? (
        <div role="tabpanel" id={`${baseId}-lauf`} aria-labelledby={`${baseId}-lauf-tab`} className="grid gap-4">
          <section aria-label={t("Aktiv")} className="grid gap-1.5">
            <Heading count={g.active.length}>{t("Aktiv")}</Heading>
            {g.active.length === 0 ? (
              <p className="px-1 text-caption text-a-mut">{t("Gerade läuft kein Agent.")}</p>
            ) : (
              <div className="grid gap-1.5">
                {g.active.map((a, i) => (
                  <AgentRow key={a.id} agent={a} now={now} index={i} onOpen={() => onOpenAgent(a.id)} />
                ))}
              </div>
            )}
          </section>
          <section aria-label={t("Fertig in diesem Lauf")} className="grid gap-1.5">
            <Heading count={g.finished.length}>{t("Fertig in diesem Lauf")}</Heading>
            {currentRun?.prompt && (
              <p className="truncate px-1 text-caption text-a-mut" title={currentRun.prompt}>
                {quote(currentRun.prompt)}
              </p>
            )}
            {g.finished.length === 0 ? (
              <p className="px-1 text-caption text-a-mut">{t("In diesem Lauf ist noch kein Agent fertig.")}</p>
            ) : (
              <div className="grid gap-1.5">
                {g.finished.map((a, i) => (
                  <AgentRow key={a.id} agent={a} now={now} index={i} onOpen={() => onOpenAgent(a.id)} />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div role="tabpanel" id={`${baseId}-archiv`} aria-labelledby={`${baseId}-archiv-tab`} className="grid gap-4">
          {g.archive.length === 0 ? (
            <p className="px-1 text-caption text-a-mut">{t("Keine Agenten aus früheren Läufen.")}</p>
          ) : (
            g.archive.map(({ run, agents }) => (
              <section key={run.id} aria-label={runLabel(run, now)} className="grid gap-1.5">
                <h3 className="grid gap-0.5 px-1">
                  <span className="font-mono text-label font-semibold tracking-wider text-a-mut uppercase">
                    {runLabel(run, now)} · {agents.length === 1 ? t("1 Agent") : t("{n} Agenten", { n: agents.length })}
                  </span>
                  {run.prompt && (
                    <span className="truncate text-caption text-a-mut" title={run.prompt}>
                      {quote(run.prompt)}
                    </span>
                  )}
                </h3>
                <div className="grid gap-1.5">
                  {agents.map((a, i) => (
                    <AgentRow key={a.id} agent={a} now={now} index={i} onOpen={() => onOpenAgent(a.id)} />
                  ))}
                </div>
              </section>
            ))
          )}
          {(g.hiddenCount > 0 || showHidden) && (
            <button type="button" onClick={() => setShowHidden((v) => !v)} className="min-h-[44px] justify-self-start rounded-md px-2 text-caption text-a-mut hover:bg-a-p2 hover:text-a-ink sm:min-h-8">
              {showHidden ? t("Ausgeblendete wieder verstecken") : t("Ausgeblendete zeigen ({n})", { n: g.hiddenCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
