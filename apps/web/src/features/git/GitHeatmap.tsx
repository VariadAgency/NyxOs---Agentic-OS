// Heatmap-Kalender „Commits je Tag“, 12 Wochen.
// Spalten = Wochen, Zeilen = Mo–So, Farbe = Summe aller Repos in 5 Akzent-Stufen (Quartile der
// Tage mit Commits). Tooltip nennt die Aufteilung je Art in deren Farbe. Jede Zelle ist ein Knopf:
// Klick öffnet die Commits dieses Tages. Tastatur: Tab/Pfeile über die Knöpfe.
import { locale, t, type GitDashboard } from "@nyxos/shared";
import { useMemo, useState } from "react";
import { HEAT_COLORS } from "../../components/charts/Heatmap";
import { levelByThresholds, quartileThresholds } from "../../components/charts/scale";
import { cn } from "../../lib/cn";
import { FAMILY, num } from "./meta";
import { useGitNav } from "./nav";

const WEEKDAYS = [t("Mo"), t("Di"), t("Mi"), t("Do"), t("Fr"), t("Sa"), t("So")];
const monthFmt = new Intl.DateTimeFormat(locale(), { month: "short", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** Montag = 0 … Sonntag = 6 (Kalendertag als UTC-Mittag, damit keine Zeitzone verschiebt). */
function weekdayIndex(day: string): number {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export function GitHeatmap({ days }: { days: GitDashboard["heatmap"] }) {
  const nav = useGitNav();
  const [active, setActive] = useState<string | null>(null);
  const totals = useMemo(() => days.map((d) => d.app + d.nyxos + d.other), [days]);
  const thresholds = useMemo(() => quartileThresholds(totals), [totals]);
  const offset = days[0] ? weekdayIndex(days[0].day) : 0;
  const weeks = Math.ceil((days.length + offset) / 7);
  const sum = useMemo(() => days.reduce((a, d) => ({ app: a.app + d.app, nyxos: a.nyxos + d.nyxos, other: a.other + d.other }), { app: 0, nyxos: 0, other: 0 }), [days]);
  const all = sum.app + sum.nyxos + sum.other;
  const hovered = days.find((d) => d.day === active) ?? null;

  const monthLabels: (string | null)[] = Array.from({ length: weeks }, () => null);
  let lastMonth = "";
  days.forEach((d, i) => {
    const col = Math.floor((i + offset) / 7);
    const m = d.day.slice(0, 7);
    if (m !== lastMonth && monthLabels[col] === null) {
      monthLabels[col] = monthFmt.format(new Date(`${d.day}T12:00:00Z`));
      lastMonth = m;
    }
  });

  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-1">
        <div className="grid shrink-0 gap-[3px] pt-[18px]" style={{ gridTemplateRows: "repeat(7, 16px)" }} aria-hidden>
          {WEEKDAYS.map((w, i) => (
            <span key={w} className="font-mono text-label leading-4 text-a-mut">
              {i % 2 === 0 ? w : ""}
            </span>
          ))}
        </div>
        <div className="grid min-w-0 flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(16px, 1fr))`, gridTemplateRows: "15px repeat(7, 16px)" }} role="grid" aria-label={t("Commits je Tag, letzte 12 Wochen")}>
          {monthLabels.map((m, col) => (
            <span key={`m${col}`} className="font-mono text-label leading-none text-a-mut" style={{ gridColumn: col + 1, gridRow: 1 }} aria-hidden>
              {m ?? ""}
            </span>
          ))}
          {days.map((d, i) => {
            const total = totals[i] ?? 0;
            const col = Math.floor((i + offset) / 7) + 1;
            const row = ((i + offset) % 7) + 2;
            const dayText = dayFmt.format(new Date(`${d.day}T12:00:00Z`));
            const label = total === 1 ? t("{day}: {n} Commit", { day: dayText, n: total }) : t("{day}: {n} Commits", { day: dayText, n: total });
            return (
              <button
                key={d.day}
                type="button"
                data-testid="heat-cell"
                data-day={d.day}
                aria-label={label}
                title={label}
                onMouseEnter={() => setActive(d.day)}
                onMouseLeave={() => setActive((a) => (a === d.day ? null : a))}
                onFocus={() => setActive(d.day)}
                onBlur={() => setActive((a) => (a === d.day ? null : a))}
                onClick={() => nav.open({ t: "day", key: d.day })}
                className={cn("h-4 w-full rounded-[4px] outline-none transition-[transform,box-shadow] duration-150 hover:scale-110 focus-visible:ring-2 focus-visible:ring-a-acc", active === d.day && "shadow-[0_0_0_1.5px_var(--a-ink)]")}
                style={{ gridColumn: col, gridRow: row, background: HEAT_COLORS[levelByThresholds(total, thresholds)] }}
              />
            );
          })}
        </div>
      </div>
      <div className="flex min-h-[20px] flex-wrap items-center justify-between gap-x-4 gap-y-2 text-caption text-a-mut">
        {hovered ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1" role="status">
            <span className="font-mono text-a-ink">{dayFmt.format(new Date(`${hovered.day}T12:00:00Z`))}</span>
            {(["app", "nyxos", "other"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1">
                <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ background: FAMILY[k].color }} />
                {FAMILY[k].label} <span className="font-mono tabular-nums text-a-ink">{hovered[k]}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(["app", "nyxos", "other"] as const)
              .filter((k) => k !== "other" || sum.other > 0)
              .map((k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FAMILY[k].color }} />
                  {FAMILY[k].label} <span className="font-mono tabular-nums text-a-ink">{num(sum[k])}</span>
                </span>
              ))}
            <span className="text-a-mut">· {t("{n} Commits in 12 Wochen · Tag anklicken für die Commits", { n: num(all) })}</span>
          </span>
        )}
        <span className="flex items-center gap-1.5" aria-hidden>
          {t("weniger")}
          {HEAT_COLORS.map((c) => (
            <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
          ))}
          {t("mehr")}
        </span>
      </div>
      {all > 0 && (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-a-p3" aria-hidden>
          {(["app", "nyxos", "other"] as const).map((k) => (
            <span key={k} style={{ width: `${(sum[k] / all) * 100}%`, background: FAMILY[k].color }} />
          ))}
        </div>
      )}
    </div>
  );
}
