// Die Abschnitte der Git-Seite. Jeder hat eigene Farbe, eigene Kennzeichnung und EIGENE
// Inhalte — App-Repo: Zweige + Commits + Ungesichert; Worktrees: Karten mit vor/hinter main und den
// Sessions darin; NyxOS: Agenten-Arbeitskopien als dichte Liste; weitere Repos: kompakt.
import { t, type GitBranchRow, type GitRepoSection, type GitWorktreeCard, type RepoKind } from "@nyxos/shared";
import { useState, type ReactNode } from "react";
import { Sparkline } from "../../components/charts/Sparkline";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { FAMILY, GROUP_META, lastPart, num } from "./meta";
import { useGitNav } from "./nav";
import { AheadBehind, CommitLine, EmptyLine, Pill, ProbePill, Rel, SessionLink, UncommittedBar } from "./parts";

export function SectionHeader({ kind, title, count, children }: { kind: RepoKind; title: string; count?: string; children?: ReactNode }) {
  const f = FAMILY[kind];
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-stretch gap-3">
        <span aria-hidden className={cn("w-1 shrink-0 rounded-full", f.bar)} />
        <div className="grid min-w-0 gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-title2 font-semibold text-a-ink">{title}</h2>
            <Pill className={cn(f.soft, f.text, "font-medium")}>{f.label}</Pill>
            {count && <span className="font-mono text-caption text-a-mut">{count}</span>}
          </div>
          <p className="text-caption text-a-mut">{f.hint}</p>
        </div>
      </div>
      {children}
    </header>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="font-mono text-label tracking-wider text-a-mut uppercase">{label}</span>
      {children}
    </div>
  );
}

function Box({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("cc-card-deep grid min-w-0 content-start gap-2 border border-a-line p-3", className)}>
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="font-mono text-label font-medium tracking-wider text-a-mut uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

export function BranchLine({ b, repoId, main }: { b: GitBranchRow; repoId: string; main: string }) {
  const nav = useGitNav();
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2.5 py-2 hover:bg-a-p2">
      <button type="button" onClick={() => nav.open({ t: "branch", repoId, key: b.name })} className="flex min-w-0 flex-1 items-center gap-2 text-left after:absolute after:inset-0 after:content-['']">
        <span className={cn("min-w-0 truncate font-mono text-caption", b.isCurrent ? "font-semibold text-a-ink" : "text-a-ink")} title={b.name}>
          {b.name}
        </span>
        {b.isCurrent && <Pill className="bg-a-acc/12 text-a-acc">{t("aktuell")}</Pill>}
      </button>
      {b.checkedOutAt && !b.isCurrent && (
        <span className="max-w-[180px] truncate text-label text-a-violet" title={b.checkedOutAt}>
          {t("in {folder}", { folder: lastPart(b.checkedOutAt) })}
        </span>
      )}
      {b.name !== main && <AheadBehind ahead={b.ahead} behind={b.behind} main={main} />}
      <ProbePill probe={b.probe} />
      <Rel iso={b.lastCommitAt} />
    </div>
  );
}

/** App-Repo und weitere Repos: Zweige, Commits, Ungesichert. */
export function RepoPanel({ repo, collapseBranches = 8 }: { repo: GitRepoSection; collapseBranches?: number }) {
  const [allBranches, setAllBranches] = useState(false);
  const f = FAMILY[repo.kind];
  const branches = allBranches ? repo.branches : repo.branches.slice(0, collapseBranches);
  const openBranches = repo.branches.filter((b) => b.name !== repo.mainBranch && b.ahead > 0).length;
  return (
    <div className="grid gap-3">
      <div className="cc-card-deep grid gap-4 border border-a-line p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("Aktueller Zweig")}>
          <span className="truncate font-mono text-callout text-a-ink" title={repo.currentBranch ?? undefined}>
            {repo.currentBranch ?? t("kein Zweig")}
          </span>
          <span className="truncate font-mono text-label text-a-mut" title={repo.root}>
            {repo.root}
          </span>
        </Stat>
        <Stat label={t("Commits · 30 Tage")}>
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums text-a-ink">{num(repo.commits30d)}</span>
          <div className="h-7">
            <Sparkline values={repo.commitsPerDay} height={28} color={f.color} label={t("Commits je Tag, 30 Tage: {values}", { values: repo.commitsPerDay.join(", ") })} />
          </div>
        </Stat>
        <Stat label={t("Offene Zweige")}>
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums text-a-ink">{num(openBranches)}</span>
          <span className="text-caption text-a-mut">{t("von {n} Zweigen haben eigene Commits", { n: num(repo.branches.length) })}</span>
        </Stat>
        <Stat label={t("Ungesichert · {n} Dateien", { n: num(repo.uncommitted.total) })}>
          <UncommittedBar u={repo.uncommitted} />
        </Stat>
      </div>

      <Box title={t("Zweige · {n}", { n: repo.branches.length })} right={<span className="text-label text-a-mut">{t("vor/hinter {main}", { main: repo.mainBranch })}</span>}>
        <div className="grid gap-0.5">
          {branches.map((b) => (
            <BranchLine key={b.name} b={b} repoId={repo.repoId} main={repo.mainBranch} />
          ))}
          {repo.branches.length === 0 && <EmptyLine>{t("Keine Zweige gefunden.")}</EmptyLine>}
        </div>
        {repo.branches.length > collapseBranches && (
          <button type="button" onClick={() => setAllBranches((v) => !v)} className="justify-self-start rounded-md px-2.5 py-1 text-caption text-a-acc hover:bg-a-p2">
            {allBranches ? t("Weniger zeigen") : t("Alle {n} Zweige zeigen", { n: repo.branches.length })}
          </button>
        )}
      </Box>

      <Box title={t("Letzte Commits")}>
        <div className="grid gap-0.5">
          {repo.recentCommits.map((c) => (
            <CommitLine key={c.sha} c={c} />
          ))}
          {repo.recentCommits.length === 0 && <EmptyLine>{t("In den letzten 90 Tagen keine Commits.")}</EmptyLine>}
        </div>
      </Box>

      {repo.uncommitted.total > 0 && (
        <details className="cc-card-deep group border border-a-line p-3">
          <summary className="cursor-pointer list-none px-1 font-mono text-label font-medium tracking-wider text-a-mut uppercase marker:hidden">
            {t("Ungesicherte Dateien · {n}", { n: num(repo.uncommitted.total) })} <span className="text-a-acc normal-case group-open:hidden">{t("anzeigen")}</span>
          </summary>
          <ul className="mt-2 grid gap-0.5">
            {repo.uncommitted.files.map((u) => (
              <li key={u.path} className="flex min-w-0 items-center gap-2 px-1 text-caption">
                <span className={cn("w-16 shrink-0 text-label", GROUP_META[u.group]?.text)}>{GROUP_META[u.group]?.label}</span>
                <span className="min-w-0 truncate font-mono text-a-ink" title={u.path}>
                  {u.path}
                </span>
              </li>
            ))}
            {repo.uncommitted.total > repo.uncommitted.files.length && <li className="px-1 text-caption text-a-mut">{t("… und {n} weitere", { n: num(repo.uncommitted.total - repo.uncommitted.files.length) })}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function isRecent(iso: string | null, minutes = 10): boolean {
  return !!iso && Date.now() - Date.parse(iso) < minutes * 60_000;
}

/** Worktree als Karte: große Zahlen (vor/hinter main, ungesichert), Sessions darin, letzter Commit. */
export function WorktreeCardView({ w }: { w: GitWorktreeCard }) {
  const nav = useGitNav();
  const live = isRecent(w.lastActivityAt);
  return (
    <article className="cc-card-deep relative grid min-w-0 content-start gap-3 border border-a-line p-4 transition-colors hover:border-a-violet/50" data-worktree={w.repoId}>
      <span aria-hidden className="absolute top-0 left-4 h-[3px] w-10 rounded-b-full bg-a-violet" />
      <div className="flex min-w-0 items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => nav.open({ t: "worktree", repoId: w.repoId })}
          className="grid min-w-0 gap-0.5 text-left after:absolute after:inset-0 after:rounded-xl after:content-['']"
          data-nyx-item="repo"
          data-nyx-at={w.lastActivityAt ?? undefined}
        >
          <span className="truncate font-display text-headline font-semibold text-a-ink" title={w.path}>
            {w.label}
          </span>
          <span className="truncate font-mono text-caption text-a-violet" title={w.branch ?? undefined}>
            {w.branch ?? t("kein Zweig")}
          </span>
        </button>
        <ProbePill probe={w.probe} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-0.5">
          <span className={cn("font-display text-title2 leading-none font-semibold tabular-nums", w.ahead > 0 ? "text-a-ok" : "text-a-mut")}>+{num(w.ahead)}</span>
          <span className="text-label text-a-mut">{t("vor {main}", { main: w.mainBranch })}</span>
        </div>
        <div className="grid gap-0.5">
          <span className={cn("font-display text-title2 leading-none font-semibold tabular-nums", w.behind > 0 ? "text-a-bad" : "text-a-mut")}>−{num(w.behind)}</span>
          <span className="text-label text-a-mut">{t("hinter {main}", { main: w.mainBranch })}</span>
        </div>
        <div className="grid gap-0.5">
          <span className={cn("font-display text-title2 leading-none font-semibold tabular-nums", w.uncommitted.total > 0 ? "text-a-wait" : "text-a-mut")}>{num(w.uncommitted.total)}</span>
          <span className="text-label text-a-mut">{t("ungesichert")}</span>
        </div>
      </div>
      <UncommittedBar u={w.uncommitted} compact />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {w.sessions.open.map((s) => (
          <SessionLink key={s.key} session={s} />
        ))}
        {w.sessions.open.length === 0 && <span className="text-caption text-a-mut">{t("Gerade keine Session darin")}</span>}
        {w.sessions.total > w.sessions.open.length && <span className="text-caption text-a-mut">{t("+ {n} frühere", { n: w.sessions.total - w.sessions.open.length })}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2 border-t border-a-line pt-2.5 text-caption">
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", live ? "cc-pulse bg-a-ok" : "bg-a-violet/60")} />
        <span className="shrink-0 text-a-mut">{live ? t("gerade aktiv") : t("zuletzt aktiv {when}", { when: relativeTime(w.lastActivityAt) ?? "–" })}</span>
        {w.lastCommit && (
          <span className="min-w-0 truncate text-a-mut" title={w.lastCommit.subject}>
            · <span className="font-mono">{w.lastCommit.sha.slice(0, 7)}</span> {w.lastCommit.subject}
          </span>
        )}
      </div>
    </article>
  );
}

/** NyxOS: eigene Kennzahlen + die Agenten-Arbeitskopien als dichte, sortierte Liste. */
export function NyxOSPanel({ repo, worktrees }: { repo: GitRepoSection; worktrees: GitWorktreeCard[] }) {
  const nav = useGitNav();
  const [all, setAll] = useState(false);
  const shown = all ? worktrees : worktrees.slice(0, 10);
  const active = worktrees.filter((w) => w.sessions.open.length > 0).length;
  const dirty = worktrees.filter((w) => w.uncommitted.total > 0).length;
  return (
    <div className="grid gap-3">
      <div className="cc-card-deep grid gap-4 border border-a-line p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("Commits · 30 Tage")}>
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums text-a-ink">{num(repo.commits30d)}</span>
          <div className="h-7">
            <Sparkline values={repo.commitsPerDay} height={28} color={FAMILY.nyxos.color} label={t("Commits je Tag, 30 Tage: {values}", { values: repo.commitsPerDay.join(", ") })} />
          </div>
        </Stat>
        <Stat label={t("Agenten-Arbeitskopien")}>
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums text-a-ink">{num(worktrees.length)}</span>
          <span className="text-caption text-a-mut">{t("{n} mit laufender Session", { n: num(active) })}</span>
        </Stat>
        <Stat label={t("Mit ungesicherten Dateien")}>
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums text-a-ink">{num(dirty)}</span>
          <span className="text-caption text-a-mut">{t("Hauptordner: {n} Dateien", { n: num(repo.uncommitted.total) })}</span>
        </Stat>
        <Stat label={t("Hauptordner")}>
          <span className="truncate font-mono text-callout text-a-ink">{repo.currentBranch ?? t("kein Zweig")}</span>
          <span className="truncate font-mono text-label text-a-mut" title={repo.root}>
            {repo.root}
          </span>
        </Stat>
      </div>

      <Box title={t("Agenten-Arbeitskopien · {n}", { n: worktrees.length })} right={<span className="text-label text-a-mut">{t("zuletzt aktive zuerst")}</span>}>
        <div className="grid gap-0.5" role="list">
          {shown.map((w) => (
            <div key={w.repoId} role="listitem" className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-2 hover:bg-a-p2">
              <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", w.sessions.open.length > 0 ? "cc-pulse bg-a-ok" : "bg-a-lime/50")} />
              <button type="button" onClick={() => nav.open({ t: "worktree", repoId: w.repoId })} className="flex min-w-0 flex-1 items-center gap-2 text-left after:absolute after:inset-0 after:content-['']">
                <span className="min-w-0 truncate text-callout text-a-ink" title={w.path}>
                  {w.label}
                </span>
                <span className="min-w-0 truncate font-mono text-label text-a-lime" title={w.branch ?? undefined}>
                  {w.branch}
                </span>
              </button>
              <AheadBehind ahead={w.ahead} behind={w.behind} main={w.mainBranch} />
              {w.uncommitted.total > 0 && <Pill className="bg-a-wait/12 text-a-wait">{t("{n} ungesichert", { n: num(w.uncommitted.total) })}</Pill>}
              {w.sessions.open[0] && <SessionLink session={w.sessions.open[0]} />}
              <Rel iso={w.lastActivityAt} />
            </div>
          ))}
          {worktrees.length === 0 && <EmptyLine>{t("Gerade arbeitet kein Agent in einer eigenen Arbeitskopie.")}</EmptyLine>}
        </div>
        {worktrees.length > 10 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="justify-self-start rounded-md px-2.5 py-1 text-caption text-a-lime hover:bg-a-p2">
            {all ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: worktrees.length })}
          </button>
        )}
      </Box>

      <Box title={t("Letzte Commits")}>
        <div className="grid gap-0.5">
          {repo.recentCommits.map((c) => (
            <CommitLine key={c.sha} c={c} />
          ))}
          {repo.recentCommits.length === 0 && <EmptyLine>{t("In den letzten 90 Tagen keine Commits.")}</EmptyLine>}
        </div>
      </Box>
    </div>
  );
}
