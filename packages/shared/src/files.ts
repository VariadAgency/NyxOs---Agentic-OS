// Reiter „Dateien“ — alle Dateien, die Sessions gelesen oder geändert haben (Quelle:
// `session_files`), nach Bereich und Ordner gruppiert, mit den beteiligten Sessions.
import { lazyFields, tr } from "./lazy-text.js";

const FILE_AREAS_DE = [
  { id: "projekte", label: "Projekte" },
  { id: "worktrees", label: "Worktrees" },
  { id: "sonstiges", label: "Außerhalb der Projekte" },
] as const;

/** Labels are German source texts, translated on every read. */
export const FILE_AREAS = FILE_AREAS_DE.map((a) => lazyFields(a, { label: tr }));

export type FileAreaId = (typeof FILE_AREAS)[number]["id"];

export const FILE_MODES = ["alle", "geaendert", "gelesen"] as const;
export type FileModeFilter = (typeof FILE_MODES)[number];

export interface FileAreaSummary {
  id: FileAreaId;
  label: string;
  files: number;
  changed: number;
  lastAt: string | null;
}

export interface TouchedFile {
  /** Absoluter Pfad wie in `session_files` (Schlüssel für die Sessions-Abfrage). */
  path: string;
  area: FileAreaId;
  /** Pfad innerhalb des Bereichs, z. B. `apps/web/src/App.tsx` bzw. `<worktree>/…`. */
  rel: string;
  /** Ordner (bis 3 Ebenen) innerhalb des Bereichs, Gruppierungs-Schlüssel; `""` = Wurzel. */
  folder: string;
  name: string;
  changed: boolean;
  read: boolean;
  sessions: number;
  /** Wann zuletzt eine Session angefangen hat, die Datei zu lesen/ändern. */
  lastAt: string | null;
}

export interface FilesOverview {
  /** Dateien, die zu Suche + Art passen (alle Bereiche). */
  total: number;
  /** Sessions, die irgendeine dieser Dateien angefasst haben. */
  sessions: number;
  areas: FileAreaSummary[];
  files: TouchedFile[];
  /** `true`, wenn mehr Dateien passen, als geschickt wurden (die zuletzt berührten zuerst). */
  truncated: boolean;
}

export interface FileSession {
  key: string;
  title: string | null;
  tool: string;
  modes: ("read" | "write")[];
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  state: string | null;
  closed: boolean;
  href: string;
}

export interface FileSessions {
  path: string;
  sessions: FileSession[];
}
