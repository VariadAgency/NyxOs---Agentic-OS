// Kleine Bausteine des Ideen-Tabs (Auswahl-Chips, Stufen-Abzeichen).
import type { EntryStage } from "@nyxos/shared";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { STAGE_META } from "../entries/meta";
import { stageLabel } from "./meta";

/** Auswahl-Chip (Filter, Sortierung). `activeClass` färbt den aktiven Zustand in der Stufen-Farbe. */
export function Chip({ active, onClick, children, activeClass, disabled, count, testId }: { active: boolean; onClick: () => void; children: ReactNode; activeClass?: string; disabled?: boolean; count?: number; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-lg border px-2.5 text-caption transition-colors disabled:pointer-events-none disabled:opacity-40",
        active ? (activeClass ?? "border-a-acc/50 bg-a-acc/10 text-a-acc") : "border-a-line bg-a-p text-a-mut hover:border-a-mut/50 hover:text-a-ink",
      )}
    >
      {children}
      {count !== undefined && <span className={cn("font-mono text-label tabular-nums", active ? "" : "text-a-mut")}>{count}</span>}
    </button>
  );
}

/** Farbiges Abzeichen der Stufe (Eingang / In Klärung / Konzept fertig). */
export function StageBadge({ stage }: { stage: string }) {
  const m = STAGE_META[stage as EntryStage];
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 font-mono text-label font-medium tracking-wide", m ? `${m.bg} ${m.text}` : "bg-a-p3 text-a-mut")}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", m?.dot ?? "bg-a-mut")} />
      {stageLabel(stage)}
    </span>
  );
}

/** Aktiver Chip in der Farbe der Stufe. */
export function stageChipClass(stage: string): string | undefined {
  const m = STAGE_META[stage as EntryStage];
  return m ? `border-current/40 ${m.bg} ${m.text}` : undefined;
}
