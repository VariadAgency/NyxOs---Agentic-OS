import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

interface KpiTileProps {
  label: string;
  value: number | string;
  detail?: string;
  accent?: "ok" | "wait" | "bad" | "acc";
}

const ACCENT_TEXT: Record<NonNullable<KpiTileProps["accent"]>, string> = {
  ok: "text-a-ok",
  wait: "text-a-wait",
  bad: "text-a-bad",
  acc: "text-a-acc",
};

/**
 * Kennzahl-Kachel: Mono/Versalien-Überschrift, große Zahl
 * (tabular-nums), zählt beim ERSTEN Erscheinen kurz hoch. `prefers-reduced-motion` überspringt das
 * Hochzählen und zeigt sofort den Endwert.
 */
export function KpiTile({ label, value, detail, accent }: KpiTileProps) {
  const numeric = typeof value === "number" ? value : null;
  const [display, setDisplay] = useState(numeric === null ? value : 0);
  // "Beim ERSTEN Erscheinen hochzählen" heißt: sobald die echte Zahl ankommt (oft erst nach dem
  // ersten Render, weil die Daten noch laden) — nicht wortwörtlich nur beim allerersten Mount. Ohne
  // diese Unterscheidung blieb die Kachel bei 0 stehen, wenn `value` beim Mount noch 0/leer war und
  // erst danach der echte Wert eintraf (gefunden per Playwright-Screenshot gegen den Probe-Stack:
  // alle Kennzahl-Kacheln zeigten „0", obwohl die Abschnitte darunter echte Zahlen hatten).
  const animatedOnce = useRef(false);

  useEffect(() => {
    if (numeric === null) return;
    if (animatedOnce.current || numeric === 0) {
      // Bei 0 gibt es nichts hochzuzählen — UND: das markiert die Animation noch nicht als
      // "erledigt", falls gleich danach der echte (von Null verschiedene) Wert nachkommt.
      setDisplay(numeric);
      return;
    }
    animatedOnce.current = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(numeric);
      return;
    }
    const start = performance.now();
    const durationMs = 500;
    let raf = 0;
    const tick = (now: number) => {
      // `Math.max(0, …)`: manche `requestAnimationFrame`-Implementierungen (z. B. jsdom in Tests)
      // liefern einen Zeitstempel, der nicht sauber zu `performance.now()` passt — ohne die
      // Untergrenze würde `t` negativ und die Zahl kurzzeitig falsch (sogar negativ) anzeigen.
      const t = Math.max(0, Math.min(1, (now - start) / durationMs));
      const eased = Math.max(0, Math.min(numeric, Math.round(numeric * (1 - (1 - t) * (1 - t)))));
      setDisplay(eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [numeric]);

  return (
    <div className="cc-card-deep flex flex-col gap-1.5 border border-a-line p-4">
      <span className="font-mono text-label tracking-wide text-a-mut uppercase">{label}</span>
      <span className={cn("cc-kpi-value font-display text-[30px] leading-none font-semibold tracking-[-0.02em] tabular-nums", accent ? ACCENT_TEXT[accent] : "text-a-ink")}>{display}</span>
      {detail && <span className="text-caption text-a-mut">{detail}</span>}
    </div>
  );
}
