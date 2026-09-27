// Kontext-Wächter — Entscheidung, reine Funktion (kein DB-/Netz-Zugriff): aus dem aktuellen
// Kontext-Anteil, den aufgelösten Schwellen und dem zuletzt gemerkten Zustand einer Session wird
// abgeleitet, ob jetzt (a) ein Hinweis fällig ist, (b) ein Erzwingen-Versuch fällig ist, und ob die
// beiden Merker zurückgesetzt werden (Kontext-Anteil wieder unter die jeweilige Schwelle gefallen —
// das erlaubt einen NEUEN Hinweis/Versuch bei einer künftigen Überschreitung, ohne in einer
// Schleife mehrfach je Überschreitung zu senden, s. `tick.ts`, das diese Entscheidung ausführt).
import type { ResolvedContextGuardThresholds } from "@nyxos/shared";

export interface ContextGuardStateSnapshot {
  hinweisNotifiedAt: string | null;
  erzwingenAttemptedAt: string | null;
}

export interface ContextGuardDecisionInput {
  pct: number | null;
  thresholds: ResolvedContextGuardThresholds;
  /** P2-Zustand ("waiting" = wartet auf dich — nur dann darf erzwungen werden). */
  sessionState: string | null;
  /** läuft die Session in tmux und kann die NyxOS ihr Text schicken? */
  attachable: boolean;
  state: ContextGuardStateSnapshot;
}

export interface ContextGuardDecision {
  notify: boolean;
  resetHinweis: boolean;
  forceCompact: boolean;
  resetErzwingen: boolean;
}

const NOOP: ContextGuardDecision = { notify: false, resetHinweis: false, forceCompact: false, resetErzwingen: false };

export function decideContextGuardActions(input: ContextGuardDecisionInput): ContextGuardDecision {
  const { pct, thresholds, state } = input;
  if (pct === null) return NOOP;

  const overHinweis = pct >= thresholds.hinweisPct;
  const overErzwingen = thresholds.erzwingenEnabled && thresholds.erzwingenPct !== null && pct >= thresholds.erzwingenPct;

  if (!overHinweis) {
    return {
      notify: false,
      resetHinweis: state.hinweisNotifiedAt !== null,
      forceCompact: false,
      resetErzwingen: state.erzwingenAttemptedAt !== null,
    };
  }

  if (!overErzwingen) {
    return {
      notify: state.hinweisNotifiedAt === null,
      resetHinweis: false,
      forceCompact: false,
      // Erzwingen-Schwelle liegt über der Hinweis-Schwelle (Validierung) — wer unter ihr liegt,
      // liegt also unter der Erzwingen-Schwelle: ein vorheriger Versuch darf hier zurückgesetzt werden.
      resetErzwingen: state.erzwingenAttemptedAt !== null,
    };
  }

  return {
    notify: state.hinweisNotifiedAt === null,
    resetHinweis: false,
    forceCompact: state.erzwingenAttemptedAt === null && input.sessionState === "waiting" && input.attachable,
    resetErzwingen: false,
  };
}
