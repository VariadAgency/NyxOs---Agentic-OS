import { t } from "@nyxos/shared";
import { Link } from "react-router";
import type { RelatedSameFile, Session, SessionDetail } from "../../lib/api";
import { BAUSTELLE_NONE } from "../../hooks/useSessionsRoute";
import { useRelatedSessions } from "../../hooks/useSessionApi";
import { artLabel } from "../../lib/arts";
import { stateMeta } from "../../lib/stateMeta";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ToolTag } from "./ToolTag";
import { useSessionOutcomes } from "../../features/session-panels/api";
import { OutcomeList, SimilarList } from "../../features/session-panels/Outcomes";
import { lazy, Suspense } from "react";
import { sessionLabel } from "../../lib/sessionLabel";
const LocalGraph = lazy(() => import("../../features/brain/LocalGraph").then((m) => ({ default: m.LocalGraph })));

function sessionHref(session: { art: string; baustelle: { slug: string } | null; sessionKey: string }): string {
  return `/sessions/${session.art}/${session.baustelle?.slug ?? BAUSTELLE_NONE}/${session.sessionKey}`;
}

function StatusDot({ state }: { state: Session["state"] }) {
  const meta = stateMeta(state);
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />;
}

function Row({ session }: { session: Session }) {
  return (
    <Link
      to={sessionHref({ art: session.art, baustelle: session.baustelle, sessionKey: session.id })}
      className="flex items-center gap-2 rounded border border-a-line bg-a-p2 px-2.5 py-1.5 text-caption hover:bg-a-p3"
    >
      <StatusDot state={session.state} />
      <span className="min-w-0 flex-1 truncate text-a-ink">{sessionLabel(session)}</span>
      <ToolTag tool={session.tool} />
    </Link>
  );
}

function SameFileRow({ hit }: { hit: RelatedSameFile }) {
  return (
    <Link
      to={sessionHref({ art: hit.art, baustelle: hit.baustelle, sessionKey: hit.sessionKey })}
      className="grid min-w-0 gap-1 rounded border border-a-line bg-a-p2 px-2.5 py-1.5 text-caption hover:bg-a-p3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state={hit.state} />
        <span className="min-w-0 flex-1 truncate text-a-ink">{sessionLabel(hit)}</span>
        <ToolTag tool={hit.tool} />
        <span className="rounded border border-a-line px-1.5 font-mono text-label text-a-mut">{artLabel(hit.art)}</span>
      </div>
      <div className="min-w-0 truncate font-mono text-label text-a-mut" title={hit.sharedFiles.join(", ")}>
        {t(hit.sharedCount === 1 ? "{n} gemeinsame Datei: {files}" : "{n} gemeinsame Dateien: {files}", { n: hit.sharedCount, files: hit.sharedFiles.join(", ") })}
        {hit.sharedCount > hit.sharedFiles.length ? " …" : ""}
      </div>
    </Link>
  );
}

/** Erledigt / erfolgreich behoben / offen geblieben / vergleichbar — eigener Abruf, damit die
 * bisherigen Listen (Eltern/Kind/gleiche Dateien) nicht darauf warten müssen. */
function Outcomes({ sessionId }: { sessionId: string }) {
  const q = useSessionOutcomes(sessionId);
  if (q.isPending) {
    return (
      <div className="grid gap-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-9" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="grid justify-items-start gap-2 text-caption">
        <p className="text-a-bad">{t("Erledigt/Behoben/Vergleichbar konnten nicht geladen werden.")}</p>
        <Button onClick={() => q.refetch()}>{t("Erneut versuchen")}</Button>
      </div>
    );
  }
  const { done, fixed, open, similar, stats } = q.data;
  return (
    <div className="grid min-w-0 gap-4" data-testid="refs-outcomes">
      <p className="text-caption text-a-mut" data-testid="refs-stats">
        {t(stats.commits === 1 ? "{n} Commit" : "{n} Commits", { n: stats.commits })} · {t(stats.testRuns === 1 ? "{n} Testlauf" : "{n} Testläufe", { n: stats.testRuns })} · {t("{done} von {total} Agenten fertig", { done: stats.agentsFinished, total: stats.agentsTotal })}
      </p>
      <OutcomeList testId="refs-done" title={t("Erledigt")} items={done} sessionId={sessionId} empty={t("Noch nichts belegbar erledigt (keine abgehakte Aufgabe, kein Commit, kein fertiger Agent).")} />
      <OutcomeList
        testId="refs-fixed"
        title={t("Erfolgreich behoben")}
        items={fixed}
        sessionId={sessionId}
        showConfidence
        empty={t("Kein behobener Fehler erkannt (kein erledigter Bug-Eintrag, kein „fix“-Commit, kein Test rot → grün).")}
      />
      <OutcomeList testId="refs-open" title={t("Offen geblieben")} items={open} sessionId={sessionId} empty={t("Nichts offen — keine unerledigte Aufgabe, kein roter Test, kein blockierender Prüfer.")} />
      <SimilarList items={similar} />
    </div>
  );
}

/**
 * Reiter „Bezüge": Eltern-/Kind-Session und Sessions mit gemeinsam geschriebenen Dateien,
 * beides jetzt vom Server (`GET /api/sessions/:id/related`) — vorher nur Eltern/Kind aus der schon
 * geladenen Liste, „gemeinsame Dateien" war ein offener Punkt (kein Endpunkt).
 */
export function RefsPanel({ detail }: { detail: SessionDetail }) {
  const relatedQuery = useRelatedSessions(detail.session.id);

  if (relatedQuery.isPending) {
    return (
      <div className="grid gap-2 p-3">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10" />
        ))}
      </div>
    );
  }

  if (relatedQuery.isError) {
    return (
      <div className="grid justify-items-start gap-2 p-3 text-caption">
        <p className="text-a-bad">{t("Bezüge konnten nicht geladen werden.")}</p>
        <Button onClick={() => relatedQuery.refetch()}>{t("Erneut versuchen")}</Button>
      </div>
    );
  }

  const { parent, children, sameFiles } = relatedQuery.data;

  return (
    // Eigener Scroll-Bereich — mit den neuen Listen ist der Reiter länger als die Kachel.
    <div className="cc-scroll grid h-full min-w-0 content-start gap-4 overflow-y-auto p-3" role="tabpanel" aria-label={t("Bezüge")}>
      {/* Lokaler Graph (Tiefe 1–3) oben, Listen darunter bleiben unverändert. */}
      <Suspense fallback={<Skeleton className="h-[340px]" />}>
        <LocalGraph nodeId={`session:${detail.session.id}`} />
      </Suspense>
      <Outcomes sessionId={detail.session.id} />
      <div>
        <h5 className="mb-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{t("Eltern-Session")}</h5>
        {parent ? <Row session={parent} /> : <p className="text-label text-a-mut">{t("Keine — das ist eine Haupt-Session.")}</p>}
      </div>
      <div>
        <h5 className="mb-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{t("Kind-Sessions ({n})", { n: children.length })}</h5>
        {children.length === 0 ? (
          <p className="text-label text-a-mut">{t("Keine.")}</p>
        ) : (
          <div className="grid gap-1">
            {children.map((c) => (
              <Row key={c.id} session={c} />
            ))}
          </div>
        )}
      </div>
      <div>
        <h5 className="mb-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">
          {t("Dieselben Dateien geschrieben ({n})", { n: sameFiles.length })}
        </h5>
        {sameFiles.length === 0 ? (
          <p className="text-label text-a-mut">{t("Keine — diese Session teilt keine geschriebene Datei mit einer anderen.")}</p>
        ) : (
          <div className="grid gap-1">
            {sameFiles.map((hit) => (
              <SameFileRow key={hit.sessionKey} hit={hit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
