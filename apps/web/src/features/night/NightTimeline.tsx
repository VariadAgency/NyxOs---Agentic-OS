// Nachtmodus — Planer als Zeitleiste (Uhrzeit, Budget-Ring). Zeigt das Fenster (23:00–07:00 Standard)
// als Balken, den aktuellen Zeitpunkt als Marker und den Budget-Verbrauch als Ring daneben. Reine
// Darstellung — die echten Nachtläufe (`GET /api/night/runs`) liefert der Aufrufer.
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

export interface NightRunLite {
  taskId: string;
  title: string;
  status: "queued" | "running" | "done" | "stopped_budget" | "stopped_time" | "waiting_mac" | "failed";
  startedAt: string | null;
  endedAt: string | null;
}

export interface NightTimelineProps {
  window: { start: string; end: string };
  runs: NightRunLite[];
  /** 0–1, Anteil des Nacht-Budgets, der schon verbraucht ist. */
  budgetUsedFraction: number;
  now?: Date;
  className?: string;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Position 0–100 % innerhalb der Fensterbreite, auch wenn das Fenster über Mitternacht geht. */
function positionInWindow(window: NightTimelineProps["window"], atMinutes: number): number {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const span = end > start ? end - start : 24 * 60 - start + end;
  let offset = atMinutes - start;
  if (offset < 0) offset += 24 * 60;
  return Math.min(100, Math.max(0, (offset / span) * 100));
}

const STATUS_COLOR: Record<NightRunLite["status"], string> = {
  queued: "bg-a-dim",
  running: "bg-a-wait",
  done: "bg-a-ok",
  stopped_budget: "bg-a-bad",
  stopped_time: "bg-a-bad",
  waiting_mac: "bg-a-idle",
  failed: "bg-a-bad",
};

const STATUS_LABEL: Record<NightRunLite["status"], string> = {
  queued: t("wartet"),
  running: t("läuft"),
  done: t("fertig"),
  stopped_budget: t("gestoppt: Budget"),
  stopped_time: t("gestoppt: Zeit"),
  waiting_mac: t("wartet auf die Brücke"),
  failed: t("fehlgeschlagen"),
};

function BudgetRing({ fraction }: { fraction: number }) {
  const pct = Math.min(1, Math.max(0, fraction));
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 36 36" className="h-9 w-9 shrink-0" role="img" aria-label={t("{pct} % des Nacht-Budgets verbraucht", { pct: Math.round(pct * 100) })}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--a-line)" strokeWidth="3" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke={pct >= 0.9 ? "var(--a-bad)" : pct >= 0.6 ? "var(--a-wait)" : "var(--a-acc)"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 18 18)"
        className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500"
      />
      <text /* typo-keep: SVG-Einheiten im 36er-Ring */ x="18" y="21" textAnchor="middle" className="fill-a-ink font-mono text-[9px]">
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

export function NightTimeline({ window: win, runs, budgetUsedFraction, now = new Date(), className }: NightTimelineProps) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowPct = positionInWindow(win, nowMinutes);
  return (
    <div className={cn("min-w-0 rounded-xl border border-a-line bg-a-p p-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="font-mono text-label uppercase tracking-wide text-a-mut">
          {t("Nachtfenster {start}–{end}", { start: win.start, end: win.end })}
        </div>
        <BudgetRing fraction={budgetUsedFraction} />
      </div>
      <div className="relative h-2 min-w-0 rounded-full bg-a-p3">
        {runs.map((run) => {
          if (!run.startedAt) return null;
          const start = positionInWindow(win, new Date(run.startedAt).getHours() * 60 + new Date(run.startedAt).getMinutes());
          const end = run.endedAt ? positionInWindow(win, new Date(run.endedAt).getHours() * 60 + new Date(run.endedAt).getMinutes()) : nowPct;
          const width = Math.max(1, end - start);
          return (
            <span
              key={run.taskId}
              title={`${run.title}: ${STATUS_LABEL[run.status]}`}
              className={cn("absolute top-0 h-2 rounded-full opacity-80", STATUS_COLOR[run.status])}
              style={{ left: `${start}%`, width: `${width}%` }}
            />
          );
        })}
        {/* Marker für "jetzt" — nur sinnvoll innerhalb des Fensters. */}
        <span className="absolute -top-1 h-4 w-[2px] bg-a-ink/70" style={{ left: `${nowPct}%` }} aria-hidden />
      </div>
      <ul className="mt-3 space-y-1">
        {runs.length === 0 && <li className="font-body text-callout text-a-mut">{t("Keine Nachtläufe.")}</li>}
        {runs.map((run) => (
          <li key={run.taskId} className="flex min-w-0 items-center gap-2 font-body text-callout text-a-ink">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_COLOR[run.status])} aria-hidden />
            <span className="min-w-0 truncate">{run.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
