// Tab "Agenten" (die Skill-Bibliothek ist der eigene Tab „Skills“): Kennzahlen · läuft gerade · heute abgeschlossen · alle Agenten
// (als Kacheln, Klick → Großansicht `?agent=`) · Skills · Auffälligkeiten.
// Ruhige Listen, Status als Pill links, ganze Zeile klickbar → Großansicht über `?run=`/`?skill=`
// (die URL bleibt die eine Quelle der Wahrheit, wie im Sessions-Tab).
import { locale, t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { PageShell } from "../../components/PageShell";
import { StatCard } from "../../components/charts";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { fetchAgentRuns, fetchAnomalies, fetchCatalog, fetchSkillUsage, type AgentRun } from "./api";
import { buildAgentTiles } from "./agentTileModel";
import { AgentTileSection } from "./AgentTiles";
import { formatDurationMs } from "./format";

const numberFmt = new Intl.NumberFormat(locale());
const TODAY_LIMIT = 8;
const DAY_MS = 86_400_000;

type Verdict = AgentRun["verdict"];

const VERDICT: Record<NonNullable<Verdict> | "none" | "running", { label: string; cls: string }> = {
  running: { label: t("läuft"), cls: "bg-a-ok/12 text-a-ok" },
  PASS: { label: "PASS", cls: "bg-a-ok/12 text-a-ok" },
  PASS_WITH_NOTES: { label: t("mit Hinweisen"), cls: "bg-a-wait/12 text-a-wait" },
  BLOCK: { label: "BLOCK", cls: "bg-a-bad/12 text-a-bad" },
  none: { label: t("ohne Urteil"), cls: "bg-a-p3 text-a-mut" },
};

function StatusPill({ run }: { run: AgentRun }) {
  const v = run.running ? VERDICT.running : VERDICT[run.verdict ?? "none"];
  return (
    <span className={cn("inline-flex w-[104px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium", v.cls)}>
      {run.running && <span aria-hidden className="cc-pulse h-1.5 w-1.5 rounded-full bg-a-ok" />}
      {v.label}
    </span>
  );
}

/** Nur für die Großansicht: Urteil in Langform. */
function VerdictPill({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict ?? "none"];
  const label = verdict === "PASS_WITH_NOTES" ? t("PASS mit Hinweisen") : v.label;
  return <span className={cn("rounded-full px-2 py-0.5 text-caption font-medium", v.cls)}>{label}</span>;
}

/** Dauer als dünner Balken relativ zum längsten Wert der Liste + Text. */
function DurationBar({ ms, max }: { ms: number | null; max: number }) {
  const pct = ms === null || max <= 0 ? 0 : Math.max(3, (ms / max) * 100);
  return (
    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_78px] items-center gap-2">
      <span className="h-1 overflow-hidden rounded-full bg-a-p3" aria-hidden>
        <span className="cc-progress-fill block h-full rounded-full bg-a-acc/70" style={{ width: `${pct}%` }} />
      </span>
      <span className="whitespace-nowrap text-right font-mono text-caption tabular-nums text-a-mut">{formatDurationMs(ms)}</span>
    </span>
  );
}

function runMs(r: AgentRun, now: number): number | null {
  if (r.durationMs !== null) return r.durationMs;
  if (r.running && r.startedAt) return Math.max(0, now - Date.parse(r.startedAt));
  return null;
}

const RUN_COLS = "grid-cols-[104px_minmax(0,1fr)] md:grid-cols-[104px_minmax(0,1fr)_minmax(150px,210px)_88px]";

function RunRow({ run, maxMs, now, index, onOpen }: { run: AgentRun; maxMs: number; now: number; index: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-run-id={run.id}
      className={cn("cc-stagger grid w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-callout transition-colors duration-150 hover:bg-a-p2", RUN_COLS)}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <StatusPill run={run} />
      <span className="grid min-w-0">
        <span className="truncate font-medium text-a-ink">{run.agentName ?? t("unbekannter Agent")}</span>
        <span className="truncate text-caption text-a-mut">
          {run.parentTitle ?? t("ohne Eltern-Session")} · {t("{n} Aufrufe", { n: numberFmt.format(run.toolCalls) })}
        </span>
      </span>
      <span className="hidden md:block">
        <DurationBar ms={runMs(run, now)} max={maxMs} />
      </span>
      <span className="hidden whitespace-nowrap text-right font-mono text-caption tabular-nums text-a-mut md:block">{relativeTime(run.endedAt ?? run.startedAt, now) ?? "—"}</span>
    </button>
  );
}

function Section({ title, count, sub, children, action }: { title: string; count?: number; sub?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="cc-card-deep grid min-w-0 content-start gap-2 rounded-xl border border-a-line p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="flex items-center gap-2 font-mono text-label font-semibold uppercase tracking-wider text-a-mut">
          {title}
          {count !== undefined && <span className="rounded-full bg-a-p3 px-1.5 py-0.5 text-label tabular-nums text-a-mut">{count}</span>}
        </h2>
        {action}
      </div>
      {sub && <p className="px-1 text-caption text-a-mut">{sub}</p>}
      {children}
    </section>
  );
}

/** Skills haben ihren eigenen Tab – von hier nur noch ein Sprung dorthin (die Leiste nennt Skills einmal). */
function SkillsLink() {
  return (
    <Link
      to="/skills"
      className="inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-md border border-a-line px-3 text-callout text-a-ink transition-colors duration-150 hover:border-a-violet/60 hover:bg-a-p2"
    >
      <span aria-hidden="true" className="text-a-violet">❖</span>
      Skills
      <span aria-hidden="true">→</span>
    </Link>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="grid min-h-[96px] place-items-center text-center text-callout text-a-mut">{children}</p>;
}

function MoreButton({ open, hidden, onToggle }: { open: boolean; hidden: number; onToggle: () => void }) {
  if (hidden <= 0 && !open) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="mx-1 mt-1 w-fit rounded-md px-2 py-1 text-caption text-a-mut transition-colors hover:bg-a-p2 hover:text-a-ink">
      {open ? t("Weniger anzeigen") : t("Alle anzeigen ({n} weitere)", { n: hidden })}
    </button>
  );
}

export function AgentsView() {
  const [params, setParams] = useSearchParams();
  const [showAllToday, setShowAllToday] = useState(false);
  const runsQ = useQuery({ queryKey: ["agent-runs"], queryFn: () => fetchAgentRuns() });
  const catalogQ = useQuery({ queryKey: ["agent-catalog"], queryFn: fetchCatalog });
  const skillsQ = useQuery({ queryKey: ["skill-usage"], queryFn: fetchSkillUsage });
  const anomaliesQ = useQuery({ queryKey: ["agent-anomalies"], queryFn: fetchAnomalies });
  const now = Date.now();

  const derived = useMemo(() => {
    const runs = runsQ.data ?? [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();
    const endedIn = (from: number, to: number) => runs.filter((r) => !r.running && r.endedAt && Date.parse(r.endedAt) >= from && Date.parse(r.endedAt) < to);
    const finishedToday = endedIn(t0, Number.POSITIVE_INFINITY).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    const finishedYesterday = endedIn(t0 - DAY_MS, t0);
    const perDay = Array.from({ length: 14 }, (_, i) => endedIn(t0 - (13 - i) * DAY_MS, t0 - (12 - i) * DAY_MS).length);
    const judged = runs.filter((r) => r.verdict !== null);
    const durations = runs.map((r) => r.durationMs).filter((d): d is number => d !== null).sort((a, b) => a - b);
    return {
      runs,
      running: runs.filter((r) => r.running),
      finishedToday,
      finishedYesterday: finishedYesterday.length,
      perDay,
      judged: judged.length,
      passRate: judged.length ? (judged.filter((r) => r.verdict === "PASS").length / judged.length) * 100 : null,
      medianMs: durations.length ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
    };
  }, [runsQ.data]);
  // Eine Kachel je Agent (Läufe je Agent-Typ + Bestand mit Modell/Werkzeugen/Prompt).
  const tiles = useMemo(() => buildAgentTiles(runsQ.data ?? [], catalogQ.data ?? [], Date.now()), [runsQ.data, catalogQ.data]);

  if (runsQ.isPending) {
    return (
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-4 md:p-6" aria-busy>
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[148px] rounded-xl" />)}
        </div>
        <Skeleton className="h-[240px] rounded-xl" />
      </div>
    );
  }
  if (runsQ.isError) {
    return (
      <div className="grid place-items-center p-10 text-center">
        <p className="mb-3 text-callout text-a-mut">{t("Agenten-Läufe konnten nicht geladen werden.")}</p>
        <button type="button" onClick={() => void runsQ.refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">{t("Erneut versuchen")}</button>
      </div>
    );
  }

  const { runs, running, finishedToday } = derived;
  const catalog = catalogQ.data ?? [];
  const skillUsage = skillsQ.data ?? [];
  const skillCatalog = new Map(catalog.filter((c) => c.kind === "skill").map((c) => [c.name, c]));
  const openRun = params.get("run");
  const openSkill = params.get("skill");
  const openAgent = params.get("agent");
  const selectedRun = runs.find((r) => r.id === openRun) ?? null;
  const selectedSkill = openSkill ? { name: openSkill, stat: skillUsage.find((s) => s.skill === openSkill) ?? null, catalog: skillCatalog.get(openSkill) ?? null } : null;
  const closeDetail = () => setParams((p) => { p.delete("run"); p.delete("skill"); return p; }, { replace: true });
  const openRunDetail = (id: string) => setParams((p) => { p.delete("skill"); p.set("run", id); return p; });
  const openAgentDetail = (key: string) => setParams((p) => { p.set("agent", key); return p; });
  const closeAgentDetail = () => setParams((p) => { p.delete("agent"); return p; }, { replace: true });

  const todayVisible = showAllToday ? finishedToday : finishedToday.slice(0, TODAY_LIMIT);
  const maxRunMs = Math.max(0, ...[...running, ...todayVisible].map((r) => runMs(r, now) ?? 0));
  const maxSkillRuns = Math.max(1, ...skillUsage.map((s) => s.runs7d));

  return (
    <PageShell gap="gap-4">
      <PageHeader
        title={t("Agenten")}
        sub={`${running.length === 0 ? t("Gerade läuft kein Agent") : running.length === 1 ? t("1 Agent läuft gerade") : t("{n} Agenten laufen gerade", { n: running.length })} · ${t("{n} heute fertig", { n: finishedToday.length })} · ${t("{n} verschiedene Agenten", { n: tiles.length })}`}
        actions={<SkillsLink />}
      />

      {selectedRun && <RunDetail run={selectedRun} onClose={closeDetail} />}
      {selectedSkill && <SkillDetail skill={selectedSkill} onClose={closeDetail} />}

      <section aria-label={t("Kennzahlen")} className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
        <StatCard id="agents-running" label={t("Laufen gerade")} value={running.length} format={(n) => String(Math.round(n))} caption={running.length === 0 ? t("alles ruhig") : t("längster seit {d}", { d: formatDurationMs(Math.max(...running.map((r) => runMs(r, now) ?? 0))) })} />
        <StatCard
          id="agents-today"
          label={t("Heute fertig")}
          value={finishedToday.length}
          format={(n) => String(Math.round(n))}
          trend={{ current: finishedToday.length, previous: derived.finishedYesterday, period: t("ggü. gestern"), upIsGood: null }}
          sparkline={derived.perDay}
          sparklineLabel={t("fertige Läufe je Tag · 14 T")}
        />
        <StatCard id="agents-pass" label={t("PASS-Quote")} value={derived.passRate === null ? null : Math.round(derived.passRate)} format={(n) => `${Math.round(n)} %`} caption={derived.judged === 0 ? t("noch kein Urteil erfasst") : t("aus {n} Läufen mit Urteil", { n: derived.judged })} />
        <StatCard id="agents-median" label={t("Typische Dauer")} value={derived.medianMs === null ? null : derived.medianMs / 1000} format={(n) => formatDurationMs(n * 1000)} caption={t("Median aller Läufe")} />
      </section>

      <Section title={t("Läuft gerade")} count={running.length}>
        {running.length === 0 ? (
          <EmptyLine>{t("Gerade läuft kein Agent.")}</EmptyLine>
        ) : (
          <div className="grid gap-0.5">
            {running.map((r, i) => <RunRow key={r.id} run={r} maxMs={maxRunMs} now={now} index={i} onOpen={() => openRunDetail(r.id)} />)}
          </div>
        )}
      </Section>

      <Section title={t("Heute abgeschlossen")} count={finishedToday.length}>
        {finishedToday.length === 0 ? (
          <EmptyLine>{t("Heute ist noch kein Agent fertig geworden.")}</EmptyLine>
        ) : (
          <div className="grid gap-0.5">
            {todayVisible.map((r, i) => <RunRow key={r.id} run={r} maxMs={maxRunMs} now={now} index={i} onOpen={() => openRunDetail(r.id)} />)}
            <MoreButton open={showAllToday} hidden={finishedToday.length - TODAY_LIMIT} onToggle={() => setShowAllToday((v) => !v)} />
          </div>
        )}
      </Section>

      <AgentTileSection tiles={tiles} openKey={openAgent} now={now} onOpen={openAgentDetail} onClose={closeAgentDetail} onOpenRun={openRunDetail} />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
        <Section title={t("Skills genutzt · 7 Tage")} count={skillUsage.length}>
          {skillUsage.length === 0 ? (
            <EmptyLine>{t("Keine Skill-Nutzung in den letzten 7 Tagen.")}</EmptyLine>
          ) : (
            <div className="grid gap-0.5">
              {skillUsage.map((s, i) => (
                <button
                  key={s.skill}
                  type="button"
                  onClick={() => setParams((p) => { p.delete("run"); p.set("skill", s.skill); return p; })}
                  data-skill-name={s.skill}
                  className="cc-stagger grid grid-cols-[minmax(0,1fr)_minmax(64px,120px)_88px] items-center gap-3 rounded-lg px-2.5 py-2 text-left text-callout transition-colors duration-150 hover:bg-a-p2"
                  style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                >
                  <span className="truncate font-medium text-a-ink">/{s.skill}</span>
                  <span className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-2">
                    <span className="h-1 overflow-hidden rounded-full bg-a-p3" aria-hidden>
                      <span className="cc-progress-fill block h-full rounded-full bg-a-acc/70" style={{ width: `${(s.runs7d / maxSkillRuns) * 100}%` }} />
                    </span>
                    <span className="text-right font-mono text-caption tabular-nums text-a-ink">{s.runs7d}×</span>
                  </span>
                  <span className="whitespace-nowrap text-right font-mono text-caption tabular-nums text-a-mut">{relativeTime(s.lastUsedAt, now) ?? "—"}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
        <Section title={t("Auffälligkeiten")} count={anomaliesQ.data?.length ?? 0}>
          {!anomaliesQ.data || anomaliesQ.data.length === 0 ? (
            <EmptyLine>{t("Keine Auffälligkeiten.")}</EmptyLine>
          ) : (
            <ul className="grid gap-1">
              {anomaliesQ.data.map((a, i) => (
                <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-lg px-2.5 py-2 text-callout text-a-ink">
                  <span className="mt-px rounded-full bg-a-wait/12 px-2 py-0.5 text-label font-medium text-a-wait">{t("Hinweis")}</span>
                  <span className="min-w-0">
                    {a.kind === "skill_unused" && (
                      <>
                        Skill{" "}
                        <button type="button" className="underline decoration-a-line underline-offset-2 hover:decoration-a-ink" onClick={() => setParams((p) => { p.delete("run"); p.set("skill", a.skill); return p; })}>
                          /{a.skill}
                        </button>{" "}
                        {a.sinceDays < 0 ? t("wurde noch nie genutzt.") : t("seit {n} Tagen nicht genutzt.", { n: a.sinceDays })}
                      </>
                    )}
                    {a.kind === "gate_repeated_block" && <>{t("Prüf-Agent {name} blockt dieselbe Session wiederholt ({count}×).", { name: a.agentName, count: a.count })}</>}
                    {a.kind === "skill_missing_required" && <>{t("Pflicht-Skill /{skill}: nur {actual}× statt {expected}× in 7 Tagen.", { skill: a.skill, actual: a.actual, expected: a.expectedPer7d })}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </PageShell>
  );
}

function DetailShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div data-testid="agent-detail" className="grid min-w-0 gap-2 rounded-xl border border-a-acc/40 bg-a-p2 p-4 shadow-[0_8px_24px_rgba(0,0,0,.35)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="truncate font-display text-headline font-semibold text-a-ink">{title}</h2>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">{t("Schließen")} ✕</button>
      </div>
      {children}
    </div>
  );
}

function RunDetail({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  return (
    <DetailShell title={run.agentName ?? t("Agenten-Lauf")} onClose={onClose}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-callout">
        <dt className="text-a-mut">{t("Werkzeug")}</dt><dd>{run.tool === "claude" ? "Claude" : "Codex"}</dd>
        <dt className="text-a-mut">{t("Eltern-Session")}</dt><dd className="truncate">{run.parentTitle ?? run.parentSessionKey ?? "—"}</dd>
        <dt className="text-a-mut">{t("Start")}</dt><dd className="font-mono tabular-nums">{formatDateTime(run.startedAt)}</dd>
        <dt className="text-a-mut">{t("Ende")}</dt><dd className="font-mono tabular-nums">{run.running ? t("läuft noch") : formatDateTime(run.endedAt)}</dd>
        <dt className="text-a-mut">{t("Dauer")}</dt><dd className="font-mono tabular-nums">{formatDurationMs(runMs(run, Date.now()))}</dd>
        <dt className="text-a-mut">{t("Werkzeug-Aufrufe")}</dt><dd className="font-mono tabular-nums">{numberFmt.format(run.toolCalls)}</dd>
        <dt className="text-a-mut">{t("Urteil")}</dt><dd>{run.running ? <StatusPill run={run} /> : <VerdictPill verdict={run.verdict} />}</dd>
      </dl>
    </DetailShell>
  );
}

function SkillDetail({ skill, onClose }: { skill: { name: string; stat: { runs7d: number; lastUsedAt: string | null } | null; catalog: { description: string | null; path: string } | null }; onClose: () => void }) {
  return (
    <DetailShell title={`/${skill.name}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-callout">
        <dt className="text-a-mut">{t("Beschreibung")}</dt><dd>{skill.catalog?.description ?? "—"}</dd>
        <dt className="text-a-mut">{t("Läufe (7 Tage)")}</dt><dd className="font-mono tabular-nums">{skill.stat?.runs7d ?? 0}</dd>
        <dt className="text-a-mut">{t("Zuletzt genutzt")}</dt><dd>{relativeTime(skill.stat?.lastUsedAt ?? null) ?? t("nie")}</dd>
        <dt className="text-a-mut">{t("Pfad")}</dt><dd className="truncate font-mono text-caption" title={skill.catalog?.path}>{skill.catalog?.path ?? "—"}</dd>
      </dl>
    </DetailShell>
  );
}
