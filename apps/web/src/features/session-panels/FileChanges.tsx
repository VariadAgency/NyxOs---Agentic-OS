// Klick auf eine Datei zeigt ihre einzelnen Änderungen (neueste zuerst) mit den
// geänderten Zeilen — in der Seite aufgeklappt, kein neuer Tab.
import { locale, t, timeZone, type ChangeSnippetLine } from "@nyxos/shared";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useFileChanges } from "./api";
import { DiffStat, Highlight } from "./FilePath";

export function DiffLines({ lines, needle = "", className }: { lines: ChangeSnippetLine[]; needle?: string; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded border border-a-line bg-a-bg font-mono text-label leading-[1.55]", className)}>
      {lines.map((l, i) => (
        <div key={i} className={cn("flex min-w-max gap-2 px-2", l.kind === "+" ? "bg-a-ok/10 text-a-ink" : "bg-a-bad/10 text-a-mut")}>
          <span aria-hidden="true" className={cn("w-2 shrink-0 select-none", l.kind === "+" ? "text-a-ok" : "text-a-bad")}>
            {l.kind === "+" ? "+" : "−"}
          </span>
          <span className="whitespace-pre">
            <Highlight text={l.text || " "} needle={needle} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function FileChanges({ sessionId, path, needle = "", agent = null }: { sessionId: string; path: string; needle?: string; agent?: string | null }) {
  const q = useFileChanges(sessionId, path, agent);
  if (q.isPending) return <Skeleton className="h-20" />;
  if (q.isError) {
    return (
      <div className="flex items-center gap-2 text-label">
        <span className="text-a-bad">{t("Die Änderungen dieser Datei konnten nicht geladen werden.")}</span>
        <Button variant="ghost" onClick={() => q.refetch()}>
          {t("Erneut versuchen")}
        </Button>
      </div>
    );
  }
  if (q.data.ops.length === 0) {
    return <p className="text-label text-a-mut">{t("Für diese Datei liegen keine einzelnen Änderungen im Verlauf vor (z. B. per Befehl im Terminal geändert).")}</p>;
  }
  return (
    <div className="grid gap-2" data-testid="file-changes">
      {q.data.total > q.data.ops.length && <p className="text-label text-a-mut">{t("Die letzten {n} von {total} Änderungen.", { n: q.data.ops.length, total: q.data.total })}</p>}
      {q.data.ops.map((op, i) => (
        <div key={i} className="grid gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-label text-a-mut">
            <span className="text-a-ink">{op.tool === "Write" ? t("Neu geschrieben") : op.tool === "apply_patch" ? t("Patch") : t("Bearbeitet")}</span>
            {op.ts && <span title={new Date(op.ts).toLocaleString(locale(), { timeZone: timeZone() })}>{relativeTime(op.ts)}</span>}
            {op.agentId && <span className="rounded bg-a-violet/15 px-1 font-mono text-label text-a-violet">{t("Sub-Agent")}</span>}
            <DiffStat added={op.added} removed={op.removed} className="ml-auto" />
          </div>
          {op.lines.length > 0 ? <DiffLines lines={op.lines} needle={needle} className="max-h-64" /> : <p className="text-label text-a-mut">{t("Keine Zeilen (leere Datei oder nur gelöscht).")}</p>}
          {op.truncated && <p className="text-label text-a-mut">{t("Gekürzt — die Änderung ist länger.")}</p>}
        </div>
      ))}
    </div>
  );
}
