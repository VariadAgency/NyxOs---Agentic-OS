// Gemeinsam für Begleiter und Nyx-Tab: Wann bist du fertig mit Reden, und hört Nyx sich gerade
// selbst? Übernommen und angepasst aus adewaskar/jarvis `src/lib/voice.ts` (`holdFor`, `makeAssembler`, `isEcho`,
// `SELF_GUARD_MS`; MIT, © 2026 Aditya Dewaskar, s. NOTICE). Geändert: deutsche Füll-/Bindewörter, Umlaute bleiben
// beim Vergleich erhalten (das Original löschte sie), Wortgrenzen ohne `\b` (in JS kennt `\b` keine Umlaute).
// Die Wortlisten gibt es auf Deutsch und Englisch; welche gilt, folgt der eingestellten Sprache (`getLang()`).
import { getLang } from "@nyxos/shared";

const en = () => getLang() === "en";

/** Barge-in so kurz nach Nyx' eigenem Satzbeginn ist sein Echo, nicht du. */
export const SELF_GUARD_MS = 350;
/** Fertig wirkender Satz ohne Satzzeichen: so lange auf mehr warten. */
export const SETTLE_MS = 250;
/** Offensichtlich unfertig („… und“): so lange warten. */
export const CONTINUE_MS = 1600;
/** Obergrenze, egal wie unfertig. */
export const MAX_HOLD_MS = 6000;
/** Nach Nyx' letztem Wort gilt ein Treffer noch so lange als mögliches Echo. */
export const ECHO_TAIL_MS = 1800;

/** Endet der Text auf eines dieser Wörter, ist der Satz nicht fertig. */
const CONTINUES_DE =
  /(?:^|\s)(und|oder|aber|denn|weil|dass|ob|wenn|als|wie|damit|sodass|also|dann|der|die|das|den|dem|des|ein|eine|einen|einem|einer|mein|meine|dein|sein|ihr|unser|zu|zum|zur|von|vom|mit|für|auf|an|am|in|im|bei|nach|über|unter|aus|ist|sind|war|hat|habe|haben|kann|soll|will|muss|noch|auch|mal|bitte|äh|ähm)$/iu;

const CONTINUES_EN =
  /(?:^|\s)(and|or|but|because|since|that|if|whether|when|as|like|so|then|the|a|an|my|your|his|her|our|their|this|these|to|of|from|with|for|on|at|in|by|about|into|over|under|is|are|was|were|has|have|had|can|should|will|would|must|also|please|uh|um|erm)$/iu;

/** Satzzeichen, die eine Erkennung mitten im Gedanken ausgibt. */
const TRAILS = /[,;:–—-]$|\.\.\.$|…$/;

/** Kurze Befehle, die trotz 1–2 Wörtern fertig sind — und die immer durch den Echo-Filter kommen. */
export const OVERRIDE_DE = /(?:^|[^\p{L}])(stopp|stop|halt|warte|moment|nyx|abbrechen|lass gut sein|vergiss es|nein|ruhe|leiser|weiter|zurück|danke|ja)(?![\p{L}])/iu;
export const OVERRIDE_EN = /(?:^|[^\p{L}])(stop|halt|wait|hold on|nyx|cancel|never mind|forget it|no|quiet|be quiet|shut up|quieter|continue|go on|back|thanks|thank you|yes)(?![\p{L}])/iu;
const override = () => (en() ? OVERRIDE_EN : OVERRIDE_DE);

/** Wie lange nach diesem Textstück auf mehr gewartet wird (0 = sofort senden). */
export function holdFor(text: string): number {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return CONTINUE_MS;
  if (/[.!?]$/.test(t) && !TRAILS.test(t)) return 0;
  if (TRAILS.test(t)) return CONTINUE_MS;
  if ((en() ? CONTINUES_EN : CONTINUES_DE).test(t)) return CONTINUE_MS;
  if (words.length <= 2 && !override().test(t)) return CONTINUE_MS;
  return SETTLE_MS;
}

/** Wörter, die nichts beweisen (zu häufig). */
const STOP_DE = new Set(
  (
    "der die das den dem des ein eine einen einem einer und oder aber so zu zum zur von vom in im an am auf aus bei mit nach " +
    "für über unter ist sind war waren sein bin bist hat habe haben wird werden es er sie wir ihr ich du mich dich mir dir uns euch " +
    "dein mein sein unser was wer wie wo wann warum ob wenn dann als noch schon auch nur mal jetzt hier da dort gerade eben " +
    "ja nein nicht kein keine okay ok gut also bitte gerne"
  ).split(" "),
);
const STOP_EN = new Set(
  (
    "the a an and or but so to of from in on at by with for about into over under is are was were be been am has have had " +
    "will would can could should it he she we they you i me my your his her our their us them this that these those what who " +
    "how where when why if then than also just now here there yes no not okay ok good well please sure"
  ).split(" "),
);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hat das Mikro gerade Nyx' eigene Stimme gehört (≥ 60 % der Inhaltswörter gleich)? */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false;
  if (override().test(heard)) return false;
  const all = norm(heard).split(" ").filter(Boolean);
  if (all.length === 0) return true;
  const mine = new Set(norm(spoken).split(" "));
  const stop = en() ? STOP_EN : STOP_DE;
  const content = all.filter((w) => !stop.has(w));
  // Nichts Unterscheidbares gesagt: nur bei völliger Übereinstimmung verwerfen — eine echte Frage zu
  // verlieren kostet mehr als ein durchgerutschtes Echo.
  if (content.length < 2) {
    if (all.length < 2) return false;
    return all.every((w) => mine.has(w));
  }
  let hits = 0;
  for (const w of content) if (mine.has(w)) hits++;
  return hits / content.length >= 0.6;
}

/**
 * Typische Phantom-Texte der Erkennung bei Geräuschen ohne Sprache (Whisper „halluziniert“ sie bei Straße, Vögeln,
 * Musik, Rauschen). Sie dürfen Nyx nie unterbrechen.
 */
const PHANTOM_DE =
  /^(?:untertitel(?:ung)?\b.*|.*amara\.org.*|vielen dank(?: für(?:s)? (?:zuschauen|zuhören))?|danke(?: schön)?|tschüss|(?:\[|\(|\*)?\s*(?:musik|applaus|lachen|stille|geräusch|geräusche|rauschen|piepen|vogel(?:gezwitscher)?)\s*(?:\]|\)|\*)?|bis zum nächsten mal|copyright.*|swr \d+|mh+|hm+|äh+|ähm+|oh+|ah+)$/iu;

const PHANTOM_EN =
  /^(?:subtitles?\b.*|.*amara\.org.*|thank you(?: (?:so much|very much))?(?: for watching)?|thanks for watching|bye|you|(?:\[|\(|\*)?\s*(?:music|applause|laughter|laughing|silence|noise|static|beep|birds?(?: chirping)?)\s*(?:\]|\)|\*)?|see you next time|copyright.*|mh+|hm+|uh+|um+|oh+|ah+)$/iu;

/** Phantom-Text der Erkennung (bei Geräuschen ohne Sprache) – nie als Frage oder Unterbrechung werten. */
export function isPhantom(heard: string): boolean {
  const t = heard.trim().replace(/[.!?,;:…"„“]+$/u, "").trim();
  return !t || (en() ? PHANTOM_EN : PHANTOM_DE).test(t);
}

/** Ein einzelnes Wort, das Nyx trotzdem sofort stoppen darf. */
const STOP_CMD_DE = /^(?:(?:hey |ok )?nyx[, ]*)?(?:stopp|stop|halt|warte|moment|abbrechen|ruhe|leiser|sei still)$/iu;
const STOP_CMD_EN = /^(?:(?:hey |ok )?nyx[, ]*)?(?:stop|halt|wait|hold on|cancel|quiet|be quiet|shut up|enough)$/iu;

/**
 * Live-Test Safari: Reicht das Gehörte, um Nyx zu UNTERBRECHEN? Nur echte Worte: mindestens zwei Wörter
 * (oder ein klarer Befehl wie „Stopp“), kein Phantom-Text der Erkennung, kein Echo der eigenen Stimme. Geräusche
 * (Straße, Vogel, Klappern) lösen so nie mehr einen Abbruch aus – Nyx denkt bzw. spricht weiter.
 */
export function isRealSpeech(heard: string, spoken = ""): boolean {
  if (isPhantom(heard)) return false;
  const t = heard.trim().replace(/[.!?,;:…"„“]+$/u, "").trim();
  if ((en() ? STOP_CMD_EN : STOP_CMD_DE).test(t)) return true;
  const words = norm(t).split(" ").filter((w) => w.length > 0);
  if (words.length < 2) return false;
  return !isEcho(heard, spoken);
}

/**
 * Was du tatsächlich gehört hast: alle ganz abgespielten Sätze plus vom laufenden Satz den abgespielten
 * Anteil (in ganzen Wörtern, mit „…“). So speichert der Verlauf nach einer Unterbrechung nur Gehörtes.
 */
export function heardText(done: readonly string[], current: { text: string; fraction: number } | null): string {
  const parts = done.map((s) => s.trim()).filter(Boolean);
  if (current && current.fraction > 0) {
    const words = current.text.trim().split(/\s+/).filter(Boolean);
    const n = Math.floor(words.length * Math.min(1, current.fraction));
    if (n >= words.length) parts.push(current.text.trim());
    else if (n > 0) parts.push(`${words.slice(0, n).join(" ")} …`);
  }
  return parts.join(" ");
}

export interface Assembler {
  /** Neues Stück Text; `active` = du redest gerade schon weiter. */
  feed(text: string, active: boolean): void;
  flush(): void;
  cancel(): void;
  held(): string;
}

/** Setzt Sprach-Stücke zu einem Gedanken zusammen und schickt ihn erst ab, wenn er fertig wirkt. */
export function makeAssembler(h: { emit: (text: string) => void; partial?: (text: string) => void }): Assembler {
  let held = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    clear();
    const text = held.trim();
    held = "";
    firstAt = 0;
    if (text) h.emit(text);
  };
  return {
    feed(text, active) {
      if (!text.trim()) return;
      held = `${held} ${text}`.replace(/\s+/g, " ").trim();
      if (!firstAt) firstAt = Date.now();
      h.partial?.(held);
      clear();
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS);
        return;
      }
      const wait = Math.min(holdFor(held), Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)));
      if (wait === 0) fire();
      else timer = setTimeout(fire, wait);
    },
    flush: fire,
    cancel() {
      clear();
      held = "";
      firstAt = 0;
    },
    held: () => held,
  };
}
