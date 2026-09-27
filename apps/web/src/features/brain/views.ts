// Mehrere Gehirne: vorgefertigte Ansichten, „Pro Baustelle", eigenes Gehirn je Session und
// gespeicherte eigene Ansichten. Eine Ansicht setzt nur Filter (Sichtbarkeit) — Farben, Kräfte und
// Darstellung bleiben, wie du sie eingestellt hast.
import { GRAPH_NODE_TYPES, t, type GraphNodeType } from "@nyxos/shared";
import { NOTE_CATEGORIES, type NoteCategory } from "./colors";
import { defaultSettings, type BrainSettings, type SavedView, type ViewFilters, type Visibility } from "./settings";

export type PresetId = "all" | "code" | "planung" | "sessions" | "baustelle";

export const PRESETS: Array<{ id: PresetId; label: string; hint: string }> = [
  { id: "all", label: t("Alles"), hint: t("Alles, was NyxOS weiß") },
  { id: "code", label: t("Nur Code"), hint: t("Code-Notizen, Commits und Zweige (Dateien per Schalter)") },
  { id: "planung", label: t("Planung/Obsidian"), hint: t("Obsidian-Notizen ohne Code, dazu Aufgaben, Ideen, Entscheidungen und Befunde") },
  { id: "sessions", label: t("Sessions & Agenten"), hint: t("Sessions, Sub-Agenten, Baustellen und Arten") },
  { id: "baustelle", label: t("Pro Baustelle"), hint: t("Eine Baustelle mit allem, was bis zwei Schritte daran hängt") },
];

const only = (types: GraphNodeType[]): Record<GraphNodeType, Visibility> =>
  Object.fromEntries(GRAPH_NODE_TYPES.map((k) => [k, types.includes(k) ? "show" : "hide"])) as Record<GraphNodeType, Visibility>;
const notes = (cats: NoteCategory[] | "all"): Record<NoteCategory, Visibility> =>
  Object.fromEntries(NOTE_CATEGORIES.map((c) => [c, cats === "all" || cats.includes(c) ? "show" : "hide"])) as Record<NoteCategory, Visibility>;

/** Filter-Grundstand jeder Ansicht (Zeitraum, Zustände, Suche zurück auf „alles"). */
function baseFilters(): ViewFilters {
  const d = defaultSettings();
  return { groups: d.groups, noteGroups: d.noteGroups, subGroups: {}, focus: null, period: "all", states: d.states, showOrphans: true, showUnresolved: true, search: "" };
}

export function applyPreset(s: BrainSettings, id: PresetId, opts: { focusId?: string; focusLabel?: string } = {}): BrainSettings {
  const f = baseFilters();
  switch (id) {
    case "code":
      f.groups = only(["note", "commit", "branch"]);
      f.noteGroups = notes(["code", "bibliothek", "schnittstellen"]);
      f.showUnresolved = false;
      break;
    case "planung":
      f.groups = only(["note", "task", "idea", "decision", "question", "problem", "bug", "finding"]);
      f.noteGroups = { ...notes("all"), code: "hide", bibliothek: "hide" };
      break;
    case "sessions":
      f.groups = only(["session", "subagent", "baustelle", "art"]);
      break;
    case "baustelle":
      f.focus = opts.focusId ? { id: opts.focusId, depth: 2, label: opts.focusLabel } : null;
      break;
    case "all":
      // „Nur Code“ hatte früher mehr Punkte als „Alles“, weil nur dort Dateien an waren.
      // Dateien in „Alles“ kosteten aber rund ein Drittel mehr Punkte, Speicher und Ladezeit — das
      // Gehirn darf nicht langsamer werden. Darum lädt KEINE Vorgabe Dateien (Schalter im Bedienfeld),
      // und „Alles“ bleibt trotzdem die Obermenge.
      break;
  }
  return { ...s, ...f, activeView: id };
}

/** Eigenes Gehirn je Session: Session + Nachbarn bis Tiefe 2 (Dateien bleiben, wie sie eingestellt sind —
 * eine große Session hat über tausend, die würden alles andere überdecken). Gilt nur für diesen Besuch. */
export function sessionBrain(s: BrainSettings, nodeId: string, label?: string, depth: 1 | 2 | 3 = 2): BrainSettings {
  const restore = s.focus?.transient && s.focus.restore ? s.focus.restore : { ...snapshotView(s, "").filters, activeView: s.activeView };
  const f = baseFilters();
  return { ...s, ...f, groups: { ...f.groups, file: s.groups.file }, focus: { id: nodeId, depth, label, transient: true, restore }, activeView: "session" };
}

/** Session-Gehirn bzw. Fokus schließen: vorige Filter zurück. */
export function clearFocus(s: BrainSettings): BrainSettings {
  if (s.focus?.transient && s.focus.restore) {
    const { activeView, ...filters } = s.focus.restore;
    return { ...s, ...filters, focus: null, activeView };
  }
  return { ...s, focus: null, activeView: s.activeView === "baustelle" ? "all" : s.activeView };
}

export function snapshotView(s: BrainSettings, name: string): SavedView {
  const { groups, noteGroups, subGroups, period, states, showOrphans, showUnresolved, search } = s;
  const focus = s.focus ? { id: s.focus.id, depth: s.focus.depth, label: s.focus.label } : null;
  return { name, filters: structuredClone({ groups, noteGroups, subGroups, focus, period, states, showOrphans, showUnresolved, search }) };
}

export function applySavedView(s: BrainSettings, v: SavedView): BrainSettings {
  const f = baseFilters();
  const saved = v.filters;
  return {
    ...s,
    ...f,
    ...saved,
    groups: { ...f.groups, ...saved.groups },
    noteGroups: { ...f.noteGroups, ...saved.noteGroups },
    subGroups: { ...(saved.subGroups ?? {}) },
    states: { ...f.states, ...saved.states },
    activeView: `saved:${v.name}`,
  };
}

/** Speichert (oder ersetzt gleichnamig) die aktuelle Ansicht. */
export function saveView(s: BrainSettings, name: string): BrainSettings {
  const clean = name.trim().slice(0, 40);
  if (!clean) return s;
  const views = s.savedViews.filter((v) => v.name !== clean);
  return { ...s, savedViews: [...views, snapshotView(s, clean)], activeView: `saved:${clean}` };
}

export function deleteView(s: BrainSettings, name: string): BrainSettings {
  return { ...s, savedViews: s.savedViews.filter((v) => v.name !== name), activeView: s.activeView === `saved:${name}` ? "custom" : s.activeView };
}
