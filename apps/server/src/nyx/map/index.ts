// Nyx kennt NyxOS komplett. Die Karte selbst entsteht automatisch aus dem Code (scripts/nyxos-map.mjs →
// nyxosMap.generated.ts); hier nur: Suche (Werkzeug `nyxos_karte`), knappe Übersicht für den System-Prompt und der
// Klickpfad je Route (ui_navigate schickt ihn mit, damit der Cursor Schritt für Schritt hinklickt statt zu springen).
import { z } from "zod";
import type { ToolRegistry } from "../../haiku/tools.js";
import { NYXOS_MAP } from "./nyxosMap.generated.js";
import type { NyxosMapData, NyxosMapPage, NyxosMapTable } from "./types.js";

export type { NyxosMapData, NyxosMapPage } from "./types.js";

const STOP = new Set(
  "wo wie was wer welche welcher welches welchen ist sind gibt es ich du mir mich man kann stelle stellt ein aus an auf in im ins der die das den dem des ein eine einen einem und oder zu zum zur mit von vom für bei bitte mal nyxos tab seite finde find where how what which is the a an to of in on for do i can my me set up open".split(" "),
);

/** Englische und umgangssprachliche Wörter → Begriffe, wie sie in der (deutschen) Karte stehen. */
const SYNONYMS: Record<string, string[]> = {
  settings: ["einstellungen"],
  notifications: ["mitteilungen"],
  notification: ["mitteilungen"],
  benachrichtigung: ["mitteilungen"],
  benachrichtigungen: ["mitteilungen"],
  push: ["mitteilungen", "push"],
  quiet: ["ruhezeit"],
  nachtruhe: ["ruhezeit"],
  tasks: ["aufgaben"],
  task: ["aufgaben"],
  todo: ["aufgaben"],
  ideas: ["ideen"],
  decisions: ["entscheidungen"],
  inbox: ["entscheidungen"],
  approvals: ["freigaben"],
  files: ["dateien"],
  usage: ["nutzung"],
  costs: ["nutzung", "kosten"],
  brain: ["gehirn"],
  graph: ["gehirn"],
  voice: ["stimme"],
  personality: ["persönlichkeit"],
  models: ["modelle"],
  model: ["modelle"],
  account: ["konto"],
  login: ["anmeldung"],
  conflicts: ["konflikte"],
  agents: ["agenten"],
  table: ["tabelle"],
  database: ["tabelle"],
  datenbank: ["tabelle"],
  overview: ["überblick"],
  home: ["überblick"],
};

const norm = (s: string) => s.toLowerCase().normalize("NFC");
/** Grober Wortstamm: „Mitteilungen“ = „Mitteilung“, „Skills“ = „Skill“. */
const stem = (w: string) => (w.length > 5 ? w.replace(/(en|er|e|n|s)$/u, "") : w.length > 3 ? w.replace(/s$/u, "") : w);

export function queryTerms(q: string): string[] {
  const words = norm(q)
    .split(/[^\p{L}\p{N}_-]+/u)
    // Kurze Wörter („am“, „im“) träfen als Teilwort fast alles („Telegram“) – erst ab drei Zeichen.
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(stem(w));
    for (const s of SYNONYMS[w] ?? []) out.add(stem(s));
  }
  return [...out];
}

const hits = (text: string, terms: string[]) => {
  const t = norm(text);
  return terms.filter((w) => t.includes(w)).length;
};

interface PageHit {
  page: NyxosMapPage;
  score: number;
  anchor: string | null;
}

function scorePage(p: NyxosMapPage, terms: string[]): PageHit {
  let score = hits(p.title, terms) * 6 + hits(p.path, terms) * 4 + hits(p.keywords.join(" "), terms) * 4 + hits(p.purpose, terms) * 2 + hits(p.en ?? "", terms) * 3 + hits(p.ids.join(" "), terms);
  let anchor: string | null = null;
  let best = 0;
  // Stichwort einer Stelle (z. B. „Ruhezeit“) → genau dorthin (Anker).
  for (const s of p.spots ?? []) {
    const h = hits(s.keywords.join(" ") + " " + s.anchor, terms);
    if (h > best) {
      best = h;
      anchor = s.anchor;
    }
  }
  for (const t of p.tabs ?? []) {
    const h = hits(`${t.title} ${t.keywords.join(" ")}`, terms);
    if (h > best) {
      best = h;
      anchor = t.anchor;
    }
  }
  score += best * 5;
  // Leisten-Seiten vor tiefen Unterseiten, wenn beides gleich gut passt.
  if (score > 0 && p.clickPath.length === 1) score += 1;
  return { page: p, score, anchor };
}

function scoreTable(t: NyxosMapTable, terms: string[]): number {
  return hits(t.name.replace(/_/g, " "), terms) * 5 + hits(t.description, terms) * 2 + hits(t.columns.map((c) => `${c.name} ${c.note ?? ""}`).join(" "), terms);
}

/** Was Nyx zu einer Seite bekommt – knapp genug für einen Werkzeug-Rückgabewert. */
function describePage(h: PageHit, map: NyxosMapData) {
  const p = h.page;
  const route = h.anchor ? `${p.path}#${h.anchor}` : p.path;
  const apiInfo = p.api.slice(0, 8).map((path) => {
    const known = map.api.find((a) => a.path === path || a.path.replace(/\/:[^/]+/g, "") === path);
    return known ? `${known.method} ${known.path} – ${known.purpose}` : path;
  });
  return {
    titel: p.title,
    ...(p.en ? { englisch: p.en } : {}),
    route,
    zweck: p.purpose,
    klickpfad: [...p.clickPath, ...(h.anchor ? [`#${h.anchor}`] : [])],
    ...(p.tabs?.length ? { abschnitte: p.tabs.map((t) => `${t.title} (#${t.anchor}${t.advanced ? ", unter „Erweitert“" : ""})`) } : {}),
    kennungen: p.ids.slice(0, 30),
    ...(apiInfo.length ? { api: apiInfo } : {}),
  };
}

/** Antwort des Werkzeugs `nyxos_karte`. */
export interface NyxosMapAnswer {
  gefunden?: boolean;
  hinweis: string;
  leiste?: string[];
  seiten?: ReturnType<typeof describePage>[];
  tabellen?: { name: string; zweck: string | null; spalten: string[] }[];
  api?: string[];
}

/** Suche in der Karte: Seiten (mit Klickpfad, Kennungen, API), Tabellen (mit Spalten) und API-Wege. */
export function searchNyxosMap(query: string, map: NyxosMapData = NYXOS_MAP): NyxosMapAnswer {
  const terms = queryTerms(query);
  if (terms.length === 0) return { hinweis: "Frag nach einem Bereich, einer Einstellung, einem Knopf oder einer Tabelle.", leiste: map.nav.map((n) => `${n.label} (${n.path})`) };
  const wantsTables = terms.some((t) => t.startsWith("tabell") || t.startsWith("spalt"));
  const pages = map.pages
    .map((p) => scorePage(p, terms))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.length - b.page.path.length)
    .slice(0, wantsTables ? 2 : 4);
  const tables = map.tables
    .map((t) => ({ t, score: scoreTable(t, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, wantsTables ? 4 : 2);
  const api = map.api
    .map((a) => ({ a, score: hits(`${a.path} ${a.purpose}`, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (pages.length === 0 && tables.length === 0 && api.length === 0) {
    return { gefunden: false, hinweis: "Nichts dazu in der Karte. Frag anders (anderes Wort) oder schau mit ui_read_screen nach.", leiste: map.nav.map((n) => `${n.label} (${n.path})`) };
  }
  return {
    gefunden: true,
    seiten: pages.map((h) => describePage(h, map)),
    ...(tables.length ? { tabellen: tables.map(({ t }) => ({ name: t.name, zweck: t.description || null, spalten: t.columns.map((c) => (c.note ? `${c.name} (${c.note.slice(0, 80)})` : c.name)) })) } : {}),
    ...(api.length ? { api: api.map(({ a }) => `${a.method} ${a.path} – ${a.purpose}`) } : {}),
    hinweis: "Hinkommen: ui_navigate mit der route (der Cursor klickt den Klickpfad sichtbar ab). Daten lesen: app_api mit dem API-Weg.",
  };
}

/** Knappe Übersicht aller Tabs für den System-Prompt (Token sparen: nur Namen, Pfade, Einstellungs-Bereiche). */
export function nyxosMapOverview(map: NyxosMapData = NYXOS_MAP): string {
  const tabs = map.nav.map((n) => `${n.label}${n.en && n.en !== n.label ? ` (${n.en})` : ""} ${n.path}`).join(" · ");
  const settings = map.pages
    .filter((p) => p.clickPath[0] === "nav:settings" && p.path !== "/settings")
    .map((p) => p.title.replace(/^Einstellungen › /, ""))
    .join(", ");
  return `Leiste: ${tabs}.\nEinstellungen: ${settings}.`;
}

/** Route-Muster (`/skills/:key`) gegen eine echte Route prüfen → Werte der Platzhalter. */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const pa = a[i] ?? "";
    const pb = b[i] ?? "";
    if (pa.startsWith(":")) {
      try {
        params[pa.slice(1)] = decodeURIComponent(pb);
      } catch {
        params[pa.slice(1)] = pb;
      }
    } else if (pa !== pb) return null;
  }
  return params;
}

/** Klickpfad (data-nyx-Kennungen ab der Leiste) für eine Route, Platzhalter ersetzt; `[]` = unbekannt. */
export function clickPathFor(route: string, map: NyxosMapData = NYXOS_MAP): string[] {
  const path = (route.split(/[?#]/)[0] ?? route).replace(/\/+$/, "") || "/";
  for (const p of map.pages) {
    const params = matchPattern(p.path, path);
    if (!params) continue;
    return p.clickPath.map((step) => step.replace(/<([A-Za-z]+)>/g, (_m, k: string) => params[k] ?? `<${k}>`)).filter((s) => !/<[A-Za-z]+>/.test(s));
  }
  return [];
}

export const NYXOS_MAP_PROMPT = `NyxOS-Karte (Werkzeug nyxos_karte):
- Du kennst NyxOS komplett: jede Seite, jeden Unterreiter, jeden Knopf (data-nyx-Kennung), jeden API-Weg und jede Tabelle. Die Karte entsteht automatisch aus dem Code.
- Behaupte NIE, etwas gebe es in NyxOS nicht (Tab, Knopf, Einstellung, Daten), ohne vorher nyxos_karte gefragt zu haben. „Wo stelle ich … ein?“, „Welche Tabelle speichert …?“, „Wie komme ich zu …?“ → nyxos_karte.
- Hinkommen immer mit ui_navigate (route aus der Karte): dein Cursor klickt den Klickpfad sichtbar ab – Leiste, Zeile, Kachel. Nie springen. Daten dazu (z. B. welcher Skill am meisten genutzt wird: GET /api/skills, Feld uses) liest du mit app_api.`;

/** Werkzeug `nyxos_karte` (Umfang „full“). */
export function registerNyxosMapTool(reg: ToolRegistry, map: NyxosMapData = NYXOS_MAP): void {
  reg.register({
    name: "nyxos_karte",
    description:
      "Die Karte von NyxOS (automatisch aus dem Code): findet zu einer Frage die passende Seite mit Zweck, route, Klickpfad (data-nyx-Kennungen ab der Leiste), Abschnitten, Knöpfen, API-Wegen – und DB-Tabellen mit Spalten. Beispiele: „skills“, „wo stelle ich Ruhezeit ein“, „welche Tabelle speichert Mitteilungen“, „Telegram koppeln“. Vor jeder Aussage „gibt es nicht“ fragen.",
    scopes: ["full"],
    input: z.object({ frage: z.string().trim().min(1).max(300) }),
    handler: async (a) => searchNyxosMap(a.frage, map),
  });
}
