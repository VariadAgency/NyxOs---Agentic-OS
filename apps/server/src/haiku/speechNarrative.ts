// (der Nutzer nach dem Test): Das Briefing zum Anhören ging Kachel für Kachel durch, las Zahlen einzeln
// vor, erklärte Diagramme („zeigt die letzten 7 Tage …“), nannte bei „Braucht dich“ nur zwei Punkte und las unten nur
// Stichpunkte. Jetzt schreibt Nyx die Sprechfassung selbst: zusammenhängend, in eigenen Worten, mit Zusammenhängen
// („Die Nutzung ist heute hoch – heute Nacht liefen fünf Sessions“), alle Punkte, die der Nutzer brauchen, und ein
// ausführlicher Stand am Ende.
//
// Leitplanken wie beim Bericht: Nyx bekommt nur die gespeicherten Daten des Berichts (plus daraus gerechnete Vergleiche),
// jeder Satz geht durch die Zahlen-Prüfung (eine Zahl, die nicht in den Daten steht, wird nie gesprochen), jeder Satz
// nennt die Stelle der Seite, die dabei leuchtet. Klappt das nicht, bleibt die bisherige Fassung aus den Daten.
import {
  BRIEF_CHART_KEYS,
  BRIEF_GROUP_TITLE,
  BRIEF_TILE_KEYS,
  briefGroupOf,
  formatTokensCompact,
  type BriefSpeechSection,
  type BriefSpeechSentence,
  type BriefSpeechTarget,
  type HaikuReport,
} from "@nyxos/shared";
import { extractJson } from "./json.js";
import { numbersIn, timeWordsIn } from "./report.js";
import type { HaikuRuntime } from "./runtime.js";
import { localDay } from "./settings.js";
import { buildBriefingSpeech, reportNumbers, speakText, speechNumbersOk } from "./speech.js";

// ───────────────────────────── Vergleiche aus den Daten ─────────────────────────────

const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
/** „heute 40 % mehr“ – ab dem Dreifachen „etwa 18-mal so viel“ statt absurder Prozente („1700 % mehr“, Live-Fund). */
export function changeWords(a: number, b: number, who: string): string | null {
  const d = pct(a, b);
  if (d === null) return null;
  if (a >= 3 * b) return `${who} etwa ${Math.round(a / b)}-mal so viel`;
  return `${who} ${d >= 0 ? `${d} % mehr` : `${-d} % weniger`}`;
}

/** Tageszeit einer Stunde (Zeitzone des Nutzers) (für „heute Nacht liefen …“). */
function dayPart(hour: number): "nacht" | "morgen" | "nachmittag" | "abend" {
  if (hour < 6) return "nacht";
  if (hour < 12) return "morgen";
  if (hour < 18) return "nachmittag";
  return "abend";
}

export interface SpeechContext {
  /** Fertige Vergleichs-Sätze mit Ziffern – ihre Zahlen gelten als belegt. */
  lines: string[];
}

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
/** „2026-09-24“ → „heute“ / „gestern“ / „Donnerstag, 24.09.“ – nie das ISO-Datum (gesprochen „… bis null neun bis …“). */
function dayLabel(iso: string, reportDay: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  if (iso === reportDay) return "heute";
  const prev = new Date(`${reportDay}T12:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  if (iso === prev.toISOString().slice(0, 10)) return "gestern";
  return `${WEEKDAYS[d.getUTCDay()]}, ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

/** Was man aus den Graphen herausliest, als fertige Aussagen (statt „der Graph zeigt …“). */
export function speechContext(report: HaikuReport): SpeechContext {
  const f = report.figures;
  if (!f) return { lines: [] };
  const lines: string[] = [];
  const sum = (d: { claude: number; codex: number }) => d.claude + d.codex;
  const today = sum(f.usage.today);
  const days = f.charts.usage7d.slice(0, -1).map(sum);
  const avg = days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const diff = pct(today, avg);
  // Morgens läuft der Tag erst seit ein paar Stunden: „heute 80 % weniger“ wäre irreführend. Dann nur „mehr“ als
  // Vergleich, sonst der Stand bisher – und gestern (ganzer Tag) gegen die Tage davor.
  const partial = report.kind === "briefing";
  if (diff !== null && today > 0) {
    if (diff >= 0 || !partial) lines.push(`Nutzung heute${partial ? " seit 0 Uhr" : ""} ${formatTokensCompact(today)} Tokens; Schnitt der ${days.length} Vortage ${formatTokensCompact(Math.round(avg))} – ${changeWords(today, avg, "heute")}.`);
    else lines.push(`Nutzung heute seit 0 Uhr ${formatTokensCompact(today)} Tokens – der Tag hat erst begonnen, ein Vergleich mit ganzen Tagen passt noch nicht.`);
  }
  if (partial && days.length >= 2) {
    const yesterday = days.at(-1) ?? 0;
    const before = days.slice(0, -1);
    const avgBefore = before.reduce((a, b) => a + b, 0) / before.length;
    const yd = pct(yesterday, avgBefore);
    if (yd !== null && yesterday > 0) lines.push(`Nutzung gestern ${formatTokensCompact(yesterday)} Tokens; Schnitt der ${before.length} Tage davor ${formatTokensCompact(Math.round(avgBefore))} – ${changeWords(yesterday, avgBefore, "gestern")}.`);
  }
  const busiest = [...f.charts.usage7d].sort((a, b) => sum(b) - sum(a))[0];
  if (busiest && sum(busiest) > 0) lines.push(`Stärkster Nutzungstag der letzten 7 Tage: ${dayLabel(busiest.day, report.day)} mit ${formatTokensCompact(sum(busiest))} Tokens.`);
  const week = f.usage.week.claude + f.usage.week.codex;
  const prev = f.usage.prevWeek.claude + f.usage.prevWeek.codex;
  const wd = pct(week, prev);
  if (wd !== null && week > 0) lines.push(`Nutzung diese 7 Tage ${formatTokensCompact(week)} Tokens, Vorwoche ${formatTokensCompact(prev)} – ${changeWords(week, prev, "diese Woche")}.`);
  // Sessions je Tageszeit (letzte 24 Stunden): die höchste Zahl gleichzeitig aktiver Sessions je Abschnitt – getrennt
  // nach heute/gestern (die 24 Stunden eines Recaps reichen in den gestrigen Abend), damit „heute Nacht“ stimmt.
  const parts = new Map<string, number>();
  for (const h of f.charts.sessionsHourly) {
    const at = new Date(h.at);
    const when = Number.isNaN(at.getTime()) || localDay(at) === report.day ? "heute" : "gestern";
    const key = `${when} ${dayPart(h.hour)}`;
    parts.set(key, Math.max(parts.get(key) ?? 0, h.claude + h.codex));
  }
  const partName = { nacht: "Nacht (0–6 Uhr)", morgen: "Morgen (6–12 Uhr)", nachmittag: "Nachmittag (12–18 Uhr)", abend: "Abend (18–24 Uhr)" } as const;
  const active = [...parts.entries()].filter(([, n]) => n > 0).map(([key, n]) => {
    const [when = "heute", p = "nacht"] = key.split(" ");
    return `${when} ${partName[p as keyof typeof partName]} bis zu ${n} gleichzeitig`;
  });
  if (active.length > 0) lines.push(`Aktive Sessions in den letzten 24 Stunden: ${active.join(", ")}.`);
  const cw = f.commits.week;
  const cp = f.commits.prevWeek;
  if (cw + cp > 0) lines.push(`Commits diese 7 Tage ${cw}, die 7 Tage davor ${cp}.`);
  return { lines };
}

// ───────────────────────────── Auftrag an Nyx ─────────────────────────────

const TARGETS: BriefSpeechTarget[] = ["headline", "needs", ...BRIEF_TILE_KEYS.map((k) => `tile:${k}` as const), ...BRIEF_CHART_KEYS.map((k) => `chart:${k}` as const), "group:lief", "group:haengt", "group:naechstes"];

export const SPEECH_SYSTEM = `Du bist Nyx und liest dem Nutzer sein Briefing vor – gesprochen, wie ein kluger Kollege, der kurz den Stand erzählt.

So klingt es:
- In deinen eigenen Worten, zusammenhängend. Verbinde, was zusammengehört, statt Kacheln einzeln aufzuzählen: „Die Nutzung ist heute deutlich höher als sonst – in der Nacht liefen bis zu fünf Sessions gleichzeitig.“
- Direkt und konkret, kein Drumherum, keine Floskeln, keine Begrüßung (die kommt vorher), kein Schlusssatz wie „Das war's“.
- Nie erklären, wie ein Diagramm aufgebaut ist oder wie man es liest („zeigt die letzten 7 Tage …“) – Der Nutzer sieht es selbst. Sag nur, was daraus folgt, wenn es wichtig ist.
- Nur die wichtigen Zahlen, nicht jede. Unwichtiges (alles null, nichts los) höchstens in einem Halbsatz.
- Eine Sprache ohne Mischmasch (s. Sprach-Zeile unten), du-Form, erste Person. Keine Commit-Kennungen, Pfeile, Klammer-Nummern, Markdown.

Reihenfolge:
1. Kernaussage: das Wichtigste in einem Satz.
2. Was dich braucht: JEDEN Punkt aus „braucht_dich“ nennen, in der gegebenen Reihenfolge, je ein kurzer Satz, was es ist und was der Nutzer tun soll. Bei mehr als sechs Punkten: die ersten fünf einzeln, dann „braucht_dich_weitere“ als Anzahl, die noch wartet.
3. Die Lage in Zahlen – zusammengefasst in zwei bis vier Sätzen mit Zusammenhängen (Nutzung, Sessions, Commits, Aufgaben, Störungen).
4. Was lief, was hängt, was als Nächstes: ausführlich in ganzen Sätzen erklären, was genau passiert ist und was das bedeutet – nicht die Stichpunkte vorlesen. Nutze die Namen aus „quellen“.

„Sortier-Vorschlag: „X“ → Y“ heißt: die Session „X“ in die Kategorie Y einsortieren (ein Klick auf Ja) – nichts anderes. „Wartet: X“ heißt: die Session X wartet auf eine Antwort vom Nutzer.
Jeden Braucht-dich-Punkt genau EINMAL nennen, natürlich verbunden – keine Aufzähl-Wörter wie „Erste Frage … Vierte Punkt“. Ein Vergleich mit 0 (z. B. Vorwoche 0) ist kein Trend – dann nur die Zahl nennen.

Zahlen: Nenne nur Zahlen, die genau so in den Daten oder in „vergleiche“ stehen, als Ziffern (die Stimme spricht sie richtig). Rechne nichts Neues aus, runde nichts. „kein/keine/nichts“ nur, wenn die Daten das sagen. Zeitwörter (gestern, heute Nacht, diese Woche, vorhin …) nur, wenn sie so in den Daten stehen. Punkte mit „einschaetzung“ sind Einschätzungen – sag das auch so.

Jeder Satz bekommt ein „ziel“: die Stelle der Seite, über die er spricht (sie leuchtet beim Vorlesen). Erlaubt: ${TARGETS.join(", ")}.

Antworte NUR mit JSON: {"saetze":[{"ziel":"headline","text":"…"}, …]} – 8 bis 18 Sätze, jeder höchstens 220 Zeichen.`;

const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Bis so viele „Braucht dich“-Punkte nennt Nyx alle einzeln; darüber die ersten fünf + „noch N weitere“. */
const NEEDS_ALL = 6;
const NEEDS_NAMED_MODEL = 5;
const NEED_KIND: Record<HaikuReport["needsYou"][number]["kind"], string> = {
  approval: "Freigabe",
  question: "Frage",
  plan: "Plan",
  review: "Prüfung",
  crashed: "abgestürzte Session",
  build: "Build-Fehler",
  session: "wartende Session",
};

export function speechPrompt(report: HaikuReport): string {
  const f = report.figures;
  const groups = (["lief", "haengt", "naechstes"] as const).map((g) => ({
    gruppe: BRIEF_GROUP_TITLE[g],
    ziel: `group:${g}`,
    punkte: report.sections
      .filter((s) => briefGroupOf(s.title) === g)
      .flatMap((s) =>
        s.statements.map((st) => ({ abschnitt: s.title, text: clip(st.text, 400), quellen: st.sources.slice(0, 5).map((src) => clip(src.label, 90)), einschaetzung: st.estimate || undefined })),
      ),
  }));
  const needs = report.needsYou;
  const data = {
    art: report.kind === "briefing" ? "Morgen-Briefing" : "Abend-Recap",
    kernaussage: clip(report.headline?.text ?? report.lage, 300),
    lage: clip(report.lage, 300),
    braucht_dich: needs.map((i) => ({
      art: NEED_KIND[i.kind],
      titel: clip(i.title, 160),
      detail: clip(i.detail, 200) || undefined,
      minuten: i.minutes,
      ein_klick: i.zeroEnergy,
      anzahl: i.count && i.count > 1 ? i.count : undefined,
      quellen: i.sources.slice(0, 3).map((src) => clip(src.label, 90)),
    })),
    braucht_dich_weitere: needs.length > NEEDS_ALL ? needs.length - NEEDS_NAMED_MODEL : undefined,
    kacheln: f
      ? {
          zeitraum: f.periodLabel,
          sessions: f.sessions,
          commits: f.commits,
          auftraege: { offen: f.tasks.open, stufen: f.tasks.byStage },
          nutzung_heute: { claude: formatTokensCompact(f.usage.today.claude), codex: formatTokensCompact(f.usage.today.codex) },
          nutzung_7_tage: { claude: formatTokensCompact(f.usage.week.claude), codex: formatTokensCompact(f.usage.week.codex) },
          offene_fragen: f.openQuestions,
          konflikte: f.conflicts,
          build_fehler: f.buildsRed,
          braucht_dich: f.needsYou,
        }
      : null,
    vergleiche: speechContext(report).lines,
    stand: groups,
  };
  return `Daten des Briefings (nur diese verwenden):\n${JSON.stringify(data, null, 1)}`;
}

// ───────────────────────────── Antwort prüfen ─────────────────────────────

const SECTION_OF = (target: BriefSpeechTarget): BriefSpeechSection => {
  if (target === "headline") return "kernaussage";
  if (target === "needs") return "braucht_dich";
  if (target === "group:lief") return "lief";
  if (target === "group:haengt") return "haengt";
  if (target === "group:naechstes") return "naechstes";
  return "kennzahlen";
};

/** Mindestens so viele gültige Sätze, sonst gilt die Antwort als misslungen (Rückfall auf die Daten-Fassung). */
const MIN_SENTENCES = 4;

export interface NarrativeResult {
  sentences: BriefSpeechSentence[];
  dropped: string[];
}

/** Liest Nyx' Antwort ein: gültige Ziele, Zahlen nur aus Bericht + Vergleichen, fürs Ohr umgeschrieben. */
export function parseNarrative(raw: unknown, report: HaikuReport): NarrativeResult | null {
  const obj = raw as { saetze?: unknown } | null;
  if (!obj || !Array.isArray(obj.saetze)) return null;
  const allowed = reportNumbers(report);
  const lines = speechContext(report).lines;
  for (const line of lines) for (const n of numbersIn(line)) allowed.add(n);
  // Zahlen, die der Auftrag an Nyx zusätzlich nennt (gebündelte Punkte „4×“, „noch N weitere“).
  for (const i of report.needsYou) if (i.count && i.count > 1) allowed.add(String(i.count));
  if (report.needsYou.length > NEEDS_ALL) allowed.add(String(report.needsYou.length - NEEDS_NAMED_MODEL));
  // Wie `validateStatement`: ein Zeitwort („gestern“, „heute Nacht“) nur, wenn es auch in den Daten steht.
  const factText = [report.lage, report.headline?.text ?? "", report.figures?.periodLabel ?? "", ...lines, ...report.sections.flatMap((s) => s.statements.map((st) => st.text)), ...report.needsYou.flatMap((i) => [i.title, i.detail ?? ""])].join(" ");
  const timeOk = new Set(timeWordsIn(factText));
  // Im Recap ist „morgen“ der Ausblick, keine Behauptung über Daten.
  if (report.kind === "recap") timeOk.add("morgen");
  // „heute Nacht“ aus den Vergleichen sagt man auch „letzte Nacht“ / „nachts“.
  if (timeOk.has("heute nacht")) for (const w of ["letzte nacht", "nachts"]) timeOk.add(w);
  const sentences: BriefSpeechSentence[] = [];
  const dropped: string[] = [];
  for (const s of obj.saetze.slice(0, 24)) {
    const text = typeof (s as { text?: unknown }).text === "string" ? clip((s as { text: string }).text, 260) : "";
    const zielRaw = (s as { ziel?: unknown }).ziel;
    const known = (TARGETS as string[]).includes(String(zielRaw)) ? (zielRaw as BriefSpeechTarget) : null;
    // Live-Fund: Nyx nannte die Punkte unter „tile:needs_you“ – das ist dieselbe Liste. Sonst hielt die Sicherung die
    // Punkte für fehlend und hängte die Daten-Liste dazu (alles doppelt gesprochen).
    const target = known === "tile:needs_you" ? "needs" : known;
    if (!text || !target) continue;
    const written = /[.!?…]$/.test(text) ? text : `${text}.`;
    if (!speechNumbersOk(written, allowed) || timeWordsIn(written).some((w) => !timeOk.has(w))) {
      dropped.push(written);
      continue;
    }
    const spoken = speakText(written);
    if (spoken.length > 3) sentences.push({ section: SECTION_OF(target), target, text: spoken, written });
  }
  if (sentences.length < MIN_SENTENCES) return null;
  return { sentences: ensureAllNeeds(sentences, report), dropped };
}

/**
 * des Nutzers Hauptkritik war „bei Braucht dich nur zwei Punkte“. Fehlen in Nyx' Fassung Punkte (ausgelassen oder an der
 * Zahlen-Prüfung gescheitert), ersetzt die vollständige Liste aus den Daten Nyx' Braucht-dich-Sätze an derselben Stelle.
 */
function ensureAllNeeds(sentences: BriefSpeechSentence[], report: HaikuReport): BriefSpeechSentence[] {
  const needed = Math.min(report.needsYou.length, NEEDS_ALL);
  const own = sentences.filter((s) => s.target === "needs");
  if (needed === 0 || own.length >= needed) return sentences;
  const complete = buildBriefingSpeech(report).sentences.filter((s) => s.target === "needs");
  const at = own.length > 0 ? sentences.indexOf(own[0] as BriefSpeechSentence) : sentences.findIndex((s) => s.target !== "headline");
  const rest = sentences.filter((s) => s.target !== "needs");
  const pos = at < 0 ? rest.length : Math.min(at, rest.length);
  return [...rest.slice(0, pos), ...complete, ...rest.slice(pos)];
}

// ───────────────────────────── Erzeugen + Zwischenspeicher ─────────────────────────────

/** Je Bericht einmal erzeugen (das Modell braucht einige Sekunden); die letzten paar Berichte bleiben gemerkt. */
const CACHE_MAX = 8;
const cache = new Map<number, Promise<NarrativeResult | null>>();

export interface NarrateDeps {
  runtime: HaikuRuntime;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

async function generate(deps: NarrateDeps, report: HaikuReport): Promise<NarrativeResult | null> {
  const t0 = Date.now();
  const res = await deps.runtime.run({ kind: report.kind, scope: "none", systemPrompt: SPEECH_SYSTEM, prompt: speechPrompt(report), thinking: false });
  if (res.type !== "final") {
    deps.log?.("briefing-sprechfassung-fehler", { reportId: report.id, grund: res.message });
    return null;
  }
  const parsed = parseNarrative(extractJson(res.rawText), report);
  deps.log?.("briefing-sprechfassung", { reportId: report.id, ms: Date.now() - t0, saetze: parsed?.sentences.length ?? 0, verworfen: parsed?.dropped.length ?? null, ok: parsed !== null });
  return parsed;
}

/** Nyx' Sprechfassung eines Berichts (gemerkt; ein zweiter Aufruf wartet auf denselben Lauf). */
export function narrateBriefing(deps: NarrateDeps, report: HaikuReport): Promise<NarrativeResult | null> {
  const hit = cache.get(report.id);
  if (hit) return hit;
  const job = generate(deps, report).catch((e: unknown) => {
    deps.log?.("briefing-sprechfassung-fehler", { reportId: report.id, grund: e instanceof Error ? e.message : String(e) });
    return null;
  });
  cache.set(report.id, job);
  // Misslungen → nicht merken, beim nächsten Vorlesen neu versuchen.
  void job.then((r) => {
    if (r === null && cache.get(report.id) === job) cache.delete(report.id);
  });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as number);
  return job;
}

/** Tests: Zwischenspeicher leeren. */
export function clearNarrativeCache(): void {
  cache.clear();
}
