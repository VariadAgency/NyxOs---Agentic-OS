// Aus der vollen Antwort (Markdown) wird die kurze, sprechbare Fassung `speak` für Stimme
// und Telegram-Sprachnachrichten. Regex-Folge übernommen aus Hermes Agent `tools/tts_text_normalize.py`
// (`strip_markdown_for_tts`, `normalize_symbols_for_tts`; MIT, © 2025 Nous Research, s. NOTICE),
// Abkürzungen auf Deutsch umgestellt.
//: Ziffern, Beträge, Prozent, Einheiten und Uhrzeiten bleiben hier UNVERÄNDERT. Die Stimme
// (infra/nyx-voice/nyx_voice/text_de.py bzw. text_en.py) spricht sie je Satz auf Deutsch oder Englisch richtig aus –
// „1.809 Dollar“ hätte die englische Stimme sonst falsch gelesen, „0,98 Euro“ die deutsche als „null Komma …“.

const CODE_BLOCK = /```[\s\S]*?```/g;
const IMAGE = /!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g;
const LINK = /\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g;
const URL = /https?:\/\/\S+/g;
const INLINE_CODE = /`([^`]+)`/g;
const BOLD = /\*\*(.+?)\*\*/gs;
const UNDERSCORE_BOLD = /__(.+?)__/gs;
const ITALIC = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs;
const STRIKE = /~~(.+?)~~/gs;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const BLOCKQUOTE = /^\s*>\s?/gm;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/gm;
const HR = /^\s*[-*_]{3,}\s*$/gm;
const TABLE_PIPE = /\s*\|\s*/g;
/** Quellen-Nummern aus dem Chat („[1]“) und nicht aufgelöste Marker („[[session:…]]“). */
// Nyx-Prüfung G02/G17: Listen „[1], [2], [3]“ bzw. „[1] und [2]“ als Ganzes, sonst bleibt „Sessions,,.“ / „warten und.“ stehen.
const SOURCE_ONE = String.raw`\[\[[^\]]*\]\]|\[\d{1,2}\]`;
const SOURCE_NUM = new RegExp(String.raw`\s?(?:${SOURCE_ONE})(?:\s*(?:,|und|oder|and|or|&)?\s*(?:${SOURCE_ONE}))*`, "g");
const EMOJI = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0E}|\u{FE0F}/gu;

/** Abkürzungen, die eine Stimme falsch vorliest (Punkt ≠ Satzende). */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bz\.\s?B\./g, "zum Beispiel"],
  [/\bd\.\s?h\./g, "das heißt"],
  [/\bu\.\s?a\./g, "unter anderem"],
  [/\bu\.\s?U\./g, "unter Umständen"],
  [/\bbzw\./g, "beziehungsweise"],
  [/\bca\./g, "circa"],
  [/\bevtl\./g, "eventuell"],
  [/\bggf\./g, "gegebenenfalls"],
  [/\binkl\./g, "inklusive"],
  [/\bzzgl\./g, "zuzüglich"],
  [/\busw\./g, "und so weiter"],
  [/\bvgl\./g, "vergleiche"],
  [/\bNr\./g, "Nummer"],
  [/\bStd\./g, "Stunden"],
  [/\bMin\./g, "Minuten"],
  [/\bMio\./g, "Millionen"],
  [/\bMrd\./g, "Milliarden"],
  [/\bTsd\./g, "Tausend"],
];

/** Nur Aufzählungszeichen; Zahlen, Währungen, Einheiten, „→“, „≈“, „~“ und „&“ liest die Stimme je Sprache selbst. */
const SYMBOLS: [RegExp, string][] = [
  [/[•◦▪▫]/g, " "],
  // „„Billing relevance“ → Audit?“ las die Stimme als Zeichen vor
  [/\s*(?:→|->|⇒)\s*/g, " nach "],
  [/\s*(?:←|<-)\s*/g, " von "],
  // „Freigaben (2):“ → „Freigaben:“ (die Zahl steht im Satz davor)
  [/\s*\(\d+\)(?=\s*:)/g, ""],
];

/** Markdown/Formatierung entfernen, Wörter behalten (Hermes `strip_markdown_for_tts`). */
export function stripMarkdownForSpeech(text: string): string {
  if (!text) return "";
  return text
    .replace(CODE_BLOCK, " ")
    .replace(IMAGE, (_m, alt: string) => (alt ? ` ${alt} ` : " "))
    .replace(LINK, "$1")
    .replace(URL, "")
    .replace(SOURCE_NUM, "")
    .replace(INLINE_CODE, "$1")
    .replace(BOLD, "$1")
    .replace(UNDERSCORE_BOLD, "$1")
    .replace(ITALIC, "$1")
    .replace(STRIKE, "$1")
    .replace(HEADING, "$1:")
    .replace(BLOCKQUOTE, "")
    .replace(LIST_ITEM, "")
    .replace(HR, "")
    .replace(TABLE_PIPE, "; ");
}

export function normalizeForSpeech(text: string): string {
  let out = text.replace(/[\u00a0\u2009\u202f]/g, " ").replace(/\u2212/g, "-").replace(/\u2026/g, "...");
  for (const [re, word] of ABBREVIATIONS) out = out.replace(re, word);
  for (const [re, word] of SYMBOLS) out = out.replace(re, word);
  return out.replace(EMOJI, "");
}

const MAX_SENTENCES = 3;
const MAX_CHARS = 320;

/**
 * Kurze, sprechbare Fassung: ohne Markdown/Links/Emojis, Abkürzungen ausgeschrieben, höchstens drei Sätze bzw.
 * 320 Zeichen (Persona: „meist ein bis zwei Sätze“ – Details stehen im Text daneben).
 */
export function toSpeakText(markdown: string): string {
  const flat = normalizeForSpeech(stripMarkdownForSpeech(markdown))
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;]$/.test(l) ? l : `${l}.`))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/:\./g, ":")
    .trim();
  if (!flat) return "";
  // Satzgrenze: Punkt/!/? gefolgt von Leerzeichen und einem Großbuchstaben/Zahl – „am 3. Oktober“ bleibt heil.
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9„"])/);
  let out = "";
  for (const s of sentences.slice(0, MAX_SENTENCES)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > MAX_CHARS) break;
    out = next;
  }
  if (!out) {
    const cut = flat.lastIndexOf(" ", MAX_CHARS - 1);
    out = `${flat.slice(0, cut > 40 ? cut : MAX_CHARS - 1)}…`;
  }
  return out;
}
