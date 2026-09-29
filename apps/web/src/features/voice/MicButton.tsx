// Mikrofon-Knopf mit pulsierendem Pegelring. Push-to-talk: Maus/Touch halten ODER Tastenkürzel halten
// (Vorgabe: Leertaste, wenn kein Eingabefeld fokussiert ist — s. `useHoldToTalkShortcut`). Einsatz:
// Suchfeld/⌘K; `target` ist die Schnittstelle für Haiku-Panel/Terminal.
import { useEffect, useRef } from "react";
import { t, type VoiceTarget } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { type VoiceResult, useVoiceRecorder } from "./useVoiceRecorder";

export interface MicButtonProps {
  target?: VoiceTarget;
  onResult?: (result: VoiceResult) => void;
  /** Tastenkürzel zum Halten (Vorgabe: Leertaste). `null` schaltet das Kürzel ab. */
  shortcutKey?: string | null;
  className?: string;
  /** Kleine Fassung ohne Statuszeile darunter — für die Einbettung in ein Suchfeld/⌘K. */
  compact?: boolean;
}

function useHoldToTalkShortcut(key: string | null, onDown: () => void, onUp: () => void) {
  // `onDown`/`onUp` sind neue Funktionsreferenzen bei jedem Render (sie hängen an `start`/`stop`,
  // die sich mit `status` ändern) — über Refs statt Abhängigkeiten geführt, sonst reißt der
  // Effekt bei jedem Zustandswechsel ab und baut sich neu auf. Genau dabei verlöre ein lokales
  // `let held` in der Effekt-Closure seinen Wert: das echte Loslassen der Taste käme dann NACH dem
  // Neuaufbau an und würde am frischen, wieder auf `false` stehenden `held` abprallen (im Test
  // reproduziert: Leertaste loslassen rief `stop()` nie auf, weil der Effekt zwischen Keydown und
  // Keyup wegen des Zustandswechsels "recording" neu lief). Ref hält `held` über den Neuaufbau hinweg.
  const onDownRef = useRef(onDown);
  const onUpRef = useRef(onUp);
  onDownRef.current = onDown;
  onUpRef.current = onUp;
  const heldRef = useRef(false);

  useEffect(() => {
    if (!key) return;
    const isTypingTarget = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== key || heldRef.current || isTypingTarget(e.target)) return;
      heldRef.current = true;
      onDownRef.current();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== key || !heldRef.current) return;
      heldRef.current = false;
      onUpRef.current();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [key]);
}

export function MicButton({ target = "search", onResult, shortcutKey = "Space", className, compact = false }: MicButtonProps) {
  const { status, level, error, start, stop, cancel } = useVoiceRecorder({ target, onResult });
  useHoldToTalkShortcut(shortcutKey, () => void start(), () => void stop());

  const recording = status === "recording";
  const ringScale = 1 + level * 0.6; // 1.0–1.6, per Pegel
  const label = recording ? t("Aufnahme beenden") : t("Diktat aufnehmen (halten)");
  const size = compact ? "h-7 w-7" : "h-11 w-11";
  const icon = compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5";

  const button = (
    <button
      type="button"
      aria-pressed={recording}
      aria-label={label}
      title={shortcutKey ? t("Halten zum Diktieren (Leertaste)") : t("Halten zum Diktieren")}
      onMouseDown={() => void start()}
      onMouseUp={() => void stop()}
      onMouseLeave={() => recording && cancel()}
      onTouchStart={(e) => {
        e.preventDefault();
        void start();
      }}
      onTouchEnd={() => void stop()}
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full border transition-colors duration-150",
        size,
        recording ? "border-a-acc bg-a-acc/15 text-a-acc" : "border-a-line bg-a-p2 text-a-mut hover:text-a-ink hover:border-a-dim",
        status === "transcribing" && "opacity-70",
        compact && "border-transparent bg-transparent hover:bg-a-p3",
      )}
      disabled={status === "transcribing"}
    >
      {/* Pegelring: skaliert mit dem RMS-Pegel, `prefers-reduced-motion` deaktiviert die Übergangs-Animation. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full border-2 border-a-acc/60 motion-safe:transition-transform motion-safe:duration-100"
        style={{ transform: recording ? `scale(${ringScale})` : "scale(1)", opacity: recording ? 0.5 + level * 0.5 : 0 }}
      />
      <MicIcon className={icon} />
    </button>
  );

  if (compact) {
    return (
      <span className={cn("relative inline-flex", className)}>
        {button}
        {error && <span className="absolute right-0 top-full z-10 mt-1 max-w-40 text-nowrap rounded border border-a-line bg-a-p px-1.5 py-0.5 text-label text-a-bad shadow-lg">{error}</span>}
      </span>
    );
  }

  return (
    <div className={cn("inline-flex flex-col items-center gap-1", className)}>
      {button}
      <span className="font-mono text-label uppercase tracking-wide text-a-mut">
        {status === "recording" ? t("nimmt auf …") : status === "transcribing" ? t("erkennt …") : status === "error" ? t("Fehler") : t("Halten")}
      </span>
      {error && <span className="max-w-40 text-center text-label text-a-bad">{error}</span>}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
