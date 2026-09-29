// Antwort-Text → einzelne, sprechbare Sätze (während Nyx noch schreibt).
//
// Idee und Regeln aus adewaskar/jarvis `src/lib/tts.ts` `createSpeaker.push` + `shape` (MIT, © 2026 Aditya
// Dewaskar, s. NOTICE): fertige Sätze sofort heraus, Abkürzungen sind kein Satzende, lange Absätze ohne
// Punkt nach ~220 Zeichen am Wortende schneiden, Markdown/Links vor dem Sprechen entfernen.
// Neu geschrieben für Deutsch (z. B., d. h., Datumsangaben „25.09.“, Ordinalzahlen) und Englisch (e.g., i.e., Mr.),
// ohne Faltfehler bei mehreren Abkürzungen hintereinander. Die Sprache folgt `getLang()`.
import { getLang } from "@nyxos/shared";


const SENTENCE_END = /([.!?…]["'“”’)\]]?\s)|(\n\n)/g;
const ABBREVIATION_DE =
  /(?:^|\s)(?:z\.\s?b|d\.\s?h|u\.\s?a|o\.\s?ä|u\.\s?u|s\.\s?o|s\.\s?u|bzw|ca|evtl|ggf|inkl|zzgl|usw|etc|vgl|nr|dr|prof|hr|fr|str|min|max|std|mio|mrd|jan|feb|mär|apr|jun|jul|aug|sep|sept|okt|nov|dez|bspw|sog|allg)\.$/iu;
const ABBREVIATION_EN =
  /(?:^|\s)(?:e\.\s?g|i\.\s?e|a\.\s?m|p\.\s?m|u\.\s?s|vs|etc|approx|incl|mr|mrs|ms|dr|prof|sr|jr|st|mt|no|inc|ltd|co|dept|fig|min|max|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/iu;
/** Einzelner Buchstabe („z.“, „B.“) oder Zahl/Datum („3.“, „25.09.“) vor dem Punkt. */
const LETTER_OR_NUMBER = /(?:^|[\s(])(?:\p{L}|[\d.]{1,10})\.$/u;
/** Englisch: nur ein einzelner Buchstabe („U.“ in „U.S.“) – eine Zahl vor dem Punkt ist dort ein echtes Satzende. */
const LETTER_ONLY = /(?:^|[\s(])\p{L}\.$/u;
const MAX_UNSPOKEN = 220;

/** Entfernt, was eine Stimme nicht vorlesen soll (Markdown, Links, Quellen-Marker). */
export function shapeForSpeech(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/^\s*(?:Quellen?|Sources?):.*$/gim, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function isFalseEnd(candidate: string): boolean {
  const c = candidate.trimEnd();
  if (getLang() === "en") return ABBREVIATION_EN.test(c) || LETTER_ONLY.test(c);
  return ABBREVIATION_DE.test(c) || LETTER_OR_NUMBER.test(c);
}

export interface SentenceChunker {
  push(delta: string): void;
  /** Rest ausgeben (Antwort fertig). */
  end(): void;
  reset(): void;
}

export function createSentenceChunker(emit: (sentence: string) => void): SentenceChunker {
  let buffer = "";
  const out = (s: string) => {
    const shaped = shapeForSpeech(s);
    if (shaped && /[\p{L}\p{N}]/u.test(shaped)) emit(shaped);
  };
  return {
    push(delta) {
      buffer += delta;
      let from = 0;
      for (;;) {
        SENTENCE_END.lastIndex = from;
        const m = SENTENCE_END.exec(buffer);
        if (!m) break;
        const cut = m.index + m[0].length;
        if (isFalseEnd(buffer.slice(0, m.index + 1))) {
          from = cut;
          continue;
        }
        out(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
        from = 0;
      }
      if (buffer.length > MAX_UNSPOKEN) {
        const cut = buffer.lastIndexOf(" ", MAX_UNSPOKEN);
        if (cut > 40) {
          out(buffer.slice(0, cut));
          buffer = buffer.slice(cut);
        }
      }
    },
    end() {
      if (buffer.trim()) out(buffer);
      buffer = "";
    },
    reset() {
      buffer = "";
    },
  };
}
