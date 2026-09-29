// Eine Karte je Auftrag (Farbe = Projekt), darin die Pakete (Farbe = Status) und auf Klick
// deren Schritte samt verknüpften Sessions/Commits. Ganze Zeile klickbar → Großansicht (`?e=`).
// Erledigte Aufträge (BERICHT.md da) bieten „Bericht lesen“ statt „Agent starten“ — kein
// zweiter Agent auf ein fertiges Paket. Der Status-Balken erscheint nur bei mehr als einer Stufe.
import type { Entry, EntryLink } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { relativeTime, shortenPath } from "../../lib/format";
import { useEntryDetail } from "../entries/hooks";
import { KIND_LABELS, PRIORITY_LABELS } from "../entries/meta";
import { sessionHref } from "../git/meta";
import { openNewSessionWith } from "../terminal/terminalApi";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { agentStartPrefill, auditAreaSummary, packageTitle, STAGE_THEME, stageSpread, type TaskGroup, type TaskStage } from "./model";
import { ProgressRing, StageBar } from "./TaskHeader";

const VISIBLE_PACKAGES = 5;

function Chip({ children, title, tone = "var(--a-mut)", className }: { children: ReactNode; title?: string; tone?: string; className?: string }) {
  return (
    <span
      title={title}
      className={`text-label ${cn("inline-flex max-w-[260px] items-center gap-1 truncate rounded-full border px-2 py-0.5 leading-4", className)}`}
      style={{ borderColor: `color-mix(in srgb, ${tone} 35%, var(--a-line))`, color: tone, background: `color-mix(in srgb, ${tone} 8%, transparent)` }}
    >
      {children}
    </span>
  );
}

const chipLink = "inline-flex max-w-[260px] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-label leading-4 transition-colors hover:brightness-125";

function SessionChip({ sessionKey, label }: { sessionKey: string; label?: string }) {
  const tone = sessionKey.startsWith("codex:") ? "var(--a-codex)" : "var(--a-claude)";
  return (
    <Link
      to={sessionHref(sessionKey)}
      onClick={(e) => e.stopPropagation()}
      className={chipLink}
      style={{ borderColor: `color-mix(in srgb, ${tone} 40%, var(--a-line))`, color: tone, background: `color-mix(in srgb, ${tone} 9%, transparent)` }}
      title={label ? t("Session: {label}", { label }) : t("Zur Session")}
    >
      <span aria-hidden>●</span>
      {label ? <span className="truncate">{label}</span> : t("Session")}
    </Link>
  );
}

function StagePill({ stage }: { stage: TaskStage }) {
  const theme = STAGE_THEME[stage];
  return (
    <span className="inline-flex w-[88px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium" style={{ color: theme.color, background: `color-mix(in srgb, ${theme.color} 14%, transparent)` }}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", stage === "laeuft" && "cc-pulse")} style={{ background: theme.color, boxShadow: `0 0 6px ${theme.color}` }} />
      {theme.label}
    </span>
  );
}

/** Schritte (Unteraufgaben) + Verknüpfungen eines Pakets — erst beim Aufklappen geladen. */
function PackageSteps({ entry, color, onOpenEntry }: { entry: Entry; color: string; onOpenEntry: (id: number) => void }) {
  const detail = useEntryDetail(entry.id);
  if (detail.isPending) {
    return (
      <div className="grid gap-1.5 px-3 pb-3" aria-busy>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-52" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="flex items-center gap-3 px-3 pb-3 text-caption text-a-mut">
        {t("Die Schritte konnten gerade nicht geladen werden.")}
        <button type="button" onClick={() => void detail.refetch()} className="rounded-md border border-a-line px-2 py-0.5 text-caption text-a-ink hover:bg-a-p3">
          {t("Erneut versuchen")}
        </button>
      </div>
    );
  }
  const { subtasks, links } = detail.data;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <div className="grid gap-2.5 px-3 pb-3 pl-[18px]">
      <div className="flex items-center gap-2.5 text-caption text-a-mut">
        <span className="font-mono tabular-nums text-a-ink">
          {t("{done} / {total} Schritte", { done, total: subtasks.length })}
        </span>
        <span className="h-1 w-32 overflow-hidden rounded-full bg-a-p3" aria-hidden>
          <span className="cc-progress-fill block h-full rounded-full" style={{ width: `${subtasks.length ? (done / subtasks.length) * 100 : 0}%`, background: color }} />
        </span>
      </div>
      {subtasks.length === 0 ? (
        <p className="text-caption text-a-mut">{t("Noch keine Schritte erfasst. Sie erscheinen, sobald die Session sie abhakt.")}</p>
      ) : (
        <ul aria-label={t("Schritte")} className="grid gap-1 border-l-2 pl-3" style={{ borderColor: `color-mix(in srgb, ${color} 35%, var(--a-line))` }}>
          {subtasks.map((s) => (
            <li key={s.id} className="flex items-start gap-2 text-caption">
              <span
                aria-hidden
                className="mt-[2px] grid h-4 w-4 shrink-0 place-items-center rounded-full border text-label leading-none"
                style={s.done ? { background: color, borderColor: color, color: "var(--a-bg)" } : { borderColor: `color-mix(in srgb, ${color} 45%, var(--a-line))` }}
              >
                {s.done ? "✓" : ""}
              </span>
              <span className={cn("min-w-0 flex-1", s.done ? "text-a-mut line-through decoration-a-line" : "text-a-ink")}>{s.title}</span>
              {s.doneAt && <span className="shrink-0 font-mono text-label text-a-mut">{relativeTime(s.doneAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && <LinkChips links={links} onOpenEntry={onOpenEntry} />}
    </div>
  );
}

function LinkChips({ links, onOpenEntry }: { links: EntryLink[]; onOpenEntry: (id: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t("Verknüpft")}>
      <span className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Verknüpft")}</span>
      {links.map((l) => {
        const type = l.direction === "in" ? l.fromType : l.toType;
        const id = l.direction === "in" ? l.fromId : l.toId;
        if (type === "session") return <SessionChip key={l.id} sessionKey={id} label={l.label ?? l.relation} />;
        if (type === "entry")
          return (
            <button key={l.id} type="button" onClick={() => onOpenEntry(Number(id))} className={chipLink} style={{ borderColor: "color-mix(in srgb, var(--a-violet) 40%, var(--a-line))", color: "var(--a-violet)" }}>
              ↗ {l.label ?? t("Eintrag {id}", { id })}
            </button>
          );
        if (type === "commit")
          return (
            <Chip key={l.id} tone="var(--a-lime)" title={l.label ?? id}>
              <span aria-hidden>⎇</span>
              <span className="font-mono">{id.slice(0, 7)}</span>
            </Chip>
          );
        return (
          <Chip key={l.id} tone="var(--a-indigo)" title={id}>
            {type === "doc" ? "📄" : "▪"} {shortenPath(l.label ?? id, 40)}
          </Chip>
        );
      })}
    </div>
  );
}

/** Warum „Agent starten“ gerade nicht geht (`null` = geht). */
export function agentStartBlocked(bridgeOnline: boolean | undefined): string | null {
  if (bridgeOnline === undefined) return t("Einen Moment, die Verbindung zum Mac wird geprüft.");
  return bridgeOnline ? null : t("Der Rechner ist gerade nicht verbunden. Sobald die Brücke wieder läuft, kannst du hier einen Agenten starten.");
}

/** Öffnet „Neue Session“ vorbelegt — nichts startet ohne deinen Klick im Dialog. */
function AgentStartButton({ entry, title, blocked }: { entry: Entry; title: string; blocked: string | null }) {
  const tone = "var(--a-claude)";
  return (
    <button
      type="button"
      data-nyx="agent-starten"
      aria-label={t("Agent starten für {title}", { title })}
      title={blocked ?? t("Öffnet „Neue Session“ vorbelegt: Ordner, Claude Opus 5.5 und der Auftrag als erste Nachricht")}
      disabled={blocked !== null}
      onClick={() => openNewSessionWith(agentStartPrefill(entry))}
      className="rounded-md border px-2.5 py-1 text-caption font-medium transition-colors hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone, background: `color-mix(in srgb, ${tone} 9%, transparent)` }}
    >
      ▶ {t("Agent starten")}
    </button>
  );
}

/** Fertiger Auftrag → Großansicht mit dem Bericht (steht dort unter „Planungsdokumente“). */
function ReportButton({ title, onOpen }: { title: string; onOpen: () => void }) {
  const tone = STAGE_THEME.erledigt.color;
  return (
    <button
      type="button"
      data-nyx="bericht-lesen"
      aria-label={t("Bericht lesen: {title}", { title })}
      title={t("Öffnet die Großansicht mit dem Bericht dieses Auftrags")}
      onClick={onOpen}
      className="rounded-md border px-2.5 py-1 text-caption font-medium transition-colors hover:brightness-125"
      style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone, background: `color-mix(in srgb, ${tone} 9%, transparent)` }}
    >
      {t("Bericht lesen")}
    </button>
  );
}

function PackageRow({ entry, index, onOpen, onStart, starting, agentBlocked }: { entry: Entry & { stage: TaskStage }; index: number; onOpen: (id: number) => void; onStart?: () => void; starting: boolean; agentBlocked: string | null }) {
  const [open, setOpen] = useState(false);
  const theme = STAGE_THEME[entry.stage];
  const title = packageTitle(entry);
  const showProgress = entry.stage === "laeuft" || entry.stage === "pruefen";
  return (
    <li
      data-stage={entry.stage}
      style={{ "--s": theme.color, animationDelay: `${Math.min(index, 8) * 30}ms` } as CSSProperties}
      className={cn("cc-stagger rounded-xl border transition-colors duration-150", open ? "border-a-line bg-a-bg/40" : "border-transparent hover:border-a-line hover:bg-a-p2")}
    >
      <div
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-2.5 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
        onClick={() => onOpen(entry.id)}
      >
        <span className="hidden sm:block">
          <StagePill stage={entry.stage} />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="sm:hidden">
              <StagePill stage={entry.stage} />
            </span>
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), onOpen(entry.id))}
              className="min-w-0 truncate text-left text-callout font-medium text-a-ink hover:underline"
              title={entry.title}
              data-nyx-item="task"
              data-nyx-at={entry.updatedAt}
            >
              {title}
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={entry.kind === "bug" ? "var(--a-bad)" : entry.kind === "audit" ? "var(--a-indigo)" : "var(--a-violet)"}>{KIND_LABELS[entry.kind]}</Chip>
            {entry.priority && <Chip tone={entry.priority === "p0" ? "var(--a-bad)" : entry.priority === "p1" ? "var(--a-wait)" : "var(--a-acc)"}>{PRIORITY_LABELS[entry.priority]}</Chip>}
            {entry.kind === "audit" && entry.baustelle && !entry.baustelle.label.endsWith(entry.sourceId ?? "\u0000") && <Chip tone="var(--a-temp)">{t("Paket {name}", { name: entry.baustelle.label.replace(/^P-/, "") })}</Chip>}
            {entry.estimate && (
              <Chip tone="var(--a-temp)" title={entry.estimate}>
                ⏱ {entry.estimate.length > 28 ? `${entry.estimate.slice(0, 28)}…` : entry.estimate}
              </Chip>
            )}
            {entry.maturity && (
              <Chip tone={entry.maturity.passed ? "var(--a-acc)" : "var(--a-wait)"}>
                {t("Reife {passed}/{total}", { passed: entry.maturity.passedCount, total: entry.maturity.totalCount })}
              </Chip>
            )}
            {entry.startedSessionKey && <SessionChip sessionKey={entry.startedSessionKey} />}
            {entry.gitBranch && (
              <Chip tone="var(--a-lime)" title={t("Zweig {branch}", { branch: entry.gitBranch })}>
                <span aria-hidden>⎇</span>
                <span className="font-mono">{entry.gitBranch}</span>
              </Chip>
            )}
            {entry.sourceRemovedAt && (
              <Chip tone="var(--a-wait)" title={t("Die Quelle (Datei) gibt es nicht mehr.")}>
                {t("Quelle entfernt")}
              </Chip>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {showProgress && (
            <span className="flex w-[118px] items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-a-p3">
                <span className="cc-progress-fill block h-full rounded-full" style={{ width: `${entry.progressPercent}%`, background: theme.color, boxShadow: `0 0 8px ${theme.color}` }} role="progressbar" aria-valuenow={entry.progressPercent} aria-valuemin={0} aria-valuemax={100} />
              </span>
              <span className="w-9 text-right font-mono text-label tabular-nums text-a-mut">{entry.progressPercent}%</span>
            </span>
          )}
          {entry.stage !== "erledigt" && <AgentStartButton entry={entry} title={title} blocked={agentBlocked} />}
          {entry.stage === "erledigt" && entry.sourceType === "goal" && <ReportButton title={title} onOpen={() => onOpen(entry.id)} />}
          {onStart && (
            // Der alte Start-Weg tut etwas anderes als „Agent starten“ — eigener Zweig
            // (Worktree), sofort ohne Dialog, Stufe → „läuft“. Darum nur Neben-Knopf, klar anders beschriftet.
            <button
              type="button"
              data-nyx="aufgabe-starten"
              aria-label={t("Im eigenen Zweig starten: {title}", { title })}
              title={t("Legt einen eigenen Zweig (Worktree) für diesen Auftrag an und startet Claude dort sofort, ohne Dialog.")}
              disabled={starting}
              onClick={onStart}
              className="rounded-md border border-a-line px-2.5 py-1 text-caption text-a-mut transition-colors hover:bg-a-p3 hover:text-a-ink disabled:opacity-50"
            >
              {starting ? t("Startet …") : `⎇ ${t("Im eigenen Zweig")}`}
            </button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("Schritte von {title}", { title })}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-a-line px-2 py-1 text-caption text-a-mut transition-colors hover:bg-a-p3 hover:text-a-ink"
          >
            {t("Schritte")} <span aria-hidden className={cn("inline-block transition-transform duration-200", open && "rotate-90")}>›</span>
          </button>
        </div>
      </div>
      {open && <PackageSteps entry={entry} color={theme.color} onOpenEntry={onOpen} />}
    </li>
  );
}

export function TaskGroupCard({
  group,
  index,
  onOpen,
  onStart,
  startingId,
  bridgeOnline,
}: {
  group: TaskGroup;
  index: number;
  onOpen: (id: number) => void;
  onStart: (id: number) => void;
  startingId: number | null;
  /** Brücke da? (`undefined` = noch unbekannt) */
  bridgeOnline?: boolean;
}) {
  const agentBlocked = agentStartBlocked(bridgeOnline);
  const [showAll, setShowAll] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const { project } = group;
  const visible = showAll ? group.items : group.items.slice(0, VISIBLE_PACKAGES);
  const hidden = group.items.length - visible.length;
  const isAudit = group.key.startsWith("audit:");
  const parts = [
    isAudit
      ? group.items.length === 1
        ? t("{n} Befund", { n: group.items.length })
        : t("{n} Befunde", { n: group.items.length })
      : group.items.length === 1
        ? t("{n} Paket", { n: group.items.length })
        : t("{n} Pakete", { n: group.items.length }),
    group.stageCounts.laeuft + group.stageCounts.pruefen > 0 ? t("{n} in Arbeit", { n: group.stageCounts.laeuft + group.stageCounts.pruefen }) : null,
    group.done > 0 ? t("{n} erledigt", { n: group.done }) : null,
  ].filter(Boolean);
  return (
    <article
      aria-label={group.title}
      data-project={project.key}
      style={{ "--c": project.color, animationDelay: `${Math.min(index, 8) * 30}ms` } as CSSProperties}
      className="cc-stagger group/card relative grid gap-3 overflow-hidden rounded-2xl border border-a-line bg-a-p p-3.5 transition-[border-color,transform,box-shadow] duration-200 ease-apple hover:border-(--c)/45 hover:shadow-raise motion-safe:hover:-translate-y-px md:p-4"
    >
      {/* Projektfarbe nur als feine, einfarbige Linie links – die Fläche bleibt eine Farbe. */}
      <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-r-full" style={{ background: project.color }} />
      <header className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 pl-1.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-label">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium" style={{ color: project.color, background: `color-mix(in srgb, ${project.color} 14%, transparent)` }}>
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: project.color }} />
              {project.label}
            </span>
            <span className="font-mono uppercase tracking-wide text-a-mut">{isAudit ? t("Audit") : t("Auftrag")}</span>
            <span className="font-mono text-a-mut">· {relativeTime(group.updatedAt) ?? "—"}</span>
          </div>
          {isAudit ? (
            // Audit-Bereich anklickbar → Zusammenfassung (Zahlen, Dringlichkeit, wichtigste Befunde) + Nyx.
            <button type="button" data-testid="audit-area-toggle" aria-expanded={summaryOpen} onClick={() => setSummaryOpen((v) => !v)} className="mt-1 flex max-w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-a-acc">
              <h3 className="min-w-0 truncate font-display text-title2 font-semibold text-a-ink">{group.title}</h3>
              <span className="shrink-0 rounded-full border border-a-line px-2 py-0.5 text-label text-a-mut">
                {t("Zusammenfassung")} <span aria-hidden className={cn("inline-block transition-transform duration-200", summaryOpen && "rotate-90")}>›</span>
              </span>
            </button>
          ) : (
            <h3 className="mt-1 truncate font-display text-title2 font-semibold text-a-ink">{group.title}</h3>
          )}
          <p className="mt-0.5 text-caption text-a-mut">{parts.join(" · ")}</p>
        </div>
        <ProgressRing pct={group.progress} size={54} stroke={5} color={project.color} label={t("Fortschritt {title}", { title: group.title })} />
      </header>
      {isAudit && summaryOpen && <AuditAreaPanel group={group} onOpen={onOpen} />}
      {stageSpread(group.stageCounts) > 1 && <StageBar counts={group.stageCounts} className="relative" />}
      <ul className="relative grid gap-0.5">
        {visible.map((e, i) => (
          <PackageRow
            key={e.id}
            entry={e as Entry & { stage: TaskStage }}
            index={i}
            onOpen={onOpen}
            onStart={e.stage === "startklar" ? () => onStart(e.id) : undefined}
            starting={startingId === e.id}
            agentBlocked={agentBlocked}
          />
        ))}
      </ul>
      {(hidden > 0 || showAll) && group.items.length > VISIBLE_PACKAGES && (
        <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} className="relative w-fit rounded-md px-2 py-1 text-caption transition-colors hover:bg-a-p2" style={{ color: project.color }}>
          {showAll
            ? t("Weniger anzeigen")
            : isAudit
              ? t("Alle {n} Befunde zeigen ({hidden} weitere)", { n: group.items.length, hidden })
              : t("Alle {n} Pakete zeigen ({hidden} weitere)", { n: group.items.length, hidden })}
        </button>
      )}
    </article>
  );
}

/** Was steckt in diesem Audit-Bereich? Zahlen, Dringlichkeit, die wichtigsten offenen Befunde – und Nyx erklärt. */
function AuditAreaPanel({ group, onOpen }: { group: TaskGroup; onOpen: (id: number) => void }) {
  const sum = auditAreaSummary(group);
  return (
    <section aria-label={t("Zusammenfassung {title}", { title: group.title })} data-testid="audit-area-summary" className="relative grid min-w-0 gap-2.5 rounded-xl border border-a-line bg-a-p2/60 p-3">
      <p className="text-callout text-a-ink">{sum.sentence}</p>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {sum.stages.map((s) => (
          <Chip key={s.stage} tone={STAGE_THEME[s.stage].color}>
            {STAGE_THEME[s.stage].label} {s.count}
          </Chip>
        ))}
        {sum.priorities.map((p) => (
          <Chip key={p.label} title={t("Dringlichkeit")}>
            {p.label} {p.count}
          </Chip>
        ))}
      </div>
      {sum.top.length > 0 && (
        <div className="grid min-w-0 gap-1">
          <span className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Wichtigste offene Befunde")}</span>
          <ul className="grid min-w-0 gap-0.5">
            {sum.top.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onOpen(e.id)} className="w-full min-w-0 truncate rounded-md px-2 py-1 text-left text-caption text-a-ink hover:bg-a-p3" title={e.title}>
                  {e.priority && <span className="mr-1.5 font-mono text-a-mut">{e.priority.toUpperCase()}</span>}
                  {packageTitle(e)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AskNyxButton question={t("Erklär mir kurz den {title}: was steckt drin, was ist am wichtigsten?", { title: group.title })} facts={sum.facts} />
    </section>
  );
}
