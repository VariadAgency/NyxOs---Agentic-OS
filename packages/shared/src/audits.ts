// Audit-Detail: `GET /api/audits/:entryId` (apps/server/src/audits/detail.ts). Ein Audit-Eintrag
// ist EIN Befund aus der Tabelle „Gesamtreihenfolge sämtlicher Befunde“ eines MASSNAHMENPLAN.md. Die Zeile
// verlinkt die Originalstelle (Audit-Datei mit Beleg, Begründung, Lösungsweg) — genau die zeigt das Detail.
import type { EntryStage } from "./entries.js";
import type { FileSession } from "./files.js";

/** Werte aus der Plan-Zeile (Rang | Stufe | Befund | Schwere | R | Aufwand | Paket | Vorher abschließen). */
export interface AuditFindingMeta {
  id: string;
  title: string;
  rang: number | null;
  stufe: number | null;
  schwere: string | null;
  risiko: number | null;
  aufwand: string | null;
  paket: string | null;
  /** IDs, die vorher abgeschlossen sein müssen (leer = keine). */
  vorher: string[];
  /** Was das Paket gemeinsam erledigt (Spalte „Gemeinsame Arbeit“ der Paket-Tabelle). */
  paketArbeit: string | null;
}

export interface AuditRelated {
  findingId: string;
  title: string;
  /** Eintrag in der NyxOS (zum Öffnen), `null` = (noch) nicht importiert. */
  entryId: number | null;
  stage: EntryStage | null;
  schwere: string | null;
  /** Warum verwandt: gleiches Paket, gleiche Audit-Datei, oder muss vorher erledigt werden. */
  reason: "paket" | "datei" | "vorher";
}

export interface AuditTaskRef {
  entryId: number;
  title: string;
  stage: EntryStage;
  /** GOAL.md, repo-relativ. */
  path: string;
}

export interface AuditSource {
  /** Audit-Datei relativ zum Projektordner, z. B. `docs/audit-2026-09/02-security/X.md`. */
  path: string;
  name: string;
  /** Der Abschnitt dieses Befunds (Markdown ab `### [ID]` bis zum nächsten gleichrangigen Titel). */
  section: string | null;
  /** Die ganze Audit-Datei (Markdown). `null` = gerade nicht lesbar (Mac zu und noch kein Spiegel). */
  content: string | null;
  /** „mac“ = eben frisch vom Mac gelesen, „spiegel“ = letzter gespeicherter Stand auf dem Server. */
  origin: "mac" | "spiegel" | null;
  /** Stand der Datei (Mac: Änderungszeit, Spiegel: wann zuletzt gespiegelt). */
  updatedAt: string | null;
  /** Zum Öffnen im Reiter „Dateien“ (Wurzel „project“). */
  finderRel: string;
}

export interface AuditDetail {
  entryId: number;
  finding: AuditFindingMeta | null;
  /** Maßnahmenplan, aus dem der Befund stammt (repo-relativ). */
  planPath: string | null;
  source: AuditSource | null;
  related: AuditRelated[];
  /** Aufträge (GOAL.md), die diesen Befund nennen. */
  tasks: AuditTaskRef[];
  /** Sessions, die die Audit-Datei gelesen oder geändert haben. */
  sessions: FileSession[];
}
