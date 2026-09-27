// Sichtbare Marke für Temporäres – Sanduhr + Restzeit („⏳ 4 Std“). Eine Farbe (`--a-temp`),
// damit man Wegwerf-Einträge in jeder Liste auf einen Blick erkennt. Restzeit tickt jede Minute nach.
import { formatRemaining, t, TEMPORARY_REASON_LABEL, type TemporaryReason } from "@nyxos/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";

/** Neu zeichnen im Minutentakt (Restzeit), ohne Server-Aufruf. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

interface TempBadgeProps {
  expiresAt: string;
  /** Was nach Ablauf passiert: Sessions wandern ins Archiv, Haiku-Fäden werden gelöscht. */
  what: "session" | "thread";
  reason?: TemporaryReason | null;
  className?: string;
}

export function TempBadge({ expiresAt, what, reason, className }: TempBadgeProps) {
  const now = useMinuteNow();
  const left = formatRemaining(expiresAt, now);
  const base = what === "session" ? t("Temporär – wandert ins Archiv in {left}", { left }) : t("Temporär – wird gelöscht in {left}", { left });
  const text = reason ? `${base} · ${TEMPORARY_REASON_LABEL[reason]}` : base;
  return (
    <span
      title={text}
      aria-label={text}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-a-temp/35 bg-a-temp/10 px-1.5 py-px font-mono text-label leading-[16px] text-a-temp",
        className,
      )}
    >
      <span aria-hidden="true">⏳ {left}</span>
    </span>
  );
}
