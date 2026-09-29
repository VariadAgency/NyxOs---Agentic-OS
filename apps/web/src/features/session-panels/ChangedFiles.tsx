// „Geänderte Dateien" rechts im Session-Vollbild — erst 5, dann „alle N zeigen". Jede Datei
// kurz und lesbar (Name fett, Ordner gedämpft, voller Pfad im Tooltip) mit Anzahl Änderungen und +/−.
// Klick klappt die einzelnen Änderungen der Datei direkt darunter auf.
import { useState } from "react";
import { t, type ChangeFileStat } from "@nyxos/shared";
import type { SessionDetail } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useSessionChanges } from "./api";
import { FileChanges } from "./FileChanges";
import { DiffStat, FilePath } from "./FilePath";

export const FILES_PREVIEW = 5;

export function ChangedFiles({ detail }: { detail: SessionDetail }) {
  const changes = useSessionChanges(detail.session.id);
  const [expanded, setExpanded] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);

  // Solange der Server rechnet: die schon bekannten Pfade (ohne Zahlen) statt einer leeren Fläche.
  const fallback: ChangeFileStat[] = detail.files.filter((f) => f.mode === "write").map((f) => ({ path: f.path, edits: null, added: null, removed: null, lastTs: null, agentIds: [] }));
  const files: ChangeFileStat[] = changes.data?.files ?? fallback;
  const shown = expanded ? files : files.slice(0, FILES_PREVIEW);
  const hidden = files.length - shown.length;

  return (
    <div className="min-w-0" data-testid="changed-files">
      <h5 className="mb-1.5 flex items-baseline gap-2 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">
        {t("Geänderte Dateien")}
        {files.length > 0 && <span className="rounded bg-a-p3 px-1.5 font-normal normal-case tracking-normal text-a-ink">{files.length}</span>}
      </h5>
      {files.length === 0 ? (
        <p className="text-label text-a-mut">{t("Keine Änderungen.")}</p>
      ) : (
        <ul className="grid min-w-0 gap-0.5 text-caption">
          {shown.map((f) => {
            const open = openPath === f.path;
            return (
              <li key={f.path} className={cn("min-w-0 rounded", open && "bg-a-p2")}>
                <button
                  type="button"
                  onClick={() => setOpenPath(open ? null : f.path)}
                  aria-expanded={open}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-a-p2"
                >
                  <FilePath path={f.path} cwd={detail.session.cwd} className="flex-1" />
                  <DiffStat added={f.added} removed={f.removed} edits={f.edits} />
                </button>
                {open && (
                  <div className="px-1.5 pb-2">
                    <FileChanges sessionId={detail.session.id} path={f.path} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {files.length > FILES_PREVIEW && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1.5 rounded px-1.5 py-0.5 text-caption font-medium text-a-acc hover:bg-a-p2" aria-expanded={expanded}>
          {expanded ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: files.length })}
          {!expanded && hidden > 0 && <span className="ml-1 font-normal text-a-mut">(+{hidden})</span>}
        </button>
      )}
    </div>
  );
}
