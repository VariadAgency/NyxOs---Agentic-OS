import { useState } from "react";
import { formatTokensCompact, type SessionAgentSummary, t } from "@nyxos/shared";
import type { SessionDetail, Session } from "../../lib/api";
import { BAUSTELLE_NONE } from "../../hooks/useSessionsRoute";
import { useSessions } from "../../hooks/useSessions";
import { useSessionAgents } from "../../features/session-panels/api";
import { AgentTile } from "../../features/session-panels/AgentTile";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

function hrefFor(key: string, sessions: Session[] | undefined): string | null {
  const s = sessions?.find((x) => x.id === key);
  if (!s) return null;
  return `/sessions/${s.art}/${s.baustelle?.slug ?? BAUSTELLE_NONE}/${s.id}`;
}

/**
 * Reiter „Agenten": eine Kachel je Sub-Agent (Claude) bzw. Kind-Session (Codex), neueste
 * zuerst. Klick vergrößert die Kachel in der Seite: Auftrag, Ergebnis, Tokens, Dauer, Werkzeuge,
 * geänderte Dateien — alles aus dem Verlauf des Agenten.
 */
export function AgentsPanel({ detail }: { detail: SessionDetail }) {
  const sessionId = detail.session.id;
  const agentsQuery = useSessionAgents(sessionId);
  const sessions = useSessions();
  const [openId, setOpenId] = useState<string | null>(null);

  if (agentsQuery.isPending) {
    return (
      <div className="grid gap-1.5 p-3">
        {[0, 1, 2].map((r) => (
          <Skeleton key={r} className="h-14" />
        ))}
      </div>
    );
  }
  if (agentsQuery.isError) {
    return (
      <div className="grid justify-items-start gap-2 p-3 text-caption">
        <p className="text-a-bad">{t("Die Agenten konnten nicht geladen werden.")}</p>
        <Button onClick={() => agentsQuery.refetch()}>{t("Erneut versuchen")}</Button>
      </div>
    );
  }
  const agents: SessionAgentSummary[] = agentsQuery.data.agents;
  if (agents.length === 0) {
    return <div className="p-4 text-caption text-a-mut">{t("Keine Sub-Agenten in dieser Session.")}</div>;
  }
  const tokens = agents.reduce((sum, a) => sum + (a.tokens?.total ?? 0), 0);
  const finished = agents.filter((a) => a.hasTranscript).length;

  return (
    // Eigener Scroll-Bereich: bei ~100 Agenten ist die Liste viel länger als die Kachel.
    <div className="cc-scroll grid h-full min-w-0 content-start gap-2 overflow-y-auto p-3" role="tabpanel" aria-label={t("Agenten")}>
      <p className="text-caption text-a-mut">
        {t(agents.length === 1 ? "{n} Agent" : "{n} Agenten", { n: agents.length })} · {t("{tokens} Tokens zusammen", { tokens: formatTokensCompact(tokens) })}
        {finished < agents.length && ` · ${t("{n} ohne Verlauf", { n: agents.length - finished })}`} · {t("Klick auf eine Kachel zeigt Auftrag und Ergebnis.")}
      </p>
      {agents.map((agent) => (
        <AgentTile
          key={agent.id}
          sessionId={sessionId}
          agent={agent}
          open={openId === agent.id}
          onToggle={() => setOpenId((id) => (id === agent.id ? null : agent.id))}
          sessionHref={agent.sessionKey ? hrefFor(agent.sessionKey, sessions.data) : null}
        />
      ))}
    </div>
  );
}
