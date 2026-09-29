// Großansicht einer Entscheidung (`/inbox#inbox-<id>` bzw. `/inbox#approval-<id>`): voller Text/Befehl, Art,
// Herkunft mit Links (Session, Auftrag, Quellen), Zeitpunkte, bei Freigaben Regel + was die Knöpfe bewirken, bei
// Sortier-Vorschlägen Kategorie + betroffene Sessions, verwandte Einträge derselben Session, Nyx' Einschätzung und
// DIESELBEN Antwort-Knöpfe wie auf der Karte (gleiche Logik, gleiche Nyx-Sperre). Erledigtes: nur lesen.
import { type Approval, bundleInboxItems, GUARD_RULE_LABELS, type InboxItem, parseSortSuggestion, t, tc } from "@nyxos/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime, shortenPath } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { sessionHref } from "../git/meta";
import { ErrorBox, SourceChips } from "../haiku/ui";
import { ApprovalActions, QuestionActions, SortActions } from "./DecisionActions";
import { NyxAskChip, NyxSummaryPanel, useDecisionNyx } from "./DecisionNyx";
import { answerLabel, APPROVAL_STATUS, CREATED_BY, type DecisionRef, decisionHref, deliveryText, ESCALATION_LABEL, KIND_LABEL, SessionName, sortReason } from "./decisionMeta";

const RELATED_LIMIT = 8;

interface Props {
  target: DecisionRef;
  approvals: Approval[];
  items: InboxItem[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onClose: () => void;
  onToast: (m: string) => void;
}

type Subject = { kind: "approval"; approval: Approval } | { kind: "inbox"; item: InboxItem };

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

export function DecisionDetail({ target, approvals, items, loading, failed, onRetry, onClose, onToast }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    rootRef.current?.scrollIntoView?.({ block: "start" });
    const onKey = (e: KeyboardEvent) => {
      // Esc schließt – außer beim Tippen einer eigenen Antwort (sonst wäre der Text weg).
      if (e.key === "Escape" && !e.defaultPrevented && !isEditable(e.target)) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const subject: Subject | null =
    target.kind === "approval"
      ? (() => {
          const a = approvals.find((x) => x.id === target.id);
          return a ? { kind: "approval" as const, approval: a } : null;
        })()
      : (() => {
          const i = items.find((x) => x.id === target.id);
          return i ? { kind: "inbox" as const, item: i } : null;
        })();

  return (
    <div ref={rootRef} data-testid="decision-detail" className="grid w-full min-w-0 content-start gap-4 p-4 md:p-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-a-line bg-a-p2 px-3 text-caption text-a-ink hover:bg-a-p3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc">
          ← {t("Entscheidungen")}
        </button>
        <span className="hidden font-mono text-label text-a-mut md:inline">{t("Esc schließt")}</span>
      </div>

      {loading && !subject && <div className="h-48 animate-pulse rounded-xl bg-a-p2 motion-reduce:animate-none" aria-label={t("Lädt")} />}
      {failed && !subject && <ErrorBox text={t("Die Entscheidung konnte nicht geladen werden.")} onRetry={onRetry} />}
      {!loading && !failed && !subject && (
        <div className="cc-card grid gap-1 px-4 py-8 text-center">
          <p className="font-display text-headline text-a-ink">{t("Diesen Eintrag gibt es nicht (mehr).")}</p>
          <p className="text-caption text-a-mut">{t("Vielleicht ist er zu alt für die Liste oder wurde entfernt.")}</p>
        </div>
      )}
      {subject?.kind === "approval" && <ApprovalDetail approval={subject.approval} approvals={approvals} items={items} onToast={onToast} />}
      {subject?.kind === "inbox" && <InboxDetail item={subject.item} approvals={approvals} items={items} onToast={onToast} />}
    </div>
  );
}

// ─── Bausteine ───

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("cc-card grid min-w-0 gap-2.5 p-4 md:p-5", className)}>
      <h2 className="font-mono text-label uppercase tracking-[.12em] text-a-mut">{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1.5 text-callout sm:grid-cols-[max-content_minmax(0,1fr)]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-caption text-a-mut sm:pt-px">{k}</dt>
          <dd className="min-w-0 break-words text-a-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function When({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <span>
      {formatDateTime(at)} <span className="text-a-mut">· {relativeTime(at)}</span>
    </span>
  );
}

function SessionLink({ sessionKey }: { sessionKey: string }) {
  return (
    <Link to={sessionHref(sessionKey)} className="text-a-acc underline-offset-2 hover:underline">
      <SessionName sessionKey={sessionKey} />
    </Link>
  );
}

function StatusPill({ open, text }: { open: boolean; text: string }) {
  return <span className={cn("rounded-full px-2 py-px font-mono text-label", open ? "bg-a-wait/10 text-a-wait" : "bg-a-p3 text-a-mut")}>{text}</span>;
}

function NyxBlock({ target }: { target: DecisionRef }) {
  const nyx = useDecisionNyx(target.kind, target.id);
  return (
    <section className="grid min-w-0 gap-2.5" aria-label={t("Nyx' Einschätzung")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <NyxAskChip nyx={nyx} />
        {!nyx.open && <span className="min-w-0 text-caption text-a-mut">{t("Worum geht's, was Nyx empfehlen würde und was wichtig zu wissen ist.")}</span>}
      </div>
      <NyxSummaryPanel nyx={nyx} />
    </section>
  );
}

/** Andere Entscheidungen derselben Session (offen und erledigt), neueste zuerst. */
function Related({ sessionKey, self, approvals, items }: { sessionKey: string | null; self: DecisionRef; approvals: Approval[]; items: InboxItem[] }) {
  if (!sessionKey) return null;
  const rows = [
    ...approvals
      .filter((a) => a.sessionKey === sessionKey && !(self.kind === "approval" && a.id === self.id))
      .map((a) => ({ ref: { kind: "approval" as const, id: a.id }, label: t("Freigabe"), title: a.command, at: a.createdAt, status: APPROVAL_STATUS[a.status], mono: true })),
    ...items
      .filter((i) => i.sessionKey === sessionKey && !(self.kind === "inbox" && i.id === self.id))
      .map((i) => ({ ref: { kind: "inbox" as const, id: i.id }, label: KIND_LABEL[i.kind], title: i.title, at: i.createdAt, status: i.status === "open" ? t("offen") : answerLabel(i), mono: false })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RELATED_LIMIT);
  if (rows.length === 0) return null;
  return (
    <Section title={t("Verwandt · dieselbe Session")}>
      <ul className="grid min-w-0 gap-0.5">
        {rows.map((r) => (
          <li key={`${r.ref.kind}-${r.ref.id}`} className="min-w-0">
            <Link to={decisionHref(r.ref)} replace className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-caption hover:bg-a-p2">
              <span className="shrink-0 font-mono text-label text-a-mut">{r.label}</span>
              <span className={cn("min-w-0 flex-1 truncate text-a-ink", r.mono && "font-mono")}>{r.title}</span>
              <span className="max-w-[40%] shrink-0 truncate text-a-mut">{r.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Freigabe ───

function ApprovalDetail({ approval, approvals, items, onToast }: { approval: Approval; approvals: Approval[]; items: InboxItem[]; onToast: (m: string) => void }) {
  const ref: DecisionRef = { kind: "approval", id: approval.id };
  const label = GUARD_RULE_LABELS[approval.rule] ?? approval.rule;
  const open = approval.status === "pending";
  return (
    <>
      <header className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-full bg-a-wait/10 px-2 py-px font-mono text-label text-a-wait">{t("Freigabe · {label}", { label })}</span>
          <StatusPill open={open} text={APPROVAL_STATUS[approval.status]} />
        </div>
        <h1 className="min-w-0 break-words font-display text-title font-semibold text-a-ink">{t("Freigabe: {label}", { label })}</h1>
        <p className="text-callout leading-relaxed text-a-ink">{approval.reason}</p>
      </header>

      <NyxBlock target={ref} />

      <Section title={t("Befehl")}>
        <pre className="cc-scroll min-w-0 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-a-line bg-a-bg px-3 py-2 font-mono text-caption text-a-ink">
          <code>{approval.command}</code>
        </pre>
        <Facts
          rows={[
            [t("Regel"), `${label} (${approval.rule})`],
            [t("Werkzeug"), approval.tool],
            [t("Ordner"), approval.worktree ?? approval.cwd ? <span className="font-mono text-caption">{shortenPath(approval.worktree ?? approval.cwd ?? "", 80)}</span> : null],
            [t("Versuche"), approval.attempts > 0 ? String(approval.attempts) : null],
          ]}
        />
      </Section>

      <Section title={t("Was passieren würde")}>
        <ul className="grid min-w-0 list-disc gap-1 pl-5 text-callout leading-relaxed text-a-ink">
          <li>
            <strong className="font-semibold">{t("Freigeben:")}</strong> {t("Die Session darf genau diesen Befehl ein Mal ausführen. Die Freigabe verfällt nach 24 Stunden.")}
          </li>
          <li>
            <strong className="font-semibold">{t("Ablehnen:")}</strong> {t("Die Session bekommt ein Nein und muss ohne diesen Befehl weitermachen.")}
          </li>
        </ul>
      </Section>

      <Section title={t("Herkunft & Zeit")}>
        <Facts
          rows={[
            [t("Session"), approval.sessionKey ? <SessionLink sessionKey={approval.sessionKey} /> : null],
            [t("Auftrag"), approval.auftrag],
            [t("Angefragt"), <When at={approval.createdAt} />],
            [t("Entschieden"), approval.decidedAt ? <When at={approval.decidedAt} /> : null],
            [t("Genutzt"), approval.consumedAt ? <When at={approval.consumedAt} /> : null],
          ]}
        />
      </Section>

      <Section title={open ? t("Deine Entscheidung") : t("Entschieden")}>
        {open ? <ApprovalActions approval={approval} onToast={onToast} /> : <p className="text-callout text-a-ink">{APPROVAL_STATUS[approval.status]}</p>}
      </Section>

      <Related sessionKey={approval.sessionKey} self={ref} approvals={approvals} items={items} />
    </>
  );
}

// ─── Frage / Plan / Eskalation / Sortieren ───

function InboxDetail({ item, approvals, items, onToast }: { item: InboxItem; approvals: Approval[]; items: InboxItem[]; onToast: (m: string) => void }) {
  const ref: DecisionRef = { kind: "inbox", id: item.id };
  const open = item.status === "open";
  const sort = parseSortSuggestion(item.title);
  const escalation = item.escalation !== null || item.kind === "eskalation";
  // Sortier-Vorschläge sind auf der Karte gebündelt – die Großansicht zeigt dasselbe Bündel (Ja/Nein gilt für alle).
  const bundle = sort && open ? (bundleInboxItems(items.filter((i) => i.status === "open")).find((b) => b.type === "sort" && b.items.some((i) => i.id === item.id)) ?? null) : null;
  const sortItems = bundle?.type === "sort" ? bundle.items : [item];
  const title = sort
    ? sortItems.length === 1
      ? t("„{subject}“ nach „{target}“ sortieren?", { subject: sort.subject, target: sort.target })
      : t("{n} Sessions nach „{target}“ sortieren?", { n: sortItems.length, target: sort.target })
    : item.title;

  return (
    <>
      <header className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {sort ? (
            <span className="rounded-full bg-a-p3 px-2 py-px text-label font-semibold text-a-mut">{tc("inbox", "Sortieren")}</span>
          ) : (
            <span className={cn("rounded-full px-2 py-px font-mono text-label", escalation ? "bg-a-bad/10 text-a-bad" : "bg-a-acc/10 text-a-acc")}>
              {KIND_LABEL[item.kind]}
              {item.escalation && ` · ${ESCALATION_LABEL[item.escalation] ?? item.escalation}`}
            </span>
          )}
          <StatusPill open={open} text={open ? t("offen") : item.status === "dismissed" ? t("verworfen") : t("beantwortet")} />
          {open && <span className="font-mono text-label text-a-mut">{t("~{n} Min", { n: Math.max(1, item.estimateMinutes) })}</span>}
        </div>
        <h1 className="min-w-0 break-words font-display text-title font-semibold text-a-ink">{title}</h1>
      </header>

      <NyxBlock target={ref} />

      {sort ? (
        <Section title={t("Vorschlag")}>
          {sortReason(item.body) && <p className="text-callout leading-relaxed text-a-ink">{sortReason(item.body)}</p>}
          <Facts
            rows={[
              [t("Kategorie"), sort.target],
              [t("Bei „Ja“"), t("Die Session wird nur zugeordnet – es entsteht keine Regel.")],
              [t("Bei „Nein“"), t("Die Session bleibt, wo sie ist.")],
            ]}
          />
          <h3 className="pt-1 text-caption text-a-mut">{sortItems.length === 1 ? t("Betroffene Session") : t("Betroffene Sessions ({n})", { n: sortItems.length })}</h3>
          <ul className="grid min-w-0 gap-1">
            {sortItems.map((i) => (
              <li key={i.id} className="min-w-0 truncate text-callout">
                {i.sessionKey ? <SessionLink sessionKey={i.sessionKey} /> : <span className="text-a-mut">{t("eine Session")}</span>}
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        item.body && (
          <Section title={t("Worum es geht")}>
            <div className="min-w-0 break-words text-callout leading-relaxed text-a-ink">
              <Markdown text={item.body} />
            </div>
          </Section>
        )
      )}

      {item.options.length > 0 && !sort && (
        <Section title={t("Möglichkeiten")}>
          <ul className="grid min-w-0 gap-1 text-callout text-a-ink">
            {item.options.map((o) => (
              <li key={o.id} className="min-w-0">
                <span className="font-semibold">{o.label}</span>
                {o.detail && <span className="text-a-mut"> – {o.detail}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t("Herkunft & Zeit")}>
        <Facts
          rows={[
            [t("Von"), CREATED_BY[item.createdBy]],
            [t("Session"), !sort && item.sessionKey ? <SessionLink sessionKey={item.sessionKey} /> : null],
            [t("Baustelle"), item.baustelle],
            [t("Antwort landet in"), item.decisionFile ? <span className="font-mono text-caption">{shortenPath(item.decisionFile, 80)}</span> : null],
            [t("Angelegt"), <When at={item.createdAt} />],
            [t("Beantwortet"), item.answeredAt ? <When at={item.answeredAt} /> : null],
          ]}
        />
        <SourceChips sources={item.sources} />
      </Section>

      <Section title={open ? t("Deine Antwort") : t("Gegebene Antwort")}>
        {open ? (
          sort ? (
            <SortActions target={sort.target} items={sortItems} onToast={onToast} />
          ) : (
            <QuestionActions item={item} onToast={onToast} />
          )
        ) : (
          <div className="grid min-w-0 gap-1">
            <p className="text-callout font-semibold text-a-ink">{answerLabel(item)}</p>
            {item.status === "answered" && item.delivery && <p className="text-caption text-a-mut">{deliveryText(item)}</p>}
          </div>
        )}
      </Section>

      <Related sessionKey={item.sessionKey} self={ref} approvals={approvals} items={items} />
    </>
  );
}
