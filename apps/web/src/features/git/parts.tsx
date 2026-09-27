// Kleine Bausteine der Git-Seite (Zeilen, Pillen, Balken). Ganze Zeilen sind klickbar
// (Hover `--a-p2`), Zeit in Mono, Status als Pille.
import { locale, t, timeZone, type AttributionConfidence, type GitActionRow, type GitCommitRow, type GitSessionRef, type GitUncommittedSummary, type RepoKind } from "@nyxos/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { ACTION, CONFIDENCE, FAMILY, GROUP_META, lastPart, num, sessionHref, sessionName, toolColor } from "./meta";
import { useGitNav } from "./nav";

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-label leading-4", className)}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: AttributionConfidence }) {
  const m = CONFIDENCE[confidence];
  return (
    <Pill className={m.cls} title={m.hint}>
      {m.label}
    </Pill>
  );
}

/** Session als Link (Punkt in Anbieter-Farbe). `relative z-10`, damit sie über einer „ganze Zeile
 * klickbar“-Fläche liegt und selbst klickbar bleibt. */
export function SessionLink({ session, className }: { session: GitSessionRef; className?: string }) {
  const open = session.state === "running" || session.state === "waiting";
  return (
    <Link
      to={sessionHref(session.key)}
      title={session.title ?? session.key}
      className={cn("relative z-10 inline-flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-full border border-a-line bg-a-p2 px-2 py-0.5 text-caption text-a-ink hover:border-a-acc/50", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", open && "cc-pulse")} style={{ background: toolColor(session.tool) }} />
      <span className="truncate">{sessionName(session)}</span>
    </Link>
  );
}

export function Who({ who }: { who: GitActionRow["who"] }) {
  if (who.type === "session" && who.session) return <SessionLink session={who.session} />;
  if (who.type === "nyxos") return <Pill className="bg-a-lime/12 text-a-lime">NyxOS</Pill>;
  return (
    <Pill className="bg-a-indigo/12 text-a-indigo" title={t("Keine Session passt zu Zeit und Ordner — vermutlich von Hand oder von einem Werkzeug außerhalb der Sessions.")}>
      {t("von Hand?")}
    </Pill>
  );
}

export function AheadBehind({ ahead, behind, main = "main" }: { ahead: number; behind: number; main?: string }) {
  if (ahead === 0 && behind === 0) return <span className="text-caption text-a-mut">{t("gleich mit {main}", { main })}</span>;
  const CAP = 20;
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={t("{ahead} eigene Commits, die {main} fehlen · {behind} Commits aus {main}, die hier fehlen", { ahead, behind, main })}>
      <span className="flex h-1.5 w-16 items-center" aria-hidden>
        <span className="flex h-full w-1/2 justify-end">{behind > 0 && <span className="h-full rounded-l-full bg-a-bad" style={{ width: `${(Math.min(behind, CAP) / CAP) * 100}%` }} />}</span>
        <span className="h-2.5 w-px bg-a-line" />
        <span className="flex h-full w-1/2">{ahead > 0 && <span className="h-full rounded-r-full bg-a-ok" style={{ width: `${(Math.min(ahead, CAP) / CAP) * 100}%` }} />}</span>
      </span>
      <span className="font-mono text-caption tabular-nums">
        <span className={ahead > 0 ? "text-a-ok" : "text-a-mut"}>+{ahead}</span> <span className={behind > 0 ? "text-a-bad" : "text-a-mut"}>−{behind}</span>
      </span>
    </span>
  );
}

export function ProbePill({ probe }: { probe: { status: "clean" | "conflict"; conflictFiles: string[] } | null }) {
  if (!probe) return null;
  return probe.status === "clean" ? (
    <Pill className="bg-a-ok/12 text-a-ok" title={t("NyxOS hat den Merge nach main probeweise durchgespielt (ohne etwas zu ändern): geht sauber.")}>
      {t("Merge geht sauber")}
    </Pill>
  ) : (
    <Pill className="bg-a-conf/12 text-a-conf" title={t("Probe-Merge nach main hätte Konflikte in: {files}", { files: probe.conflictFiles.join(", ") })}>
      {t("Konflikt beim Probe-Merge")}
    </Pill>
  );
}

/** Ungesicherte Dateien als gestapelter Balken nach Gruppe (Code/Doku/Projekt/Verschoben). */
export function UncommittedBar({ u, compact = false }: { u: GitUncommittedSummary; compact?: boolean }) {
  if (u.total === 0) return <span className="text-caption text-a-ok">{t("Alles gesichert")}</span>;
  const entries = Object.entries(u.groups).filter(([, n]) => n > 0);
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-a-p3" aria-hidden>
        {entries.map(([g, n]) => (
          <span key={g} className={GROUP_META[g]?.bar ?? "bg-a-indigo"} style={{ width: `${(n / u.total) * 100}%` }} />
        ))}
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption">
          {entries.map(([g, n]) => (
            <span key={g} className="flex items-center gap-1 text-a-mut">
              <span aria-hidden className={cn("h-2 w-2 rounded-[2px]", GROUP_META[g]?.bar)} />
              {GROUP_META[g]?.label ?? g} <span className="font-mono tabular-nums text-a-ink">{num(n)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function FamilyDot({ kind }: { kind: RepoKind }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: FAMILY[kind].color }} />;
}

export function Rel({ iso }: { iso: string | null }) {
  const rel = relativeTime(iso);
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-label text-a-mut" title={iso ? new Date(iso).toLocaleString(locale(), { timeZone: timeZone() }) : undefined}>
      {rel ?? "–"}
    </span>
  );
}

/** Eine Commit-Zeile: ganze Zeile öffnet die Großansicht, die Session ist ein eigener Link. */
export function CommitLine({ c, showRepo = false }: { c: GitCommitRow; showRepo?: boolean }) {
  const nav = useGitNav();
  return (
    <div className="group relative flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2.5 py-2 hover:bg-a-p2">
      <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full" style={{ background: FAMILY[c.kind].color }} />
      <button type="button" onClick={() => nav.open({ t: "commit", repoId: c.repoId, key: c.sha })} className="flex min-w-0 flex-1 items-center gap-2.5 text-left after:absolute after:inset-0 after:content-['']">
        <span className="shrink-0 font-mono text-caption text-a-mut">{c.sha.slice(0, 7)}</span>
        {c.parents > 1 && <Pill className="bg-a-violet/12 text-a-violet">{t("Merge")}</Pill>}
        <span className="min-w-0 flex-1 truncate text-callout text-a-ink" title={c.subject}>
          {c.subject}
        </span>
      </button>
      {showRepo && <Pill className={cn(FAMILY[c.kind].soft, FAMILY[c.kind].text)}>{c.repoLabel}</Pill>}
      <span className="max-w-[180px] shrink truncate font-mono text-label text-a-mut" title={c.branch}>
        {c.branch}
      </span>
      {c.insertions !== null && (
        <span className="shrink-0 font-mono text-label tabular-nums">
          <span className="text-a-ok">+{num(c.insertions)}</span> <span className="text-a-bad">−{num(c.deletions ?? 0)}</span>
        </span>
      )}
      {c.attribution.session ? <SessionLink session={c.attribution.session} /> : <Pill className="bg-a-indigo/12 text-a-indigo">{t("ohne Session")}</Pill>}
      <Rel iso={c.committedAt} />
    </div>
  );
}

export function ActionLine({ a }: { a: GitActionRow }) {
  const nav = useGitNav();
  const m = ACTION[a.kind];
  const clickable = !!a.sha && !!a.repoId;
  const body = (
    <>
      <Pill className={m.cls}>
        <span aria-hidden>{m.icon}</span>
        {a.label}
      </Pill>
      <span className="min-w-0 flex-1 truncate text-caption text-a-mut" title={a.detail}>
        {a.detail}
      </span>
    </>
  );
  return (
    <div className="group relative flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2.5 py-2 hover:bg-a-p2">
      {a.repoKind && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full" style={{ background: FAMILY[a.repoKind].color }} />}
      {clickable ? (
        <button type="button" onClick={() => nav.open({ t: "commit", repoId: a.repoId ?? "", key: a.sha ?? "" })} className="flex min-w-0 flex-1 items-center gap-2.5 text-left after:absolute after:inset-0 after:content-['']">
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{body}</span>
      )}
      {a.where && (
        <span className="max-w-[200px] shrink truncate font-mono text-label text-a-mut" title={a.where}>
          {lastPart(a.where)}
        </span>
      )}
      <Who who={a.who} />
      <Rel iso={a.at} />
    </div>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-2 text-caption text-a-mut">{children}</p>;
}
