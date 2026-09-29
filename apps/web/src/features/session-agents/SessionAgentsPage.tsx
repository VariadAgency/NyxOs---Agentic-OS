// Agents of a session in full screen (`/sessions/:art/:baustelle/:id/agenten[/:agentId]`) — the same view as the popup
// in the chat, only large; meant for many agents running at once. "Back to the chat" leads into the session.
import { t } from "@nyxos/shared";
import { Link, useNavigate, useParams } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { PageShell } from "../../components/PageShell";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useSessionDetail } from "../../hooks/useSessionApi";
import { sessionLabel } from "../../lib/sessionLabel";
import { AgentDetailLive } from "./AgentDetailLive";
import { AgentsOverview } from "./AgentsOverview";
import { useSessionAgentsLive } from "./api";
import { agentsPageHref, barSummary, chatHref, groupAgents, type SessionRef } from "./model";

export function SessionAgentsPage() {
  const params = useParams<{ art: string; baustelle: string; id: string; agentId?: string }>();
  const navigate = useNavigate();
  const id = params.id ?? "";
  const ref: SessionRef = { id, art: params.art ?? "_", baustelle: params.baustelle && params.baustelle !== "_" ? { slug: params.baustelle } : null };
  const detail = useSessionDetail(id || null);
  const q = useSessionAgentsLive(id);
  const agentId = params.agentId ?? null;
  const title = detail.data ? sessionLabel(detail.data.session) : t("Session");
  const back = (
    <Link to={chatHref(ref)} className="inline-flex min-h-[44px] items-center rounded-md border border-a-line bg-a-p3 px-3 text-caption text-a-ink hover:bg-a-p2 sm:min-h-(--a-ctl-h)">
      {t("← Zurück zum Chat")}
    </Link>
  );

  return (
    <PageShell gap="gap-4">
      <PageHeader
        title={t("Agenten")}
        sub={
          <>
            <span className="text-a-ink">{title}</span>
            {q.data && q.data.agents.length > 0 && ` · ${barSummary(groupAgents(q.data, false))}`}
          </>
        }
        actions={back}
      />
      {q.isPending ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="grid justify-items-start gap-2">
          <p className="text-caption text-a-bad">{t("Die Agenten konnten nicht geladen werden.")}</p>
          <Button onClick={() => void q.refetch()}>{t("Erneut versuchen")}</Button>
        </div>
      ) : q.data.agents.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-a-line p-6 text-center text-callout text-a-mut">{t("Diese Session hat keine Agenten gestartet.")}</p>
      ) : (
        <div className="mx-auto grid w-full max-w-[960px] min-w-0">
          {agentId ? (
            <AgentDetailLive session={ref} agentId={agentId} childKeys={q.data.childKeys} onBack={() => navigate(agentsPageHref(ref))} />
          ) : (
            <AgentsOverview session={ref} data={q.data} onOpenAgent={(a) => navigate(agentsPageHref(ref, a))} />
          )}
        </div>
      )}
    </PageShell>
  );
}
