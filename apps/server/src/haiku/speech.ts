// Briefing zum Anhören: die Sprechfassung eines gespeicherten Berichts.
//
// Kurz und gut vorlesbar, in festen Abschnitten (Kernaussage → Braucht dich → Kennzahlen in Worten → Was lief →
// Was hängt → Als Nächstes). Jeder Satz nennt die Stelle der Briefing-Seite (`target`), über die er spricht —
// die Seite hebt beim Vorlesen genau diese Stelle hervor.
//
// Zahlen: Jeder Satz entsteht zuerst mit Ziffern (`written`) NUR aus dem Bericht (Kennzahlen aus `figures`,
// Sätze und Titel wie gespeichert). Dieselbe Zahlen-Prüfung wie bei Haikus Sätzen (`numbersIn`) lässt nur Zahlen
// durch, die im Bericht stehen; ein Satz mit fremder Zahl fällt weg. Erst danach wird er fürs Ohr umgeschrieben
// (`speakGerman`: „10:38“ → „zehn Uhr achtunddreißig“, „3,9 Mrd.“ → „drei Komma neun Milliarden“).
import {
  BRIEF_GROUP_TITLE,
  briefGroupOf,
  briefGroupTarget,
  briefTileTarget,
  formatTokensCompact,
  getLang,
  greetingLine,
  t,
  type BriefGroup,
  type BriefingFigures,
  type BriefingSpeech,
  type BriefSpeechSection,
  type BriefSpeechSentence,
  type BriefSpeechTarget,
  type HaikuReport,
} from "@nyxos/shared";
import { numbersIn } from "./report.js";

// ───────────────────────────── Zahlen fürs Ohr ─────────────────────────────

const ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const tens = TENS[Math.floor(n / 10)] ?? "";
  const one = n % 10;
  return one === 0 ? tens : `${one === 1 ? "ein" : ONES[one]}und${tens}`;
}

/** 0 … 999: `lead` = Zahl steht allein („hundert“), sonst Teil einer größeren („einhundert“). */
function below1000(n: number, lead: boolean): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const hundreds = h === 0 ? "" : h === 1 ? (lead ? "hundert" : "einhundert") : `${ONES[h]}hundert`;
  if (rest === 0) return hundreds || (lead ? "null" : "");
  return hundreds + below100(rest);
}

/** Ganze Zahl in Worten (bis 999 999 999 999), „eins“ am Ende wie gesprochen. */
export function integerWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return below1000(n, true);
  const parts: string[] = [];
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  const inner = (x: number) => below1000(x, false).replace(/eins$/, "ein");
  if (billions) parts.push(billions === 1 ? "eine Milliarde" : `${inner(billions)} Milliarden`);
  if (millions) parts.push(millions === 1 ? "eine Million" : `${inner(millions)} Millionen`);
  let tail = "";
  if (thousands) tail += `${thousands === 1 ? "ein" : inner(thousands)}tausend`;
  if (rest) tail += below1000(rest, false);
  if (tail) parts.push(tail);
  return parts.join(" ");
}

/** Nomen, vor denen „1“ als „eine“ gesprochen wird (sonst „ein“ bzw. allein „eins“). */
const FEMININE = /^(Session|Frage|Freigabe|Freigabe-Anfrage|Störung|Aufgabe|Minute|Stunde|Million|Milliarde|Billion|Datei|Idee|Entscheidung|Nachricht|Woche|Stimme)(?![\p{L}])/u;
const stem = (w: string) => w.replace(/(en|n|s)$/u, "");

/** „1“ vor einem Wort: „eine Session“, „ein Punkt“; vor einem Verb nach dem letzten Nomen („2 Sessions …, 1 wartet“). */
function oneFor(before: string, after: string): string {
  const next = /^\s+([\p{L}][\p{L}-]*)/u.exec(after)?.[1];
  if (next && /^\p{Lu}/u.test(next)) return FEMININE.test(next) ? "eine" : "ein";
  const nouns = before.match(/\p{Lu}[\p{L}-]+/gu) ?? [];
  const last = nouns.at(-1);
  if (next && last && (FEMININE.test(last) || FEMININE.test(stem(last)))) return "eine";
  return "eins";
}

const digitsSpoken = (d: string) => [...d].map((c) => ONES[Number(c)] ?? c).join(" ");

const MAGNITUDE: Record<string, [string, string]> = {
  tsd: ["tausend", "tausend"],
  mio: ["Million", "Millionen"],
  mrd: ["Milliarde", "Milliarden"],
  bio: ["Billion", "Billionen"],
};

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
/** Tag als Ordnungszahl nach „vom/am“: „ersten“, „dritten“, „siebten“, „zwanzigsten“, „einunddreißigsten“. */
function ordinalDative(n: number): string {
  const special: Record<number, string> = { 1: "ersten", 3: "dritten", 7: "siebten", 8: "achten" };
  return special[n] ?? `${integerWords(n)}${n < 20 ? "ten" : "sten"}`;
}

/** Zahl mit Komma („3,9“) in Worten: „drei Komma neun“. */
const decimalWords = (s: string) => {
  const [a = "0", b = ""] = s.split(",");
  return b ? `${integerWords(Number(a))} Komma ${digitsSpoken(b)}` : integerWords(Number(a));
};

/**
 * Macht einen deutschen Satz vorlesbar: keine Ziffern, keine Anführungszeichen, keine Kürzel.
 * Uhrzeiten, Token-Mengen („4 Mio.“), Tausenderpunkte, Kommazahlen, „#12“, „T-01“ und „1“ mit richtigem Geschlecht.
 */
export function speakGerman(input: string): string {
  let s = input;
  s = s.replace(/[„“”"‚‘'`*_]/g, "");
  s = s.replace(/\bz\.\s?B\./g, "zum Beispiel").replace(/\bggü\./g, "gegenüber").replace(/\bca\./g, "etwa").replace(/\bu\.\s?a\./g, "unter anderem");
  s = s.replace(/~\s*/g, "etwa ");
  s = s.replace(/(?<![\p{L}])Min\.?(?![\p{L}])/gu, "Minuten").replace(/(?<![\p{L}])Std\.?(?![\p{L}])/gu, "Stunden");
  s = s.replace(/\s*%/g, " Prozent").replace(/\bUSD\b/g, "Dollar").replace(/\s*&\s*/g, " und ");
  s = s.replace(/\s*[·→|]\s*/g, ", ");
  s = s.replace(/\(\s*/g, ", ").replace(/\s*\)/g, "");
  s = s.replace(/#\s?(\d+)/g, "Nummer $1");
  // Kennungen wie „T-01“, „P7“: Ziffern einzeln.
  s = s.replace(/(?<![\p{L}\d])([\p{L}]{1,3})-?(0\d+)(?!\d)/gu, (_m, l: string, d: string) => `${l} ${digitsSpoken(d)}`);
  s = s.replace(/(?<![\p{L}\d])(\p{Lu}{1,3})-?([1-9]\d*)(?![\d\p{L}]|[.,:]\d)/gu, "$1 $2");
  // Datum „25.09.“ / „25.09.2026“ (z. B. „Session vom 25.09., 10:38“) → „fünfundzwanzigsten September“.
  s = s.replace(/(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4})?(?![\d])/g, (m: string, d: string, mo: string, y: string | undefined, offset: number, all: string) => {
    const day = Number(d);
    const month = MONTHS[Number(mo) - 1];
    if (!month || day < 1 || day > 31) return m;
    const end = !y && offset + m.length >= all.length ? "." : "";
    return `${ordinalDative(day)} ${month}${y ? ` ${integerWords(Number(y))}` : ""}${end}`;
  });
  // Spanne „9-17 Uhr“, „10:00–12:00“ → „bis“.
  s = s.replace(/(\d)\s?[–-]\s?(\d)/g, "$1 bis $2");
  s = s.replace(/(?<![\d:])0 Uhr\b/g, "Mitternacht");
  // „10:38 Uhr“ – das „Uhr“ dahinter nicht doppelt sprechen.
  s = s.replace(/(?<![\d,.])(\d{1,2}):(\d{2})(?!\d)(?:\s*Uhr(?![\p{L}]))?/gu, (_m, h: string, m: string) => {
    const hh = Number(h);
    const mm = Number(m);
    return `${hh === 1 ? "ein" : integerWords(hh)} Uhr${mm ? ` ${integerWords(mm)}` : ""}`;
  });
  s = s.replace(/(\d+(?:,\d+)?)\s*(Tsd|Mio|Mrd|Bio)(\.?)(?![\p{L}])(\s*)/gu, (m: string, num: string, unit: string, dot: string, space: string, offset: number, all: string) => {
    const [one, many] = MAGNITUDE[unit.toLowerCase()] ?? ["", ""];
    // Der Kürzel-Punkt am Satzende ist zugleich der Satzpunkt.
    const end = dot && offset + m.length >= all.length ? "." : "";
    if (unit.toLowerCase() === "tsd") return `${decimalWords(num)}tausend${end}${space}`;
    return `${num === "1" ? "eine" : decimalWords(num)} ${num === "1" ? one : many}${end}${space}`;
  });
  s = s.replace(/(?<![\d,.])(\d{1,3}(?:\.\d{3})+)(?![\d])/g, (m) => m.replace(/\./g, ""));
  s = s.replace(/(\d+),(\d+)/g, (_m, a: string, b: string) => decimalWords(`${a},${b}`));
  s = s.replace(/\d+/g, (m: string, offset: number, all: string) => {
    if (m.length > 1 && m.startsWith("0")) return digitsSpoken(m);
    const n = Number(m);
    if (n === 1) return oneFor(all.slice(0, offset), all.slice(offset + m.length));
    return integerWords(n);
  });
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?:;])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,([.!?])/g, "$1")
    .replace(/([?!]),/g, "$1")
    .replace(/^[,\s]+/, "")
    .trim()
    // „1 Session …“ am Satzanfang wird „eine Session …“ – großgeschrieben wie jeder Satzanfang.
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Englische Fassung: Sprachausgaben lesen Ziffern im Englischen selbst richtig vor — hier nur Zeichen,
 * Kürzel und Klammern glätten.
 */
export function speakEnglish(input: string): string {
  let s = input;
  s = s.replace(/[„“”"‚‘`*_]/g, "");
  s = s.replace(/\be\.\s?g\./gi, "for example").replace(/\bvs\./g, "versus").replace(/\bapprox\./gi, "about");
  s = s.replace(/~\s*/g, "about ");
  s = s.replace(/(?<![\p{L}])min\.?(?![\p{L}])/gu, "minutes").replace(/(?<![\p{L}])hrs?\.?(?![\p{L}])/gu, "hours");
  // Short units as the page writes them („5 h“, „14 d“, „28.1M“, „950K“) – voices read them letter by letter.
  s = s.replace(/(?<![\d.,])1\s?h(?![\p{L}])/gu, "1 hour").replace(/(\d)\s?h(?![\p{L}])/gu, "$1 hours");
  s = s.replace(/(?<![\d.,])1\s?d(?![\p{L}])/gu, "1 day").replace(/(\d)\s?d(?![\p{L}])/gu, "$1 days");
  s = s.replace(/(?<![\d.,])1\s?(?:sec|s)(?![\p{L}])/gu, "1 second").replace(/(\d)\s?(?:sec|s)(?![\p{L}])/gu, "$1 seconds");
  s = s.replace(/(\d)\s?K(?![\p{L}])/gu, "$1 thousand").replace(/(\d)\s?M(?![\p{L}])/gu, "$1 million").replace(/(\d)\s?B(?![\p{L}])/gu, "$1 billion");
  // US short dates („09/26“) as words: „September 26“.
  s = s.replace(/\b(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\b/g, (_m, mo: string, d: string) => `${EN_MONTHS[Number(mo) - 1]} ${Number(d)}`);
  s = s.replace(/\s*%/g, " percent").replace(/\bUSD\b/g, "dollars").replace(/\s*&\s*/g, " and ");
  s = s.replace(/\s*[·→|]\s*/g, ", ");
  s = s.replace(/\(\s*/g, ", ").replace(/\s*\)/g, "");
  s = s.replace(/#\s?(\d+)/g, "number $1");
  s = s.replace(/(\d)\s?[–-]\s?(\d)/g, "$1 to $2");
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?:;])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,([.!?])/g, "$1")
    .replace(/([?!]),/g, "$1")
    .replace(/^[,\s]+/, "")
    .trim()
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Vorlesbare Fassung in der App-Sprache. */
export function speakText(input: string): string {
  return getLang() === "en" ? speakEnglish(input) : speakGerman(input);
}

// ───────────────────────────── Zahlen-Prüfung ─────────────────────────────

/** Feste Wörter der Seite, die eine Zahl tragen („Commits · 7 Tage“, „letzte 24 Stunden“, „14 Tage“). */
const FIXED_NUMBERS = ["7", "14", "24"];

function collectNumbers(value: unknown, out: Set<string>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    for (const n of numbersIn(String(value))) out.add(n);
    for (const n of numbersIn(formatTokensCompact(value))) out.add(n);
  } else if (typeof value === "string") {
    for (const n of numbersIn(value)) out.add(n);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
}

/** Alle Zahlen, die im Bericht stehen (Sätze, Titel, Aufwand, Kennzahlen – ohne Diagramm-Reihen). */
export function reportNumbers(report: HaikuReport): Set<string> {
  const out = new Set<string>(FIXED_NUMBERS);
  collectNumbers([report.greeting, report.lage, report.headline?.text ?? ""], out);
  for (const sec of report.sections) for (const st of sec.statements) collectNumbers(st.text, out);
  for (const item of report.needsYou) collectNumbers([item.title, item.detail ?? "", item.minutes], out);
  const f = report.figures;
  if (f) {
    // Ohne Diagramm-Reihen und Zeitstempel: vorgelesen werden nur Kachel-Werte.
    collectNumbers([f.periodLabel, f.sessions, f.commits, f.tasks, f.usage, f.openQuestions, f.conflicts, f.buildsRed, f.needsYou], out);
    for (const split of [f.usage.today, f.usage.week, f.usage.prevWeek]) collectNumbers(split.claude + split.codex, out);
  }
  return out;
}

/** true = jede Zahl im Satz (auch Zahlwort oder Größenordnung) steht im Bericht. */
export function speechNumbersOk(written: string, allowed: Set<string>): boolean {
  return [...numbersIn(written)].every((n) => allowed.has(n));
}

// ───────────────────────────── Sprechfassung ─────────────────────────────

/** Einzahl/Mehrzahl als eigener Text (`{n}` im Text). */
const plural = (n: number, one: string, many: string, vars: Record<string, string | number> = {}) => t(n === 1 ? one : many, { n, ...vars });
const tokens = (n: number) => formatTokensCompact(n);
/** Satzende sicherstellen, ohne doppelte Zeichen. */
const period = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** Titel fürs Vorlesen: ohne Satzzeichen am Ende, höchstens ~70 Zeichen an einer Wortgrenze. */
function shortTitle(title: string, max = 70): string {
  const t = title.replace(/\s+/g, " ").replace(/[.!?:;,]+$/u, "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).trim();
}

/** Satz aus dem Bericht kürzen: an einem Komma/Wort, nicht mitten im Wort. */
function shortSentence(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf(","), cut.lastIndexOf(" – "));
  return period(cut.slice(0, at > 60 ? at : cut.lastIndexOf(" ")).trim());
}


/** die Kacheln in drei zusammenfassenden Sätzen (Arbeit, Verbrauch, Probleme) – Nulls fallen weg. */
export function figureSummary(f: BriefingFigures): [BriefSpeechTarget, string][] {
  const out: [BriefSpeechTarget, string][] = [];
  const { running, waiting, activeInPeriod: active, closedInPeriod: closed } = f.sessions;
  const nowText =
    running + waiting === 0
      ? t("Gerade arbeitet keine Session")
      : `${plural(running, "Gerade arbeitet {n} Session", "Gerade arbeiten {n} Sessions")}${waiting > 0 ? plural(waiting, ", {n} wartet", ", {n} warten") : ""}`;
  const periodText =
    active + closed > 0
      ? `${plural(active, "; {period} waren {n} Session aktiv", "; {period} waren {n} Sessions aktiv", { period: f.periodLabel })}${closed > 0 ? t(" und {n} sind fertig", { n: closed }) : ""}`
      : "";
  out.push([briefTileTarget("sessions_active"), `${nowText}${periodText}.`]);
  const today = f.usage.today.claude + f.usage.today.codex;
  const week = f.usage.week.claude + f.usage.week.codex;
  const usage =
    today > 0
      ? week > 0
        ? t("Heute wurden {today} Tokens verbraucht, in den letzten 7 Tagen {week}", { today: tokens(today), week: tokens(week) })
        : t("Heute wurden {today} Tokens verbraucht", { today: tokens(today) })
      : week > 0
        ? t("Heute noch kein Verbrauch, in den letzten 7 Tagen {week} Tokens", { week: tokens(week) })
        : "";
  const commits =
    f.commits.week > 0
      ? f.commits.today > 0
        ? plural(f.commits.week, "{n} Commit in 7 Tagen, {today} davon heute", "{n} Commits in 7 Tagen, {today} davon heute", { today: f.commits.today })
        : plural(f.commits.week, "{n} Commit in 7 Tagen", "{n} Commits in 7 Tagen")
      : "";
  if (usage || commits) out.push([briefTileTarget("usage_today"), `${[usage, commits].filter(Boolean).join(" – ")}.`]);
  const problems = [
    f.tasks.open > 0 ? plural(f.tasks.open, "{n} Auftrag offen", "{n} Aufträge offen") : "",
    f.buildsRed > 0 ? t(f.buildsRed === 1 ? "1 Build-Fehler" : "{n} Build-Fehler", { n: f.buildsRed }) : "",
    f.conflicts > 0 ? plural(f.conflicts, "{n} Konflikt zwischen Sessions", "{n} Konflikte zwischen Sessions") : "",
  ].filter(Boolean);
  if (problems.length > 0) out.push([briefTileTarget(f.buildsRed > 0 ? "server" : "tasks_open"), t("Sonst: {list}.", { list: problems.join(", ") })]);
  return out;
}

const GROUP_SECTION: Record<BriefGroup, BriefSpeechSection> = { lief: "lief", haengt: "haengt", naechstes: "naechstes" };
/** Je Gruppe höchstens so viele Sätze des Berichts (vorher 2/3/1 – zu knapp, nur Stichpunkte). */
const GROUP_LIMIT = 5;
/** „Braucht dich“: so viele Punkte einzeln, der Rest als Anzahl. */
const NEEDS_NAMED = 6;
/** deutsche Texte als Schlüssel, übersetzt beim Vorlesen */
const GROUP_EMPTY: Record<BriefGroup, string> = { lief: "Noch nichts gelaufen.", haengt: "Nichts hängt.", naechstes: "Nichts drängt." };

/**
 * Die Sprechfassung eines gespeicherten Berichts (Briefing oder Recap).
 * gegrüßt wird nach der JETZIGEN Uhrzeit (`now`, dieselbe Regel wie der Briefing-Kopf) – nicht mit dem
 * Gruß, der beim Schreiben galt (Kopf „Guten Abend“, gesprochen „Guten Morgen“).
 */
export function buildBriefingSpeech(report: HaikuReport, now: Date = new Date(), name?: string | null): BriefingSpeech {
  const allowed = reportNumbers(report);
  const sentences: BriefSpeechSentence[] = [];
  const add = (section: BriefSpeechSection, target: BriefSpeechTarget, written: string) => {
    const w = period(written);
    // Gleiche Prüfung wie bei Haikus Sätzen: eine Zahl, die nicht im Bericht steht, wird nie gesprochen.
    if (!speechNumbersOk(w, allowed)) return;
    const text = speakText(w);
    if (text.length > 3) sentences.push({ section, target, text, written: w });
  };

  // Kernaussage
  add("kernaussage", "headline", greetingLine(now, name));
  add("kernaussage", "headline", report.headline?.text ?? report.lage);

  // Braucht dich — JEDER Punkt (vorher nur zwei, der Rest fiel weg).
  const needs = report.needsYou;
  if (needs.length === 0) add("braucht_dich", "needs", t("Gerade wartet nichts auf dich."));
  else {
    add("braucht_dich", "needs", plural(needs.length, "{n} Punkt braucht dich.", "{n} Punkte brauchen dich."));
    const named = needs.slice(0, NEEDS_NAMED);
    named.forEach((item, i) => {
      const lead = i === 0 ? t("Zuerst") : i === named.length - 1 && needs.length <= NEEDS_NAMED ? t("Und zuletzt") : t("Dann");
      const title = shortTitle(item.title, 90);
      const line =
        item.minutes > 0
          ? t("{lead}: {title} – etwa {min} Min.", { lead, title, min: item.minutes })
          : item.zeroEnergy
            ? t("{lead}: {title} – ein Klick.", { lead, title })
            : t("{lead}: {title}.", { lead, title });
      add("braucht_dich", "needs", line);
    });
    if (needs.length > NEEDS_NAMED) add("braucht_dich", "needs", plural(needs.length - NEEDS_NAMED, "Dazu {n} weiterer Punkt in der Liste.", "Dazu {n} weitere Punkte in der Liste."));
  }

  // Kennzahlen — zusammengefasst in wenigen Sätzen statt jede Kachel einzeln; Graphen werden nicht
  // erklärt (der Nutzer sieht sie selbst). Die ausführliche, zusammenhängende Fassung schreibt Nyx (speechNarrative.ts).
  const f = report.figures;
  if (f) for (const [target, sentence] of figureSummary(f)) add("kennzahlen", target, sentence);

  // Was lief / Was hängt / Als Nächstes — die Sätze des Berichts, ganz (nicht nur der erste Stichpunkt)
  for (const g of ["lief", "haengt", "naechstes"] as const) {
    const statements = report.sections.filter((s) => briefGroupOf(s.title) === g).flatMap((s) => s.statements);
    const picked = statements.slice(0, GROUP_LIMIT);
    if (picked.length === 0) add(GROUP_SECTION[g], briefGroupTarget(g), `${t(BRIEF_GROUP_TITLE[g])}: ${t(GROUP_EMPTY[g])}`);
    for (const st of picked) add(GROUP_SECTION[g], briefGroupTarget(g), shortSentence(st.text, 240));
  }

  return { reportId: report.id, kind: report.kind, day: report.day, sentences, source: "daten" };
}

/** Gruß (nach der JETZIGEN Uhrzeit) + Nyx' eigene Sprechfassung. */
export function withNarration(base: BriefingSpeech, narrated: BriefSpeechSentence[], now: Date = new Date(), name?: string | null): BriefingSpeech {
  const g = period(greetingLine(now, name));
  return { ...base, sentences: [{ section: "kernaussage", target: "headline", text: speakText(g), written: g }, ...narrated], source: "nyx" };
}
