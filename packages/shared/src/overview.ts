// Überblick-Dashboard. Jede Kachel trägt ihren Trend als Rohwerte (aktuell/vorher +
// Zeitraum) statt eines fertigen Prozentwerts — die Anzeige entscheidet, ob „+62" oder „▲ 12 %"
// ehrlicher ist (ein Prozentwert gegen eine Null-Woche ist Rauschen). Keine erfundenen Zahlen: was
// es (noch) nicht gibt, bleibt `placeholder: true`.
//
// Kopfzeile, Kacheln, „Kritische Sessions“, Briefing und „Braucht dich“ kommen aus EINEM
// Schnappschuss (Server `overview/snapshot.ts`) — der Lage-Satz wird hier einmal gebaut und von
// Server (Überblick + Briefing) und Web gleich benutzt. Der Fingerabdruck erkennt, ob ein Briefing
// noch zum jetzigen Stand passt.
import { z } from "zod";
import { t } from "./i18n/index.js";

export interface MetricTrend {
  current: number;
  previous: number;
  /** Vergleichszeitraum für die Anzeige, z. B. „Vorwoche", „Vortag". */
  period: string;
  /** true = mehr ist gut (grün), false = mehr ist schlecht (rot), null = neutral. */
  upIsGood: boolean | null;
}

export interface MetricTile {
  key: string;
  label: string;
  value: number | null;
  /** Anzeigeformat der großen Zahl. */
  format: "count" | "tokens";
  trend: MetricTrend | null;
  /** Tageswerte (älteste zuerst) — leer = keine Verlaufsdaten für diese Kennzahl. */
  sparkline: number[];
  /** Was die Sparkline zeigt, z. B. „Starts je Tag · 14 T". */
  sparklineLabel: string | null;
  /** Eine kurze Zeile unter der Zahl (Kontext aus echten Daten), null = keine. */
  caption: string | null;
  captionTone: "wait" | "bad" | null;
  placeholder: boolean;
  placeholderReason: string | null;
  /** Route, zu der die Kachel per Klick springt (GOAL: "Jede Zahl öffnet ihre Quelle"). */
  href: string;
}

export interface CommitDay {
  date: string; // YYYY-MM-DD
  claude: number;
  codex: number;
  human: number;
}

export interface CriticalSession {
  sessionKey: string;
  sessionId: string;
  title: string | null;
  /** fertiger Name nach `sessionLabel` (Titel → Auftrag → erste Nachricht → Ort + Zeit), nie leer. */
  label: string;
  tool: string;
  state: string | null;
  reason: string;
  href: string;
}

export interface BaustelleProgress {
  slug: string;
  label: string;
  /** null = kein Fortschritt messbar (noch keine Aufgaben aus P4). */
  progressPct: number | null;
  openSessions: number;
}

/**
 * „Offene Frage“ = etwas, das nur der Nutzer entscheiden kann. EINE Zahl für Überblick-Kachel,
 * Entscheidungen-Tab und Konflikte-Kopf (Server: Schnappschuss `overview/snapshot.ts`, `GET /api/open-questions`):
 * - `approvals`: offene Freigabe-Anfragen (Push, Deploy, …)
 * - `inbox`: offene Karten der Entscheidungen (Fragen aus Sessions/Haiku, Pläne, Eskalationen)
 * - `conflicts`: offene Konflikt-Fragen — nur zwischen Sessions, die gerade leben
 */
export interface OpenQuestionCounts {
  approvals: number;
  /** Offene Entscheidungs-Karten OHNE Sortier-Vorschläge (die zählen in `sorting`). */
  inbox: number;
  conflicts: number;
  /** gebündelte Sortier-Vorschläge von Nyx – Kleinkram, zählt NICHT in `total` (kein roter Zähler). */
  sorting?: number;
  total: number;
}

/** „2 Freigaben · 1 Frage · 1 Konflikt“ — Aufschlüsselung unter der Zahl; leer = nichts offen. */
export function openQuestionsCaption(q: OpenQuestionCounts): string {
  // Sortier-Vorschläge zählen nicht in `total`, werden aber genannt – sonst stünde
  // „Nichts zu entscheiden“ über einer Seite, auf der noch ein Vorschlag wartet.
  const sorting = q.sorting ?? 0;
  const sortPart = sorting > 0 ? plural(sorting, "1 Sortier-Vorschlag", "{n} Sortier-Vorschläge") : null;
  if (q.total === 0) return sortPart ?? t("Nichts zu entscheiden");
  const parts: string[] = [];
  if (q.approvals > 0) parts.push(plural(q.approvals, "1 Freigabe", "{n} Freigaben"));
  if (q.inbox > 0) parts.push(plural(q.inbox, "1 Frage", "{n} Fragen"));
  if (q.conflicts > 0) parts.push(plural(q.conflicts, "1 Konflikt", "{n} Konflikte"));
  if (sortPart) parts.push(sortPart);
  return parts.join(" · ");
}

/** Zählwerte für den Lage-Satz im Kopf („3 Sessions laufen, 1 wartet auf dich, 2 Aufgaben startklar"). */
export interface OverviewCounts {
  running: number;
  waiting: number;
  idle: number;
  crashed: number;
  startklar: number;
}

/** Count with the right word: two whole German source texts (`"1 Frage"`, `"{n} Fragen"`), translated. */
const plural = (n: number, one: string, many: string) => (n === 1 ? t(one) : t(many, { n }));

/** Ein Satz Lage aus echten Zahlen (UI-Kritik b: Mehrzahl + Verb stimmen). dieselbe Funktion
 * für Überblick-Kopf und Briefing, damit beide wörtlich dasselbe sagen. */
export function situationSentence(c: OverviewCounts): string {
  const parts: string[] = [];
  if (c.running > 0) parts.push(plural(c.running, "1 Session läuft", "{n} Sessions laufen"));
  if (c.waiting > 0) parts.push(plural(c.waiting, "1 wartet auf dich", "{n} warten auf dich"));
  if (c.crashed > 0) parts.push(plural(c.crashed, "1 ist abgestürzt", "{n} sind abgestürzt"));
  if (c.startklar > 0) parts.push(plural(c.startklar, "1 Aufgabe startklar", "{n} Aufgaben startklar"));
  if (parts.length === 0) return c.idle > 0 ? plural(c.idle, "Alles ruhig, 1 Session ruht.", "Alles ruhig, {n} Sessions ruhen.") : t("Alles ruhig, gerade läuft nichts.");
  if (c.running === 0 && (c.waiting > 0 || c.crashed > 0)) parts.unshift(t("Keine Session läuft"));
  return `${parts.join(", ")}.`;
}

/** zuletzt fertig geworden — sauber beendete Sessions und erledigte Aufträge, jüngste zuerst. */
export interface RecentDoneItem {
  kind: "session" | "entry";
  id: string;
  title: string;
  /** z. B. „Session beendet“, „Bug erledigt“. */
  label: string;
  at: string;
  href: string;
}

/** Zustell-Warteschlange – Nachrichten, die noch auf den Rechner warten, nicht abgelaufen. */
export interface PendingDeliveries {
  count: number;
  /** In wie vielen Sessions etwas wartet. */
  sessions: number;
  /** Link zur Session mit der ältesten wartenden Nachricht (null, wenn nichts wartet). */
  href: string | null;
  title: string | null;
}

export interface OverviewSnapshot {
  /** Nur der Vorname („Der Nutzer") — der Gruß kommt aus der Tageszeit des Geräts. */
  greetingName: string;
  /** Zeitpunkt des Schnappschusses — für „Stand HH:MM“. */
  generatedAt: string;
  counts: OverviewCounts;
  /** Lage-Satz aus `counts` (identisch mit dem Satz im Briefing desselben Stands). */
  lage: string;
  /** offene Fragen desselben Schnappschusses (Kachel „Offene Fragen“). */
  openQuestions: OpenQuestionCounts;
  /** Anzahl „Braucht dich“ im selben Schnappschuss. */
  needsYouCount: number;
  /** Fingerabdruck des Schnappschusses (gleich = Briefing passt zum Überblick). */
  fingerprint: string;
  metrics: MetricTile[];
  /** 14 lückenlose Kalendertage (UTC), älteste zuerst. */
  commits: CommitDay[];
  criticalSessions: CriticalSession[];
  /** verwaiste Geister-Sessions desselben Schnappschusses (warten > 1 Tag, nie eine Nachricht) –
   * Aufräum-Kandidaten, nie automatisch geschlossen. */
  orphanedSessions: CriticalSession[];
  /** alle verwaisten Sessions (die Liste oben ist auf die jüngsten begrenzt). */
  orphanedTotal: number;
  baustellen: BaustelleProgress[];
  /** zuletzt fertig geworden (höchstens 8). */
  recentDone: RecentDoneItem[];
  /** Warteschlange aus demselben Schnappschuss. */
  pendingDeliveries: PendingDeliveries;
  serverOk: boolean | null;
}

// ───────────────────────────── Altersgrenze für „abgestürzt“ ─────────────────────────────

/** Standard: nach 12 Stunden ohne Prozess gilt eine Session nicht mehr als „abgestürzt“, sondern als
 * beendet. 12 h decken einen Arbeitstag plus Abend ab: Ein Absturz vom Nachmittag steht abends noch im
 * Recap, einer vom späten Abend morgens im Briefing — ältere sind Rauschen („vor 33 T“). */
export const DEFAULT_CRASHED_MAX_HOURS = 12;

export const SessionStateSettingsSchema = z.object({
  /** Nach so vielen Stunden ohne Prozess zählt eine Session nicht mehr als „abgestürzt“. */
  crashedMaxHours: z.number().int().min(1).max(24 * 90),
});
export type SessionStateSettings = z.infer<typeof SessionStateSettingsSchema>;
