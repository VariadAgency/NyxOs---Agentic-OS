// Gemeinsame Bausteine für Haiku, Inbox und Ideen-Links: Quellen-Chips, Etiketten, Toast,
// Stagger. Lädt die gemeinsamen Flächen/Bewegungen aus `haiku.css`.
import "./haiku.css";
import { getLang, locale, t, type HaikuErrorCode, type HaikuSource } from "@nyxos/shared";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";

export const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";
export const FIELD =
  "w-full min-w-0 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-body text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none";

/** Stagger beim ersten Erscheinen: 30 ms je Element, höchstens 8 Elemente versetzt. */
export function riseStyle(index: number): CSSProperties {
  return { ["--i" as string]: Math.min(index, 7) } as CSSProperties;
}

const SOURCE_ICON: Record<HaikuSource["kind"], string> = {
  session: "▣",
  entry: "☰",
  doc: "▤",
  approval: "⛨",
  inbox: "⚖",
  build: "⚒",
  night: "☾",
  usage: "◔",
  commit: "⎇",
  report: "☀",
};

export function SourceChips({ sources, className }: { sources: HaikuSource[]; className?: string }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label={t("Quellen")} className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {sources.map((s) => {
        const inner = (
          <>
            <span aria-hidden="true" className="font-mono text-label opacity-80">
              {SOURCE_ICON[s.kind] ?? "•"}
            </span>
            <span className="min-w-0 truncate">{s.label}</span>
          </>
        );
        const base = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption";
        return (
          <li key={`${s.kind}-${s.id}`} className="min-w-0 max-w-full">
            {s.href ? (
              <Link
                to={s.href}
                title={s.label}
                className={cn(base, "border-a-acc/30 bg-a-acc/8 text-a-acc transition-colors duration-150 hover:border-a-acc/60 hover:bg-a-acc/10")}
              >
                {inner}
              </Link>
            ) : (
              <span title={s.label} className={cn(base, "border-a-line bg-a-p2 text-a-mut")}>
                {inner}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function EstimateTag({ long = false }: { long?: boolean }) {
  return (
    <span className="inline-flex items-center rounded border border-a-wait/30 bg-a-wait/10 px-1.5 py-px font-mono text-label text-a-wait">
      {long ? t("Einschätzung (ohne Quelle)") : t("Einschätzung")}
    </span>
  );
}

export const HAIKU_ERROR_TEXT: Record<HaikuErrorCode, string> = {
  disabled: t("Nyx ist ausgeschaltet."),
  not_ready: t("Nyx ist gerade nicht bereit."),
  budget: t("Tagesgrenze erreicht. Morgen geht es weiter – oder die Grenze in den Einstellungen erhöhen."),
  timeout: t("Nyx hat zu lange gebraucht. Bitte noch einmal fragen."),
  busy: t("Nyx ist gerade beschäftigt. Gleich noch einmal versuchen."),
  rate_limit: t("Zu viele Anfragen hintereinander. Kurz warten."),
  engine: t("Der Motor meldet einen Fehler."),
  invalid: t("Die Frage konnte nicht verarbeitet werden."),
  auth: t("Bitte anmelden (Touch ID) – dann noch einmal fragen."),
};

/** Kurzer Toast (5 s), eine Meldung zur Zeit. */
export function useToast(ms = 5000) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), ms);
    return () => clearTimeout(timer);
  }, [message, ms]);
  const show = useCallback((text: string) => setMessage(text), []);
  return { message, show };
}

export function ToastView({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="cc-rise fixed bottom-[calc(var(--a-demo-bar-h)+20px)] left-1/2 z-[60] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-a-line bg-a-p3 px-4 py-2 text-caption text-a-ink shadow-lg"
    >
      {message}
    </div>
  );
}

/** Fehlerzustand mit „Erneut versuchen“ (jede Ansicht kennt Lade-, Leer-, Fehlerzustand). */
export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-a-bad/30 bg-a-bad/5 px-3 py-2.5 text-callout text-a-ink">
      <span className="min-w-0">{text}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-mono text-caption text-a-acc underline">
          {t("Erneut versuchen")}
        </button>
      )}
    </div>
  );
}

export function formatUsd(v: number): string {
  // Wie Nutzung/Überblick (de „2.663 $“, en „$2,663“); kleine Beträge mit 3 Stellen, geschütztes Leerzeichen vor $.
  const digits = v < 0.1 && v > 0 ? 3 : 2;
  const num = v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return getLang() === "en" ? `$${num}` : `${num}\u00a0$`;
}

