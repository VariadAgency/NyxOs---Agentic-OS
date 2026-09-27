// Kopf des Aufgaben-Tabs — Titel mit einem Satz Lage, großer Fortschrittsring, farbige
// Kennzahl-Kacheln (offen / in Arbeit / startklar / fertig heute) und die Verteilung nach Projekt
// (klickbar = Filter). Farben nur aus den Tokens. Balken nur, wenn sie etwas sagen (mehr als
// eine Stufe) — sonst ein Satz und die Projekte als Filter-Chips.
import { t } from "@nyxos/shared";
import type { CSSProperties, ReactNode } from "react";
import { useCountUpOnce } from "../../components/charts/StatCard";
import { cn } from "../../lib/cn";
import { STAGE_ORDER, STAGE_THEME, stageSpread, type TaskStats, type TaskStage } from "./model";

/** Ring mit Prozent in der Mitte (SVG, Farbe frei wählbar — Projekt- oder Akzentfarbe). */
export function ProgressRing({ pct, size = 44, stroke = 4, color, label }: { pct: number; size?: number; stroke?: number; color: string; label?: string }) {
  const v = Math.max(0, Math.min(100, pct));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={t("{label}: {pct} Prozent", { label: label ?? t("Fortschritt"), pct: Math.round(v) })}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`color-mix(in srgb, ${color} 18%, var(--a-p3))`} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
          style={{ filter: v > 0 ? `drop-shadow(0 0 4px color-mix(in srgb, ${color} 55%, transparent))` : undefined }}
        />
      </svg>
      <span className={`relative font-mono tabular-nums text-a-ink ${size >= 64 ? "text-headline font-medium" : "text-label"}`}>{Math.round(v)} %</span>
    </span>
  );
}

/** Gestapelter Balken der Status-Anteile (eine Farbe je Stufe). */
export function StageBar({ counts, className, height = 6 }: { counts: Record<TaskStage, number>; className?: string; height?: number }) {
  const total = STAGE_ORDER.reduce((s, k) => s + counts[k], 0);
  return (
    <div data-stagebar className={cn("flex w-full gap-[2px] overflow-hidden rounded-full bg-a-p3", className)} style={{ height }} aria-hidden>
      {total > 0 &&
        STAGE_ORDER.filter((k) => counts[k] > 0).map((k) => (
          <span key={k} className="cc-progress-fill h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(counts[k] / total) * 100}%`, background: STAGE_THEME[k].color }} title={`${STAGE_THEME[k].label}: ${counts[k]}`} />
        ))}
    </div>
  );
}

function Kpi({ id, label, value, detail, color, icon }: { id: string; label: string; value: number; detail: string; color: string; icon: ReactNode }) {
  const shown = useCountUpOnce(`tasks-${id}`, value) ?? value;
  return (
    <div
      className="cc-stagger relative grid content-start gap-1.5 overflow-hidden rounded-xl border border-a-line bg-a-p p-4"
    >
      <span aria-hidden className="absolute top-3.5 right-3.5 grid h-7 w-7 place-items-center rounded-lg text-callout" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
        {icon}
      </span>
      <span className="pr-9 font-mono text-label uppercase tracking-wide text-a-mut">{label}</span>
      <span className="font-display text-[30px] font-semibold leading-none tabular-nums" style={{ color: value > 0 ? color : "var(--a-ink)" }}>
        {Math.round(shown)}
      </span>
      <span className="truncate text-caption text-a-mut">{detail}</span>
    </div>
  );
}

export function TaskKpis({ stats, openDetail }: { stats: TaskStats; openDetail: string }) {
  return (
    <section aria-label={t("Kennzahlen")} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] gap-3">
      <Kpi id="open" label={t("Offen gesamt")} value={stats.open} detail={openDetail} color="var(--a-violet)" icon="◎" />
      <Kpi id="work" label={t("In Arbeit")} value={stats.inArbeit} detail={stats.pruefen > 0 ? (stats.pruefen === 1 ? t("{n} wartet auf deine Abnahme", { n: stats.pruefen }) : t("{n} warten auf deine Abnahme", { n: stats.pruefen })) : t("läuft oder wird geprüft")} color={STAGE_THEME.laeuft.color} icon="▶" />
      <Kpi id="ready" label={t("Startklar")} value={stats.startklar} detail={t("ein Klick startet")} color={STAGE_THEME.startklar.color} icon="⚑" />
      <Kpi id="today" label={t("Fertig heute")} value={stats.fertigHeute} detail={t("{n} insgesamt erledigt", { n: stats.erledigt })} color={STAGE_THEME.erledigt.color} icon="✓" />
    </section>
  );
}

/** Verteilung nach Projekt: je Projekt eine Zeile mit Farbe, gestapeltem Status-Balken und Zahl. */
export function ProjectBreakdown({ stats, selected, onSelect }: { stats: TaskStats; selected: string | null; onSelect: (key: string | null) => void }) {
  if (stats.byProject.length === 0) return null;
  // Steht alles auf derselben Stufe, wäre jeder Balken 100 % einfarbig — ohne Aussage.
  if (stageSpread(stats.byStage) <= 1) {
    const only = STAGE_ORDER.find((k) => stats.byStage[k] > 0) ?? "geplant";
    return (
      <section aria-label={t("Nach Projekt")} className="grid gap-2.5 rounded-xl border border-a-line bg-a-p p-4">
        <p className="flex items-center gap-2 px-1 text-callout text-a-mut">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STAGE_THEME[only].color }} />
          <span>
            {t("Alles steht auf „{stage}“ · {hint}", { stage: STAGE_THEME[only].label, hint: STAGE_THEME[only].hint })}
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {stats.byProject.map((p) => {
            const active = selected === p.project.key;
            return (
              <button
                key={p.project.key}
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(active ? null : p.project.key)}
                className={"text-caption " + cn("inline-flex h-(--a-ctl-h) items-center gap-2 rounded-full border px-3 transition-colors", active ? "border-(--c)/50 bg-(--c)/10 text-a-ink" : "border-a-line text-a-mut hover:bg-a-p2 hover:text-a-ink")}
                style={{ "--c": p.project.color } as CSSProperties}
              >
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.project.color }} />
                {p.project.label}
                <span className="font-mono tabular-nums text-a-ink">{p.total}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <section aria-label={t("Nach Projekt")} className="grid gap-2 rounded-xl border border-a-line bg-a-p p-4 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="font-mono text-label font-semibold uppercase tracking-wider text-a-mut">{t("Nach Projekt")}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {STAGE_ORDER.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-label text-a-mut">
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: STAGE_THEME[k].color }} />
              {STAGE_THEME[k].label}
            </span>
          ))}
        </div>
      </div>
      <div className="grid gap-1">
        {stats.byProject.map((p, i) => {
          const active = selected === p.project.key;
          return (
            <button
              key={p.project.key}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : p.project.key)}
              className={cn(
                "cc-stagger grid grid-cols-[minmax(72px,150px)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors duration-150",
                active ? "border-(--c)/50 bg-(--c)/10" : "border-transparent hover:bg-a-p2",
              )}
              style={{ "--c": p.project.color, animationDelay: `${Math.min(i, 8) * 30}ms` } as CSSProperties}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.project.color, boxShadow: `0 0 8px color-mix(in srgb, ${p.project.color} 60%, transparent)` }} />
                <span className="truncate text-callout font-medium text-a-ink">{p.project.label}</span>
              </span>
              <StageBar counts={p.stageCounts} height={8} />
              <span className="whitespace-nowrap font-mono text-caption tabular-nums text-a-mut">
                <span className="text-a-ink">{p.open}</span> {t("offen")} · {p.total}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
