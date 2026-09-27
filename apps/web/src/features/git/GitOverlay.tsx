// Großansichten der Git-Seite — Commit (Dateien +/−, Session mit Sicherheit), Zweig
// (Commits, Probe-Merge), Worktree (Sessions, Commits, ungesicherte Dateien, Aktionen) und Tag
// (Commits aus der Heatmap). Alles verlinkt weiter; Zurück/Esc/Schließen wie bei den Aufgaben.
import { locale, t, type GitCommitDetail, type GitCommitRow } from "@nyxos/shared";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { Skeleton } from "../../components/ui/skeleton";
import { useGitBranch, useGitCommit, useGitDay, useGitWorktree } from "../../hooks/useGit";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { CONFIDENCE, FAMILY, GROUP_META, lastPart, num, sessionHref, sessionName, toolColor } from "./meta";
import { useGitNav, type GitTarget } from "./nav";
import { ActionLine, AheadBehind, CommitLine, ConfidenceBadge, EmptyLine, Pill, ProbePill, Rel, SessionLink, UncommittedBar } from "./parts";

const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="cc-card-deep grid gap-2 border border-a-line p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-label tracking-wider text-a-mut uppercase">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-[72px] w-full" />
      <Skeleton className="h-[160px] w-full" />
      <Skeleton className="h-[220px] w-full" />
    </div>
  );
}

function Gone({ text }: { text: string }) {
  return <p className="rounded-lg border border-a-line bg-a-p p-4 text-callout text-a-mut">{text}</p>;
}

function FileBars({ commit }: { commit: GitCommitDetail }) {
  const max = Math.max(1, ...commit.files.map((f) => (f.add ?? 0) + (f.del ?? 0)));
  return (
    <ul className="grid gap-0.5">
      {commit.files.map((f) => {
        const binary = f.add === null && f.del === null;
        return (
          <li key={f.path} className="grid grid-cols-[minmax(0,1fr)_auto_96px] items-center gap-3 rounded-md px-2 py-1 hover:bg-a-p2">
            <span className="min-w-0 truncate font-mono text-caption text-a-ink" title={f.path}>
              {f.path}
            </span>
            {binary ? (
              <span className="text-label text-a-mut">{t("Binärdatei")}</span>
            ) : (
              <span className="font-mono text-caption tabular-nums">
                <span className="text-a-ok">+{num(f.add ?? 0)}</span> <span className="text-a-bad">−{num(f.del ?? 0)}</span>
              </span>
            )}
            <span className="flex h-1.5 overflow-hidden rounded-full bg-a-p3" aria-hidden>
              <span className="bg-a-ok" style={{ width: `${((f.add ?? 0) / max) * 100}%` }} />
              <span className="bg-a-bad" style={{ width: `${((f.del ?? 0) / max) * 100}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CommitView({ repoId, sha }: { repoId: string; sha: string }) {
  const nav = useGitNav();
  const q = useGitCommit(repoId, sha);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Gone text={t("Diesen Commit kennt NyxOS (noch) nicht. Die Brücke liest neue Commits ein paar Sekunden nach dem Commit ein.")} />;
  const c = q.data;
  const f = FAMILY[c.kind];
  const a = c.attribution;
  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill className={cn(f.soft, f.text)}>{c.repoLabel}</Pill>
          {c.parents > 1 && <Pill className="bg-a-violet/12 text-a-violet">{t("Merge-Commit")}</Pill>}
          <button type="button" onClick={() => nav.open({ t: "branch", repoId: c.repoId, key: c.branch })} className="rounded-full border border-a-line px-2 py-0.5 font-mono text-caption text-a-mut hover:border-a-acc/50 hover:text-a-ink">
            {c.branch}
          </button>
        </div>
        <h1 className="font-display text-title2 font-semibold text-a-ink">{c.subject}</h1>
        <p className="flex flex-wrap gap-x-3 font-mono text-caption text-a-mut">
          <span>{c.sha.slice(0, 12)}</span>
          <span>{formatDateTime(c.committedAt)}</span>
          {c.authorName && <span>{c.authorName}</span>}
          {c.worktreePath && <span title={c.worktreePath}>{t("in {folder}", { folder: lastPart(c.worktreePath) })}</span>}
        </p>
      </header>

      <Card title={t("Gemacht von")} right={<ConfidenceBadge confidence={a.confidence} />}>
        {a.session ? (
          <Link to={sessionHref(a.session.key)} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-a-line bg-a-p2 px-3 py-2.5 hover:border-a-acc/50">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: toolColor(a.session.tool) }} />
            <span className="min-w-0 flex-1 truncate text-callout text-a-ink">{sessionName(a.session)}</span>
            <span className="shrink-0 text-caption text-a-acc">{t("Session öffnen ›")}</span>
          </Link>
        ) : (
          <p className="text-callout text-a-ink">{t("Keine Session")}</p>
        )}
        <p className="text-caption text-a-mut">{a.reason}</p>
        {a.confidence !== "keine" && <p className="text-caption text-a-mut">{CONFIDENCE[a.confidence].hint}</p>}
      </Card>

      <Card
        title={t("Geänderte Dateien · {n}", { n: num(c.filesChanged ?? c.files.length) })}
        right={
          c.insertions !== null ? (
            <span className="font-mono text-caption tabular-nums">
              <span className="text-a-ok">+{num(c.insertions)}</span> <span className="text-a-bad">−{num(c.deletions ?? 0)}</span>
            </span>
          ) : undefined
        }
      >
        {c.files.length > 0 ? <FileBars commit={c} /> : <EmptyLine>{c.parents > 1 ? t("Der Merge hat keine eigenen Änderungen gegenüber dem Hauptzweig.") : t("Für diesen Commit liegen keine Datei-Angaben vor.")}</EmptyLine>}
        {c.filesTruncated && <p className="text-caption text-a-mut">{t("Die Liste zeigt die ersten {n} Dateien; die Summe oben zählt alle.", { n: num(c.files.length) })}</p>}
      </Card>
    </div>
  );
}

function CommitList({ commits, empty, showRepo }: { commits: GitCommitRow[]; empty: string; showRepo?: boolean }) {
  return (
    <div className="grid gap-0.5">
      {commits.map((c) => (
        <CommitLine key={`${c.repoId}:${c.sha}`} c={c} showRepo={showRepo} />
      ))}
      {commits.length === 0 && <EmptyLine>{empty}</EmptyLine>}
    </div>
  );
}

function BranchView({ repoId, name }: { repoId: string; name: string }) {
  const q = useGitBranch(repoId, name);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Gone text={t("Diesen Zweig gibt es nicht mehr (gelöscht oder umbenannt).")} />;
  const { branch, commits, repoLabel, kind, mainBranch } = q.data;
  const f = FAMILY[kind];
  const isMain = branch.name === mainBranch;
  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill className={cn(f.soft, f.text)}>{repoLabel}</Pill>
          <Pill className="bg-a-p3 text-a-mut">{t("Zweig")}</Pill>
          {branch.isCurrent && <Pill className="bg-a-acc/12 text-a-acc">{t("aktuell ausgecheckt")}</Pill>}
        </div>
        <h1 className="break-all font-mono text-title2 font-semibold text-a-ink">{branch.name}</h1>
        <div className="flex flex-wrap items-center gap-3 text-caption text-a-mut">
          {!isMain && <AheadBehind ahead={branch.ahead} behind={branch.behind} main={mainBranch} />}
          <ProbePill probe={branch.probe} />
          {branch.checkedOutAt && <span title={branch.checkedOutAt}>{t("ausgecheckt in {folder}", { folder: lastPart(branch.checkedOutAt) })}</span>}
          {branch.upstream && <span className="font-mono">↔ {branch.upstream}</span>}
        </div>
      </header>
      {branch.probe?.status === "conflict" && branch.probe.conflictFiles.length > 0 && (
        <Card title={t("Konflikt beim Probe-Merge")}>
          <p className="text-caption text-a-mut">{t("NyxOS hat den Merge nach {main} probeweise durchgespielt, ohne etwas zu ändern. Diese Dateien würden kollidieren:", { main: mainBranch })}</p>
          <ul className="grid gap-0.5">
            {branch.probe.conflictFiles.map((p) => (
              <li key={p} className="truncate font-mono text-caption text-a-conf" title={p}>
                {p}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={isMain ? t("Letzte Commits auf {branch}", { branch: branch.name }) : t("Eigene Commits · {n}", { n: commits.length })}>
        <CommitList commits={commits} empty={isMain ? t("Keine Commits erfasst.") : t("Alles davon ist schon in {main}.", { main: mainBranch })} />
      </Card>
    </div>
  );
}

function WorktreeView({ repoId }: { repoId: string }) {
  const nav = useGitNav();
  const q = useGitWorktree(repoId);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Gone text={t("Diese Worktree gibt es nicht mehr — sie wurde vermutlich aufgeräumt.")} />;
  const { card, sessions, commits, uncommitted, actions } = q.data;
  const kind = card.parentRepoId === "nyxos" ? "nyxos" : "worktree";
  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill className={cn(FAMILY[kind].soft, FAMILY[kind].text)}>{kind === "nyxos" ? t("Arbeitskopie von NyxOS") : t("Worktree des App-Repos")}</Pill>
          <ProbePill probe={card.probe} />
        </div>
        <h1 className="font-display text-title2 font-semibold text-a-ink">{card.label}</h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-a-mut">
          {card.branch && card.parentRepoId && (
            <button type="button" onClick={() => nav.open({ t: "branch", repoId: card.parentRepoId ?? "app", key: card.branch ?? "" })} className="rounded-full border border-a-line px-2 py-0.5 font-mono text-caption hover:border-a-acc/50 hover:text-a-ink">
              {card.branch}
            </button>
          )}
          <span className="font-mono" title={card.path}>
            {card.path}
          </span>
        </p>
      </header>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t("vor {main}", { main: card.mainBranch }), value: `+${num(card.ahead)}`, cls: card.ahead > 0 ? "text-a-ok" : "text-a-mut" },
          { label: t("hinter {main}", { main: card.mainBranch }), value: `−${num(card.behind)}`, cls: card.behind > 0 ? "text-a-bad" : "text-a-mut" },
          { label: t("ungesichert"), value: num(card.uncommitted.total), cls: card.uncommitted.total > 0 ? "text-a-wait" : "text-a-mut" },
          { label: t("Sessions darin"), value: num(sessions.length), cls: "text-a-ink" },
        ].map((k) => (
          <div key={k.label} className="cc-card-deep grid gap-1 border border-a-line p-3">
            <span className={cn("font-display text-title leading-none font-semibold tabular-nums", k.cls)}>{k.value}</span>
            <span className="text-caption text-a-mut">{k.label}</span>
          </div>
        ))}
      </div>
      {card.catchup && (
        <p className="rounded-lg border border-a-line bg-a-p px-3 py-2 text-caption text-a-mut">
          {card.catchup.outcome === "merged" ? t("Nachziehen: automatisch nachgezogen") : card.catchup.outcome === "skipped-dirty" ? t("Nachziehen: übersprungen, weil ungesicherte Dateien da sind") : t("Nachziehen: als Aufgabe vorgemerkt")} · <Rel iso={card.catchup.at} />
        </p>
      )}
      <Card title={t("Sessions darin · {n}", { n: sessions.length })}>
        <div className="grid gap-1">
          {sessions.map((s) => (
            <div key={s.key} className="flex min-w-0 items-center gap-2 px-1">
              <SessionLink session={s} className="max-w-none flex-1" />
              <Pill className={s.state === "running" ? "bg-a-ok/12 text-a-ok" : s.state === "waiting" ? "bg-a-wait/12 text-a-wait" : "bg-a-indigo/12 text-a-indigo"}>
                {s.state === "running" ? t("läuft") : s.state === "waiting" ? t("wartet") : s.state === "idle" ? t("ruht") : s.state === "crashed" ? t("abgestürzt") : t("beendet")}
              </Pill>
              <Rel iso={s.lastActivityAt} />
            </div>
          ))}
          {sessions.length === 0 && <EmptyLine>{t("In diesem Ordner hat noch keine Session gearbeitet.")}</EmptyLine>}
        </div>
      </Card>
      <Card title={t("Eigene Commits · {n}", { n: commits.length })}>
        <CommitList commits={commits} empty={t("Keine eigenen Commits — alles ist schon in {main}.", { main: card.mainBranch })} />
      </Card>
      <Card title={t("Ungesicherte Dateien · {n}", { n: num(uncommitted.length) })}>
        <UncommittedBar u={card.uncommitted} />
        <ul className="grid gap-0.5">
          {uncommitted.slice(0, 200).map((u) => (
            <li key={u.path} className="flex min-w-0 items-center gap-2 px-1 text-caption">
              <span className={cn("w-16 shrink-0 text-label", GROUP_META[u.group]?.text)}>{GROUP_META[u.group]?.label}</span>
              <span className="min-w-0 truncate font-mono text-a-ink" title={u.path}>
                {u.path}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {actions.length > 0 && (
        <Card title={t("Git-Aktionen hier")}>
          <div className="grid gap-0.5">
            {actions.map((a) => (
              <ActionLine key={a.id} a={a} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function DayView({ day }: { day: string }) {
  const q = useGitDay(day);
  if (q.isLoading) return <Loading />;
  const commits = q.data?.commits ?? [];
  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="font-display text-title2 font-semibold text-a-ink">{dayFmt.format(new Date(`${day}T12:00:00Z`))}</h1>
        <p className="text-caption text-a-mut">{commits.length === 1 ? t("1 Commit in allen Repos") : t("{n} Commits in allen Repos", { n: num(commits.length) })}</p>
      </header>
      <Card title={t("Commits")}>
        <CommitList commits={commits} empty={t("An diesem Tag gab es keine Commits.")} showRepo />
      </Card>
    </div>
  );
}

function titleOf(target: GitTarget): string {
  if (target.t === "commit") return t("Commit {sha}", { sha: target.key?.slice(0, 7) ?? "" });
  if (target.t === "branch") return t("Zweig {name}", { name: target.key ?? "" });
  if (target.t === "worktree") return t("Worktree {name}", { name: lastPart(target.repoId?.split(":").pop() ?? "") });
  return t("Commits des Tages");
}

export function GitOverlay() {
  const nav = useGitNav();
  const target = nav.current;
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") nav.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, nav]);
  if (!target) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-a-bg/85 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={titleOf(target)}>
      <div className="flex items-center gap-2 border-b border-a-line bg-a-p px-4 py-2.5">
        <button type="button" onClick={nav.back} className="rounded border border-a-line px-2.5 py-1 text-caption text-a-mut hover:bg-a-p3">
          {t("‹ Zurück")}
        </button>
        <span className="min-w-0 flex-1 truncate text-caption text-a-mut">Git · {titleOf(target)}</span>
        <span className="rounded border border-a-line px-1.5 py-0.5 font-mono text-label text-a-mut">Esc</span>
        <button type="button" onClick={nav.close} className="rounded border border-a-line px-2.5 py-1 text-caption text-a-mut hover:bg-a-p3">
          {t("Schließen")}
        </button>
      </div>
      <div className="cc-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] p-5">
          {target.t === "commit" && target.repoId && target.key && <CommitView repoId={target.repoId} sha={target.key} />}
          {target.t === "branch" && target.repoId && target.key && <BranchView repoId={target.repoId} name={target.key} />}
          {target.t === "worktree" && target.repoId && <WorktreeView repoId={target.repoId} />}
          {target.t === "day" && target.key && <DayView day={target.key} />}
        </div>
      </div>
    </div>
  );
}
