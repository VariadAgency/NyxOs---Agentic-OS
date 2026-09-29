// Tastenzeile über der Handy-Tastatur. Die Bildschirm-Tastatur von iPhone/Android hat weder Esc, Tab,
// Strg noch Pfeiltasten – für Claude Code (Esc = abbrechen, ⇧Tab = Modus, ↑ = letzte Eingabe, Strg-C) braucht es
// sie aber. Die Knöpfe stehlen der Tastatur nie den Fokus (`pointerdown` → preventDefault), sonst klappte sie
// bei jedem Tipp zu. Pfeile wiederholen sich beim Halten wie echte Tasten.
import { t } from "@nyxos/shared";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type TermKey = "esc" | "tab" | "shiftTab" | "enter" | "ctrlC" | "slash" | "up" | "down" | "left" | "right";

const ARROW: Record<"up" | "down" | "right" | "left", string> = { up: "A", down: "B", right: "C", left: "D" };

/** Zeichenfolge je Taste. Pfeile im „Anwendungs-Modus“ (z. B. vim, less) als `ESC O x` statt `ESC [ x`. */
export function keySequence(key: TermKey, opts: { appCursor?: boolean } = {}): string {
  switch (key) {
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "shiftTab":
      return "\x1b[Z";
    case "enter":
      return "\r";
    case "ctrlC":
      return "\x03";
    case "slash":
      return "/";
    default:
      return `\x1b${opts.appCursor ? "O" : "["}${ARROW[key]}`;
  }
}

/** Strg + ein Zeichen → Steuerzeichen (Strg-A = 0x01 … Strg-Z = 0x1a, Strg-[ = Esc …); sonst `null`. */
export function ctrlChar(input: string): string | null {
  if (input.length !== 1) return null;
  const c = input.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A–Z [ \ ] ^ _
  if (input === "?") return "\x7f";
  if (input === " ") return "\x00";
  return null;
}

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 70;

interface KeyDef {
  key: TermKey;
  label: string;
  /** Vorlese-/Hinweis-Name, wenn das Zeichen allein nichts sagt. */
  name?: string;
  repeat?: boolean;
}

const KEYS_BEFORE_CTRL: KeyDef[] = [
  { key: "esc", label: "Esc" },
  { key: "tab", label: "Tab" },
  { key: "shiftTab", label: "⇧Tab", name: t("Umschalt-Tab") },
];
const KEYS_AFTER_CTRL: KeyDef[] = [
  { key: "ctrlC", label: "^C", name: t("Strg-C") },
  { key: "up", label: "↑", name: t("Pfeil hoch"), repeat: true },
  { key: "down", label: "↓", name: t("Pfeil runter"), repeat: true },
  { key: "left", label: "←", name: t("Pfeil links"), repeat: true },
  { key: "right", label: "→", name: t("Pfeil rechts"), repeat: true },
  { key: "slash", label: "/", name: t("Schrägstrich") },
  { key: "enter", label: "⏎", name: "Enter" },
];

const KEY_CLASS =
  "grid h-11 min-w-11 shrink-0 place-items-center rounded-lg border border-a-line bg-a-p3 px-2.5 font-mono text-callout text-a-ink select-none [-webkit-tap-highlight-color:transparent] [touch-action:manipulation] active:bg-a-p2 disabled:opacity-40";

/** Kein Fokuswechsel: die Handy-Tastatur (xterm-Eingabefeld) bleibt offen. */
const keepFocus = (e: ReactPointerEvent<HTMLButtonElement>) => e.preventDefault();

export function TerminalKeys({
  disabled,
  ctrlArmed,
  onCtrlToggle,
  onSend,
  appCursor,
  className,
  children,
}: {
  disabled: boolean;
  ctrlArmed: boolean;
  onCtrlToggle: () => void;
  onSend: (data: string) => void;
  /** Liest den Modus erst beim Drücken (er kann sich während der Sitzung ändern). */
  appCursor: () => boolean;
  className?: string;
  /** Weitere Knöpfe am Ende (Einfügen, Kopieren, Tastatur). */
  children?: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repeated = useRef(false);
  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);

  const send = (key: TermKey) => onSend(keySequence(key, { appCursor: appCursor() }));

  const button = (def: KeyDef) => (
    <button
      key={def.key}
      type="button"
      disabled={disabled}
      aria-label={def.name ?? def.label}
      title={def.name ?? def.label}
      data-key={def.key}
      className={KEY_CLASS}
      onPointerDown={(e) => {
        keepFocus(e);
        if (!def.repeat || disabled) return;
        // Halten = wiederholen; der erste Anschlag kommt sofort, der Klick danach zählt nicht doppelt.
        repeated.current = true;
        send(def.key);
        stop();
        const again = () => {
          send(def.key);
          timer.current = setTimeout(again, REPEAT_EVERY_MS);
        };
        timer.current = setTimeout(again, REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (repeated.current) {
          repeated.current = false;
          return;
        }
        send(def.key);
      }}
    >
      {def.label}
    </button>
  );

  return (
    <div
      role="toolbar"
      aria-label={t("Terminal-Tasten")}
      data-testid="terminal-keys"
      className={cn("cc-scroll flex items-center gap-1.5 overflow-x-auto border-t border-a-line bg-a-p px-2 py-1.5 [scrollbar-width:none]", className)}
    >
      {KEYS_BEFORE_CTRL.map(button)}
      <button
        type="button"
        disabled={disabled}
        aria-label={t("Strg")}
        aria-pressed={ctrlArmed}
        title={t("Strg – rastet für die nächste Taste ein")}
        data-key="ctrl"
        className={cn(KEY_CLASS, ctrlArmed && "border-a-acc bg-a-acc/20 text-a-acc")}
        onPointerDown={keepFocus}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onCtrlToggle}
      >
        {t("Strg")}
      </button>
      {KEYS_AFTER_CTRL.map(button)}
      {children && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-a-line" />
          {children}
        </>
      )}
    </div>
  );
}
