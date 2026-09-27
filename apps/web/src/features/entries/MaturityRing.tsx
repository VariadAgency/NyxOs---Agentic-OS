import type { MaturityResult } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

/**
 * Reife-Check als Ring + Checkliste (Stil wie "Content score", dunkel statt hell): Mitte = "n/6" groß, Ring-Segmente aus Status-Farbe, Liste der 6 Punkte mit
 * Nachweis-Text darunter.
 */
export function MaturityRing({ maturity }: { maturity: MaturityResult }) {
  const { passedCount, totalCount } = maturity;
  const pct = totalCount > 0 ? (passedCount / totalCount) * 100 : 0;
  const color = passedCount === totalCount ? "var(--a-acc)" : "var(--a-wait)";
  return (
    <div className="flex gap-4">
      <div
        className="relative grid h-20 w-20 shrink-0 place-items-center rounded-full"
        style={{ background: `conic-gradient(${color} ${pct * 3.6}deg, var(--a-p3) 0deg)` }}
        role="img"
        aria-label={t("Reife-Check: {passed} von {total} Punkten bestanden", { passed: passedCount, total: totalCount })}
      >
        <div className="grid h-[60px] w-[60px] place-items-center rounded-full bg-a-p text-center">
          <span className="font-display text-title2 leading-none font-semibold tabular-nums text-a-ink">
            {passedCount}/{totalCount}
          </span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5">
        {maturity.points.map((p) => (
          <li key={p.key} className="flex items-start gap-2 text-caption">
            <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-label", p.passed ? "bg-a-ok/20 text-a-ok" : "bg-a-p3 text-a-mut")}>{p.passed ? "✓" : "·"}</span>
            <span>
              <span className={p.passed ? "text-a-ink" : "text-a-mut"}>{p.label}</span>
              <span className="block text-label text-a-mut">{p.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
