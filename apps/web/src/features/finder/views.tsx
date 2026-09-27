// Ansichten „Symbole“, „Liste“ und „Galerie“ (die Spalten stehen in ColumnsView.tsx). Klick wählt,
// Doppelklick öffnet (Ordner: hinein, Datei: Vollbild). Tastatur steuert FinderView für alle Ansichten.
import { FINDER_KIND_LABEL, t, type FinderEntry } from "@nyxos/shared";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { FileIcon, KIND_COLOR, Thumb } from "./FileIcon";
import { PreviewPane } from "./Preview";
import { MoreButton, useProgressive } from "./progressive";
import { formatDate, formatSize, SORT_LABEL, type SortBy, type SortSpec } from "./sort";

export interface ViewProps {
  root: string;
  entries: FinderEntry[];
  selected: string | null;
  onSelect: (e: FinderEntry) => void;
  onOpen: (e: FinderEntry) => void;
}

/** Gewählte Zeile/Kachel in den sichtbaren Bereich holen (Tastatur-Blättern). */
function useScrollSelected(container: React.RefObject<HTMLElement | null>, selected: string | null) {
  useEffect(() => {
    if (!selected) return;
    const el = container.current?.querySelector(`[data-rel="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [container, selected]);
}

export function IconsView({ root, entries, selected, onSelect, onOpen }: ViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollSelected(ref, selected);
  const { shown, rest, more } = useProgressive(entries, selected);
  return (
    <div>
    <div ref={ref} role="listbox" aria-label={t("Symbole")} className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] content-start gap-2 p-3">
      {shown.map((e) => {
        const sel = e.rel === selected;
        return (
          <div
            key={e.rel}
            role="option"
            aria-selected={sel}
            data-rel={e.rel}
            title={e.name}
            onClick={() => onSelect(e)}
            onDoubleClick={() => onOpen(e)}
            className="group flex cursor-default flex-col items-center gap-1.5 rounded-xl p-2 text-center select-none"
          >
            <div className={cn("grid h-[76px] w-[88px] place-items-center rounded-lg", sel ? "bg-a-p3" : "group-hover:bg-a-p2")}>
              <Thumb root={root} entry={e} size={64} />
            </div>
            <span className={cn("line-clamp-2 max-w-full rounded px-1.5 text-caption leading-snug break-all", sel ? "bg-a-acc text-a-bg" : "text-a-ink", e.hidden && !sel && "opacity-60")}>{e.name}</span>
          </div>
        );
      })}
    </div>
    <MoreButton rest={rest} onMore={more} />
    </div>
  );
}

function HeaderCell({ by, sort, onSort, className }: { by: SortBy; sort: SortSpec; onSort: (s: SortSpec) => void; className?: string }) {
  const active = sort.by === by;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cn("sticky top-0 z-10 bg-a-p px-2 py-1.5 text-left font-normal", className)}>
      <button type="button" onClick={() => onSort({ by, dir: active && sort.dir === "asc" ? "desc" : "asc" })} className={cn("inline-flex items-center gap-1 text-caption", active ? "font-medium text-a-ink" : "text-a-mut hover:text-a-ink")}>
        {SORT_LABEL[by]}
        {active && <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

export function ListView({ root: _root, entries, selected, onSelect, onOpen, sort, onSort, showPath = false }: ViewProps & { sort: SortSpec; onSort: (s: SortSpec) => void; showPath?: boolean }) {
  const ref = useRef<HTMLTableElement>(null);
  useScrollSelected(ref, selected);
  const { shown, rest, more } = useProgressive(entries, selected);
  return (
    <>
    <table ref={ref} aria-label={showPath ? t("Suchergebnisse") : t("Dateiliste")} className="w-full table-fixed border-separate border-spacing-0 text-caption">
      <thead>
        <tr className="border-b border-a-line">
          <HeaderCell by="name" sort={sort} onSort={onSort} className="w-auto pl-4" />
          <HeaderCell by="date" sort={sort} onSort={onSort} className="hidden w-[170px] md:table-cell" />
          <HeaderCell by="size" sort={sort} onSort={onSort} className="w-[96px] text-right" />
          <HeaderCell by="kind" sort={sort} onSort={onSort} className="hidden w-[150px] lg:table-cell" />
        </tr>
      </thead>
      <tbody>
        {shown.map((e, i) => {
          const sel = e.rel === selected;
          return (
            <tr
              key={e.rel}
              data-rel={e.rel}
              aria-selected={sel}
              onClick={() => onSelect(e)}
              onDoubleClick={() => onOpen(e)}
              className={cn("cursor-default select-none", sel ? "bg-a-acc/85 text-a-bg" : i % 2 === 1 ? "bg-a-p2/50 hover:bg-a-p2" : "hover:bg-a-p2")}
            >
              <td className="truncate py-1 pr-2 pl-4">
                <span className="inline-flex max-w-full items-center gap-2 align-middle">
                  <FileIcon entry={e} size={16} />
                  <span className={cn("truncate", !sel && "text-a-ink", e.hidden && !sel && "opacity-60")} title={e.rel}>
                    {e.name}
                  </span>
                  {showPath && <span className={cn("truncate text-label", sel ? "text-a-bg/80" : "text-a-mut")}>{e.rel.slice(0, Math.max(0, e.rel.length - e.name.length - 1)) || t("oberste Ebene")}</span>}
                </span>
              </td>
              <td className={cn("hidden truncate px-2 py-1 md:table-cell", !sel && "text-a-mut")}>{formatDate(e.mtimeMs)}</td>
              <td className={cn("px-2 py-1 text-right tabular-nums", !sel && "text-a-mut")}>{e.isDir ? (e.children !== null ? t("{n} Obj.", { n: e.children }) : "–") : formatSize(e.size)}</td>
              <td className={cn("hidden truncate px-2 py-1 lg:table-cell", !sel && "text-a-mut")}>{t(FINDER_KIND_LABEL[e.kind])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    <MoreButton rest={rest} onMore={more} />
    </>
  );
}

/** Galerie: oben die große Vorschau der gewählten Datei, darunter ein Filmstreifen, darunter die Infos. */
export function GalleryView({ root, entries, selected, onSelect, onOpen }: ViewProps) {
  const strip = useRef<HTMLDivElement>(null);
  useScrollSelected(strip, selected);
  const current = entries.find((e) => e.rel === selected) ?? entries[0] ?? null;
  const { shown, rest, more } = useProgressive(entries, current?.rel ?? null);
  return (
    <div className="flex min-h-full flex-col gap-3 p-3">
      {current && (
        <div className="grid min-h-[320px] place-items-center rounded-xl border border-a-line bg-a-p p-4" onDoubleClick={() => onOpen(current)}>
          {current.kind === "image" ? <Thumb root={root} entry={current} size={900} className="max-h-[52vh]" /> : <FileIcon entry={current} size={120} />}
        </div>
      )}
      <div ref={strip} role="listbox" aria-label={t("Filmstreifen")} className="cc-scroll flex gap-2 overflow-x-auto pb-2">
        {shown.map((e) => {
          const sel = e.rel === current?.rel;
          return (
            <div
              key={e.rel}
              role="option"
              aria-selected={sel}
              data-rel={e.rel}
              title={e.name}
              onClick={() => onSelect(e)}
              onDoubleClick={() => onOpen(e)}
              className={cn("grid h-[84px] w-[84px] shrink-0 cursor-default place-items-center rounded-lg border-2 p-1", sel ? "border-a-acc bg-a-p3" : "border-transparent bg-a-p2 hover:bg-a-p3")}
            >
              <Thumb root={root} entry={e} size={70} />
            </div>
          );
        })}
        <MoreButton rest={rest} onMore={more} className="shrink-0 self-center rounded-md border border-a-line bg-a-p2 px-3 py-1 text-caption whitespace-nowrap text-a-mut hover:text-a-ink" />
      </div>
      {current && (
        <div className="cc-card-deep border border-a-line p-3">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full" style={{ background: KIND_COLOR[current.kind] }} />
            <span className="text-caption text-a-mut">{t("Infos")}</span>
          </div>
          <PreviewPane root={root} entry={current} onOpen={() => onOpen(current)} body={false} />
        </div>
      )}
    </div>
  );
}
