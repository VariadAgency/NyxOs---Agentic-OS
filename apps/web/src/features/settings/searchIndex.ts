// Search in the settings. Finds areas (title, summary, keywords) and single settings (keywords of a block) – a hit
// jumps to the subpage and there to the block (`#<panel-id>`). Pure and without React, so overview, tests and ⌘K use
// the same logic. The texts come translated from the register, so the search works in the chosen language.
import type { Tone } from "../../lib/tones";
import type { SettingsSection } from "./types";

export interface SettingsHit {
  /** Eindeutig je Treffer (Ziel). */
  key: string;
  /** Was gefunden wurde: Bereich, Abschnitt oder die einzelne Einstellung. */
  label: string;
  /** Bereich, in dem der Treffer liegt (leer, wenn der Treffer der Bereich selbst ist). */
  context: string;
  path: string;
  icon: string;
  tone: Tone;
}

/** Höchstens so viele Treffer – mehr liest niemand. */
export const SETTINGS_SEARCH_MAX = 8;

/** Klein, ohne Akzente: „Zugänge“ findet man auch mit „zugange“, „Über dich“ mit „uber“. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

interface Candidate {
  label: string;
  context: string;
  path: string;
  icon: string;
  tone: Tone;
  /** Bonus, damit der Bereich selbst vor einem gleichnamigen Stichwort steht. */
  bonus: number;
}

function candidates(sections: readonly SettingsSection[]): { own: Candidate[]; summaries: { text: string; c: Candidate }[] } {
  const own: Candidate[] = [];
  const summaries: { text: string; c: Candidate }[] = [];
  for (const s of sections) {
    const target = s.href ?? s.path;
    const base = { icon: s.icon, tone: s.tone };
    const sectionHit: Candidate = { ...base, label: s.title, context: "", path: target, bonus: 5 };
    own.push(sectionHit);
    summaries.push({ text: s.summary, c: sectionHit });
    for (const k of s.keywords) own.push({ ...base, label: k, context: s.title, path: target, bonus: 0 });
    if (s.href) continue;
    // Ein einziger Abschnitt = die Seite selbst: kein Anker, kein eigener Treffer für seinen Titel.
    const single = s.panels.length === 1;
    for (const p of s.panels) {
      const at = single ? s.path : `${s.path}#${p.id}`;
      if (!single && foldText(p.title) !== foldText(s.title)) own.push({ ...base, label: p.title, context: s.title, path: at, bonus: 2 });
      for (const k of p.keywords ?? []) own.push({ ...base, label: k, context: s.title, path: at, bonus: 1 });
      for (const spot of p.spots ?? []) for (const k of spot.keywords) own.push({ ...base, label: k, context: s.title, path: `${s.path}#${spot.anchor}`, bonus: 1 });
    }
  }
  return { own, summaries };
}

/** 0 = passt nicht. Alle Suchwörter müssen im Text stecken; genauer Treffer > Anfang > Wortanfang > irgendwo. */
function score(text: string, q: string, words: string[]): number {
  const t = foldText(text);
  if (!words.every((w) => t.includes(w))) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const tokens = t.split(/[^\p{L}\p{N}]+/u);
  if (words.every((w) => tokens.some((tok) => tok.startsWith(w)))) return 60;
  return 40;
}

/** Treffer für `query`, beste zuerst, je Ziel nur einmal. Leere Suche → keine Treffer. */
export function searchSettings(query: string, sections: readonly SettingsSection[], max = SETTINGS_SEARCH_MAX): SettingsHit[] {
  const q = foldText(query.trim()).replace(/\s+/g, " ");
  if (!q) return [];
  const words = q.split(" ");
  const { own, summaries } = candidates(sections);
  const scored: { c: Candidate; s: number; i: number }[] = [];
  own.forEach((c, i) => {
    const s = score(c.label, q, words);
    if (s > 0) scored.push({ c, s: s + c.bonus, i });
  });
  // Zusammenfassung zählt schwach (nur wenn Titel/Stichwort nichts liefern, steht der Bereich trotzdem in der Liste).
  summaries.forEach(({ text, c }, i) => {
    if (score(text, q, words) > 0) scored.push({ c, s: 20, i: own.length + i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const seen = new Set<string>();
  const hits: SettingsHit[] = [];
  for (const { c } of scored) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    hits.push({ key: c.path, label: c.label, context: c.context, path: c.path, icon: c.icon, tone: c.tone });
    if (hits.length >= max) break;
  }
  return hits;
}
