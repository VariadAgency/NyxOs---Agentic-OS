// Einstellungen des Gehirns (Steuerleiste oben rechts), gemerkt in localStorage.
import { GRAPH_NODE_TYPES, t, type GraphNodeType } from "@nyxos/shared";
import { NOTE_CATEGORIES, type ColorKey, type NoteCategory } from "./colors";
import { DEFAULT_FORCES, type Forces } from "./forces";

/** Dreifach-Schalter je Knotenart: zeigen · ausgrauen · ausblenden. */
export type Visibility = "show" | "dim" | "hide";
export type Period = "all" | "7d" | "30d" | "archive";

export const SESSION_STATES = ["running", "waiting", "idle", "crashed", "closed", "ended"] as const;
export type SessionStateKey = (typeof SESSION_STATES)[number];
export const SESSION_STATE_LABELS: Record<SessionStateKey, string> = {
  running: t("läuft"),
  waiting: t("wartet"),
  idle: t("ruht"),
  crashed: t("abgestürzt"),
  closed: t("geschlossen"),
  ended: t("beendet"),
};

export type { Forces } from "./forces";
export { DEFAULT_FORCES } from "./forces";

/** „Eigenes Gehirn": nur dieser Knoten + Nachbarn bis `depth` (Pro Baustelle, je Session). */
export interface Focus {
  id: string;
  depth: 1 | 2 | 3;
  /** Anzeigename für den Hinweis-Chip. */
  label?: string;
  /** true = aus einer Session heraus geöffnet → nicht dauerhaft merken. */
  transient?: boolean;
  /** Filter von vorher (Schließen des Session-Gehirns bzw. Speichern stellt sie wieder her). */
  restore?: ViewFilters & { activeView: string };
}

/** Gespeicherte eigene Ansicht: Name + Filter (keine Farben/Kräfte/Darstellung). */
export interface SavedView {
  name: string;
  filters: ViewFilters;
}

export type ViewFilters = Pick<BrainSettings, "groups" | "noteGroups" | "subGroups" | "focus" | "period" | "states" | "showOrphans" | "showUnresolved" | "search">;

export const SETTINGS_SCHEMA = 3;

export interface BrainSettings {
  /** 2 = Farbe je Art ist Standard. Ältere Stände werden beim Laden umgestellt. */
  schema: number;
  search: string;
  showOrphans: boolean;
  showUnresolved: boolean;
  period: Period;
  states: Record<SessionStateKey, boolean>;
  groups: Record<GraphNodeType, Visibility>;
  /** Obsidian-Notizen je Kategorie (Ordner/Typ) — wirkt zusätzlich zu `groups.note`. */
  noteGroups: Record<NoteCategory, Visibility>;
  /** Untergruppen (Code-Unterordner, Bibliotheks-Arten) — wirkt zusätzlich zur Familie. Fehlt = zeigen. */
  subGroups: Partial<Record<ColorKey, Visibility>>;
  colorByType: boolean;
  /** Eigene Farben je Gruppe (Farbwähler in „Gruppen"). */
  colors: Partial<Record<ColorKey, string>>;
  /** Leichtes Leuchten der Punkte. */
  glow: boolean;
  focus: Focus | null;
  /** Aktive Ansicht: Vorgabe-ID (`all`, `code` …) oder `saved:<Name>`, `custom` nach eigenen Änderungen. */
  activeView: string;
  savedViews: SavedView[];
  /** 3D-Steuerung: umkreisen oder frei fliegen. */
  control3d: "orbit" | "fly";
  arrows: boolean;
  /** Ab dieser Zoomstufe erscheinen Beschriftungen (0,3–4). */
  labelZoom: number;
  nodeSize: number;
  linkWidth: number;
  mode: "2d" | "3d";
  forces: Forces;
  panelOpen: boolean;
  openSections: Record<"filter" | "groups" | "display" | "forces", boolean>;
}


export function defaultSettings(): BrainSettings {
  const groups = Object.fromEntries(GRAPH_NODE_TYPES.map((k) => [k, k === "file" ? "hide" : "show"])) as Record<GraphNodeType, Visibility>;
  return {
    schema: SETTINGS_SCHEMA,
    search: "",
    showOrphans: true,
    showUnresolved: true,
    period: "all",
    states: Object.fromEntries(SESSION_STATES.map((s) => [s, true])) as Record<SessionStateKey, boolean>,
    groups,
    // Fremd-Code (Bibliotheken, ⅔ aller Punkte) standardmäßig ausgegraut — bleibt bunt, nur
    // blass. Seine Töne liegen zwangsläufig nah an anderen Familien; so ist jede kräftige Farbe eindeutig.
    noteGroups: Object.fromEntries(NOTE_CATEGORIES.map((c) => [c, c === "bibliothek" ? "dim" : "show"])) as Record<NoteCategory, Visibility>,
    subGroups: {},
    colorByType: true,
    colors: {},
    glow: true,
    focus: null,
    activeView: "all",
    savedViews: [],
    control3d: "orbit",
    arrows: false,
    labelZoom: 1.6,
    nodeSize: 1,
    linkWidth: 1,
    mode: "2d",
    forces: { ...DEFAULT_FORCES },
    // Leiste rechts (Filter, Gruppen, Darstellung, Kräfte) startet zugeklappt — sie verdeckte ~¼ der Fläche.
    panelOpen: false,
    openSections: { filter: true, groups: true, display: false, forces: false },
  };
}

const KEY = "nyxos.brain.settings.v1";

/** Liest die gemerkten Einstellungen; unbekannte/kaputte Werte fallen auf die Vorgabe zurück. */
export function loadSettings(storage: Pick<Storage, "getItem"> | null = safeStorage()): BrainSettings {
  const base = defaultSettings();
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<BrainSettings>;
    const merged: BrainSettings = {
      ...base,
      ...saved,
      search: "", // Suche nie merken (sonst wundert man sich beim nächsten Besuch über ausgegraute Knoten)
      states: { ...base.states, ...(saved.states ?? {}) },
      groups: { ...base.groups, ...(saved.groups ?? {}) },
      noteGroups: { ...base.noteGroups, ...(saved.noteGroups ?? {}) },
      subGroups: typeof saved.subGroups === "object" && saved.subGroups !== null ? saved.subGroups : {},
      colors: typeof saved.colors === "object" && saved.colors !== null ? saved.colors : {},
      savedViews: Array.isArray(saved.savedViews) ? saved.savedViews.filter((v) => typeof v?.name === "string" && typeof v.filters === "object") : [],
      forces: { ...base.forces, ...(saved.forces ?? {}) },
      openSections: { ...base.openSections, ...(saved.openSections ?? {}) },
      schema: SETTINGS_SCHEMA,
    };
    // In Schema 1 war „Farben je Art" aus und wurde mitgemerkt → einmalig auf den neuen Standard stellen.
    if ((saved.schema ?? 1) < 2) merged.colorByType = true;
    // Die Leiste rechts startet bei jedem Besuch zu —
    // offen gilt nur für diesen Besuch (wie die Suche). Welche Abschnitte innen offen sind, bleibt gemerkt.
    merged.panelOpen = false;
    if (merged.control3d !== "fly") merged.control3d = "orbit";
    return merged;
  } catch {
    return base;
  }
}

export function saveSettings(s: BrainSettings, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  // Ein aus einer Session geöffnetes Gehirn gilt nur für diesen Besuch.
  const persist: BrainSettings = s.focus?.transient ? { ...s, activeView: "all", ...(s.focus.restore ?? {}), focus: null } : s;
  try {
    storage?.setItem(KEY, JSON.stringify(persist));
  } catch {
    // Speicher voll oder gesperrt: dann eben nicht merken
  }
}

export function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
