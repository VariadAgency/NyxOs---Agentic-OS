// Filter-Chip für temporäre Sessions auf der Sessions-Seite. Die Wahl bleibt pro Gerät gemerkt.
// Eigene Komponente + Hook, damit SessionsView nur zwei Zeilen bekommt.
// Automatisch als Test erkannte Sessions (Selbsttest, Probe, Haiku-Lauf) sind STANDARDMÄSSIG
// ausgeblendet und erscheinen nur mit „Temporäre zeigen“. Bewusst temporär gestartete
// Sessions (Grund „manual“) bleiben immer sichtbar (mit ⏳). Neuer Schlüssel: die alte Wahl
// („ausblenden“ war aus) soll die neue Vorgabe nicht überstimmen.
import { t } from "@nyxos/shared";
import { useCallback, useState } from "react";
import { cn } from "../../lib/cn";
import type { Session } from "../../lib/api";

const KEY = "nyxos.sessions.testsZeigen";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "1";
  } catch {
    return true;
  }
}

/** `true` = Test-Sessions ausblenden (Vorgabe). */
export function useHideTemporary(): [boolean, (next: boolean) => void] {
  const [hide, setHide] = useState(read);
  const set = useCallback((next: boolean) => {
    setHide(next);
    try {
      localStorage.setItem(KEY, next ? "0" : "1");
    } catch {
      // privater Modus o. Ä. – dann gilt die Wahl nur bis zum Neuladen
    }
  }, []);
  return [hide, set];
}

/** Automatisch als Test erkannt (nicht bewusst temporär gestartet). */
export const isTemporary = (s: Pick<Session, "temporarySince" | "temporaryReason">): boolean => !!s.temporarySince && s.temporaryReason !== "manual";

export function withoutTemporary<T extends Pick<Session, "temporarySince" | "temporaryReason">>(sessions: T[], hide: boolean): T[] {
  return hide ? sessions.filter((s) => !isTemporary(s)) : sessions;
}

interface TempFilterChipProps {
  hide: boolean;
  onChange: (next: boolean) => void;
  /** Wie viele temporäre Sessions es im aktuellen Bereich gibt (0 → Chip bleibt, aber ruhig). */
  count: number;
  className?: string;
}

export function TempFilterChip({ hide, onChange, count, className }: TempFilterChipProps) {
  const label = hide ? t("Temporäre zeigen ({count} Test-Sessions ausgeblendet)", { count }) : t("Temporäre zeigen ({count} Test-Sessions sichtbar)", { count });
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!hide}
      aria-label={label}
      title={hide ? t("Automatisch erkannte Test-Sessions zeigen") : t("Test-Sessions wieder ausblenden")}
      onClick={() => onChange(!hide)}
      className={cn(
        className,
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc",
        !hide ? "border-a-temp/50 bg-a-temp/15 text-a-temp" : "border-a-line bg-a-p text-a-mut hover:border-a-temp/40 hover:text-a-ink",
      )}
    >
      <span aria-hidden="true">⏳</span>
      <span aria-hidden="true">{t("Temporäre zeigen")}</span>
      <span aria-hidden="true" className="font-mono text-label opacity-80">
        {count}
      </span>
    </button>
  );
}
