import { BUILD_KIND_LABEL, formatBuildCount, formatTokensCompact, getLang, greetingLine, locale, situationSentence, t, timeZone, type BuildGroup, type BuildKind, type HaikuReport, type PendingDeliveries } from "@nyxos/shared";
import type { CriticalSession, MetricTile, ServerSnapshot } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { PageShell } from "../../components/PageShell";
import { BarChart, StatCard, formatDayLong, formatDayShort } from "../../components/charts";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { CloseDialog } from "../../components/sessions/CloseDialog";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { useAppInfo } from "../../hooks/useAppInfo";
import { useBridgeHistory, useBridgePresence } from "../../hooks/useBridgePresence";
import { useOverview } from "../../hooks/useOverview";
import { useCloseSession } from "../../hooks/useSessionApi";
import { useServerSnapshot } from "../../hooks/useServerSnapshot";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { metricTone, toneVar } from "../../lib/tones";
import { stateMeta } from "../../lib/stateMeta";
import { ORPHANED_META } from "../../lib/sessionLabel";
import { useBuildGroups } from "../builds/useBuilds";
import { EntryRow } from "../entries/EntryRow";
import { isSteadyRunning, isTroubled } from "../server/serverView";
import { fetchReport } from "../haiku/haikuApi";
import { useEntries, useStartEntry } from "../entries/hooks";
import { AccessHint } from "../settings/access/AccessHint";
import { SinceCard } from "./SinceCard";

/** Wie viele startklare Aufträge im Überblick gezeigt werden — der Rest ist über den Aufgaben-Tab
 * erreichbar (dieselbe Kachel-Idee wie „Kritische Sessions" max. 10). */
const STARTKLAR_LIMIT = 5;
/** Baustellen zuerst nur die ersten 6 (nach offenen Sessions sortiert), Rest aufklappbar. */
const BAUSTELLEN_LIMIT = 6;

const dateFmt = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: timeZone() });

/** Oben stehen höchstens so viele Kacheln — nur, was zum Handeln führt. */
const ACTION_LIMIT = 4;
/** Kacheln, die nur oben stehen, wenn etwas zu tun ist (Wert > 0) — dringendste zuerst. */
const URGENT_KEYS = ["builds_red", "conflicts", "sessions_waiting", "open_questions"] as const;
/** Steht immer oben: wie voll das Claude-Fenster ist (ein Limit bremst alles). */
const WINDOW_KEY = "max_window";
/** Füllen die oberen Plätze auf, wenn es weniger Dringendes gibt (ebenfalls nur bei Wert > 0). */
const FILL_KEYS = ["uncommitted", "sessions_open"] as const;

/** Text je Null-Kachel in der Zeile „Alles ruhig“ (sonst `0 <Bezeichnung>`). */
const ZERO_TEXT: Record<string, string> = {
  sessions_open: t("0 Sessions offen"),
  sessions_waiting: t("0 wartet auf dich"),
  tokens_today: t("0 Tokens heute"),
  tokens_7d: t("0 Tokens in 7 Tagen"),
  commits_7d: t("0 Commits in 7 Tagen"),
  uncommitted: t("0 ungesichert"),
  conflicts: t("0 Konflikte"),
  builds_red: t("0 Builds rot"),
  open_questions: t("0 offene Fragen"),
  audits_critical: t("0 kritische Audits"),
  max_window: t("Max-Fenster leer"),
  haiku_briefing: t("0 Nyx-Aufrufe heute"),
};

export interface MetricGroups {
  /** Oben, groß: höchstens `ACTION_LIMIT` Kacheln, die Handeln auslösen. */
  action: MetricTile[];
  /** Alle übrigen Null-Werte, zusammen in einer Zeile. */
  zero: MetricTile[];
  /** Der Rest, ruhiger darunter. */
  calm: MetricTile[];
}

/** Kennzahlen nach Dringlichkeit aufteilen (Reihenfolge der übrigen bleibt die des Servers). */
export function groupMetrics(metrics: MetricTile[]): MetricGroups {
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const live = (m: MetricTile | undefined): m is MetricTile => !!m && !m.placeholder && (m.value ?? 0) > 0;
  const action: MetricTile[] = [];
  for (const k of URGENT_KEYS) {
    const m = byKey.get(k);
    if (live(m) && action.length < ACTION_LIMIT - 1) action.push(m);
  }
  const win = byKey.get(WINDOW_KEY);
  if (win && !win.placeholder) action.push(win);
  for (const k of FILL_KEYS) {
    const m = byKey.get(k);
    if (live(m) && action.length < ACTION_LIMIT) action.push(m);
  }
  const rest = metrics.filter((m) => !action.includes(m));
  const zero = rest.filter((m) => !m.placeholder && m.value === 0);
  return { action, zero, calm: rest.filter((m) => !zero.includes(m)) };
}

function metricFormat(tile: MetricTile): (n: number) => string {
  return (n) => (tile.format === "tokens" ? formatTokensCompact(n) : Math.round(n).toLocaleString(locale()));
}

/** Dieselbe Regel wie Briefing-Kopf, Server-Bericht und Vorlesen (nachts „Noch wach“). */
export function greetingFor(now: Date, name?: string | null): string {
  return greetingLine(now, name);
}

/** Der Lage-Satz kommt vom Server (derselbe Satz wie im Briefing); hier nur weitergereicht. */
export { situationSentence };

/** Uhrzeit des Server-Stands in der eingestellten Zeitzone, z. B. „10:38“. */
const standFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });


function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function Panel({ title, action, children, className, label }: { title: string; action?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? title} className={cn("grid min-w-0 content-start gap-2", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <h2 className="font-mono text-label font-medium uppercase tracking-wider text-a-mut">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="grid min-h-[96px] place-items-center px-3 text-center text-callout text-a-mut">{children}</p>;
}

function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="rounded px-1.5 py-0.5 text-caption text-a-mut transition-colors hover:bg-a-p2 hover:text-a-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
      {children} <span aria-hidden>→</span>
    </Link>
  );
}

function MetricCard({ tile, quiet = false }: { tile: MetricTile; quiet?: boolean }) {
  // Klick auf die Kachel führt zum Tab (mehr Infos); unten rechts ein kleiner „Nyx fragen“-Knopf.
  const shown = tile.placeholder || tile.value === null ? t("noch keine Zahl") : metricFormat(tile)(tile.value);
  return (
    <div className="relative grid h-full min-w-0">
      <MetricStat tile={tile} quiet={quiet} />
      {!tile.placeholder && (
        <div className="absolute bottom-2.5 right-2.5 z-[2]">
          <AskNyxButton compact inline={false} label={t("Nyx zu „{label}“ fragen", { label: tile.label })} question={t("Erklär mir kurz die Kennzahl „{label}“ aus meinem Überblick.", { label: tile.label })} facts={`${tile.label}: ${shown}.${tile.caption ? ` ${tile.caption}.` : ""}${tile.sparklineLabel ? ` ${t("Verlauf: {trend}.", { trend: tile.sparklineLabel })}` : ""}`} />
        </div>
      )}
    </div>
  );
}

function MetricStat({ tile, quiet }: { tile: MetricTile; quiet: boolean }) {
  return (
    <StatCard
      id={tile.key}
      label={tile.label}
      value={tile.placeholder ? null : tile.value}
      format={metricFormat(tile)}
      trend={tile.trend}
      sparkline={tile.sparkline}
      sparklineLabel={tile.sparklineLabel}
      caption={tile.caption}
      captionTone={tile.captionTone}
      href={tile.href}
      variant={quiet ? "quiet" : "default"}
      reserveCorner={!tile.placeholder}
    />
  );
}

/** Alle Null-Werte in EINER grünen Zeile statt als gleich große Kacheln; jedes Stück führt zu seinem Ort. */
function CalmLine({ tiles, urgent }: { tiles: MetricTile[]; urgent: boolean }) {
  return (
    <p data-testid="overview-calm-line" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-a-line bg-a-p px-4 py-2.5 text-callout text-a-mut">
      <span aria-hidden className="mr-1 h-2 w-2 shrink-0 rounded-full bg-a-ok" />
      {/* „Alles ruhig“ nur, wenn oben nichts Dringendes steht – sonst „Sonst ruhig“ (rote Builds + „Alles ruhig“ widerspräche sich). */}
      <span className="text-a-ok">{urgent ? t("Sonst ruhig:") : t("Alles ruhig:")}{" "}</span>
      {tiles.map((tile, i) => (
        <span key={tile.key} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>{" · "}</span>}
          <Link to={tile.href} className="rounded px-0.5 text-a-ink transition-colors hover:text-a-acc focus-visible:outline-2 focus-visible:outline-a-acc pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
            {ZERO_TEXT[tile.key] ?? `0 ${tile.label}`}
          </Link>
        </span>
      ))}
    </p>
  );
}

/** Überblick-Dashboard: Begrüßung + Lage, Kennzahl-Kacheln, Commits je Tag, kritische
 * Sessions, Baustellen, Startklar, Server. Alles klickbar zur Quelle. */
export function Overview() {
  const navigate = useNavigate();
  const now = useClock();
  const { data, isLoading, isError, refetch } = useOverview();
  const { data: startklarEntries } = useEntries({ stage: "startklar" });
  const startEntry = useStartEntry();
  const [allBaustellen, setAllBaustellen] = useState(false);

  if (isLoading) {
    return (
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 p-4 md:p-6" aria-busy>
        <div className="grid gap-2">
          <Skeleton className="h-9 w-80" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[148px] w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[250px] w-full rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="grid place-items-center p-10 text-center">
        <p className="mb-3 text-callout text-a-mut">{t("Überblick konnte nicht geladen werden.")}</p>
        <button type="button" onClick={() => void refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      </div>
    );
  }

  const commitsTotal = data.commits.reduce((a, d) => a + d.human + d.claude + d.codex, 0);
  const groups = groupMetrics(data.metrics);
  const activeBaustellen = data.baustellen.filter((b) => b.openSessions > 0).length;
  const recentDone = data.recentDone ?? [];
  const startklar = startklarEntries ?? [];

  return (
    <PageShell>
      {/* Keine große Uhr – sie wiederholte nur „Stand …“ daneben. */}
      <header className="grid min-w-0 gap-1.5">
        <h1 className="font-display text-title font-semibold text-a-ink">
          {greetingFor(now, data.greetingName)}
        </h1>
        <p className="text-callout text-a-mut">
          <span className="text-a-ink">{dateFmt.format(now)}</span>
          <span aria-hidden className="mx-2 text-a-mut">·</span>
          <span data-testid="overview-lage">{data.lage ?? situationSentence(data.counts)}</span>
          <span aria-hidden className="mx-2 text-a-mut">·</span>
          <span data-testid="overview-stand" className="font-mono text-caption" title={t("Alle Zahlen dieser Seite stammen aus diesem Stand")}>
            {t("Stand {time}", { time: standFmt.format(new Date(data.generatedAt)) })}
          </span>
        </p>
      </header>

      {/* „Seit du weg warst“ ganz oben – was ist fertig, was hängt, was ist neu. */}
      <SinceCard collapsible place="overview" />

      {/* Fehlende Schlüssel/Tokens (Telegram, Modelle, Ideen-Postfach) – ein Klick zum Assistenten. */}
      <AccessHint />

      {/* Oben nur, was zum Handeln führt (höchstens 4), dann alle Null-Werte in einer Zeile. */}
      <section aria-label={t("Zum Handeln")} className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
        {groups.action.map((tile, i) => (
          <div key={tile.key} className="cc-stagger min-w-0" style={{ animationDelay: `${i * 30}ms` }}>
            <MetricCard tile={tile} />
          </div>
        ))}
      </section>

      {groups.zero.length > 0 && <CalmLine tiles={groups.zero} urgent={groups.action.some((m) => (URGENT_KEYS as readonly string[]).includes(m.key))} />}

      <BriefingTeaser fingerprint={data.fingerprint} />

      {groups.calm.length > 0 && (
        <Panel title={t("Weitere Kennzahlen")}>
          <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
            {groups.calm.map((tile) => (
              <MetricCard key={tile.key} tile={tile} quiet />
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t("Commits · 14 Tage")} action={<PanelLink to="/git">{t("Zu Git")}</PanelLink>}>
        <Card className="grid gap-1 p-4">
          <p className="text-callout text-a-mut">
            <span className="font-display text-title2 font-semibold tabular-nums text-a-ink">{commitsTotal}</span> {t("Commits, heute hervorgehoben")}
          </p>
          <BarChart
            data={data.commits.map((d) => ({ x: d.date, value: d.human + d.claude + d.codex }))}
            height={190}
            unit="Commits"
            color={toneVar(metricTone("commits_7d"))}
            ariaLabel={t("Commits je Tag, letzte 14 Tage")}
            formatTick={formatDayShort}
            formatTooltipX={formatDayLong}
            onSelect={() => navigate("/git")}
          />
        </Card>
      </Panel>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 md:grid-cols-[repeat(2,minmax(0,1fr))]">
        <Panel title={t("Kritische Sessions")} action={<PanelLink to="/sessions">{t("Alle Sessions")}</PanelLink>}>
          <Card className="grid content-start gap-0.5 p-1.5">
            {data.criticalSessions.length === 0 && <EmptyLine>{t("Nichts abgestürzt, nichts wartet. Alles im Fluss.")}</EmptyLine>}
            {data.criticalSessions.map((s) => {
              const meta = stateMeta(s.state as never);
              return (
                <Link key={s.sessionKey} to={s.href} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-callout transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11">
                  <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                  {/* Name vom Server nach `sessionLabel` – nie „(noch ohne Titel)“ oder eine Kennung. */}
                  <span className="truncate text-a-ink">{s.label}</span>
                  <span className={cn("rounded-full px-2 py-0.5 font-mono text-label", meta.bg, meta.text)}>{s.reason}</span>
                </Link>
              );
            })}
            {(data.orphanedSessions ?? []).length > 0 && <OrphanedSessions sessions={data.orphanedSessions} total={data.orphanedTotal ?? data.orphanedSessions.length} />}
          </Card>
        </Panel>

        <Panel
          title={activeBaustellen > 0 ? t("Baustellen · {n} aktiv", { n: activeBaustellen }) : t("Baustellen")}
          label={t("Baustellen")}
          action={<PanelLink to="/tasks">{t("Aufgaben")}</PanelLink>}
        >
          <Card className="grid content-start gap-0.5 p-1.5">
            {data.baustellen.length === 0 && <EmptyLine>{t("Noch keine Baustelle mit Sessions.")}</EmptyLine>}
            {(allBaustellen ? data.baustellen : data.baustellen.slice(0, BAUSTELLEN_LIMIT)).map((b) => (
              <Link key={b.slug} to={`/sessions/coding/${b.slug}`} className="grid gap-1.5 rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-callout">
                  <span className="truncate text-a-ink">{b.label}</span>
                  <span className="font-mono text-caption tabular-nums text-a-mut">
                    {b.progressPct !== null && <span className="text-a-ink">{b.progressPct} %</span>}
                    {b.progressPct !== null && <span aria-hidden className="mx-1.5 text-a-mut">·</span>}
                    {b.openSessions === 0 ? t("keine offen") : t("{n} offen", { n: b.openSessions })}
                  </span>
                </div>
                {b.progressPct !== null && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-a-p3">
                    <div className="cc-progress-fill h-full rounded-full bg-a-acc" style={{ width: `${b.progressPct}%` }} />
                  </div>
                )}
              </Link>
            ))}
            {data.baustellen.length > BAUSTELLEN_LIMIT && (
              <button type="button" aria-expanded={allBaustellen} onClick={() => setAllBaustellen((v) => !v)} className="mx-1 mt-1 w-fit rounded-md px-2 py-1 text-caption text-a-mut transition-colors hover:bg-a-p2 hover:text-a-ink">
                {allBaustellen ? t("Weniger anzeigen") : t("Alle Baustellen ({n} weitere)", { n: data.baustellen.length - BAUSTELLEN_LIMIT })}
              </button>
            )}
          </Card>
        </Panel>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 md:grid-cols-[repeat(2,minmax(0,1fr))]">
        {/* Was zuletzt fertig wurde — Sessions (sauber beendet/geschlossen) und erledigte Aufträge. */}
        <Panel title={t("Zuletzt fertig")} action={<PanelLink to="/tasks">{t("Aufgaben")}</PanelLink>}>
          <Card className="grid content-start gap-0.5 p-1.5">
            {recentDone.length === 0 && <EmptyLine>{t("Noch nichts fertig geworden.")}</EmptyLine>}
            {recentDone.map((d) => (
              <Link key={d.id} to={d.href} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-callout transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11">
                <span className={cn("h-2 w-2 rounded-full", d.kind === "entry" ? "bg-a-acc" : "bg-a-ok")} />
                <span className="grid min-w-0">
                  <span className="truncate text-a-ink">{d.title}</span>
                  <span className="truncate text-caption text-a-mut">{d.label}</span>
                </span>
                <span className="font-mono text-label tabular-nums text-a-mut">{relativeTime(d.at) ?? ""}</span>
              </Link>
            ))}
          </Card>
        </Panel>

        <Panel title={t("Startklar")} label={t("Startklar")} action={<PanelLink to="/tasks">{t("Zu den Aufgaben")}</PanelLink>}>
          <Card className="grid content-start gap-1 p-1.5">
            {startklar.length === 0 && <EmptyLine>{t("Gerade ist kein Auftrag startklar.")}</EmptyLine>}
            {startklar.slice(0, STARTKLAR_LIMIT).map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                onOpen={() => navigate(`/tasks?e=${entry.id}`)}
                onStart={() => startEntry.mutate(entry.id)}
                starting={startEntry.isPending && startEntry.variables === entry.id}
              />
            ))}
          </Card>
        </Panel>
      </div>

      <OpsPanel deliveries={data?.pendingDeliveries} />
    </PageShell>
  );
}

/** Projekt-Container (alles außer NyxOS selbst und „Andere“) in einer Zeile — echte Zahlen, oder was wirklich fehlt. */
function ProjectContainersLine({ server }: { server: ServerSnapshot }) {
  const local = useAppInfo().data?.mode === "local";
  const cc = server.containers.filter((c) => c.group !== "nyxos" && c.group !== "andere");
  if (server.docker.available && cc.length === 0) return null;
  // Lokal ist Docker freiwillig — ohne Docker-Zugang fehlt nichts, also auch keine gelbe „fehlt noch“-Zeile.
  if (local && !server.docker.available) return null;
  const troubled = cc.filter(isTroubled);
  const running = cc.filter(isSteadyRunning).length;
  const tone = !server.docker.available ? "bg-a-wait" : troubled.length > 0 ? "bg-a-bad" : "bg-a-ok";
  const text = !server.docker.available
    ? t("Projekt-Container: Ansicht fehlt noch – Details im Server-Tab")
    : troubled.length > 0
      ? t("Projekt-Container: {bad} von {total} gestört ({names})", { bad: troubled.length, total: cc.length, names: troubled.map((c) => c.name).join(", ") })
      : t("Projekt-Container: {running} von {total} laufen gesund", { running, total: cc.length });
  return (
    <Link to="/server" className="grid grid-cols-[8px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-2 text-callout transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11">
      <span className={cn("h-2 w-2 rounded-full", tone)} />
      <span className="truncate text-a-mut">{text}</span>
    </Link>
  );
}

const briefingTimeFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });

/** Der Satz, den der Teaser zeigt: der erste Satz des Briefings (der Lage-Satz steht schon im Kopf). */
function teaserText(r: HaikuReport): string {
  return r.sections[0]?.statements[0]?.text ?? r.lage;
}

/**
 * Teaser des echten Briefings (gleicher Query-Key wie `Briefing.tsx` → Live-Invalidierung über `useHaikuLive`).
 * Passt das Briefing nicht mehr zum jetzigen Stand (`stale`), zeigt der Teaser KEINE alten Zahlen
 * („Keine Session läuft“ neben „1 läuft“), sondern sagt ehrlich, dass sich etwas geändert hat.
 */
function BriefingTeaser({ fingerprint }: { fingerprint: string | undefined }) {
  const report = useQuery({ queryKey: ["haiku", "report", "briefing"], queryFn: () => fetchReport("briefing") });
  const raw = report.data ?? null;
  // Der Überblick lädt alle 30 s neu, das Briefing nicht — „aktuell“ heißt deshalb: derselbe
  // Fingerabdruck wie der Stand, den die Kopfzeile gerade zeigt (nicht nur „beim Laden noch aktuell“).
  const data = raw && fingerprint && raw.snapshot && raw.snapshot.fingerprint !== fingerprint ? { ...raw, stale: true } : raw;
  const time = data ? briefingTimeFmt.format(new Date(data.snapshot?.at ?? data.createdAt)) : "";
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-a-line bg-a-p px-4 py-3 text-callout" data-testid="briefing-teaser">
      <span aria-hidden className="text-a-acc">✦</span>
      {data && data.stale ? (
        <p className="min-w-0 flex-1 text-a-mut">{t("Seit dem Briefing von {time} hat sich etwas geändert – beim Öffnen wird es neu geschrieben.", { time })}</p>
      ) : data ? (
        <p className="min-w-0 flex-1 text-a-ink">
          <span className="mr-2 font-mono text-caption text-a-mut">{t("Briefing von {time}", { time })}</span>
          {teaserText(data)}
        </p>
      ) : (
        <p className="min-w-0 flex-1 text-a-mut">{report.isLoading ? t("Briefing wird geladen …") : t("Noch kein Briefing für heute. Nyx schreibt es morgens von selbst, oder du erstellst es jetzt.")}</p>
      )}
      <Link to="/briefing" className="shrink-0 text-caption text-a-acc hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
        {data?.stale ? t("Neu schreiben →") : t("Zum Briefing →")}
      </Link>
    </div>
  );
}

const BUILD_STATE_LABEL: Record<BuildGroup["state"], string> = { queued: t("wartet"), running: t("baut …"), green: t("grün"), red: t("rot"), unavailable: t("nicht eingerichtet") };
const BUILD_STATE_DOT: Record<BuildGroup["state"], string> = { queued: "bg-a-dim", running: "bg-a-wait", green: "bg-a-ok", red: "bg-a-bad", unavailable: "bg-a-wait" };

function OpsRow({ to, dot, children, sub }: { to: string; dot: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <Link to={to} className="grid grid-cols-[8px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-2 text-callout transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11">
      <span className={cn("h-2 w-2 rounded-full", dot)} />
      <span className="grid min-w-0">
        <span className="truncate text-a-ink">{children}</span>
        {sub && <span className="truncate text-caption text-a-mut">{sub}</span>}
      </span>
    </Link>
  );
}

/** Zustell-Warteschlange – Zahl aus demselben Schnappschuss, Klick führt zur Session mit der ältesten Nachricht. */
function DeliveriesRow({ deliveries }: { deliveries: PendingDeliveries }) {
  // Leere Warteschlange: keine Zeile (nichts zu tun); die Zeile erscheint, sobald etwas wartet.
  if (deliveries.count === 0 || !deliveries.href) return null;
  const title = deliveries.title ?? "Session";
  const sub =
    deliveries.sessions > 1
      ? t("{title} (+{n} weitere Sessions) – wird zugestellt, sobald die Session bereit ist", { title, n: deliveries.sessions - 1 })
      : t("{title} – wird zugestellt, sobald die Session bereit ist", { title });
  return (
    <OpsRow to={deliveries.href} dot="bg-a-wait" sub={sub}>
      {deliveries.count === 1 ? t("1 Nachricht wartet auf Zustellung") : t("{n} Nachrichten warten auf Zustellung", { n: deliveries.count })}
    </OpsRow>
  );
}

/**
 * „2 verwaiste Sessions – aufräumen?“. Geister-Sessions (warten > 1 Tag, nie eine
 * Nachricht) zählen nicht als „wartet auf dich“; hier kannst du sie gezielt schließen – jede einzeln und nur
 * nach Rückfrage (CloseDialog). Nichts wird von selbst geschlossen.
 */
function OrphanedSessions({ sessions, total }: { sessions: CriticalSession[]; total: number }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<CriticalSession | null>(null);
  const close = useCloseSession();
  // Der Server schickt höchstens 20 – die Zahl in der Zeile ist trotzdem die echte.
  const n = Math.max(total, sessions.length);
  const more = n - sessions.length;
  const cancel = () => {
    close.reset();
    setConfirm(null);
  };
  return (
    <div className="mt-1 border-t border-a-line pt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="orphaned-list"
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-callout text-a-mut transition-colors duration-150 hover:bg-a-p2 hover:text-a-ink"
      >
        <span aria-hidden className={cn("h-2 w-2 rounded-full", ORPHANED_META.dot)} />
        <span className="truncate">{n === 1 ? t("1 verwaiste Session – aufräumen?") : t("{n} verwaiste Sessions – aufräumen?", { n })}</span>
        <span aria-hidden className="text-caption">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul id="orphaned-list" data-testid="orphaned-list" className="grid gap-0.5 pb-1">
          {sessions.map((s) => (
            <li key={s.sessionKey} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-a-p2">
              <Link to={s.href} className="grid min-w-0 text-callout">
                <span className="truncate text-a-ink">{s.label}</span>
                <span className="truncate text-caption text-a-mut">{s.reason}</span>
              </Link>
              <Button variant="ghost" onClick={() => setConfirm(s)} aria-label={t("Schließen: {label}", { label: s.label })} className="h-(--a-ctl-h) py-0">
                {t("Schließen")}
              </Button>
            </li>
          ))}
          {more > 0 && (
            <li className="px-2.5 py-1.5 text-caption text-a-mut">
              {more === 1 ? t("1 weitere") : t("{n} weitere", { n: more })} –{" "}
              <Link to="/sessions" className="text-a-ink underline-offset-2 hover:underline">
                {t("alle unter Sessions")}
              </Link>
            </li>
          )}
        </ul>
      )}
      <CloseDialog
        open={confirm !== null}
        sessionTitle={confirm?.label ?? ""}
        pending={close.isPending}
        error={close.isError ? t("Das Schließen hat nicht geklappt. Bitte noch einmal versuchen.") : null}
        onConfirm={() => confirm && close.mutate(confirm.sessionKey, { onSuccess: () => setConfirm(null) })}
        onCancel={cancel}
      />
    </div>
  );
}

/**
 * „Betrieb“ — Server, Brücke (mit Verlauf 24 h), letzter Deploy und Build-Zustand
 * (gebündelt, je Projekt der jüngste Stand). Jede Zeile führt zum Server-Tab. Nur echte Daten: was
 * (noch) nicht geladen ist, fehlt, statt geraten zu werden.
 */
/** „vor 5 Min“ / „5 min ago“ → „5 Min“ / „5 min“ (für „verbunden seit …“). */
function sinceWithoutAgo(rel: string | null): string | null {
  if (!rel) return null;
  return getLang() === "en" ? rel.replace(/\s+ago$/, "") : rel.replace(/^vor /, "");
}

function OpsPanel({ deliveries }: { deliveries?: PendingDeliveries }) {
  const { data: server } = useServerSnapshot();
  const { data: presence } = useBridgePresence();
  const { data: history } = useBridgeHistory(true);
  const { data: groups } = useBuildGroups();
  const lastDeploy = server?.deploys?.[0] ?? null;
  const drops = (history ?? []).filter((h) => h.state !== "online").length;
  // Je Projekt die jüngste Gruppe (die Liste kommt jüngste zuerst).
  const latestByKind = new Map<BuildKind, BuildGroup>();
  for (const g of groups ?? []) if (!latestByKind.has(g.kind)) latestByKind.set(g.kind, g);
  const bridgeSince = presence ? relativeTime(presence.since, Date.parse(presence.serverNow)) : null;

  return (
    <Panel title={t("Betrieb")} action={<PanelLink to="/server">{t("Server-Tab")}</PanelLink>}>
      <Card className="grid content-start gap-0.5 p-1.5 md:grid-cols-[repeat(2,minmax(0,1fr))]">
        <OpsRow to="/server" dot={server?.nyxosHealthy ? "bg-a-ok" : "bg-a-wait"}>
          {server ? (server.nyxosHealthy ? t("NyxOS läuft") : t("NyxOS meldet ein Problem")) : t("NyxOS wird geprüft …")}
        </OpsRow>
        {presence && (
          <OpsRow
            to="/server"
            dot={presence.state === "online" ? "bg-a-ok" : presence.state === "reconnecting" ? "bg-a-wait" : "bg-a-bad"}
            sub={history ? (drops === 0 ? t("Keine Aussetzer in 24 Std") : t("{n} Aussetzer in 24 Std", { n: drops })) : null}
          >
            {presence.state === "online"
              ? t("Brücke verbunden seit {since}", { since: sinceWithoutAgo(bridgeSince) ?? t("eben") })
              : presence.state === "reconnecting"
                ? t("Brücke verbindet neu …")
                : presence.reason
                  ? t("Brücke getrennt – {reason}", { reason: presence.reason })
                  : t("Brücke getrennt")}
          </OpsRow>
        )}
        {lastDeploy && (
          <OpsRow to="/server" dot="bg-a-acc" sub={`${lastDeploy.project === "nyxos" ? "NyxOS" : lastDeploy.project}${lastDeploy.gitRev ? ` · ${t("Stand {time}", { time: lastDeploy.gitRev.slice(0, 7) })}` : ""}`}>
            {t("Letzter Deploy {when}", { when: relativeTime(lastDeploy.createdAt) ?? "" })}
          </OpsRow>
        )}
        {[...latestByKind.values()].map((g) => (
          <OpsRow key={g.key} to="/server" dot={BUILD_STATE_DOT[g.state]} sub={g.state === "red" || g.state === "unavailable" ? g.sentence : null}>
            {t(BUILD_KIND_LABEL[g.kind])}: {BUILD_STATE_LABEL[g.state]} · {formatBuildCount(g)}
          </OpsRow>
        ))}
        {deliveries && <DeliveriesRow deliveries={deliveries} />}
        {server && <ProjectContainersLine server={server} />}
      </Card>
    </Panel>
  );
}
