// Bezüge — „Erledigt", „Erfolgreich behoben", „Offen geblieben", „Vergleichbare
// Sessions". Jede Zeile ist anklickbar: Einträge öffnen ihre Großansicht, Sessions die Session,
// Agenten klappen ihre große Kachel auf, alles andere zeigt beim Aufklappen, woher der Treffer stammt.
import { useState } from "react";
import { Link } from "react-router";
import { t, type OutcomeConfidence, type OutcomeItem, type OutcomeKind, type SimilarSession } from "@nyxos/shared";
import { BAUSTELLE_NONE } from "../../hooks/useSessionsRoute";
import { artLabel } from "../../lib/arts";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { stateMeta } from "../../lib/stateMeta";
import { ToolTag } from "../../components/sessions/ToolTag";
import { AgentDetailBody } from "./AgentTile";
import { sessionLabel } from "../../lib/sessionLabel";

export const OUTCOME_PREVIEW = 6;

const KIND: Record<OutcomeKind, { label: string; dot: string }> = {
  todo: { label: t("Aufgabe"), dot: "bg-a-lime" },
  agent: { label: t("Agent"), dot: "bg-a-violet" },
  commit: { label: t("Commit"), dot: "bg-a-indigo" },
  entry: { label: t("Eintrag"), dot: "bg-a-acc" },
  subtask: { label: t("Teilaufgabe"), dot: "bg-a-acc" },
  test: { label: t("Test"), dot: "bg-a-wait" },
};

const CONFIDENCE: Record<OutcomeConfidence, { label: string; cls: string; hint: string }> = {
  sicher: { label: t("sicher"), cls: "bg-a-ok/12 text-a-ok", hint: t("Direkt belegt (Eintrag, abgehakte Aufgabe, Commit)") },
  wahrscheinlich: { label: t("wahrscheinlich"), cls: "bg-a-wait/12 text-a-wait", hint: t("Aus Commit-Nachricht oder Agenten-Ergebnis abgeleitet") },
  moeglich: { label: t("möglich"), cls: "bg-a-conf/12 text-a-conf", hint: t("Nur aus dem Verlauf erkannt (z. B. Test erst rot, dann grün)") },
};

export function ConfidencePill({ confidence }: { confidence: OutcomeConfidence }) {
  const c = CONFIDENCE[confidence];
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-px text-label font-medium", c.cls)} title={c.hint}>
      {c.label}
    </span>
  );
}

function OutcomeRow({ item, sessionId, showConfidence }: { item: OutcomeItem; sessionId: string; showConfidence: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = KIND[item.kind];
  const head = (
    <>
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", kind.dot)} />
      <span className="w-[74px] shrink-0 font-mono text-label text-a-mut">{kind.label}</span>
      <span className="min-w-0 flex-1 truncate text-a-ink">{item.title}</span>
      {showConfidence && <ConfidencePill confidence={item.confidence} />}
      {item.ts && <span className="hidden shrink-0 text-label text-a-mut sm:inline">{relativeTime(item.ts)}</span>}
    </>
  );
  const rowCls = "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-caption hover:bg-a-p3";

  if (item.link?.type === "entry") {
    return (
      <Link to={`/tasks?e=${item.link.id}`} className={cn(rowCls, "border border-a-line bg-a-p2")} title={item.why}>
        {head}
      </Link>
    );
  }
  if (item.link?.type === "session") {
    return (
      <Link to={`/sessions/${item.link.art}/${item.link.baustelle?.slug ?? BAUSTELLE_NONE}/${item.link.sessionKey}`} className={cn(rowCls, "border border-a-line bg-a-p2")} title={item.why}>
        {head}
      </Link>
    );
  }
  return (
    <div className={cn("min-w-0 rounded border border-a-line bg-a-p2", open && "border-a-acc/50")}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={rowCls}>
        {head}
      </button>
      {open && (
        <div className="grid gap-1.5 border-t border-a-line px-3 py-2 text-caption">
          <p className="text-a-mut">
            <span className="text-a-ink">{t("Warum hier:")}</span> {item.why}
          </p>
          {item.detail && <p className="break-words font-mono text-label text-a-ink">{item.detail}</p>}
          {item.ts && <p className="text-a-mut">{formatDateTime(item.ts)}</p>}
          {item.link?.type === "agent" && (
            <div className="mt-1 rounded-md border border-a-line bg-a-p p-3">
              <AgentDetailBody sessionId={sessionId} agentId={item.link.id} sessionHref={null} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OutcomeList({
  title,
  items,
  empty,
  sessionId,
  showConfidence = false,
  testId,
}: {
  title: string;
  items: OutcomeItem[];
  empty: string;
  sessionId: string;
  showConfidence?: boolean;
  testId: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, OUTCOME_PREVIEW);
  return (
    <section data-testid={testId} className="min-w-0">
      <h5 className="mb-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">
        {title} ({items.length})
      </h5>
      {items.length === 0 ? (
        <p className="text-label text-a-mut">{empty}</p>
      ) : (
        <div className="grid min-w-0 gap-1">
          {shown.map((item) => (
            <OutcomeRow key={item.id} item={item} sessionId={sessionId} showConfidence={showConfidence} />
          ))}
        </div>
      )}
      {items.length > OUTCOME_PREVIEW && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 rounded px-1.5 py-0.5 text-caption font-medium text-a-acc hover:bg-a-p2" aria-expanded={all}>
          {all ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: items.length })}
        </button>
      )}
    </section>
  );
}

function SimilarRow({ hit }: { hit: SimilarSession }) {
  const meta = stateMeta(hit.state as Parameters<typeof stateMeta>[0]);
  return (
    <Link
      to={`/sessions/${hit.art}/${hit.baustelle?.slug ?? BAUSTELLE_NONE}/${hit.sessionKey}`}
      className="grid min-w-0 gap-1 rounded border border-a-line bg-a-p2 px-2.5 py-1.5 text-caption hover:bg-a-p3"
      title={hit.sharedFiles.length ? t("Gemeinsame Dateien: {files}", { files: hit.sharedFiles.join(", ") }) : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
        <span className="min-w-0 flex-1 truncate text-a-ink">{sessionLabel(hit)}</span>
        <ToolTag tool={hit.tool} />
        <span className="rounded border border-a-line px-1.5 font-mono text-label text-a-mut">{artLabel(hit.art)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {hit.reasons.map((r) => (
          <span key={r} className="max-w-full truncate rounded bg-a-indigo/12 px-1.5 text-label text-a-indigo">
            {r}
          </span>
        ))}
        {hit.lastActivityAt && <span className="text-label text-a-mut">{relativeTime(hit.lastActivityAt)}</span>}
      </div>
    </Link>
  );
}

export function SimilarList({ items }: { items: SimilarSession[] }) {
  return (
    <section data-testid="refs-similar" className="min-w-0">
      <h5 className="mb-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{t("Vergleichbare Sessions ({n})", { n: items.length })}</h5>
      {items.length === 0 ? (
        <p className="text-label text-a-mut">{t("Keine — keine andere Session teilt Dateien oder ein ähnliches Thema.")}</p>
      ) : (
        <div className="grid min-w-0 gap-1">
          {items.map((hit) => (
            <SimilarRow key={hit.sessionKey} hit={hit} />
          ))}
        </div>
      )}
    </section>
  );
}
