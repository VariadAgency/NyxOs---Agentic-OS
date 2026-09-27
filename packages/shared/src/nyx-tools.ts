// (L5 „Werkzeug-Namen sichtbar“): EINE Zuordnung Werkzeug-ID → einfache deutsche Wörter.
// Leiste („Nyx schaut in die Nutzung …“), Ausgabe-Feld, Nyx-Tab, Nyx-Zentrum und Telegram nutzen sie –
// rohe IDs wie „server_lage“ erscheinen nirgends. Neues Werkzeug auf dem Server → hier eine Zeile ergänzen;
// bis dahin greift ein Stichwort (z. B. „session“ → „liest Sessions“), sonst „arbeitet“.

import { t } from "./i18n/index.js";

export interface NyxToolWords {
  /** Was Nyx gerade tut, klein geschrieben, ohne „Nyx“ davor: „schaut in die Nutzung“. */
  doing: string;
  /** Kurzer Name für Chips und Beschriftungen: „Nutzung“. */
  name: string;
}

export const NYX_TOOL_WORDS: Readonly<Record<string, NyxToolWords>> = {
  lage: { doing: "schaut auf die Lage", name: "Lage" },
  was_ist_neu: { doing: "schaut, was neu ist", name: "Neuigkeiten" },
  sessions_suchen: { doing: "sucht Sessions", name: "Sessions" },
  sessions_zaehlen: { doing: "zählt Sessions", name: "Sessions zählen" },
  session_lesen: { doing: "liest eine Session", name: "Session lesen" },
  session_ergebnisse: { doing: "fasst eine Session zusammen", name: "Session-Ergebnis" },
  session_search: { doing: "durchsucht alte Gespräche", name: "Gesprächssuche" },
  git_lage: { doing: "schaut in Git", name: "Git" },
  letzte_aktivitaet: { doing: "schaut, was zuletzt lief", name: "Zuletzt" },
  konflikte: { doing: "prüft Konflikte", name: "Konflikte" },
  eintrag_suchen: { doing: "sucht Aufgaben", name: "Aufgaben" },
  eintrag_lesen: { doing: "liest eine Aufgabe", name: "Aufgabe" },
  auftrag_starten: { doing: "bereitet einen Auftrag vor", name: "Auftrag" },
  ideen_suchen: { doing: "sucht Ideen", name: "Ideen" },
  idee_anlegen: { doing: "notiert eine Idee", name: "Neue Idee" },
  inbox_liste: { doing: "schaut in die Entscheidungen", name: "Entscheidungen" },
  frage_stellen: { doing: "stellt dir eine Frage", name: "Frage" },
  freigabe_anfragen: { doing: "bittet dich um Freigabe", name: "Freigabe" },
  freigaben_liste: { doing: "schaut nach Freigaben", name: "Freigaben" },
  builds_liste: { doing: "prüft die Builds", name: "Builds" },
  nachtlaeufe: { doing: "schaut in die Nachtläufe", name: "Nachtläufe" },
  plan_vorschlagen: { doing: "schreibt einen Plan", name: "Plan" },
  nutzung: { doing: "schaut in die Nutzung", name: "Nutzung" },
  server_lage: { doing: "prüft den Server", name: "Server" },
  memory: { doing: "schaut ins Gedächtnis", name: "Gedächtnis" },
  memory_suggest: { doing: "will sich etwas merken", name: "Merken" },
  todo: { doing: "pflegt die To-do-Liste", name: "To-dos" },
  schedule: { doing: "plant eine Erinnerung", name: "Erinnerung" },
  screenshot_simulator: { doing: "macht ein Bild vom Simulator", name: "Simulator-Bild" },
  show_image: { doing: "zeigt dir ein Bild", name: "Bild" },
  show_link: { doing: "zeigt dir einen Link", name: "Link" },
  telegram: { doing: "schreibt dir per Telegram", name: "Telegram" },
  briefing_vorlesen: { doing: "liest das Briefing vor", name: "Briefing" },
  ui_read_screen: { doing: "liest den Bildschirm", name: "Bildschirm" },
  ui_navigate: { doing: "öffnet eine Seite", name: "Seite öffnen" },
  ui_click: { doing: "klickt in NyxOS", name: "Klicken" },
  ui_type: { doing: "tippt in NyxOS", name: "Tippen" },
  ui_select: { doing: "wählt in NyxOS aus", name: "Auswählen" },
};

/** Rückfall für Werkzeuge, die (noch) nicht oben stehen: erstes passendes Stichwort gewinnt. */
const KEYWORDS: readonly [RegExp, NyxToolWords][] = [
  [/session/i, { doing: "liest Sessions", name: "Sessions" }],
  [/eintr|aufgab|entry|auftrag/i, { doing: "liest Aufgaben", name: "Aufgaben" }],
  [/idee/i, { doing: "liest Ideen", name: "Ideen" }],
  [/inbox|frage|entscheid|freigab/i, { doing: "liest Entscheidungen", name: "Entscheidungen" }],
  [/doc|dok|memory|konzept|datei/i, { doing: "liest Dokumente", name: "Dokumente" }],
  [/git|commit/i, { doing: "schaut in Git", name: "Git" }],
  [/build/i, { doing: "prüft die Builds", name: "Builds" }],
  [/server|health/i, { doing: "prüft den Server", name: "Server" }],
  [/nutzung|usage|verbrauch|kosten/i, { doing: "schaut in die Nutzung", name: "Nutzung" }],
  [/nacht|night/i, { doing: "schaut in die Nachtläufe", name: "Nachtläufe" }],
];

const FALLBACK: NyxToolWords = { doing: "arbeitet", name: "Werkzeug" };

/** Konnektor-Werkzeug (`mcp__higgsfield__generate_image`) → Name des Konnektors, groß geschrieben. */
function connectorName(id: string): string | null {
  const m = /^mcp__(.+?)__/.exec(id);
  const raw = m?.[1]?.replace(/[_-]+/g, " ").trim();
  if (!raw) return null;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Wörter zu einer Werkzeug-ID – nie die ID selbst (in der App-Sprache; die Tabellen oben sind die deutsche Quelle). */
export function nyxToolWords(id: string | null | undefined): NyxToolWords {
  if (!id) return { doing: t(FALLBACK.doing), name: t(FALLBACK.name) };
  const known = Object.hasOwn(NYX_TOOL_WORDS, id) ? (NYX_TOOL_WORDS[id] as NyxToolWords) : null;
  const connector = known ? null : connectorName(id);
  if (connector) return { doing: t("nutzt {name}", { name: connector }), name: connector };
  const words = known ?? KEYWORDS.find(([re]) => re.test(id))?.[1] ?? FALLBACK;
  return { doing: t(words.doing), name: t(words.name) };
}

/** „schaut in die Nutzung“ (Rückfall „arbeitet“). */
export const nyxToolDoing = (id: string | null | undefined): string => nyxToolWords(id).doing;

/** Satzanfang für Statuszeilen ohne „Nyx“ davor: „Schaut in die Nutzung“ (Rückfall „Arbeitet“). */
export function nyxToolStatus(id: string | null | undefined): string {
  const d = nyxToolDoing(id);
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/** „Nutzung“ (Rückfall „Werkzeug“). */
export const nyxToolName = (id: string | null | undefined): string => nyxToolWords(id).name;
