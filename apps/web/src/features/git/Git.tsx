// Git-Seite. Von oben nach unten: Lage-Satz → Kennzahlen → Heatmap 12 Wochen → Letzte Merges → Aktions-Log → App-Repo
// → Worktrees (Karten) → NyxOS (Agenten-Arbeitskopien) → weitere Repos. Jede Art hat eigene
// Farbe und eigene Inhalte. Nichts lädt endlos: Skelette mit fester Höhe, dann Daten oder EIN
// erklärender Satz (Brücke scannt gerade / Brücke offline). Klicks öffnen Großansichten (GitOverlay).
import { t, uncommittedCaption, uncommittedDetail, uncommittedTotalsOf, type GitActionRowKind, type GitDashboard } from "@nyxos/shared";
import { useState } from "react";
import { Link } from "react-router";
import { StatCard } from "../../components/charts/StatCard";
import { CONNECTIONS_HREF } from "../../components/ConnectionStatus";
import { PageShell } from "../../components/PageShell";
import { Skeleton } from "../../components/ui/skeleton";
import { useGitDashboard } from "../../hooks/useGit";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { GitHeatmap } from "./GitHeatmap";
import { GitOverlay } from "./GitOverlay";
import { FAMILY, num } from "./meta";
import { ActionLine, CommitLine, EmptyLine } from "./parts";
import { RepoPanel, SectionHeader, WorktreeCardView, NyxOSPanel } from "./sections";

function GitSkeleton() {
  return (
    <PageShell gap="gap-5">
      <Skeleton data-testid="git-skeleton" className="h-[44px] w-full" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} data-testid="git-skeleton" className="h-[148px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton data-testid="git-skeleton" className="h-[236px] w-full rounded-xl" />
      <Skeleton data-testid="git-skeleton" className="h-[280px] w-full rounded-xl" />
    </PageShell>
  );
}

/** Noch kein Git-Stand: nie ein leeres Gitter, sondern was los ist und was du tun kannst. */
function FirstScan({ scan }: { scan: GitDashboard["scan"] }) {
  const p = scan.progress;
  if (scan.bridge.state === "offline" && scan.state !== "scanning") {
    return (
      <div className="cc-card-deep grid gap-3 border border-a-line p-6">
        <h2 className="font-display text-title2 font-semibold text-a-ink">{t("Die Brücke ist gerade nicht verbunden.")}</h2>
        <p className="max-w-[620px] text-callout text-a-mut">
          {t("Den Git-Stand liest die Brücke auf deinem Rechner.")} {scan.bridge.reason ? `${t("Grund: {reason}.", { reason: scan.bridge.reason })} ` : ""}
          {t("Sobald sie wieder läuft, erscheinen hier Commits, Zweige und Worktrees — ganz von selbst.")}
        </p>
        <Link to={CONNECTIONS_HREF} className="justify-self-start rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 text-callout text-a-acc hover:bg-a-acc/15">
          {t("Verbindungen prüfen")}
        </Link>
      </div>
    );
  }
  const total = p?.total ?? 0;
  const done = Math.min(p?.done ?? 0, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="cc-card-deep grid gap-3 border border-a-line p-6">
      <h2 className="flex items-center gap-2 font-display text-title2 font-semibold text-a-ink">
        <span aria-hidden className="cc-pulse h-2.5 w-2.5 rounded-full bg-a-acc" />
        {t("Brücke scannt gerade …")}
      </h2>
      <p className="text-callout text-a-mut">{total > 0 ? (p?.current ? t("{done} von {total} Repos gelesen · gerade: {current}", { done, total, current: p.current }) : t("{done} von {total} Repos gelesen", { done, total })) : t("Die Brücke sucht die Repos (App, Worktrees, NyxOS) — das dauert nur ein paar Sekunden.")}</p>
      <div role="progressbar" aria-label={t("Fortschritt des ersten Scans")} aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={done} className="h-2 w-full max-w-[520px] overflow-hidden rounded-full bg-a-p3">
        <div className="h-full rounded-full bg-a-acc transition-[width] duration-300" style={{ width: `${total > 0 ? pct : 8}%` }} />
      </div>
    </div>
  );
}

function ScanChip({ scan }: { scan: GitDashboard["scan"] }) {
  if (scan.state === "scanning" && scan.progress) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc">
        <span aria-hidden className="cc-pulse h-2 w-2 rounded-full bg-a-acc" />
        {t("scannt · {done} von {total}", { done: scan.progress.done, total: scan.progress.total })}
      </span>
    );
  }
  const offline = scan.bridge.state === "offline";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption", offline ? "bg-a-wait/10 text-a-wait" : "bg-a-ok/10 text-a-ok")} title={offline ? (scan.bridge.reason ?? undefined) : undefined}>
      <span aria-hidden className={cn("h-2 w-2 rounded-full", offline ? "bg-a-wait" : "bg-a-ok")} />
      {offline ? t("Brücke offline · Stand {when}", { when: relativeTime(scan.lastScanAt) ?? "–" }) : t("Stand {when}", { when: relativeTime(scan.lastScanAt) ?? "–" })}
    </span>
  );
}

const ACTION_FILTERS: { key: string; label: string; kinds: GitActionRowKind[] | null }[] = [
  { key: "alle", label: t("Alle"), kinds: null },
  { key: "merge", label: t("Merge"), kinds: ["merge", "pull"] },
  { key: "push", label: t("Push"), kinds: ["push"] },
  { key: "reset", label: t("Reset & Co."), kinds: ["reset", "rebase", "revert", "amend", "cherry-pick"] },
  { key: "checkout", label: t("Zweig gewechselt"), kinds: ["checkout"] },
  { key: "nyxos", label: "NyxOS", kinds: ["probe-merge", "catchup", "reservation"] },
];

function ActionLog({ actions }: { actions: GitDashboard["actions"] }) {
  const [filter, setFilter] = useState("alle");
  const [expanded, setExpanded] = useState(false);
  const kinds = ACTION_FILTERS.find((f) => f.key === filter)?.kinds ?? null;
  const list = kinds ? actions.filter((a) => kinds.includes(a.kind)) : actions;
  const shown = expanded ? list : list.slice(0, 12);
  return (
    <section className="cc-card-deep grid gap-2 border border-a-line p-3" data-testid="git-actions">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div>
          <h2 className="font-mono text-label font-medium tracking-wider text-a-mut uppercase">{t("Aktions-Log")}</h2>
          <p className="text-caption text-a-mut">{t("Wer hat wann was gemacht — aus dem Git-Verlauf gelesen, nichts davon ausgelöst.")}</p>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("Aktionen filtern")}>
          {ACTION_FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)} className={cn("h-7 rounded-full px-2.5 text-caption", filter === f.key ? "bg-a-acc/15 text-a-acc" : "text-a-mut hover:bg-a-p2")}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-0.5">
        {shown.map((a) => (
          <ActionLine key={a.id} a={a} />
        ))}
        {list.length === 0 && <EmptyLine>{filter === "alle" ? t("In den letzten 90 Tagen keine Merges, Pushes, Resets oder Wechsel.") : t("Nichts von dieser Art in den letzten 90 Tagen.")}</EmptyLine>}
      </div>
      {list.length > 12 && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="justify-self-start rounded-md px-2.5 py-1 text-caption text-a-acc hover:bg-a-p2">
          {expanded ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: list.length })}
        </button>
      )}
    </section>
  );
}

function Kpis({ d }: { d: GitDashboard }) {
  const last14 = d.heatmap.slice(-14).map((h) => h.app + h.nyxos + h.other);
  const last30 = d.heatmap.slice(-30).map((h) => h.app + h.nyxos + h.other);
  // Defensiv lesen — ältere Server liefern `kpis.uncommitted` nicht (sonst stürzt die Seite ab).
  const unc = uncommittedTotalsOf(d.kpis);
  const uncCaption = unc.split ? (
    <span title={uncommittedDetail(unc.split)}>{uncommittedCaption(unc.split)}</span>
  ) : unc.files === 0 ? (
    t("Alles gesichert")
  ) : unc.places === 1 ? (
    t("Dateien in {n} Ordner", { n: num(unc.places) })
  ) : (
    t("Dateien in {n} Ordnern", { n: num(unc.places) })
  );
  const uncHref = unc.split && unc.split.repoFiles === 0 && unc.split.worktreeFiles > 0 ? "#git-worktrees" : "#git-app";
  const tiles = [
    { id: "git-today", label: t("Commits heute"), value: d.kpis.commitsToday, sparkline: last14, sparklineLabel: t("je Tag · 14 T"), href: "#git-heatmap" },
    // „Commits 7 Tage“ + Trend-Abzeichen passte bei 1280/1440 nicht — kurz „7 Tage“; die Kachel steht
    // zwischen „Commits heute“ und „Commits 30 Tage“, „Vorwoche …“ darunter macht es eindeutig.
    { id: "git-7d", label: t("7 Tage"), value: d.kpis.commits7d, trend: { current: d.kpis.commits7d, previous: d.kpis.commitsPrev7d, period: t("ggü. Vorwoche"), upIsGood: null }, caption: t("Vorwoche {n}", { n: num(d.kpis.commitsPrev7d) }), href: "#git-heatmap" },
    { id: "git-30d", label: t("Commits 30 Tage"), value: d.kpis.commits30d, sparkline: last30, sparklineLabel: t("je Tag · 30 T"), href: "#git-heatmap" },
    { id: "git-branches", label: t("Offene Zweige"), value: d.kpis.openBranches, caption: t("noch nicht in main"), href: "#git-app" },
    { id: "git-worktrees", label: t("Worktrees"), value: d.kpis.worktrees, caption: t("{app} App · {nyxos} NyxOS", { app: d.appWorktrees.length, nyxos: d.nyxosWorktrees.length }), href: "#git-worktrees" },
    // Dieselbe Zahl und Kontextzeile wie die Überblick-Kachel (eine Quelle: `kpis.uncommitted`).
    { id: "git-uncommitted", label: t("Ungesichert"), value: unc.files, caption: uncCaption, captionTone: unc.files > 200 ? ("wait" as const) : null, href: uncHref },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="git-kpis">
      {tiles.map((tile) => (
        <a key={tile.id} href={tile.href} className="block min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-a-acc [&>*]:h-full [&>*]:transition-colors hover:[&>*]:border-[var(--a-line-strong)] hover:[&>*]:bg-a-p2">
          <StatCard id={tile.id} label={tile.label} value={tile.value} format={(n) => num(Math.round(n))} trend={tile.trend ?? null} sparkline={tile.sparkline} sparklineLabel={tile.sparklineLabel} caption={tile.caption} captionTone={tile.captionTone ?? null} />
        </a>
      ))}
    </div>
  );
}

function situation(d: GitDashboard): string {
  const parts: string[] = [];
  const today = d.kpis.commitsToday;
  parts.push(today === 0 ? t("Heute noch kein Commit") : today === 1 ? t("Heute {n} Commit", { n: today }) : t("Heute {n} Commits", { n: today }));
  const busy = [...d.appWorktrees, ...d.nyxosWorktrees].filter((w) => w.sessions.open.length > 0).length;
  if (busy > 0) parts.push(busy === 1 ? t("in {n} Arbeitskopie läuft gerade eine Session", { n: busy }) : t("in {n} Arbeitskopien laufen gerade Sessions", { n: busy }));
  const conflicts = [...(d.app?.branches ?? []), ...(d.nyxos?.branches ?? [])].filter((b) => b.probe?.status === "conflict").length;
  if (conflicts > 0) parts.push(conflicts === 1 ? t("{n} Zweig hätte beim Merge Konflikte", { n: conflicts }) : t("{n} Zweige hätten beim Merge Konflikte", { n: conflicts }));
  return `${parts.join(", ")}.`;
}

export function Git() {
  const { data, isLoading, isError, refetch } = useGitDashboard();
  const d = data;
  const hasData = !!d && (d.app !== null || d.nyxos !== null || d.others.length > 0 || d.appWorktrees.length > 0);
  const view = d;

  if (isLoading) return <GitSkeleton />;
  if (isError || !view) {
    return (
      <PageShell>
        <div className="cc-card-deep grid gap-3 border border-a-line p-6">
          <h2 className="font-display text-title2 font-semibold text-a-ink">{t("Der Git-Stand ist gerade nicht erreichbar.")}</h2>
          <p className="text-callout text-a-mut">{t("Der Server antwortet nicht. Meist ist nur die Verbindung kurz weg.")}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void refetch()} className="rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 text-callout text-a-acc hover:bg-a-acc/15">
              {t("Erneut laden")}
            </button>
            <Link to={CONNECTIONS_HREF} className="rounded-lg border border-a-line px-3 py-1.5 text-callout text-a-mut hover:bg-a-p2">
              {t("Verbindungen prüfen")}
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell gap="gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="font-display text-title font-semibold text-a-ink">Git</h1>
          {hasData && <p className="text-callout text-a-mut">{situation(view)}</p>}
        </div>
        {hasData && <ScanChip scan={view.scan} />}
      </header>

      {!hasData ? (
        <FirstScan scan={view.scan} />
      ) : (
        <>
          <Kpis d={view} />

          <section id="git-heatmap" className="cc-card-deep grid gap-3 border border-a-line p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-mono text-label font-medium tracking-wider text-a-mut uppercase">{t("Commits je Tag · 12 Wochen")}</h2>
              <span className="text-caption text-a-mut">{t("alle Repos, Ortszeit")}</span>
            </div>
            <GitHeatmap days={view.heatmap} />
          </section>

          <section className="cc-card-deep grid gap-2 border border-a-line p-3" data-testid="git-merges">
            <div className="px-1">
              <h2 className="font-mono text-label font-medium tracking-wider text-a-mut uppercase">{t("Letzte Merges")}</h2>
              <p className="text-caption text-a-mut">{t("Echte Merge-Commits, neueste zuerst — mit der Session, die sie gemacht hat.")}</p>
            </div>
            <div className="grid gap-0.5">
              {view.merges.map((c) => (
                <CommitLine key={`${c.repoId}:${c.sha}`} c={c} showRepo />
              ))}
              {view.merges.length === 0 && <EmptyLine>{t("In den letzten 90 Tagen kein Merge-Commit.")}</EmptyLine>}
            </div>
          </section>

          <ActionLog actions={view.actions} />

          {view.app && (
            <section id="git-app" className="grid gap-3 scroll-mt-4" data-testid="section-app" data-color="app">
              <SectionHeader kind="app" title={view.app.label} count={t("{n} Zweige", { n: num(view.app.branches.length) })} />
              <RepoPanel repo={view.app} />
            </section>
          )}

          <section id="git-worktrees" className="grid gap-3 scroll-mt-4" data-testid="section-worktrees" data-color="worktree">
            <SectionHeader kind="worktree" title={t("Worktrees des App-Repos")} count={`${view.appWorktrees.length}`} />
            {view.appWorktrees.length > 0 ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
                {view.appWorktrees.map((w) => (
                  <WorktreeCardView key={w.repoId} w={w} />
                ))}
              </div>
            ) : (
              <p className="cc-card-deep border border-a-line p-4 text-callout text-a-mut">{t("Gerade gibt es keine eigene Arbeitskopie des App-Repos. Neue entstehen unter .worktrees im Repo, sobald ein Auftrag startet.")}</p>
            )}
          </section>

          {view.nyxos && (
            <section id="git-nyxos" className="grid gap-3 scroll-mt-4" data-testid="section-nyxos" data-color="nyxos">
              <SectionHeader kind="nyxos" title={view.nyxos.label} count={t("{n} Arbeitskopien", { n: view.nyxosWorktrees.length })} />
              <NyxOSPanel repo={view.nyxos} worktrees={view.nyxosWorktrees} />
            </section>
          )}

          {view.others.length > 0 && (
            <section id="git-weitere" className="grid gap-3 scroll-mt-4" data-testid="section-other" data-color="other">
              <SectionHeader kind="other" title={t("Weitere Repos")} count={`${view.others.length}`} />
              {view.others.map((r) => (
                <details key={r.repoId} className="cc-card-deep group border border-a-line p-3">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-1 marker:hidden">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: FAMILY.other.color }} />
                    <span className="font-display text-headline font-semibold text-a-ink">{r.label}</span>
                    <span className="font-mono text-caption text-a-indigo">{r.currentBranch}</span>
                    <span className="text-caption text-a-mut">
                      {t("{commits} Commits · 30 T · {files} ungesichert", { commits: num(r.commits30d), files: num(r.uncommitted.total) })}
                    </span>
                    <span className="ml-auto text-caption text-a-indigo group-open:hidden">{t("öffnen")}</span>
                  </summary>
                  <div className="mt-3">
                    <RepoPanel repo={r} collapseBranches={5} />
                  </div>
                </details>
              ))}
            </section>
          )}
        </>
      )}
      <GitOverlay />
    </PageShell>
  );
}
