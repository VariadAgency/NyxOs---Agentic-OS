// Verbindungs-Prüfung: gemeinsame Form für `GET /api/connections` (Server), die Seite
// Einstellungen → „Verbindungen“ (Web) und `scripts/check-connections.mjs` (Mac, liest die Form
// als JSON). Eine Quelle für Zustände, Gruppen und die Form eines Prüf-Eintrags.

/**
 * ok = läuft · warn = läuft, aber etwas stimmt nicht ganz · fail = kaputt/fehlt · user = nur der Nutzer kann es lösen ·
 * idle = nichts kaputt, es kam nur noch nichts an (frische Installation: „kommt, sobald du eine Session startest“).
 */
export const CONNECTION_STATES = ["ok", "warn", "fail", "user", "idle"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Gruppen in fester Reihenfolge (von oben nach unten auf der Seite). `localLabel` = Name im lokalen Modus
 * (alles auf einem Rechner: kein Server, keine Brücke über einen Tunnel). */
export const CONNECTION_GROUPS = [
  { id: "server", label: "Server & Datenbank", localLabel: "Datenbank & Archiv" },
  { id: "bruecke", label: "Brücke", localLabel: "Brücke" },
  { id: "haiku", label: "Nyx", localLabel: "Nyx" },
  { id: "quellen", label: "Daten-Quellen", localLabel: "Daten-Quellen" },
  { id: "betrieb", label: "Server-Betrieb", localLabel: "Betrieb" },
  { id: "zugang", label: "Anmeldung & Schutz", localLabel: "Anmeldung & Schutz" },
] as const;
export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number]["id"];

export interface ConnectionCheck {
  id: string;
  group: ConnectionGroup;
  /** Was geprüft wird, in des Nutzers Worten („Kanal zur Brücke“). */
  label: string;
  /** Was der gesunde Zustand ist („verbunden“, „jünger als 2 Min“). */
  expected: string;
  /** true bei `ok`, `warn` und `idle` (nichts kaputt), false bei `fail`/`user`. */
  ok: boolean;
  state: ConnectionState;
  /** Antwortzeit dieser einen Prüfung in Millisekunden. */
  ms: number;
  /** Was tatsächlich gesehen wurde („verbunden seit 08:34“, „812 Sessions“). */
  result?: string;
  /** Bei warn/fail/user/idle: warum, als einfacher Satz. */
  cause?: string;
  /** Bei warn/fail/user: was hilft, als einfacher Satz — bei `user` mit fertigem Befehl in `command`. */
  fix?: string;
  /** Fertiger Befehl zum Kopieren (vor allem für den Nutzer-Punkte). */
  command?: string;
}

export interface ConnectionsReport {
  /** Zeitpunkt der Prüfung (ISO). */
  checkedAt: string;
  /** Gesamtdauer der (parallelen) Prüfung in Millisekunden. */
  ms: number;
  /** true = Antwort kam aus dem Zwischenspeicher (≤ 30 s alt), nicht frisch geprüft. */
  cached: boolean;
  summary: Record<ConnectionState, number>;
  checks: ConnectionCheck[];
  /** Betriebsart der geprüften Installation (fehlt bei älteren Servern = Server-Modus). */
  mode?: "local" | "server";
}

/** Was die Brücke auf den Befehl `status` meldet (nur lesen, s. `apps/bridge/src/terminal/manager.ts`). */
export interface BridgeStatusReport {
  /** Zeitpunkt, zu dem die Brücke den Stand gebildet hat (ms seit 1970). */
  at: number;
  version: string | null;
  /** Einträge im Puffer (noch nicht beim Server) und abgelehnte Einträge. */
  queued: number;
  dead: number;
  /** Letztes erfolgreiches Senden an den Server (ms) und letzter Sendefehler. */
  lastOkAt: number | null;
  lastError: string | null;
  archiveError: string | null;
  /** Vom Datei-Wächter bekannte Verlaufsdateien. */
  watchedFiles: number;
  tmux: { ok: boolean; sessions: number; error: string | null };
  /** Zeitpunkte der letzten Läufe der Scans (ms), `null` = noch nie gelaufen oder abgeschaltet. */
  scans: { usage: number | null; git: number | null; vault: number | null; catalog: number | null };
  vaultError: string | null;
}
