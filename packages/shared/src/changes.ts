// „Seit du weg warst“: was sich seit einem Zeitpunkt getan hat (`GET /api/changes?since=`).
// Nur gelesen, aus denselben Tabellen wie Überblick und Briefing. Jede Zahl ist genau die Länge von `items`.

/** Arten in fester Reihenfolge (was dich braucht zuerst, Nutzung zuletzt). */
export const CHANGES_KINDS = ["sessions_waiting", "sessions_crashed", "decisions", "sessions_done", "commits", "tasks", "ideas", "sessions_new", "deploys", "usage"] as const;
export type ChangesKind = (typeof CHANGES_KINDS)[number];

export interface ChangesItem {
  label: string;
  /** Kurze zweite Zeile, z. B. „erledigt“, „NyxOS · 3 Dateien“, „wartet seit 2 Std“. */
  detail: string | null;
  at: string;
  /** NyxOS-Pfad, zu dem die Zeile springt. */
  path: string;
  /** Beleg-Marker für Nyx (`[[session:…]]`, `[[approval:…]]`, `[[inbox:…]]`, `[[entry:…]]`), sonst nicht gesetzt. */
  ref?: string;
}

export interface ChangesGroup {
  kind: ChangesKind;
  title: string;
  /** Immer genau `items.length` (keine erfundenen oder geschätzten Zahlen). */
  count: number;
  items: ChangesItem[];
  /** Weitere Treffer, die wegen der Obergrenze nicht in `items` stehen (0 = alles da). */
  more: number;
}

export interface ChangesResponse {
  /** Tatsächlich verwendeter Beginn (nach 7-Tage-Kappe). */
  since: string;
  until: string;
  /** true = der gewünschte Zeitpunkt lag weiter als 7 Tage zurück und wurde gekappt. */
  capped: boolean;
  /** Leere Gruppen fallen weg. */
  groups: ChangesGroup[];
}

/** Höchstens so weit zurück (Tage). */
export const CHANGES_MAX_DAYS = 7;
/** Standard ohne `since`: die letzten 24 Stunden. */
export const CHANGES_DEFAULT_HOURS = 24;
/** Obergrenze je Gruppe (Rest steht ehrlich als `more`). */
export const CHANGES_ITEM_LIMIT = 50;
