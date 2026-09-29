// „Vergleichen“: (1) was jede Session an DERSELBEN Datei geändert hat, nebeneinander —
// aus dem Verlauf (Edit/Write bzw. Codex-Patch); (2) zwei Git-Stände vergleichen (Commit ↔ Commit
// oder Commit ↔ Arbeitskopie), nur lesend über die Brücke.
import { friendlyError } from "../../lib/friendlyError";
import { ErrorDetails } from "../../components/ErrorDetails";
import { t, type CollisionEntry, type FileEdit, type SessionFileChanges } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { useFileChanges, useGitCompare } from "../../hooks/useConflicts";
import { sessionColor } from "./collisionGroups";
import { sessionLetter } from "./decisionText";
import { DiffModeToggle, DiffView, type DiffMode } from "./DiffView";

const KIND_LABEL: Record<FileEdit["kind"], string> = { edit: t("Änderung"), write: t("Datei neu geschrieben"), create: t("Datei angelegt"), patch: t("Änderung"), delete: t("Datei gelöscht") };

function Problem({ text, onRetry, error }: { text: string; onRetry?: () => void; error?: unknown }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-a-wait/40 bg-a-wait/10 px-3 py-2 text-caption text-a-wait">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{text}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-md border border-a-line px-2 py-1 text-a-ink hover:bg-a-p2">
          {t("Nochmal versuchen")}
        </button>
      )}
      {error !== undefined && <ErrorDetails error={error} />}
    </div>
  );
}

/** Zuerst nur die jüngsten Änderungen — die sind für den aktuellen Konflikt wichtig. */
const RECENT_EDITS = 5;

function SessionColumn({ s, index }: { s: SessionFileChanges; index: number }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, s.edits.length - RECENT_EDITS);
  const shown = s.edits.slice(hidden);
  return (
    <div data-testid="session-changes" className="grid min-w-0 content-start gap-2 rounded-lg border border-a-line bg-a-p p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-label font-semibold text-a-on-primary" style={{ backgroundColor: sessionColor(s.sessionKey) }}>
          {sessionLetter(index)}
        </span>
        <span className="min-w-0 flex-1 truncate text-callout text-a-ink" title={s.title ?? s.sessionKey}>
          {s.title ?? s.sessionKey}
        </span>
        <span className="shrink-0 text-caption text-a-mut">
          {s.edits.length === 1 ? t("1 Änderung") : t("{n} Änderungen", { n: s.edits.length })}
        </span>
      </div>
      {s.missingArchive && <p className="text-caption text-a-mut">{t("Der Verlauf dieser Session liegt noch nicht auf dem Server.")}</p>}
      {!s.missingArchive && s.edits.length === 0 && <p className="text-caption text-a-mut">{t("Im Verlauf dieser Session steht keine Änderung an dieser Datei.")}</p>}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="justify-self-start rounded-md px-2 py-1 text-caption text-a-acc hover:bg-a-p2">
          {hidden === 1 ? t("1 ältere Änderung auch zeigen") : t("{n} ältere Änderungen auch zeigen", { n: hidden })}
        </button>
      )}
      {shown.map((e, i) => (
        <div key={hidden + i} className="grid min-w-0 gap-1">
          <p className="text-caption text-a-mut">
            {formatDateTime(e.at)} · {KIND_LABEL[e.kind]}
            {!e.exactLines && ` · ${t("Zeilennummern nur im Ausschnitt")}`}
            {e.truncated && ` · ${t("gekürzt")}`}
          </p>
          <DiffView lines={e.lines} mode="unified" />
        </div>
      ))}
    </div>
  );
}

export function SessionChanges({ entry }: { entry: CollisionEntry }) {
  const [layout, setLayout] = useState<DiffMode>("split");
  const keys = entry.writers.map((w) => w.sessionKey);
  const q = useFileChanges(entry.path, keys, keys.length > 0);
  if (keys.length === 0) return <p className="text-caption text-a-mut">{t("Keine Session schreibt diese Datei.")}</p>;
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-caption text-a-mut">{t("Jede Spalte zeigt, was eine Session an dieser Datei geändert hat – die jüngsten Änderungen, neueste unten.")}</p>
        <DiffModeToggle mode={layout} onChange={setLayout} />
      </div>
      {q.isLoading && <p className="text-caption text-a-mut">{t("Lese die Verläufe …")}</p>}
      {q.isError && <Problem text={friendlyError(q.error, t("Konnte die Änderungen nicht laden."))} error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <div className={cn("grid min-w-0 gap-3", layout === "split" && "lg:grid-cols-2")}>
          {q.data.sessions.map((s, i) => (
            <SessionColumn key={s.sessionKey} s={s} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

const WORKTREE = "";

export function GitCompare({ path }: { path: string }) {
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState(WORKTREE);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [mode, setMode] = useState<DiffMode>("split");
  const commits = useGitCompare(path, null, null, true);
  const diff = useGitCompare(path, applied?.from ?? null, applied ? applied.to || null : null, applied !== null);

  const options = [{ value: "HEAD", label: t("Letzter Commit (HEAD)") }, ...(commits.data?.commits ?? []).map((c) => ({ value: c.sha, label: `${c.short} · ${c.subject}` }))];
  const select = "min-w-0 max-w-full truncate rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-caption text-a-ink outline-none focus:border-a-acc";

  if (commits.isError) return <Problem text={friendlyError(commits.error, t("Vergleich nicht möglich."))} error={commits.error} onRetry={() => void commits.refetch()} />;

  return (
    <div className="grid min-w-0 gap-2">
      {commits.data && (
        <p className="min-w-0 text-caption text-a-mut [overflow-wrap:anywhere]">
          {t("Git-Ordner")} <span className="font-mono text-a-ink">{commits.data.repoRoot}</span> · {t("Datei")} <span className="font-mono text-a-ink">{commits.data.relPath}</span> ·{" "}
          {commits.data.commits.length === 1 ? t("1 Commit") : t("{n} Commits", { n: commits.data.commits.length })}
        </p>
      )}
      {commits.data?.untracked && <p className="text-caption text-a-wait">{t("Diese Datei ist noch in keinem Commit. „Was ist noch nicht gespeichert?“ zeigt sie deshalb ganz als neu.")}</p>}
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="grid min-w-0 max-w-full gap-1 text-caption text-a-mut sm:max-w-[45%]">
          {t("Von")}
          <select aria-label={t("Von")} value={from} onChange={(e) => setFrom(e.target.value)} className={select}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 max-w-full gap-1 text-caption text-a-mut sm:max-w-[45%]">
          {t("Bis")}
          <select aria-label={t("Bis")} value={to} onChange={(e) => setTo(e.target.value)} className={select}>
            <option value={WORKTREE}>{t("Arbeitskopie (noch nicht gespeichert)")}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setApplied({ from, to })} className="min-h-9 rounded-lg border border-a-acc bg-a-acc/15 px-3 text-callout text-a-acc hover:bg-a-acc/25">
          {t("Vergleichen")}
        </button>
        <button type="button" onClick={() => setApplied({ from: "HEAD", to: WORKTREE })} className="min-h-9 rounded-lg border border-a-line px-3 text-callout text-a-ink hover:bg-a-p2">
          {t("Was ist noch nicht gespeichert?")}
        </button>
      </div>
      {applied && (
        <div className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-caption text-a-mut">
              {applied.from} → {applied.to || t("Arbeitskopie")}
              {diff.data?.truncated && ` · ${t("sehr groß, gekürzt")}`}
            </p>
            <DiffModeToggle mode={mode} onChange={setMode} />
          </div>
          {diff.isLoading && <p className="text-caption text-a-mut">{t("Vergleiche …")}</p>}
          {diff.isError && <Problem text={friendlyError(diff.error, t("Vergleich nicht möglich."))} error={diff.error} onRetry={() => void diff.refetch()} />}
          {diff.data && diff.data.files.length === 0 && <p className="text-caption text-a-mut">{t("Keine Unterschiede zwischen diesen Ständen.")}</p>}
          {diff.data?.files.map((f, i) => (
            <div key={i} className="grid min-w-0 gap-1">
              <p className="min-w-0 truncate font-mono text-caption text-a-ink" title={f.newPath ?? f.oldPath ?? ""}>
                {f.newPath ?? f.oldPath}
              </p>
              {f.binary ? <p className="text-caption text-a-mut">{t("Binärdatei – kein Textvergleich möglich.")}</p> : <DiffView lines={f.lines} mode={mode} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CompareSection({ entry }: { entry: CollisionEntry }) {
  const [tab, setTab] = useState<"sessions" | "git">("sessions");
  return (
    <section aria-label={t("Vergleichen")} className="grid min-w-0 gap-3 border-t border-a-line pt-3">
      <div role="tablist" aria-label={t("Vergleich")} className="flex min-w-0 flex-wrap gap-1">
        {(
          [
            ["sessions", t("Was hat jede Session geändert?")],
            ["git", t("Git-Stände vergleichen")],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("rounded-md px-3 py-1.5 text-callout", tab === id ? "bg-a-p3 text-a-ink" : "text-a-mut hover:bg-a-p2 hover:text-a-ink")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "sessions" ? <SessionChanges entry={entry} /> : <GitCompare path={entry.path} />}
    </section>
  );
}
