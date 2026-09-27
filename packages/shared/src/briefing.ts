// Briefing wie ein Artefakt. Zwei streng getrennte Teile:
// - `BriefingFigures`: ALLE Zahlen und Diagramm-Reihen — vom Server aus dem Schnappschuss (`overview/snapshot.ts`)
//   und vorhandenen Tabellen berechnet, im Bericht gespeichert (gleicher Stand wie die Sätze).
// - `BriefingModelOutput`: was das Modell (Nyx) liefern darf — nur Text und Struktur (Kernaussage, Sätze,
//   Vorschlag, welche Kacheln hervorgehoben und welche Diagramme wichtig sind). Zahlenfelder gibt es hier
//   nicht; was das Modell sonst noch schickt, fällt beim Einlesen weg.
import { z } from "zod";
import type { OpenQuestionCounts } from "./overview.js";

/** Kennzahl-Kacheln des Briefings (feste Reihenfolge). */
export const BRIEF_TILE_KEYS = ["needs_you", "sessions_active", "sessions_done", "commits", "tasks_open", "usage_today", "usage_week", "server", "conflicts"] as const;
export type BriefTileKey = (typeof BRIEF_TILE_KEYS)[number];

/** Diagramme des Briefings (Standard-Reihenfolge, das Modell darf umsortieren). */
export const BRIEF_CHART_KEYS = ["usage_7d", "sessions_hourly", "commits_daily", "tasks_progress"] as const;
export type BriefChartKey = (typeof BRIEF_CHART_KEYS)[number];

/** Aufgaben-Stufen, die der Fortschritts-Ring zeigt (Arbeits-Arten, ohne Ideen). */
export const BRIEF_TASK_STAGES = ["geplant", "startklar", "laeuft", "pruefen", "erledigt"] as const;
export type BriefTaskStage = (typeof BRIEF_TASK_STAGES)[number];

export interface ToolSplit {
  claude: number;
  codex: number;
}

export interface BriefingFigures {
  /** Zeitpunkt des Schnappschusses (identisch mit `snapshot.at`). */
  at: string;
  /** „seit gestern 0 Uhr“ (Briefing) bzw. „heute“ (Recap) — Zeitraum von `activeInPeriod`/`closedInPeriod`. */
  periodLabel: string;
  sessions: { running: number; waiting: number; idle: number; crashed: number; activeInPeriod: number; closedInPeriod: number };
  /** Commits (alle Ordner, Tage (Zeitzone des Nutzers)). */
  commits: { today: number; week: number; prevWeek: number };
  /** Aufträge (Bug, Aufgabe, Audit-Fund, Problem) je Stufe; `open` = alles außer „erledigt“. */
  tasks: { open: number; byStage: { stage: BriefTaskStage; count: number }[] };
  /** Tokens je Anbieter (Tage (Zeitzone des Nutzers)). */
  usage: { today: ToolSplit; week: ToolSplit; prevWeek: ToolSplit };
  openQuestions: OpenQuestionCounts;
  conflicts: number;
  buildsRed: number;
  needsYou: number;
  charts: {
    /** 7 Tage (Zeitzone des Nutzers), älteste zuerst, lückenlos. */
    usage7d: ({ day: string } & ToolSplit)[];
    /** Die letzten 24 Stunden bis zur laufenden (älteste zuerst): Haupt-Sessions mit Aktivität je Stunde,
     * nach Anbieter. `at` = Beginn der Stunde (ISO), `hour` = Stunde (Zeitzone des Nutzers) 0–23. */
    sessionsHourly: ({ at: string; hour: number } & ToolSplit)[];
    /** 14 Tage (Zeitzone des Nutzers), älteste zuerst; `repos` = Commits je Ordner-Schlüssel aus `commitRepos`. */
    commitsDaily: { day: string; repos: Record<string, number> }[];
    /** Die meistbenutzten Ordner (höchstens 4) + „andere“, feste Reihenfolge. */
    commitRepos: { key: string; label: string }[];
  };
}

// ───────────────────────────── Modell-Ausgabe (nur Text + Struktur) ─────────────────────────────

const factIds = z.array(z.string().min(1).max(12)).max(8);
const SentenceSchema = z.object({ abschnitt: z.string().max(80).optional(), text: z.string().min(1).max(400), fakten: factIds });
const HeadlineSchema = z.object({ text: z.string().min(1).max(240), fakten: factIds });
const SuggestionSchema = z.object({ text: z.string().min(1).max(300), fakten: factIds.optional().default([]) });

export interface BriefingModelOutput {
  kernaussage: { text: string; fakten: string[] } | null;
  saetze: { abschnitt?: string; text: string; fakten: string[] }[];
  vorschlag: { text: string; fakten: string[] } | null;
  hervorhebungen: BriefTileKey[];
  graphen: BriefChartKey[];
}

const pickKeys = <K extends string>(raw: unknown, allowed: readonly K[], max: number): K[] => {
  if (!Array.isArray(raw)) return [];
  const out: K[] = [];
  for (const v of raw) if (typeof v === "string" && (allowed as readonly string[]).includes(v) && !out.includes(v as K)) out.push(v as K);
  return out.slice(0, max);
};

/**
 * Liest die Antwort des Modells streng ein: ohne Objekt mit `saetze`-Liste → null (Rückfall auf Regel-Sätze).
 * Einzelne ungültige Sätze fallen weg, unbekannte Kachel-/Diagramm-Schlüssel ebenso. Alle anderen Felder
 * (z. B. eigene „kennzahlen“) werden nie übernommen — Zahlen kommen nur aus `BriefingFigures`.
 */
export function parseBriefingModel(raw: unknown): BriefingModelOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.saetze)) return null;
  const saetze = o.saetze.flatMap((s) => {
    const p = SentenceSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
  const head = HeadlineSchema.safeParse(o.kernaussage);
  const sug = SuggestionSchema.safeParse(o.vorschlag);
  return {
    kernaussage: head.success ? head.data : null,
    saetze,
    vorschlag: sug.success ? sug.data : null,
    hervorhebungen: pickKeys(o.hervorhebungen, BRIEF_TILE_KEYS, 3),
    graphen: pickKeys(o.graphen, BRIEF_CHART_KEYS, BRIEF_CHART_KEYS.length),
  };
}

// ───────────────────────────── Abschnitte in einfacher Sprache ─────────────────────────────

export type BriefGroup = "lief" | "haengt" | "naechstes";

export const BRIEF_GROUP_TITLE: Record<BriefGroup, string> = { lief: "Was lief", haengt: "Was hängt", naechstes: "Was als Nächstes" };

/** Ordnet einen Bericht-Abschnitt einer der drei Gruppen zu (gilt auch für ältere Berichte). */
export function briefGroupOf(sectionTitle: string): BriefGroup {
  // deutsche und englische Titel (der Bericht wird in der App-Sprache geschrieben)
  if (/^(Vorschlag|Als Nächstes|Suggestion for|Up next)/.test(sectionTitle)) return "naechstes";
  if (/^(Was wartet|Offen|Was ist kaputt|Neue Probleme|What's waiting|Open|What's broken|New problems)/.test(sectionTitle)) return "haengt";
  return "lief";
}

/** Reihenfolge der Diagramme: erst die vom Modell genannten, dann der Rest in Standard-Reihenfolge. */
export function orderCharts(preferred: readonly BriefChartKey[] | undefined): BriefChartKey[] {
  const first = (preferred ?? []).filter((k) => (BRIEF_CHART_KEYS as readonly string[]).includes(k));
  return [...new Set([...first, ...BRIEF_CHART_KEYS])];
}

// ───────────────────────────── T5 · Briefing zum Anhören ─────────────────────────────

/** Abschnitte der Sprechfassung, in dieser Reihenfolge vorgelesen. */
export const BRIEF_SPEECH_SECTIONS = ["kernaussage", "braucht_dich", "kennzahlen", "lief", "haengt", "naechstes"] as const;
export type BriefSpeechSection = (typeof BRIEF_SPEECH_SECTIONS)[number];

export const BRIEF_SPEECH_SECTION_TITLE: Record<BriefSpeechSection, string> = {
  kernaussage: "Kernaussage",
  braucht_dich: "Braucht dich",
  kennzahlen: "Kennzahlen",
  lief: "Was lief",
  haengt: "Was hängt",
  naechstes: "Als Nächstes",
};

/**
 * Stelle auf der Briefing-Seite, über die ein Satz spricht (`data-speech-target`):
 * `headline` (Kernaussage), `needs` („Braucht dich“), `tile:<Kachel>`, `chart:<Graph>`, `group:<lief|haengt|naechstes>`.
 */
export type BriefSpeechTarget = "headline" | "needs" | `tile:${BriefTileKey}` | `chart:${BriefChartKey}` | `group:${BriefGroup}`;

export const briefChartTarget = (key: BriefChartKey): BriefSpeechTarget => `chart:${key}`;

export const briefTileTarget = (key: BriefTileKey): BriefSpeechTarget => `tile:${key}`;
export const briefGroupTarget = (g: BriefGroup): BriefSpeechTarget => `group:${g}`;

export interface BriefSpeechSentence {
  section: BriefSpeechSection;
  /** Stelle auf der Seite, die beim Vorlesen hervorgehoben wird. */
  target: BriefSpeechTarget;
  /** Was die Stimme spricht: Zahlen, Uhrzeiten und Kürzel ausgeschrieben. */
  text: string;
  /** Derselbe Satz mit Ziffern – dagegen läuft die Zahlen-Prüfung (jede Zahl steht im Bericht). */
  written: string;
}

export interface BriefingSpeech {
  reportId: number;
  kind: "briefing" | "recap";
  day: string;
  sentences: BriefSpeechSentence[];
  /** „nyx“ = von Nyx in eigenen Worten geschrieben, „daten“ = Fassung aus den Daten (Rückfall). */
  source?: "nyx" | "daten";
}
