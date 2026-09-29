// Diff-Ansicht — Zeilennummern, Hinzufügen/Entfernen farbig (`--a-ok`/`--a-bad`),
// umschaltbar nebeneinander/untereinander. Lange Diffs werden virtualisiert (`@tanstack/react-virtual`,
// wie die übrigen langen Listen), Zeilen brechen um statt über die Kachel zu ragen.
import { t, toSplitRows, type DiffLine, type SplitRow } from "@nyxos/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { cn } from "../../lib/cn";

export type DiffMode = "split" | "unified";

/** Ab so vielen Zeilen wird nur noch der sichtbare Teil gezeichnet. */
export const DIFF_VIRTUAL_FROM = 300;
const ROW_ESTIMATE = 20;

const KIND_BG: Record<DiffLine["kind"], string> = { add: "bg-a-ok/10", del: "bg-a-bad/10", ctx: "", hunk: "bg-a-done/10" };
const KIND_MARK: Record<DiffLine["kind"], { sign: string; cls: string }> = {
  add: { sign: "+", cls: "text-a-ok" },
  del: { sign: "−", cls: "text-a-bad" },
  ctx: { sign: " ", cls: "text-a-mut" },
  hunk: { sign: "", cls: "text-a-done" },
};
const NUM = "select-none px-1.5 text-right tabular-nums text-a-mut";
const TEXT = "min-w-0 whitespace-pre-wrap px-1.5 [overflow-wrap:anywhere]";

function UnifiedRow({ line }: { line: DiffLine }) {
  const mark = KIND_MARK[line.kind];
  if (line.kind === "hunk") {
    return <div className={cn("col-span-4 px-2 py-0.5", KIND_BG.hunk, mark.cls, TEXT)}>{line.text}</div>;
  }
  return (
    <div data-kind={line.kind} className={cn("col-span-4 grid grid-cols-subgrid", KIND_BG[line.kind])}>
      <span className={NUM}>{line.oldNo ?? ""}</span>
      <span className={NUM}>{line.newNo ?? ""}</span>
      <span className={cn("select-none text-center", mark.cls)}>{mark.sign}</span>
      <span className={cn(TEXT, "text-a-ink")}>{line.text}</span>
    </div>
  );
}

function Half({ line, side }: { line: DiffLine | null; side: "left" | "right" }) {
  if (!line) return <div className="col-span-2 bg-a-p2/60" />;
  const kind = line.kind === "ctx" ? "ctx" : line.kind;
  return (
    <div data-kind={kind} className={cn("col-span-2 grid grid-cols-subgrid", KIND_BG[kind])}>
      <span className={NUM}>{side === "left" ? (line.oldNo ?? "") : (line.newNo ?? "")}</span>
      <span className={cn(TEXT, "text-a-ink")}>
        {kind !== "ctx" && <span className={cn("select-none pr-1", KIND_MARK[kind].cls)}>{KIND_MARK[kind].sign}</span>}
        {line.text}
      </span>
    </div>
  );
}

function SplitRowView({ row }: { row: SplitRow }) {
  if (row.kind === "hunk") return <div className={cn("col-span-4 px-2 py-0.5", KIND_BG.hunk, KIND_MARK.hunk.cls, TEXT)}>{row.left?.text}</div>;
  return (
    <div className="col-span-4 grid grid-cols-subgrid">
      <Half line={row.left} side="left" />
      <Half line={row.right} side="right" />
    </div>
  );
}

/** Feste Spalten für die Zeilennummern — auch virtualisierte Zeilen (je ein eigenes Grid) bleiben bündig. */
const GRID: Record<DiffMode, string> = {
  unified: "grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)]",
  split: "grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)]",
};

function VirtualRows({ count, mode, render }: { count: number; mode: DiffMode; render: (i: number) => React.ReactNode }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const v = useVirtualizer({ count, getScrollElement: () => parentRef.current, estimateSize: () => ROW_ESTIMATE, overscan: 20 });
  return (
    <div ref={parentRef} className="cc-scroll h-[60vh] overflow-y-auto" data-testid="diff-virtual">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((item) => (
          <div key={item.key} data-index={item.index} ref={v.measureElement} className={cn("absolute left-0 top-0 grid w-full", GRID[mode])} style={{ transform: `translateY(${item.start}px)` }}>
            {render(item.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffView({ lines, mode, emptyText = t("Keine Unterschiede.") }: { lines: DiffLine[]; mode: DiffMode; emptyText?: string }) {
  const split = useMemo(() => (mode === "split" ? toSplitRows(lines) : []), [lines, mode]);
  const count = mode === "split" ? split.length : lines.length;
  if (count === 0) return <p className="px-2 py-3 text-caption text-a-mut">{emptyText}</p>;
  const render = (i: number) => (mode === "split" ? <SplitRowView row={split[i] as SplitRow} /> : <UnifiedRow line={lines[i] as DiffLine} />);
  return (
    <div data-testid="diff-view" data-mode={mode} className="min-w-0 overflow-hidden rounded-md border border-a-line bg-a-bg font-mono text-caption leading-5">
      {count > DIFF_VIRTUAL_FROM ? (
        <VirtualRows count={count} mode={mode} render={render} />
      ) : (
        <div className={cn("cc-scroll grid max-h-[60vh] overflow-y-auto", GRID[mode])}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="contents">
              {render(i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffModeToggle({ mode, onChange, labels = { split: t("Nebeneinander"), unified: t("Untereinander") } }: { mode: DiffMode; onChange: (m: DiffMode) => void; labels?: Record<DiffMode, string> }) {
  return (
    <div role="radiogroup" aria-label={t("Ansicht")} className="inline-flex shrink-0 rounded-md border border-a-line p-0.5 text-caption">
      {(["split", "unified"] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onChange(m)} className={cn("rounded px-2.5 py-1", mode === m ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}>
          {labels[m]}
        </button>
      ))}
    </div>
  );
}
