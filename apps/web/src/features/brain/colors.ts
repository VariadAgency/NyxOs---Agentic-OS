// Farben des Gehirns. Grundtöne aus den Design-Tokens, dazu eine bunte Kategorie-Palette:
// jede Knotenart eine eigene Farbe, Obsidian-Notizen nach Ordner/Typ (Code, Planung, Bugs …).
// „Farbe je Art" ist Standard. Nie grau/weiß/schwarz als Kategorie-Farbe (das sind keine Farben),
// auch nichts Blasses, das auf dunklem Grund fast weiß wirkt.
//
// Code-Notizen (¾ des Vaults) sind zwei Familien mit Untergruppen, damit das Gehirn nicht
// einfarbig wirkt: „Eigener Code" in verwandten Blautönen je Vault-Unterordner (Views, ViewModels,
// Models, Services, Backend …) und „Bibliotheken" (Fremd-Code aus Swift-Paketen, s. `GraphNode.lib`;
// in einem großen Vault die meisten Code-Notizen) mit einem klar eigenen Farbton je Paket-Art.
// Geprüft (Test `brain-code-colors-legend.test.tsx`): Buntheit ≥ 40, HSL-Helligkeit ≤ 72 %, Kontrast zum Grund
// ≥ 4,5 : 1; Gruppen verschiedener Familien ΔE2000 ≥ 9, Töne eigenen Codes ≥ 6, Bibliotheks-Arten ≥ 20.
//
// Ruhigere Palette (vorher wirkte alles sehr bunt und überladen) — gleiche Farbtöne (Gruppen bleiben
// wiedererkennbar), aber die schreienden Neons gezähmt: OKLCH-Buntheit höchstens ~0,18 (vorher bis 0,30,
// z. B. #fa30f3, #eb0aa0, #bd3afa, #25d126) und Helligkeit in einem engen Band (OKLCH L 0,66–0,86, vorher
// 0,60–0,90) — gleichmäßig hell, klar vom Schwarz getrennt. Die Abstands-Regeln oben gelten weiter.
import { t, type GraphNode, type GraphNodeType } from "@nyxos/shared";

export const TOKENS = {
  // Schwarz ohne Blaustich, kräftige Farben – gleiche Werte wie `--a-*` in app.css.
  bg: "#050505",
  ink: "#f3f3ef",
  mut: "#a1a1a1",
  dim: "#5c5c5c",
  acc: "#3cc6c0",
  ok: "#2fd27a",
  wait: "#ffb020",
  idle: "#8a8a8a",
  done: "#4da3ff",
  bad: "#ff5a4e",
  conf: "#ff6b8a",
} as const;

/** Einheitsfarbe, wenn „Farben je Art" aus ist (bewusst kein Grau). */
export const NODE_UNIFORM = "#8fb3ff";

// --- Obsidian-Notizen nach Ordner/Typ ---------------------------------------------------------

export const NOTE_CATEGORIES = ["code", "bibliothek", "planung", "entscheidung", "architektur", "bugs", "sessions", "doku", "daten", "schnittstellen", "screens", "audit", "offen"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const NOTE_CATEGORY_LABELS: Record<NoteCategory, string> = {
  code: t("Eigener Code"),
  bibliothek: t("Bibliotheken"),
  planung: t("Planung"),
  entscheidung: t("Entscheidungen"),
  architektur: t("Architektur"),
  bugs: t("Bugs & Fixes"),
  sessions: t("Session-Notizen"),
  doku: t("Dokumentation"),
  daten: t("Daten & Abläufe"),
  schnittstellen: t("Schnittstellen"),
  screens: t("Screens & Design"),
  audit: t("Audits"),
  offen: t("Nicht erstellt"),
};

/** Untergruppen „Eigener Code" = Unterordner von `02 Code` im Vault (Views, Services,
 * Models, ViewModels, Backend; Notizen direkt im Ordner bzw. neue Unterordner → „Weiterer Code"). */
export const CODE_SUBS = ["views", "viewmodels", "models", "services", "backend", "weitere"] as const;
export type CodeSub = (typeof CODE_SUBS)[number];
/** Untergruppen „Bibliotheken" nach Paket-Art (Swift-Pakete aus `.build/checkouts`). */
export const LIB_SUBS = ["server", "netz", "daten", "sicherheit", "werkzeuge"] as const;
export type LibSub = (typeof LIB_SUBS)[number];

export const SUB_LABELS: Record<`code.${CodeSub}` | `bibliothek.${LibSub}`, string> = {
  "code.views": "Views",
  "code.viewmodels": "ViewModels",
  "code.models": "Models",
  "code.services": "Services",
  "code.backend": "Backend",
  "code.weitere": t("Weiterer Code"),
  "bibliothek.server": t("Vapor & Datenbank"),
  "bibliothek.netz": t("Netzwerk (SwiftNIO)"),
  "bibliothek.daten": t("Datenstrukturen"),
  "bibliothek.sicherheit": t("Sicherheit & Krypto"),
  "bibliothek.werkzeuge": t("Weitere Bibliotheken"),
};

/** Unterordner, die überall gewinnen (z. B. `04 Planung/Entscheidungen`). */
const NOTE_SUBFOLDER_RULES: Array<[RegExp, NoteCategory]> = [[/entscheidung|decision/, "entscheidung"]];
/** Regeln für den Oberordner (Reihenfolge zählt). */
const NOTE_RULES: Array<[RegExp, NoteCategory]> = [
  [/bug|fix/, "bugs"],
  [/audit/, "audit"],
  [/(^|[\s_/])code([\s_/]|$)/, "code"],
  [/endpoint|backendconnection|schnittstelle|mcp|api/, "schnittstellen"],
  [/datapoint|userinteraction|analytics|formsubmission|notificationtrigger|dataflow|crossrole|datenbank/, "daten"],
  [/architektur|statemanagement|algorithm/, "architektur"],
  [/screen|design|asset/, "screens"],
  [/planung|roadmap|feature|plan/, "planung"],
  [/session/, "sessions"],
];

/** Unterordner eigener Code-Notizen (Reihenfolge zählt: „ViewModels" vor „Views"). */
const CODE_SUB_RULES: Array<[RegExp, CodeSub]> = [
  [/viewmodel/, "viewmodels"],
  [/view|screen|component/, "views"],
  [/model|entit/, "models"],
  [/service|manager|network|client/, "services"],
  [/backend|server|controller/, "backend"],
];

/** Paket-Art einer Bibliothek (Paketname wie im Swift-Paket, z. B. `swift-nio-ssl`). Reihenfolge zählt. */
const LIB_RULES: Array<[RegExp, LibSub]> = [
  [/crypto|certificate|asn1|jwt|ssl|tls|boring|keychain/, "sicherheit"],
  [/vapor|fluent|sql|postgres|mysql|sqlite|redis|routing-kit|console-kit|async-kit|multipart|websocket-kit|leaf|queues|mongo/, "server"],
  [/nio|http|grpc|alamofire|network|socket/, "netz"],
  [/collections|algorithms|atomics|numerics|swift-system|deque/, "daten"],
];

export function libGroup(pkg: string): LibSub {
  const p = pkg.toLowerCase();
  return LIB_RULES.find(([re]) => re.test(p))?.[1] ?? "werkzeuge";
}

type NodeLike = Pick<GraphNode, "type" | "group" | "state" | "ref"> & { lib?: string | null };

const notePath = (n: Pick<GraphNode, "ref">): string | null => (n.ref.kind === "note" ? n.ref.path : null);

function computeCategory(n: NodeLike, path: string | null): NoteCategory {
  if (n.state === "unresolved") return "offen";
  const p = path ? path.toLowerCase() : `${n.group.toLowerCase()}/x`;
  const folders = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const top = folders.split("/")[0] ?? "";
  const hit = NOTE_SUBFOLDER_RULES.find(([re]) => re.test(folders)) ?? NOTE_RULES.find(([re]) => re.test(top));
  const cat = hit ? hit[1] : "doku";
  // Code aus einer Fremd-Bibliothek ist eine eigene Familie (liegt im Vault trotzdem unter „02 Code").
  return cat === "code" && n.lib ? "bibliothek" : cat;
}

// --- Farbgruppen ---------------------------------------------------------------------------------

type NoteLeafKey = `note.${Exclude<NoteCategory, "code" | "bibliothek">}` | `note.code.${CodeSub}` | `note.bibliothek.${LibSub}`;
/** Eine Farbgruppe (Blatt): Knotenart (außer Notiz), `note.<Kategorie>`, `note.code.<Unterordner>`
 * oder `note.bibliothek.<Paket-Art>`. */
export type ColorKey = Exclude<GraphNodeType, "note"> | NoteLeafKey;
/** Familie in Legende und Filtern: Knotenart oder `note.<Kategorie>` (Code/Bibliotheken fassen ihre Töne zusammen). */
export type FamilyKey = Exclude<GraphNodeType, "note"> | `note.${NoteCategory}`;
export type SubFamily = "note.code" | "note.bibliothek";

export const FAMILY_LEAVES: Record<SubFamily, ColorKey[]> = {
  "note.code": CODE_SUBS.map((c) => `note.code.${c}` as const),
  "note.bibliothek": LIB_SUBS.map((c) => `note.bibliothek.${c}` as const),
};

export const hasSubgroups = (family: FamilyKey): family is SubFamily => family === "note.code" || family === "note.bibliothek";

/** Familie einer Farbgruppe (`note.code.views` → `note.code`). */
export function familyOf(key: ColorKey | FamilyKey): FamilyKey {
  if (key.startsWith("note.code.")) return "note.code";
  if (key.startsWith("note.bibliothek.")) return "note.bibliothek";
  return key as FamilyKey;
}

/** Blätter einer Familie (Familien ohne Untergruppen: sie selbst). */
export function leavesOf(family: FamilyKey): ColorKey[] {
  return hasSubgroups(family) ? FAMILY_LEAVES[family] : [family as ColorKey];
}

export const DEFAULT_COLORS: Record<ColorKey, string> = {
  session: "#08c3b3",
  subagent: "#937cef",
  baustelle: "#efbe73",
  art: "#e45a93",
  file: "#c2e144",
  commit: "#4de890",
  branch: "#62edc4",
  task: "#ee8317",
  idea: "#f7c939",
  bug: "#ec5c51",
  problem: "#ed857f",
  finding: "#d460ba",
  decision: "#b691da",
  question: "#05d5e8",
  "note.planung": "#dfd474",
  "note.entscheidung": "#b691da",
  "note.architektur": "#b96cdf",
  "note.bugs": "#ec5c51",
  "note.sessions": "#08c3b3",
  "note.doku": "#ff8762",
  "note.daten": "#97eb6e",
  "note.schnittstellen": "#30cbff",
  "note.screens": "#ed5b72",
  "note.audit": "#d460ba",
  "note.offen": "#ea82e6",
  // Eigener Code: verwandte Blautöne je Unterordner
  "note.code.views": "#5195fe",
  "note.code.viewmodels": "#32b0fb",
  "note.code.models": "#6caeff",
  "note.code.services": "#8797e3",
  "note.code.backend": "#6887ff",
  "note.code.weitere": "#3299e3",
  // Bibliotheken: je Paket-Art ein klar anderer Farbton (nie blau) — sie sind ⅔ aller Notizen,
  // in einer einzigen Tonfamilie wirkte das Gehirn wieder einfarbig (erst blau, dann grün).
  "note.bibliothek.server": "#5dc258",
  "note.bibliothek.netz": "#e9839b",
  "note.bibliothek.daten": "#ec6829",
  "note.bibliothek.sicherheit": "#d89f23",
  "note.bibliothek.werkzeuge": "#0cefea",
};

/** Bewusst gleiche Farbe (gleiche Bedeutung): Bug-Einträge ↔ Notizen „Bugs & Fixes" usw. */
export const SHARED_COLOR_PAIRS: Array<[ColorKey, ColorKey]> = [
  ["bug", "note.bugs"],
  ["decision", "note.entscheidung"],
  ["finding", "note.audit"],
  ["session", "note.sessions"],
];

interface KeyMemo {
  type: string;
  state: string | null | undefined;
  group: string;
  path: string | null;
  lib: string | null | undefined;
  key: ColorKey;
  cat: NoteCategory | null;
}
// Je Knoten gemerkt (wird je Bild für jeden Knoten gefragt). Deltas ändern Knoten an Ort und Stelle
// (`Object.assign`) — darum prüft der Speicher seine Eingaben mit (billige Vergleiche, keine Texte bauen).
const keyMemo = new WeakMap<object, KeyMemo>();

function memoOf(n: NodeLike): KeyMemo {
  const path = notePath(n);
  const m = keyMemo.get(n);
  if (m && m.type === n.type && m.state === n.state && m.group === n.group && m.path === path && m.lib === n.lib) return m;
  let key: ColorKey;
  let cat: NoteCategory | null = null;
  if (n.type === "note") {
    cat = computeCategory(n, path);
    if (cat === "code") {
      const sub = path ? path.split("/").slice(1, -1).join("/").toLowerCase() : "";
      key = `note.code.${CODE_SUB_RULES.find(([re]) => re.test(sub))?.[1] ?? "weitere"}`;
    } else if (cat === "bibliothek") key = `note.bibliothek.${libGroup(n.lib ?? "")}`;
    else key = `note.${cat}`;
  } else key = n.type;
  const next: KeyMemo = { type: n.type, state: n.state, group: n.group, path, lib: n.lib, key, cat };
  keyMemo.set(n, next);
  return next;
}

/** Kategorie (Familie) einer Notiz aus ihrem Pfad (bzw. Ordner). Nicht erstellte Notizen → „offen". */
export function noteCategory(n: Pick<GraphNode, "group" | "state" | "ref"> & { lib?: string | null }): NoteCategory {
  const path = notePath(n);
  return computeCategory({ ...n, type: "note" }, path);
}

export function colorKeyOf(n: NodeLike): ColorKey {
  return memoOf(n).key;
}

/** Familie eines Knotens (Legende, Filter). */
export function familyKeyOf(n: NodeLike): FamilyKey {
  return familyOf(memoOf(n).key);
}

function familyLabel(family: FamilyKey, typeLabels: Record<GraphNodeType, string>): string {
  return family.startsWith("note.") ? NOTE_CATEGORY_LABELS[family.slice(5) as NoteCategory] : t(typeLabels[family as GraphNodeType]);
}

/** Anzeigename einer Farbgruppe oder Familie (Untergruppen: nur ihr eigener Name, z. B. „Views"). */
export function colorKeyLabel(key: ColorKey | FamilyKey, typeLabels: Record<GraphNodeType, string>): string {
  const fam = familyOf(key);
  if (fam !== key) return SUB_LABELS[key.slice(5) as keyof typeof SUB_LABELS];
  return familyLabel(fam, typeLabels);
}

/** Langer Name (Info-Karte/Seitenblatt): „Eigener Code · Views", „Bibliotheken · Netzwerk (SwiftNIO)". */
export function colorKeyFullLabel(key: ColorKey, typeLabels: Record<GraphNodeType, string>): string {
  const fam = familyOf(key);
  return fam === key ? familyLabel(fam, typeLabels) : `${familyLabel(fam, typeLabels)} · ${colorKeyLabel(key, typeLabels)}`;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Farbe einer Gruppe: eigene Wahl (Farbwähler) vor Vorgabe; kaputte Werte fallen auf die Vorgabe zurück. */
export function groupColor(key: ColorKey, overrides: Partial<Record<ColorKey, string>> | undefined): string {
  const o = overrides?.[key];
  return o && HEX.test(o) ? o.toLowerCase() : DEFAULT_COLORS[key];
}

/** Farbfläche einer Familie: Familien mit Untergruppen zeigen ihre Töne als Farbkreis. */
export function familyBackground(family: FamilyKey, overrides: Partial<Record<ColorKey, string>> | undefined): string {
  if (!hasSubgroups(family)) return groupColor(family as ColorKey, overrides);
  const cs = FAMILY_LEAVES[family].map((k) => groupColor(k, overrides));
  return `conic-gradient(${[...cs, cs[0]].join(",")})`;
}

/** Farbe eines Knotens nach Einstellungen. */
export function nodeColor(n: NodeLike, colorByType: boolean, overrides?: Partial<Record<ColorKey, string>>): string {
  if (!colorByType) return NODE_UNIFORM;
  return groupColor(colorKeyOf(n), overrides);
}

/** Farbe einer Knotenart für Pillen/Streifen (Notizen: Farbe ihrer Gruppe). */
export function typeColor(n: NodeLike, overrides?: Partial<Record<ColorKey, string>>): string {
  return groupColor(colorKeyOf(n), overrides);
}

// --- Hilfen ---------------------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgbaCache = new Map<string, Array<string | undefined>>();
/** `rgba(...)`-Text mit auf 1/32 gerundetem Alpha — wenige verschiedene Farben = gebündeltes Zeichnen.
 * Je Farbe eine kleine Tabelle (33 Stufen), weil das je Bild für jeden Knoten gerufen wird. */
export function rgba(hex: string, alpha: number): string {
  const i = Math.round(Math.max(0, Math.min(1, alpha)) * 32);
  let row = rgbaCache.get(hex);
  if (!row) {
    row = new Array<string | undefined>(33);
    rgbaCache.set(hex, row);
  }
  let v = row[i];
  if (v === undefined) {
    const [r, g, b] = hexToRgb(hex);
    v = `rgba(${r},${g},${b},${i / 32})`;
    row[i] = v;
  }
  return v;
}

const mixCache = new Map<string, string>();
/** Mischt zwei Farben (auf 1/16 gerundet und zwischengespeichert — wird je Bild für viele Knoten gerufen). */
export function mix(a: string, b: string, t: number): string {
  const q = Math.round(Math.max(0, Math.min(1, t)) * 16) / 16;
  const key = `${a}|${b}|${q}`;
  const cached = mixCache.get(key);
  if (cached) return cached;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * q)
      .toString(16)
      .padStart(2, "0");
  const v = `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
  if (mixCache.size > 4000) mixCache.clear();
  mixCache.set(key, v);
  return v;
}
