// Entscheidungs-Inbox, Route `/inbox`. Karten untereinander: zuerst Freigabe-Anfragen,
// dann Eskalationen, Fragen, Pläne. Nach einer Antwort blendet die Karte aus, der Toast nennt, wohin
// die Antwort ging (Session, ENTSCHEIDUNGEN.md). Erledigtes eingeklappt.
// Klick auf eine Karte (nicht auf ihre Knöpfe) öffnet die Großansicht `/inbox#inbox-<id>` bzw.
// `/inbox#approval-<id>` (teilbar, Esc/Zurück schließt). „Nyx fragen“ an JEDER Karte und jeder erledigten Zeile.
import { type Approval, bundleInboxItems, GUARD_RULE_LABELS, type InboxItem, t, tc } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime, shortenPath } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { fetchApprovals, fetchInbox } from "../haiku/haikuApi";
import { ErrorBox, SourceChips, ToastView, riseStyle, useToast } from "../haiku/ui";
import { ApprovalActions, QuestionActions, SortActions } from "./DecisionActions";
import { DecisionDetail } from "./DecisionDetail";
import { NyxAskChip, NyxSummaryPanel, useDecisionNyx } from "./DecisionNyx";
import {
  answerLabel,
  APPROVAL_STATUS,
  cardClickOpens,
  CREATED_BY,
  type DecisionRef,
  decisionHash,
  decisionHref,
  ESCALATION_LABEL,
  KIND_LABEL,
  LEAVE_MS,
  parseDecisionHash,
  SessionName,
  sortReason,
} from "./decisionMeta";
import { useOpenQuestions } from "./useInbox";

export { deliveryText } from "./decisionMeta";

const KIND_ORDER: Record<InboxItem["kind"], number> = { eskalation: 0, frage: 1, plan: 2 };

/** Öffnet die Großansicht; `fromList` = „Zurück“ darf in der Verlaufsliste zurückgehen. */
function useOpenDecision() {
  const navigate = useNavigate();
  return (ref: DecisionRef) => navigate({ pathname: "/inbox", hash: decisionHash(ref) }, { state: { fromList: true } });
}

export function InboxView() {
  const approvals = useQuery({ queryKey: ["approvals", "all"], queryFn: () => fetchApprovals("all") });
  const inbox = useQuery({ queryKey: ["inbox", "all"], queryFn: () => fetchInbox("all") });
  const questions = useOpenQuestions();
  const toast = useToast(6000);
  const location = useLocation();
  const navigate = useNavigate();
  const detailRef = parseDecisionHash(location.hash);

  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  const open = (inbox.data ?? []).filter((i) => i.status === "open").sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt));
  const doneItems = (inbox.data ?? []).filter((i) => i.status !== "open");
  const doneApprovals = (approvals.data ?? []).filter((a) => a.status !== "pending");
  const doneCount = doneItems.length + doneApprovals.length;
  const loading = approvals.isLoading || inbox.isLoading;
  const loaded = approvals.isSuccess && inbox.isSuccess;
  // Offene Konflikt-Fragen gehören zu „Entscheidungen“ (nur du kannst sie beantworten);
  // die Karten selbst stehen auf der Konflikte-Seite. Zahl aus demselben Schnappschuss wie der Überblick.
  const conflictQuestions = questions.data?.conflicts ?? 0;
  // Gleiche Sortier-Vorschläge von Nyx = EINE Karte. Sie sind Kleinkram und zählen
  // nicht in „offen“ (wie `openQuestions.total` auf dem Server), sondern stehen ruhig darunter.
  const bundles = bundleInboxItems(open);
  const questionsOnly = bundles.flatMap((b) => (b.type === "item" ? [b.item] : []));
  const sortBundles = bundles.flatMap((b) => (b.type === "sort" ? [b] : []));
  const openTotal = pending.length + questionsOnly.length + conflictQuestions;
  const sortNote = sortBundles.length === 0 ? "" : ` · ${sortBundles.length === 1 ? t("{n} Sortier-Vorschlag", { n: 1 }) : t("{n} Sortier-Vorschläge", { n: sortBundles.length })}`;

  if (detailRef) {
    const close = () => {
      if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
      else navigate("/inbox", { replace: true });
    };
    return (
      <>
        <DecisionDetail
          key={decisionHash(detailRef)}
          target={detailRef}
          approvals={approvals.data ?? []}
          items={inbox.data ?? []}
          loading={loading}
          failed={approvals.isError || inbox.isError}
          onRetry={() => {
            void approvals.refetch();
            void inbox.refetch();
          }}
          onClose={close}
          onToast={toast.show}
        />
        <ToastView message={toast.message} />
      </>
    );
  }

  return (
    <div className="grid w-full min-w-0 content-start gap-4 p-4 md:p-6">
      <header className="grid gap-1">
        <h1 className="font-display text-title font-semibold text-a-ink">{t("Entscheidungen")}</h1>
        <p className="text-caption text-a-mut">
          {loaded ? `${openTotal > 0 ? t("{n} offen", { n: openTotal }) : t("Alles entschieden")}${sortNote}` : t("Freigaben, Fragen, Pläne, Eskalationen und Konflikte an einem Ort")}
        </p>
      </header>

      {loading && (
        <div className="grid gap-3" aria-label={t("Lädt")}>
          {[132, 132, 104].map((h, i) => (
            <div key={i} className="animate-pulse rounded-xl bg-a-p2 motion-reduce:animate-none" style={{ height: h }} />
          ))}
        </div>
      )}
      {(approvals.isError || inbox.isError) && (
        <ErrorBox
          text={t("Entscheidungen konnten nicht geladen werden.")}
          onRetry={() => {
            void approvals.refetch();
            void inbox.refetch();
          }}
        />
      )}

      {loaded && openTotal + sortBundles.length === 0 && (
        <div className="cc-card grid place-items-center gap-1 px-4 py-10 text-center">
          <p className="font-display text-headline text-a-ink">{t("Nichts zu entscheiden.")}</p>
          <p className="text-caption text-a-mut">{t("Neue Fragen und Freigaben erscheinen hier von selbst.")}</p>
        </div>
      )}

      {/* Volle Breite — ab 1600 px zwei Kartenspalten, damit der Platz genutzt statt gestreckt wird. */}
      <div data-testid="inbox-cards" className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3 min-[1600px]:grid-cols-2">
        {pending.map((a, i) => (
          <ApprovalCard key={`a-${a.id}`} approval={a} index={i} onToast={toast.show} />
        ))}
        {questionsOnly.map((item, i) => (
          <QuestionCard key={`i-${item.id}`} item={item} index={pending.length + i} onToast={toast.show} />
        ))}
        {conflictQuestions > 0 && <ConflictQuestionsCard count={conflictQuestions} index={pending.length + questionsOnly.length} />}
        {sortBundles.map((b, i) => (
          <SortCard key={b.key} target={b.target} subject={b.subject} items={b.items} index={pending.length + questionsOnly.length + 1 + i} onToast={toast.show} />
        ))}
      </div>

      {loaded && doneCount > 0 && (
        <details className="group min-w-0 rounded-xl border border-a-line bg-a-p/60">
          <summary className="cursor-pointer select-none px-4 py-2.5 font-mono text-caption text-a-mut hover:text-a-ink">{t("Erledigt ({n})", { n: doneCount })}</summary>
          <ul className="grid min-w-0 gap-0.5 px-2 pb-2">
            {doneApprovals.map((a) => (
              <DoneRow key={`a-${a.id}`} target={{ kind: "approval", id: a.id }} kindLabel={t("Freigabe")} title={a.command} mono status={APPROVAL_STATUS[a.status]} />
            ))}
            {doneItems.map((item) => (
              <DoneRow key={`i-${item.id}`} target={{ kind: "inbox", id: item.id }} kindLabel={KIND_LABEL[item.kind]} title={item.title} status={answerLabel(item)} />
            ))}
          </ul>
        </details>
      )}
      <ToastView message={toast.message} />
    </div>
  );
}

/** Erledigte Zeile: Titel führt zur Großansicht (nur lesen), daneben „Nyx fragen“. */
function DoneRow({ target, kindLabel, title, status, mono = false }: { target: DecisionRef; kindLabel: string; title: string; status: string; mono?: boolean }) {
  const nyx = useDecisionNyx(target.kind, target.id);
  return (
    <li className="grid min-w-0 gap-1.5 rounded-lg px-2.5 py-1.5 text-caption hover:bg-a-p2/60">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 font-mono text-label text-a-mut">{kindLabel}</span>
        <Link to={decisionHref(target)} state={{ fromList: true }} className={cn("min-w-0 flex-1 truncate text-a-ink underline-offset-2 hover:underline", mono && "font-mono")}>
          {title}
        </Link>
        <span className="max-w-[40%] shrink-0 truncate text-caption text-a-mut">{status}</span>
        <NyxAskChip nyx={nyx} compact />
      </div>
      <NyxSummaryPanel nyx={nyx} />
    </li>
  );
}

/** Sammelkarte: die Konflikt-Fragen selbst (A zuerst / B zuerst / pausieren) stehen auf der Konflikte-Seite. */
function ConflictQuestionsCard({ count, index }: { count: number; index: number }) {
  return (
    <article data-testid="inbox-conflicts" className="cc-card cc-rise grid min-w-0 gap-2.5 border-a-conf/35 p-4" style={riseStyle(index)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="rounded-full bg-a-conf/15 px-2 py-0.5 font-mono text-label font-semibold text-a-conf">{t("Konflikt")}</span>
        <h2 className="min-w-0 flex-1 font-display text-headline font-medium text-a-ink">
          {count === 1 ? t("1 Konflikt-Frage") : t("{n} Konflikt-Fragen", { n: count })}
        </h2>
      </div>
      <p className="text-callout leading-relaxed text-a-ink">{t("Laufende Sessions ändern gerade dieselben Dateien. Du entscheidest, wer zuerst darf – oder ob beide pausieren.")}</p>
      <Link to="/conflicts" className="justify-self-start rounded-lg border border-transparent bg-a-primary px-3.5 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110">
        {t("Zu den Konflikten")}
      </Link>
    </article>
  );
}

/** Klickbare Karte: Rahmen hebt sich beim Überfahren, der Titel ist der Tastatur-Weg zur Großansicht. */
const CLICKABLE = "cursor-pointer transition-colors duration-150 hover:border-a-acc/45";

function CardTitle({ target, children }: { target: DecisionRef; children: ReactNode }) {
  return (
    <h2 className="min-w-0 break-words font-display text-headline font-semibold text-a-ink">
      <Link to={decisionHref(target)} state={{ fromList: true }} className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc">
        {children}
      </Link>
    </h2>
  );
}

/**
 * EIN Sortier-Vorschlag für alle Sessions mit gleichem Wortlaut und Ziel. Ruhig
 * (graues Etikett, normale Knopfhöhe), Ja/Nein gilt für alle. Vorher: je Session eine Karte mit riesigen Flächen.
 */
function SortCard({ target, subject, items, index, onToast }: { target: string; subject: string; items: InboxItem[]; index: number; onToast: (m: string) => void }) {
  const [done, setDone] = useState(false);
  const openDecision = useOpenDecision();
  const first = items[0];
  const ref: DecisionRef = { kind: "inbox", id: first?.id ?? 0 };
  const nyx = useDecisionNyx("inbox", ref.id);
  const n = items.length;
  const title = n === 1 ? t("„{subject}“ nach „{target}“ sortieren?", { subject, target }) : t("{n} Sessions nach „{target}“ sortieren?", { n, target });
  const reason = sortReason(first?.body ?? null);

  return (
    <article aria-label={title} data-testid="inbox-sort" data-nyx-item="decision" data-nyx-risk="" data-nyx-at={first?.createdAt} id={first ? decisionHash(ref) : undefined} onClick={cardClickOpens(() => openDecision(ref))} className={cn("cc-card cc-rise grid min-w-0 gap-2 p-4", CLICKABLE, done && "cc-leave")} style={riseStyle(index)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="rounded-full bg-a-p3 px-2 py-px text-label font-semibold text-a-mut">{tc("inbox", "Sortieren")}</span>
        <span className="flex-1" />
        <NyxAskChip nyx={nyx} />
        <span className="text-label text-a-mut" title={formatDateTime(first?.createdAt ?? "")}>
          {t("von Nyx")} · {relativeTime(first?.createdAt ?? null)}
        </span>
      </div>
      <NyxSummaryPanel nyx={nyx} />
      <CardTitle target={ref}>{title}</CardTitle>
      {n > 1 && <p className="text-caption text-a-mut">{t("Alle heißen „{subject}“.", { subject })}</p>}
      {reason && <p className="text-callout text-a-ink">{reason}</p>}
      <ul className="grid min-w-0 gap-0.5">
        {items.map((item) => (
          <li key={item.id} className="min-w-0 truncate text-caption text-a-mut">
            {item.sessionKey ? <SessionName sessionKey={item.sessionKey} /> : t("eine Session")}
          </li>
        ))}
      </ul>
      <SortActions target={target} items={items} onToast={onToast} onDone={() => setDone(true)} leaveMs={LEAVE_MS} />
    </article>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate font-mono text-label text-a-mut">{children}</span>;
}

function ApprovalCard({ approval, index, onToast }: { approval: Approval; index: number; onToast: (m: string) => void }) {
  const [done, setDone] = useState(false);
  const openDecision = useOpenDecision();
  const ref: DecisionRef = { kind: "approval", id: approval.id };
  const nyx = useDecisionNyx("approval", approval.id);
  const label = GUARD_RULE_LABELS[approval.rule] ?? approval.rule;

  return (
    <article
      aria-label={t("Freigabe: {label}", { label })}
      data-nyx-item="decision"
      data-nyx-at={approval.createdAt}
      // Freigeben/Ablehnen entscheidest NUR du — der Nyx-Cursor zeigt, klickt/tippt hier nie.
      data-nyx-risk=""
      id={decisionHash(ref)}
      onClick={cardClickOpens(() => openDecision(ref))}
      className={cn("cc-card cc-rise grid min-w-0 gap-2.5 border-a-wait/35 p-4", CLICKABLE, done && "cc-leave")}
      style={riseStyle(index)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="rounded-full bg-a-wait/10 px-2 py-px font-mono text-label text-a-wait">{t("Freigabe · {label}", { label })}</span>
        <span className="flex-1" />
        <NyxAskChip nyx={nyx} />
        <span className="font-mono text-label text-a-mut" title={formatDateTime(approval.createdAt)}>
          {relativeTime(approval.createdAt)}
        </span>
      </div>
      <NyxSummaryPanel nyx={nyx} />
      <p className="text-callout leading-relaxed text-a-ink">
        <Link to={decisionHref(ref)} state={{ fromList: true }} className="sr-only focus:not-sr-only">
          {t("Details zur Freigabe")}
        </Link>
        {approval.reason}
      </p>
      <pre className="cc-scroll min-w-0 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-a-line bg-a-bg px-3 py-2 font-mono text-caption text-a-ink">
        <code>{approval.command}</code>
      </pre>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {approval.sessionKey && (
          <Meta>
            {t("Session")} <SessionName sessionKey={approval.sessionKey} />
          </Meta>
        )}
        {approval.auftrag && <Meta>{t("Auftrag {name}", { name: approval.auftrag })}</Meta>}
        {(approval.worktree ?? approval.cwd) && <Meta>{shortenPath(approval.worktree ?? approval.cwd ?? "", 48)}</Meta>}
        {approval.attempts > 0 && <Meta>{approval.attempts === 1 ? t("1 Versuch") : t("{n} Versuche", { n: approval.attempts })}</Meta>}
      </div>
      <ApprovalActions approval={approval} onToast={onToast} onDone={() => setDone(true)} leaveMs={LEAVE_MS} />
    </article>
  );
}

function QuestionCard({ item, index, onToast }: { item: InboxItem; index: number; onToast: (m: string) => void }) {
  const [done, setDone] = useState(false);
  const openDecision = useOpenDecision();
  const ref: DecisionRef = { kind: "inbox", id: item.id };
  const nyx = useDecisionNyx("inbox", item.id);
  const escalation = item.escalation !== null || item.kind === "eskalation";

  return (
    <article
      aria-label={item.title}
      data-nyx-item="decision"
      data-nyx-at={item.createdAt}
      // Ja/Nein/Optionen/eigene Antwort entscheidest NUR du — der Nyx-Cursor zeigt, klickt/tippt hier nie.
      data-nyx-risk=""
      id={decisionHash(ref)}
      onClick={cardClickOpens(() => openDecision(ref))}
      className={cn("cc-card cc-rise grid min-w-0 gap-2.5 p-4", CLICKABLE, escalation && "border-a-bad/50 shadow-[inset_3px_0_0_var(--a-bad)]", done && "cc-leave")}
      style={riseStyle(index)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-px font-mono text-label", escalation ? "bg-a-bad/10 text-a-bad" : "bg-a-acc/10 text-a-acc")}>
          {KIND_LABEL[item.kind]}
          {item.escalation && ` · ${ESCALATION_LABEL[item.escalation] ?? item.escalation}`}
        </span>
        <span className="font-mono text-label text-a-mut">{t("~{n} Min", { n: Math.max(1, item.estimateMinutes) })}</span>
        <span className="flex-1" />
        <NyxAskChip nyx={nyx} />
        <span className="font-mono text-label text-a-mut" title={formatDateTime(item.createdAt)}>
          {CREATED_BY[item.createdBy]} · {relativeTime(item.createdAt)}
        </span>
      </div>
      <NyxSummaryPanel nyx={nyx} />
      <CardTitle target={ref}>{item.title}</CardTitle>
      {item.body && (
        <div className="min-w-0 break-words text-callout leading-relaxed text-a-ink">
          <Markdown text={item.body} />
        </div>
      )}
      <SourceChips sources={item.sources} />
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {item.baustelle && <Meta>{t("Baustelle {name}", { name: item.baustelle })}</Meta>}
        {item.sessionKey && (
          <Meta>
            {t("Session")} <SessionName sessionKey={item.sessionKey} />
          </Meta>
        )}
        {item.decisionFile && <Meta>→ {shortenPath(item.decisionFile, 48)}</Meta>}
      </div>
      <QuestionActions item={item} onToast={onToast} onDone={() => setDone(true)} leaveMs={LEAVE_MS} />
    </article>
  );
}
