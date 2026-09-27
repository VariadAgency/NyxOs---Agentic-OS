import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeFileHit } from "@nyxos/shared";
import type { SessionDetail } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useSessionChanges } from "../../features/session-panels/api";
import { DiffStat, FilePath } from "../../features/session-panels/FilePath";
import { DiffLines, FileChanges } from "../../features/session-panels/FileChanges";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const SEARCH_DEBOUNCE_MS = 200;
const ROW_ESTIMATE = 44;

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function FileRow({ file, sessionId, cwd, needle, open, onToggle }: { file: ChangeFileHit; sessionId: string; cwd: string | null; needle: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={cn("rounded border border-a-line bg-a-p2", open && "border-a-acc/50")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-caption hover:bg-a-p3">
        <span aria-hidden="true" className="w-3 shrink-0 text-a-mut">
          {open ? "▾" : "▸"}
        </span>
        <FilePath path={file.path} cwd={cwd} needle={file.matchedPath ? needle : ""} className="flex-1" />
        {file.agentIds.length > 0 && <span className="shrink-0 rounded bg-a-violet/15 px-1 font-mono text-label text-a-violet">{t("Sub-Agent")}</span>}
        <DiffStat added={file.added} removed={file.removed} edits={file.edits} />
        {file.lastTs && <span className="hidden shrink-0 text-label text-a-mut sm:inline">{relativeTime(file.lastTs)}</span>}
      </button>
      {!open && file.snippets.length > 0 && (
        <div className="px-2 pb-1.5 pl-7">
          <DiffLines lines={file.snippets} needle={needle} />
          {file.contentMatches > file.snippets.length && <p className="mt-0.5 text-label text-a-mut">{t("+ {n} weitere Treffer in dieser Datei", { n: file.contentMatches - file.snippets.length })}</p>}
        </div>
      )}
      {open && (
        <div className="border-t border-a-line px-2 py-2 pl-7">
          <FileChanges sessionId={sessionId} path={file.path} needle={needle} />
        </div>
      )}
    </div>
  );
}

/**
 * Reiter „Änderungen": alle geschriebenen Dateien mit Anzahl Änderungen und +/−, durchsuchbar
 * nach Dateiname und geändertem Inhalt (Treffer hervorgehoben, „x von y"). Die Liste ist virtualisiert
 * (eine echte Session hat ~1 000 Dateien); Klick auf eine Datei klappt ihre Änderungen auf.
 */
export function ChangesPanel({ detail }: { detail: SessionDetail }) {
  const sessionId = detail.session.id;
  const [input, setInput] = useState("");
  const query = useDebounced(input, SEARCH_DEBOUNCE_MS);
  const changes = useSessionChanges(sessionId, query);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const files = changes.data?.files ?? [];
  // Zähler, Hervorhebung und „Nichts gefunden" beziehen sich auf die Suche, zu der die ANGEZEIGTEN
  // Daten gehören — beim Tippen bleibt bis zur neuen Antwort die alte Liste stehen.
  const needle = changes.data?.query ?? "";

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (i) => files[i]?.path ?? i,
  });

  const totals = files.reduce(
    (acc, f) => ({ edits: acc.edits + (f.edits ?? 0), added: acc.added + (f.added ?? 0), removed: acc.removed + (f.removed ?? 0) }),
    { edits: 0, added: 0, removed: 0 },
  );
  const searching = needle.length > 0;
  const total = changes.data?.total ?? 0;

  if (changes.isPending) {
    return (
      <div className="grid gap-1.5 p-3">
        {[0, 1, 2, 3].map((r) => (
          <Skeleton key={r} className="h-8" />
        ))}
      </div>
    );
  }
  if (changes.isError && !changes.data) {
    return (
      <div className="grid justify-items-start gap-2 p-3 text-caption">
        <p className="text-a-bad">{t("Die Änderungen konnten nicht geladen werden.")}</p>
        <Button onClick={() => changes.refetch()}>{t("Erneut versuchen")}</Button>
      </div>
    );
  }
  if (total === 0 && !searching && !input) {
    return <div className="p-4 text-caption text-a-mut">{t("Diese Session hat noch keine Datei geschrieben.")}</div>;
  }

  return (
    <div className="flex h-full min-h-[420px] min-w-0 flex-col" role="tabpanel" aria-label={t("Änderungen")}>
      <div className="grid shrink-0 gap-1.5 border-b border-a-line p-3">
        <div className="flex items-center gap-2">
          <label className="flex h-[var(--a-ctl-h)] min-w-0 flex-1 items-center gap-2 rounded-md border border-a-line bg-a-bg px-2 focus-within:border-a-acc">
            <span aria-hidden="true" className="text-a-mut">
              ⌕
            </span>
            <input
              type="search"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setOpenPath(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setInput("");
              }}
              placeholder={t("Dateien und geänderten Inhalt durchsuchen …")}
              aria-label={t("Änderungen durchsuchen")}
              className="min-w-0 flex-1 bg-transparent text-caption text-a-ink outline-none placeholder:text-a-mut"
            />
          </label>
          <span className="shrink-0 font-mono text-label text-a-mut" data-testid="changes-count" aria-live="polite">
            {searching ? t("{n} von {total}", { n: files.length, total }) : t(total === 1 ? "{n} Datei" : "{n} Dateien", { n: total })}
            {changes.isFetching && <span className="ml-1 text-a-mut">…</span>}
          </span>
        </div>
        {changes.isError && (
          <div className="flex items-center gap-2 text-label">
            <span className="text-a-bad">{t("Die Suche hat gerade nicht geklappt.")}</span>
            <Button variant="ghost" onClick={() => changes.refetch()}>
              {t("Erneut versuchen")}
            </Button>
          </div>
        )}
        {!searching && (
          <p className="text-label text-a-mut">
            {t(totals.edits === 1 ? "{n} Änderung" : "{n} Änderungen", { n: totals.edits })} · <span className="text-a-ok">+{totals.added}</span> <span className="text-a-bad">−{totals.removed}</span> {t("Zeilen")}
          </p>
        )}
      </div>
      {files.length === 0 ? (
        <div className="grid justify-items-start gap-2 p-4 text-caption text-a-mut">
          <p>{t("Nichts gefunden für „{q}“. Suche nach einem Dateinamen oder nach Text, der in dieser Session geändert wurde.", { q: needle })}</p>
          <Button onClick={() => setInput("")}>{t("Suche leeren")}</Button>
        </div>
      ) : (
        <div ref={parentRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto" data-testid="changes-scroll">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const file = files[row.index];
              if (!file) return null;
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)`, padding: "2px 8px" }}
                >
                  <FileRow
                    file={file}
                    sessionId={sessionId}
                    cwd={detail.session.cwd}
                    needle={needle}
                    open={openPath === file.path}
                    onToggle={() => setOpenPath((p) => (p === file.path ? null : file.path))}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
