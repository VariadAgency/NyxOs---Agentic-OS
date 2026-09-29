// Kontext-Wächter: kleiner Ring für den Kontext-Anteil einer Session. `pct === null` heißt "unbekannt" (Modell
// ohne hinterlegtes Kontextfenster, nie geschätzt) und zeigt einen gestrichelten Ring ohne Zahl.
import { CONTEXT_GUARD_DEFAULT, t, locale } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";

const R = 15.5;
const CIRC = 2 * Math.PI * R;

/** Farbe folgt den Status-Tokens (kein neuer Sinn nötig): ruhig bis zur Hinweis-Schwelle, Hinweis-
 * Gelb bis zur Erzwingen-Schwelle, Warnfarbe darüber. Die Schwellen kommen
 * aus den ECHTEN, je Session aufgelösten Werten (Session-/Modell-Override, Haiku, Standard)
 * statt fest 60/80 — `hinweisPct`/`erzwingenPct` sind optional, Start-Standard bleibt der Rückfall. */
function ringColor(pct: number, hinweisPct: number, erzwingenPct: number | null): string {
  if (erzwingenPct !== null && pct >= erzwingenPct) return "stroke-a-bad";
  if (pct >= hinweisPct) return "stroke-a-wait";
  return "stroke-a-acc";
}

export interface ContextRingProps {
  pct: number | null;
  size?: number;
  /** Fenstergröße des Modells in Tokens (für den Tooltip), `null` = unbekannt. */
  contextWindow?: number | null;
  /** Stand der Messung (letzte Antwort), ISO. */
  at?: string | null;
  className?: string;
  /** Aufgelöste Schwellen dieser Session (`useSessionContextThresholds`) — ohne Angabe der
   * Start-Standard (60/80), z. B. solange die Einstellungen noch laden. */
  hinweisPct?: number;
  erzwingenPct?: number | null;
}

const tokensFmt = new Intl.NumberFormat(locale());

/**
 * Tooltip in einfachen Worten — „Kontext: 58 % von 200.000 Tokens · Stand vor 2 Min“.
 * Woher die Fenstergröße kommt (Preistabelle, Cache …), ist Technik und steht hier bewusst nicht.
 */
export function contextRingTitle({ pct, window, at, now = Date.now() }: { pct: number | null; window: number | null; at: string | null; now?: number }): string {
  if (pct === null) return t("Kontext: unbekannt – für dieses Modell ist keine Fenstergröße bekannt");
  const pctText = Math.round(pct);
  const parts = [window ? t("Kontext: {pct} % von {window} Tokens", { pct: pctText, window: tokensFmt.format(window) }) : t("Kontext: {pct} %", { pct: pctText })];
  const age = relativeTime(at, now);
  if (age) parts.push(t("Stand {age}", { age }));
  return parts.join(" · ");
}

export function ContextRing({ pct, size = 32, contextWindow = null, at = null, className, hinweisPct = CONTEXT_GUARD_DEFAULT.hinweisPct, erzwingenPct = CONTEXT_GUARD_DEFAULT.erzwingenPct }: ContextRingProps) {
  const clamped = pct === null ? null : Math.max(0, Math.min(100, pct));
  const offset = clamped === null ? 0 : CIRC * (1 - clamped / 100);
  const title = contextRingTitle({ pct: clamped, window: contextWindow, at });
  return (
    <div className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }} title={title} data-testid="context-ring" data-pct={clamped ?? "unbekannt"}>
      <svg width={size} height={size} viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={R} fill="none" strokeWidth="3" className={clamped === null ? "stroke-a-line" : "stroke-a-line"} />
        {clamped !== null && (
          <circle cx="18" cy="18" r={R} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={offset} className={cn("transition-[stroke-dashoffset] duration-300", ringColor(clamped, hinweisPct, erzwingenPct))} />
        )}
      </svg>
      <span /* typo-keep: Zahl im Ring */ className="absolute font-mono text-[9px] tabular-nums text-a-mut">{clamped === null ? "–" : `${Math.round(clamped)}`}</span>
    </div>
  );
}
