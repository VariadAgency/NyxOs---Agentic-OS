// (Integration B23): EINE Regel „sichtbare Session“ für alle Listen, Zähler und Schnappschüsse.
// Archivierte Wegwerf-Sessions (`sessions.archived_at`, gesetzt vom Ticker in `temporary.ts`) verschwinden
// überall aus der Anzeige; Zeile, Ereignisse und Transkript bleiben (Archiv in den Einstellungen).
//
// Nicht filtern: Einzelabrufe per ID (Detailseite, Terminal, Transkript), Ingest/Zustandsberechnung,
// Such-Index-Aufbau – dort muss eine archivierte Session weiter auffindbar bzw. bearbeitbar sein.
import { isNull, sql, type SQL } from "drizzle-orm";
import { sessionEvents, sessions } from "./schema.js";

/** Drizzle-Bedingung: Session ist nicht archiviert. */
export const visibleSession: SQL = isNull(sessions.archivedAt);

/**
 * zählt mit (Überblick, Briefing, „Zuletzt fertig“, Zähler, Push „wartet“): sichtbar UND nicht
 * automatisch als Test erkannt. Auto-Regeln (Selbsttest, Probe-Ordner, Probe-tmux, Haiku-Lauf im
 * NyxOS-Repo) treffen nur Prüfläufe — die sollen des Nutzers Zahlen nie aufblähen, auch nicht bis zum
 * Ablauf ihrer Frist. Bewusst temporär gestartete Sessions (Grund „manual“) zählen, solange sie leben.
 * Die Session-Liste zeigt Test-Sessions weiter (Filter „Temporäre zeigen“).
 */
export const countedSession: SQL = sql`(${sessions.archivedAt} is null and (${sessions.temporaryReason} is null or ${sessions.temporaryReason} = 'manual'))`;

/**
 * mindestens eine echte Frage vom Nutzer — ein Titel (entsteht erst aus der Frage) oder ein
 * `prompt`-Ereignis. Leere/abgebrochene Starts (nur Hook-Ereignisse, kein Titel) sind kein Rückblick.
 */
const hasQuestion: SQL = sql`(${sessions.title} is not null or exists (select 1 from ${sessionEvents} where ${sessionEvents.sessionKey} = ${sessions.id} and ${sessionEvents.kind} = 'prompt'))`;

/**
 * zählt im Rückblick („Zuletzt fertig“ im Überblick, Briefing/Recap „Was lief“): wie `countedSession`,
 * aber eine temporäre Session (JEDER Grund, auch von Hand „⏳ Temporär“ gestartet) nur, solange ihr Prozess lebt
 * und sie nicht geschlossen ist. Beendet ist sie ein Test und kein Ergebnis – Der Nutzer: „Bereit“, „Bestätigung
 * bereit“ gehören nicht in „Was lief“. Behält der Nutzer sie („Behalten“), ist `temporary_reason` wieder leer.
 */
export const countedHistorySession: SQL = sql`(${countedSession} and (${sessions.temporaryReason} is null or (${sessions.status} = 'running' and ${sessions.closedAt} is null)) and ${hasQuestion})`;

/** Dasselbe für Roh-SQL mit Tabellen-Alias (z. B. `join sessions s …` → `visibleSessionSql("s")`). */
export function visibleSessionSql(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Ungültiger Alias: ${alias}`);
  return sql.raw(`${alias}.archived_at is null`);
}
