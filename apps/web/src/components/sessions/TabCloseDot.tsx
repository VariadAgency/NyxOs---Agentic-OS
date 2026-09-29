// Session schließen wie einen Browser-Tab. Der Status-Punkt im Session-Tab wird nach langem
// Drücken (≥ 450 ms, Maus und Touch) zum ✕; ein Klick darauf fragt nach (die Rückfrage stellt `TabRows`).
// Solange der Zeiger auf dem ✕ ist, bleibt es; losgelassen/weg ohne Klick → nach 4 s wieder der Punkt.
// Bewusst EIN Element (immer derselbe Knopf): tauschte man Punkt gegen Knopf, könnte das Loslassen des
// langen Drucks im Browser schon als Klick auf das neue ✕ zählen.
import { t } from "@nyxos/shared";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export const LONG_PRESS_MS = 450;
export const ARMED_TIMEOUT_MS = 4000;
const VIBRATE_MS = 12;

type Phase = "idle" | "pressing" | "armed";

interface TabCloseDotProps {
  title: string;
  /** Farbe des Punkts (Zustand der Session), z. B. `bg-a-wait`. */
  dotClass: string;
  onRequestClose: () => void;
  className?: string;
  testId?: string;
}

export function TabCloseDot({ title, dotClass, onRequestClose, className, testId }: TabCloseDotProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Der Klick, der zum Druck gehört, der das ✕ erst scharf gemacht hat, zählt nicht. */
  const armedByThisPress = useRef(false);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const clearDisarm = () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
  };
  const scheduleDisarm = useCallback(() => {
    clearDisarm();
    disarmTimer.current = setTimeout(() => setPhase("idle"), ARMED_TIMEOUT_MS);
  }, []);
  useEffect(
    () => () => {
      clearPress();
      clearDisarm();
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    armedByThisPress.current = false;
    if (phase !== "idle") return;
    setPhase("pressing");
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      armedByThisPress.current = true;
      setPhase("armed");
      // Auf dem iPhone/Android spürbar, dass jetzt „scharf“ ist.
      try {
        navigator.vibrate?.(VIBRATE_MS);
      } catch {
        // Browser ohne Vibration – egal.
      }
      if (e.pointerType !== "mouse") scheduleDisarm();
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (phase !== "pressing") return;
    clearPress();
    setPhase("idle");
  };

  const armed = phase === "armed";
  return (
    <button
      type="button"
      data-testid={testId}
      data-phase={phase}
      tabIndex={armed ? 0 : -1}
      aria-hidden={armed ? undefined : true}
      aria-label={armed ? t("Session „{title}“ schließen", { title }) : undefined}
      title={armed ? t("Session schließen") : t("Lang drücken zum Schließen")}
      onPointerDown={onPointerDown}
      onPointerUp={() => {
        if (phase === "pressing") cancelPress();
        else if (armed) scheduleDisarm();
      }}
      onPointerCancel={() => {
        cancelPress();
        if (armed) scheduleDisarm();
      }}
      onPointerLeave={() => {
        cancelPress();
        if (armed) scheduleDisarm();
      }}
      onPointerEnter={() => {
        if (armed) clearDisarm();
      }}
      onPointerMove={() => {
        if (armed && disarmTimer.current) clearDisarm();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed || armedByThisPress.current) return;
        clearDisarm();
        setPhase("idle");
        onRequestClose();
      }}
      onBlur={() => {
        if (armed) scheduleDisarm();
      }}
      className={cn(
        "grid h-5 w-5 shrink-0 touch-none select-none place-items-center rounded-full [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-a-acc",
        armed ? "cursor-pointer bg-a-bad/15 text-a-bad hover:bg-a-bad/25" : "cursor-default",
        className,
      )}
    >
      {armed ? (
        <span aria-hidden="true" className="cc-tab-x text-label font-bold leading-none">
          ✕
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 rounded-full transition-transform ease-out motion-reduce:transition-none",
            dotClass,
            phase === "pressing" ? "scale-[1.8] duration-[450ms]" : "scale-100 duration-150",
          )}
        />
      )}
    </button>
  );
}
