// Anzeige-Wortlaut/Farben für Aufgaben/Ideen — eine Quelle der Wahrheit, wie `lib/stateMeta.ts` für
// Sessions. Farben ausschließlich aus den Tokens (app.css), nie erfunden.
import type { EntryKind, EntryPriority, EntryStage } from "@nyxos/shared";
import { t } from "@nyxos/shared";

export const KIND_LABELS: Record<EntryKind, string> = {
  bug: t("Bug"),
  aufgabe: t("Aufgabe"),
  audit: t("Audit"),
  idee: t("Idee"),
  entscheidung: t("Entscheidung"),
  frage: t("Frage"),
  problem: t("Problem"),
};

export interface StagePill {
  label: string;
  text: string;
  bg: string;
  dot: string;
}

export const STAGE_META: Record<EntryStage, StagePill> = {
  eingang: { label: t("Eingang"), text: "text-a-mut", bg: "bg-a-dim/10", dot: "bg-a-dim" },
  in_klaerung: { label: t("In Klärung"), text: "text-a-wait", bg: "bg-a-wait/10", dot: "bg-a-wait" },
  konzept_fertig: { label: t("Konzept fertig"), text: "text-a-acc", bg: "bg-a-acc/10", dot: "bg-a-acc" },
  geplant: { label: t("Geplant"), text: "text-a-mut", bg: "bg-a-dim/10", dot: "bg-a-dim" },
  startklar: { label: t("Startklar"), text: "text-a-acc", bg: "bg-a-acc/10", dot: "bg-a-acc" },
  laeuft: { label: t("Läuft"), text: "text-a-ok", bg: "bg-a-ok/10", dot: "bg-a-ok" },
  pruefen: { label: t("Prüfen"), text: "text-a-done", bg: "bg-a-done/10", dot: "bg-a-done" },
  erledigt: { label: t("Erledigt"), text: "text-a-mut", bg: "bg-a-dim/10", dot: "bg-a-dim" },
};

export const PRIORITY_LABELS: Record<EntryPriority, string> = { p0: "P0", p1: "P1", p2: "P2", p3: "P3" };

/** History events of an entry (`entry_events.kind`, written by server, bridge and import) in plain words. */
const EVENT_LABELS: Record<string, string> = {
  angelegt: t("Angelegt"),
  fortschritt: t("Fortschritt gemeldet"),
  teilaufgabe_erledigt: t("Teilaufgabe erledigt"),
  teilaufgaben_ergaenzt: t("Teilaufgaben ergänzt"),
  verknuepft: t("Verknüpft"),
  startklar: t("Startklar"),
  reife_verloren: t("Nicht mehr startklar"),
  erledigt_durch_bericht: t("Erledigt laut Bericht"),
  haiku_start: t("Von Nyx gestartet"),
  haiku_start_verweigert: t("Start von Nyx abgelehnt"),
};

/** Label of a history event; unknown kinds fall back to their name without underscores. */
export const eventLabel = (kind: string): string => EVENT_LABELS[kind] ?? kind.replace(/_/g, " ");

export const TASK_SECTIONS: { stage: EntryStage; title: string; hint: string }[] = [
  { stage: "startklar", title: t("Startklar"), hint: t("Reife-Check bestanden, ein Klick startet") },
  { stage: "laeuft", title: t("Läuft"), hint: t("Balken bewegt sich live") },
  { stage: "pruefen", title: t("Prüfen"), hint: t("fertig, wartet auf deine Abnahme") },
  { stage: "geplant", title: t("Geplant"), hint: t("Konzept da, aber noch nicht startklar") },
  { stage: "erledigt", title: t("Erledigt"), hint: t("nur du setzt „erledigt“") },
];

export const IDEA_SECTIONS: { stage: EntryStage; title: string; hint: string }[] = [
  { stage: "konzept_fertig", title: t("Konzept fertig"), hint: t("Spec vollständig, keine Rückfragen offen") },
  { stage: "in_klaerung", title: t("In Klärung"), hint: t("Rückfragen offen") },
  { stage: "eingang", title: t("Eingang"), hint: t("roh, noch nicht angeschaut") },
];
