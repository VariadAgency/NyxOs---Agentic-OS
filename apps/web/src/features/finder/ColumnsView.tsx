// Spaltenansicht wie im macOS-Finder. Jede Spalte ist ein Ordner entlang des gewählten Pfads, die
// letzte Spalte zeigt den Inhalt des gewählten Ordners bzw. die Vorschau der gewählten Datei. Die Spalten
// stehen nebeneinander und scrollen waagrecht (ausdrückliche Ausnahme zur Regel „nicht nebeneinander“),
// Breite je Spalte ziehbar (gemerkt), Tastatur: ↑/↓ wählen, → hinein, ← zurück, Enter öffnet, Leertaste = Übersicht.
import { t, type FinderEntry } from "@nyxos/shared";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/cn";
import { parentOf } from "./api";
import { useFinderSource } from "./source";
import { MoreButton, useProgressive } from "./progressive";
import { FileIcon } from "./FileIcon";
import { useEntries } from "./hooks";
import { ListError } from "./ListError";
import { PreviewPane } from "./Preview";
import { sortEntries, type SortSpec } from "./sort";

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 160;
const MAX_WIDTH = 640;
const KEY_STEP = 16;

export interface ColumnsViewProps {
  root: string;
  rootLabel: string;
  /** Ordner der ersten Spalte (Adresse `p`). */
  baseDir: string;
  selected: string | null;
  sort: SortSpec;
  showHidden: boolean;
  widths: number[];
  onWidths: (w: number[]) => void;
  onSelect: (rel: string) => void;
  onOpen: (e: FinderEntry) => void;
  onQuickLook: () => void;
}

/** Ordner-Kette von `baseDir` bis zum Ordner, in dem `sel` liegt. */
export function columnChain(baseDir: string, sel: string | null): string[] {
  const chain = [baseDir];
  if (!sel) return chain;
  const inside = baseDir === "" ? true : sel.startsWith(`${baseDir}/`);
  if (!inside) return chain;
  const rest = baseDir === "" ? sel : sel.slice(baseDir.length + 1);
  const segs = rest.split("/");
  let cur = baseDir;
  for (const s of segs.slice(0, -1)) {
    cur = cur ? `${cur}/${s}` : s;
    chain.push(cur);
  }
  return chain;
}

function nameOf(dir: string, rootLabel: string) {
  return dir === "" ? rootLabel : (dir.split("/").pop() ?? dir);
}

export function ColumnsView({ root, rootLabel, baseDir, selected, sort, showHidden, widths, onWidths, onSelect, onOpen, onQuickLook }: ColumnsViewProps) {
  const source = useFinderSource();
  const scroller = useRef<HTMLDivElement>(null);
  const chain = useMemo(() => columnChain(baseDir, selected), [baseDir, selected]);
  const results = useQueries({
    queries: chain.map((dir) => ({ queryKey: [source.key, "list", root, dir], queryFn: () => source.fetchList(root, dir), staleTime: 5_000, retry: false })),
  });
  const columns = chain.map((dir, i) => {
    const r = results[i];
    const entries = r?.data ? sortEntries(showHidden ? r.data.entries : r.data.entries.filter((e) => !e.hidden), sort) : [];
    return { dir, entries, loading: r?.isLoading ?? true, error: (r?.error ?? null) as unknown, retry: () => void r?.refetch() };
  });
  const last = columns[columns.length - 1];
  const selEntry = selected && last && parentOf(selected) === last.dir ? (last.entries.find((e) => e.rel === selected) ?? null) : null;
  const child = useEntries(root, selEntry?.isDir ? selEntry.rel : null, sort, showHidden);

  // Die aktive Spalte ist die, in der die Auswahl steht (sonst die erste).
  const active = selEntry ? columns.length - 1 : 0;
  const activeEntries = columns[active]?.entries ?? [];

  const move = (delta: number) => {
    if (activeEntries.length === 0) return;
    const idx = selEntry ? activeEntries.findIndex((e) => e.rel === selEntry.rel) : -1;
    const next = idx === -1 ? (delta > 0 ? 0 : activeEntries.length - 1) : Math.min(activeEntries.length - 1, Math.max(0, idx + delta));
    const target = activeEntries[next];
    if (target) onSelect(target.rel);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "ArrowRight": {
        e.preventDefault();
        const first = child.entries[0];
        if (selEntry?.isDir && first) onSelect(first.rel);
        return;
      }
      case "ArrowLeft":
        e.preventDefault();
        if (selected && parentOf(selected) !== baseDir && selected !== baseDir) onSelect(parentOf(selected));
        return;
      case "Enter":
        e.preventDefault();
        if (selEntry?.isDir) {
          const first = child.entries[0];
          if (first) onSelect(first.rel);
        } else if (selEntry) onOpen(selEntry);
        return;
      case " ":
        e.preventDefault();
        if (selEntry || selected) onQuickLook();
        return;
    }
  };

  // Neue Spalte → nach rechts scrollen (wie der Finder), die aktive Spalte bekommt den Fokus.
  const columnCount = columns.length + (selEntry?.isDir ? 1 : 0) + (selEntry && !selEntry.isDir ? 1 : 0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    try {
      if (typeof el.scrollTo === "function") el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
    } catch {
      // ältere Browser: egal
    }
  }, [columnCount, selected]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !selected) return;
    if (document.activeElement && document.activeElement !== document.body && !el.contains(document.activeElement)) return;
    const box = el.querySelector<HTMLElement>(`[data-col-active="true"]`);
    box?.focus({ preventScroll: true });
    box?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, columnCount]);

  const widthOf = (i: number) => widths[i] ?? DEFAULT_WIDTH;
  const setWidth = (i: number, w: number) => {
    const next = [...widths];
    for (let k = next.length; k <= i; k++) next[k] = DEFAULT_WIDTH;
    next[i] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
    onWidths(next);
  };

  const all = [...columns.map((c, i) => ({ ...c, highlight: i + 1 < columns.length ? (columns[i + 1]?.dir ?? null) : (selEntry?.rel ?? null) }))];
  if (selEntry?.isDir) all.push({ dir: selEntry.rel, entries: child.entries, loading: child.isLoading, error: child.error, retry: () => void child.refetch(), highlight: null });

  return (
    <div ref={scroller} onKeyDown={onKeyDown} className="cc-scroll flex h-full min-h-0 overflow-x-auto overflow-y-hidden">
      {all.map((col, i) => (
        <div key={`${col.dir}|${i}`} className="flex h-full shrink-0" style={{ width: widthOf(i) }}>
          <Column
            root={root}
            label={nameOf(col.dir, rootLabel)}
            entries={col.entries}
            loading={col.loading}
            error={col.error}
            rootLabel={rootLabel}
            onRetry={col.retry}
            highlight={col.highlight}
            active={i === active}
            onPick={(e) => onSelect(e.rel)}
            onOpen={onOpen}
          />
          <Resizer label={t("Spaltenbreite {name} ändern", { name: nameOf(col.dir, rootLabel) })} width={widthOf(i)} onWidth={(w) => setWidth(i, w)} />
        </div>
      ))}
      {selEntry && !selEntry.isDir && (
        <div className="cc-scroll h-full min-w-[320px] flex-1 overflow-y-auto p-4">
          <PreviewPane root={root} entry={selEntry} onOpen={() => onOpen(selEntry)} className="mx-auto max-w-[520px]" />
        </div>
      )}
    </div>
  );
}

function Column(props: { root: string; label: string; rootLabel: string; entries: FinderEntry[]; loading: boolean; error: unknown; onRetry: () => void; highlight: string | null; active: boolean; onPick: (e: FinderEntry) => void; onOpen: (e: FinderEntry) => void }) {
  const { label, rootLabel, entries, loading, error, onRetry, highlight, active, onPick, onOpen } = props;
  const { shown, rest, more } = useProgressive(entries, highlight);
  return (
    <div role="listbox" aria-label={label} tabIndex={0} data-col-active={active} className="cc-scroll h-full min-w-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:bg-a-p/40">
      {loading && (
        <div className="space-y-1 px-2 py-1">
          {[0, 1, 2, 3].map((k) => (
            <div key={k} className="h-5 animate-pulse rounded bg-a-p2" />
          ))}
        </div>
      )}
      {!loading && !!error && <ListError error={error} label={rootLabel} onRetry={onRetry} compact />}
      {!loading && !error && entries.length === 0 && <p className="px-3 py-3 text-center text-caption text-a-mut">{t("Leer")}</p>}
      {shown.map((e) => {
        const on = e.rel === highlight;
        return (
          <div
            key={e.rel}
            role="option"
            aria-selected={on}
            title={e.name}
            onClick={() => onPick(e)}
            onDoubleClick={() => onOpen(e)}
            className={cn(
              "mx-1 flex h-[24px] cursor-default items-center gap-1.5 rounded-[5px] px-1.5 text-caption select-none",
              on ? (active ? "bg-a-acc text-a-bg" : "bg-a-p3 text-a-ink") : "text-a-ink hover:bg-a-p2",
              e.hidden && !on && "opacity-60",
            )}
          >
            <FileIcon entry={e} size={16} />
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {e.isDir && (
              <span aria-hidden="true" className={cn("shrink-0 text-callout leading-none", on && active ? "text-a-bg" : "text-a-mut")}>
                ›
              </span>
            )}
          </div>
        );
      })}
      <MoreButton rest={rest} onMore={more} />
    </div>
  );
}

function Resizer({ label, width, onWidth }: { label: string; width: number; onWidth: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const moveP = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current) onWidth(start.current.w + (e.clientX - start.current.x));
  };
  const up = () => {
    start.current = null;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={moveP}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onWidth(DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onWidth(width + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP));
        }
      }}
      className="group relative w-[7px] shrink-0 cursor-col-resize touch-none outline-none"
    >
      <span className="absolute inset-y-0 left-[3px] w-px bg-a-line transition-colors group-hover:bg-a-acc/60 group-focus-visible:bg-a-acc" />
      <span className="absolute bottom-1.5 left-[1px] hidden h-3 w-[5px] rounded-sm border border-a-line bg-a-p2 group-hover:block" />
    </div>
  );
}
