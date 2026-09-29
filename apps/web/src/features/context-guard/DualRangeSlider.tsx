// Kontext-Wächter — Doppel-Schieberegler 50–100 % mit zwei Griffen (Hinweis/Erzwingen),
// farbige Zonen grün/gelb/rot. Zwei überlagerte
// `<input type="range">` (Tastatur/Screenreader kostenlos), Zonen als CSS-Verlauf im Hintergrund.
import { CONTEXT_GUARD_MAX_PCT, CONTEXT_GUARD_MIN_PCT, t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

interface DualRangeSliderProps {
  hinweisPct: number;
  erzwingenPct: number | null;
  erzwingenEnabled: boolean;
  onChange: (next: { hinweisPct: number; erzwingenPct: number }) => void;
  disabled?: boolean;
}

const MIN = CONTEXT_GUARD_MIN_PCT;
const MAX = CONTEXT_GUARD_MAX_PCT;
const pctToLeft = (v: number) => `${((v - MIN) / (MAX - MIN)) * 100}%`;

export function DualRangeSlider({ hinweisPct, erzwingenPct, erzwingenEnabled, onChange, disabled }: DualRangeSliderProps) {
  const erzwingen = erzwingenPct ?? MAX;

  return (
    <div className="grid gap-2">
      <div className="relative h-6">
        {/* Zonen: grün bis Hinweis, gelb bis Erzwingen, rot danach (nur wenn Erzwingen aktiv ist). */}
        <div
          className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full"
          style={{
            background: erzwingenEnabled
              ? `linear-gradient(90deg, var(--a-ok) 0 ${pctToLeft(hinweisPct)}, var(--a-wait) ${pctToLeft(hinweisPct)} ${pctToLeft(erzwingen)}, var(--a-bad) ${pctToLeft(erzwingen)} 100%)`
              : `linear-gradient(90deg, var(--a-ok) 0 ${pctToLeft(hinweisPct)}, var(--a-wait) ${pctToLeft(hinweisPct)} 100%)`,
          }}
        />
        <input
          type="range"
          aria-label={t("Hinweis-Schwelle")}
          min={MIN}
          max={MAX}
          value={hinweisPct}
          disabled={disabled}
          onChange={(e) => {
            const next = Math.min(Number(e.target.value), erzwingenEnabled ? erzwingen : MAX);
            onChange({ hinweisPct: next, erzwingenPct: erzwingen });
          }}
          className="cc-range-thumb absolute inset-x-0 top-0 h-6 w-full appearance-none bg-transparent"
        />
        {erzwingenEnabled && (
          <input
            type="range"
            aria-label={t("Erzwingen-Schwelle")}
            min={MIN}
            max={MAX}
            value={erzwingen}
            disabled={disabled}
            onChange={(e) => {
              const next = Math.max(Number(e.target.value), hinweisPct);
              onChange({ hinweisPct, erzwingenPct: next });
            }}
            className="cc-range-thumb absolute inset-x-0 top-0 h-6 w-full appearance-none bg-transparent"
          />
        )}
      </div>
      <div className="flex justify-between font-mono text-label text-a-mut">
        <span>{MIN}%</span>
        <span className={cn("text-a-ok")}>{t("Hinweis {pct}%", { pct: hinweisPct })}</span>
        {erzwingenEnabled && <span className="text-a-bad">{t("Erzwingen {pct}%", { pct: erzwingen })}</span>}
        <span>{MAX}%</span>
      </div>
    </div>
  );
}
