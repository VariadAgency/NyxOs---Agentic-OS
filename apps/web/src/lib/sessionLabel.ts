// EIN Name je Session und EINE Regel für „verwaist“ – dieselben
// Funktionen wie auf dem Server (`@nyxos/shared`), damit Reiter, Karte, Kopf, Brotkrümel, Überblick und
// Briefing gleich heißen und gleich zählen. Vorher baute jede Datei ihren Platzhalter („(noch ohne Titel)“) selbst.
import { isOrphanedSession, sessionLabel as sharedSessionLabel, t } from "@nyxos/shared";
import type { Baustelle, Session } from "./api";
import { stateMeta, type StateMeta } from "./stateMeta";

// `tool` als einfacher Text, damit auch Zeilen aus Nutzung, Dateien, Audits usw. (dort `string`) passen.
type LabelSource = Pick<Session, "title"> & Partial<Pick<Session, "titleSource" | "cwd" | "startedAt" | "lastActivityAt">> & { tool?: string | null; baustelle?: Baustelle | null };

/** Titel → Auftrag → erste Nachricht gekürzt → Baustelle/Ordner + Startzeit. Nie leer, nie eine Kennung. */
export function sessionLabel(s: LabelSource): string {
  return sharedSessionLabel({
    title: s.title,
    titleSource: s.titleSource ?? null,
    tool: s.tool ?? null,
    cwd: s.cwd ?? null,
    baustelleLabel: s.baustelle?.label ?? null,
    startedAt: s.startedAt ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
  });
}

type OrphanSource = Pick<Session, "state" | "parsedEventCount" | "tokensTotal" | "lastActivityAt"> & Partial<Pick<Session, "startedAt" | "title">>;

/** Wartet seit > 1 Tag, aber nie eine Nachricht – zählt nicht als „wartet auf dich“ (wie auf dem Server). */
export function isOrphaned(s: OrphanSource, now: number = Date.now()): boolean {
  return isOrphanedSession(
    {
      ...s,
      parsedEventCount: s.parsedEventCount ?? 0,
      tokensTotal: s.tokensTotal ?? 0,
    },
    now,
  );
}

/** Ruhig wie „geschlossen“: kein Amber, kein Pulsieren – nur ein Wort. Text in `--a-mut` (Kontrast-Regel). */
export const ORPHANED_META: StateMeta = {
  label: t("verwaist"),
  dot: "bg-a-mut",
  text: "text-a-mut",
  bg: "bg-a-p3",
  border: "border-l-a-line",
};

/** Zustandsfarbe/-wort einer Session, mit „verwaist“ statt „wartet auf dich“ für Geister-Sessions. */
export function sessionStateMeta(s: OrphanSource, now: number = Date.now()): StateMeta {
  return isOrphaned(s, now) ? ORPHANED_META : stateMeta(s.state);
}
