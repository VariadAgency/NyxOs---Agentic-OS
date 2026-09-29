// „Session zusammenfassen & prüfen“ – ein Haiku-Lauf liest den Verlauf einer Session und
// schreibt eine Prüfung: Was wurde gemacht, was ist erledigt, was ist offen, Qualität, Risiken.
// Das Ergebnis hängt an der Session (Tabelle `session_audits`) und steht im Session-Vollbild.
import { z } from "zod";
import type { HaikuEngineState } from "./haiku.js";

export const SessionAuditStatusSchema = z.enum(["running", "done", "error"]);
export type SessionAuditStatus = z.infer<typeof SessionAuditStatusSchema>;

export const AuditQualitySchema = z.enum(["gut", "mittel", "schwach"]);
export type AuditQuality = z.infer<typeof AuditQualitySchema>;

export const SessionAuditResultSchema = z.object({
  zusammenfassung: z.string(),
  gemacht: z.array(z.string()),
  erledigt: z.array(z.string()),
  offen: z.array(z.string()),
  qualitaet: z.object({ note: AuditQualitySchema, text: z.string() }),
  risiken: z.array(z.string()),
});
export type SessionAuditResult = z.infer<typeof SessionAuditResultSchema>;

export interface SessionAudit {
  id: number;
  sessionKey: string;
  status: SessionAuditStatus;
  result: SessionAuditResult | null;
  /** Bei `error`: was schiefging, in einfachen Worten. */
  error: string | null;
  /** Wie viele Verlaufs-Einträge Haiku gelesen hat (von wie vielen). */
  itemsRead: number | null;
  itemsTotal: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SessionAuditView {
  /** Kann Haiku gerade prüfen? Sonst Zustand + Grund für den gesperrten Knopf. */
  engine: { ready: boolean; state: HaikuEngineState; reason: string | null };
  audits: SessionAudit[];
}
