// Ehrlichkeits-Korrekturen am fertigen Antworttext (Funde aus echten Gesprächen):
// (1) Nach einer Freigabe-Karte versprach das Modell, die Aktion laufe nach dem Klick „von selbst“ (Prüfstand L5).
//     Das stimmt nicht: „Freigeben“ hält nur des Nutzers Entscheidung fest. Der Prompt sagt es, diese Prüfung
//     sichert es zusätzlich deterministisch ab (Freigaben erzwingt der Server, nicht der Prompt – D6).
// (5) Tippfehler bei Fachwörtern („startkllar“).

/** Der ehrliche Satz, der ein falsches Versprechen ersetzt (auch im Werkzeug-Ergebnis von `freigabe_anfragen`). */
export const APPROVAL_TRUTH = "Wichtig: Nach dem Freigeben passiert nichts von selbst – festgehalten ist nur deine Entscheidung, ausführen musst du es danach selbst oder die zuständige Session.";

/** Sätze, die eine automatische Ausführung nach dem Freigeben versprechen. */
const PROMISE_PATTERNS = [
  /(läuft|laufen|passiert|startet|geht)[^.!?\n]{0,40}\b(dann|danach|anschließend)\b[^.!?\n]{0,30}\b(direkt|automatisch|von selbst|von allein|sofort)/i,
  /\b(dann|danach|anschließend)\b[^.!?\n]{0,30}\b(läuft|laufen|passiert|startet)\b[^.!?\n]{0,30}\b(direkt|automatisch|von selbst|von allein|sofort)/i,
  /\b(dann|danach|anschließend)\s+(wird|werden)\s+[^.!?\n]{0,80}\b(geschlossen|gepusht|gemergt|gemerged|deployt|deployed|gelöscht|pausiert|ausgeführt|migriert|zusammengeführt)\b/i,
  /\b(sobald|wenn)\s+du\s+[^.!?\n]{0,40}\b(freigibst|bestätigst|klickst)\b[^.!?\n]{0,60}\b(wird|werden|läuft|passiert)\b[^.!?\n]{0,60}\b(geschlossen|gepusht|gemergt|deployt|gelöscht|ausgeführt|automatisch|von selbst)\b/i,
];

/**
 * Ersetzt Versprechen „läuft dann von selbst“ durch den ehrlichen Satz. Nur der betroffene Satzteil wird
 * geändert (nach einem Gedankenstrich der Nachsatz, sonst der ganze Satz); alles andere bleibt wörtlich.
 */
export function correctApprovalPromise(text: string): string {
  if (!PROMISE_PATTERNS.some((re) => re.test(text))) return text;
  // In Sätze teilen, Trennzeichen behalten.
  const parts = text.split(/(?<=[.!?])(\s+)/);
  let replaced = false;
  const out = parts.map((part) => {
    if (!PROMISE_PATTERNS.some((re) => re.test(part))) return part;
    // „Du kannst sie freigeben – der Push läuft dann direkt.“ → Vordersatz behalten.
    const dash = part.search(/\s[–—-]\s/);
    const head = dash > 0 ? part.slice(0, dash).trim() : "";
    const lead = head && !PROMISE_PATTERNS.some((re) => re.test(head)) ? `${head.replace(/[,;:]$/, "")}. ` : "";
    if (replaced) return lead.trim();
    replaced = true;
    return `${lead}${APPROVAL_TRUTH}`;
  });
  return out
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Fachwörter, deren Tippfehler (doppelter Buchstabe) sicher erkannt werden können. */
const DOMAIN_WORDS = ["startklar", "Freigabe", "Freigaben", "Session", "Sessions", "Auftrag", "Aufträge", "Inbox", "Briefing", "Worktree", "Deploy", "Einschätzung"];

function doubledVariants(word: string): RegExp {
  // Jeder Buchstabe darf fälschlich doppelt stehen („startkllar“, „Freigabbe“) – das Wort selbst bleibt unberührt.
  const letters = [...word].map((ch) => `${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{1,2}`).join("");
  return new RegExp(`(?<![\\p{L}])${letters}(?![\\p{L}])`, "gu");
}
const TYPO_RULES = DOMAIN_WORDS.map((w) => [doubledVariants(w), w] as const);

export function fixKnownTypos(text: string): string {
  let out = text;
  for (const [re, word] of TYPO_RULES) out = out.replace(re, (m) => (m.toLowerCase() === word.toLowerCase() ? m : m[0] === m[0]?.toUpperCase() ? word[0]?.toUpperCase() + word.slice(1) : word));
  return out;
}

// „Schick mir die Lage per Telegram“ → „Lage per Telegram geschrieben:“, obwohl Nyx kein
// Werkzeug zum Senden hat und Telegram nicht verbunden war. Nach außen geht eine Antwort nur, wenn die Frage selbst über
// Telegram kam (auch Sprachnachrichten dort) oder eine geplante Aufgabe über Telegram zustellt – das entscheidet
// `runNyxTurn` (turn.ts) und korrigiert dann gar nicht. Sonst ist jede Versand-Behauptung falsch und wird durch den
// ehrlichen Satz ersetzt – im fertigen Text UND im Live-Strom (`SendClaimStream`), damit sie auch nicht vorgelesen wird.
// keine Fehlalarme bei Sätzen über Dritte („Der Nutzer hat per Mail geschrieben“), Zitaten, Fragen, Verneinungen
// und Wörtern wie „Telegram-Modul“ (nur „Telegram-Nachricht/-Meldung“ zählt als Versand).

/** Der ehrliche Satz statt einer erfundenen Versand-Meldung. */
export const SEND_TRUTH = "Hinweis: Ich kann dir nichts per Telegram oder Mail schicken – die Antwort steht nur hier.";
/** Dasselbe auf Englisch (Nyx antwortet auf Englisch, wenn der Nutzer Englisch schreibt). */
export const SEND_TRUTH_EN = "Note: I can't send you anything via Telegram or email – the answer is only here.";

/** „Telegram“, „Mail“, „E-Mail“ – auch „Telegram-Nachricht“, aber nicht „Telegram-Modul“ oder „Mailadresse“. */
const TARGET = String.raw`(?<![\p{L}\d-])(?:Telegram|E-Mail|Email|Mail)(?:-?(?:Nachrichten|Nachricht|Meldungen|Meldung|message))?(?![\p{L}\d-])`;
const SENT_VERB = String.raw`(?:geschrieben|geschickt|gesendet|verschickt|zugeschickt|rausgeschickt|weitergeleitet|ist\s+raus|sind\s+raus|ging\s+raus|gingen\s+raus)`;
const SEND_CLAIMS_DE = [
  // „per Telegram geschickt“, auch „ist per Telegram raus“.
  new RegExp(String.raw`\b(?:per|über|via|in|an|nach)\s+(?:die\s+|deine?\s+)?${TARGET}[^.!?\n]{0,40}(?:${SENT_VERB}|\braus\b)`, "iu"),
  new RegExp(String.raw`${TARGET}[^.!?\n]{0,30}${SENT_VERB}`, "iu"),
];
const SEND_CLAIMS_EN = [
  new RegExp(String.raw`\b(?:sent|forwarded|messaged|emailed|texted)\b[^.!?\n]{0,40}\b(?:via|by|on|over|through|to)\s+(?:your\s+)?${TARGET}`, "iu"),
  new RegExp(String.raw`${TARGET}[^.!?\n]{0,20}\b(?:is|was|has\s+been|went)\s+(?:sent|out)\b`, "iu"),
];
/** Verneint („nicht“, „can't“) – dann ist es keine Behauptung, sondern schon die ehrliche Aussage. */
const NEGATION = /\b(?:nicht|nichts|kein|keine|keinen|nie|not|cannot|never)\b|\b(?:can|don|didn|won)['’]t\b/iu;
/** Satz über Dritte oder über der Nutzer („Der Nutzer hat per Mail geschrieben“, „du hast mir … geschickt“). */
const OTHERS = /\b(?:hat|hast|hatte|hattest|hatten|he|she|they)\b/iu;
/** Zitate zählen nicht (des Nutzers eigene Worte, Fremdtext). */
const QUOTED = /„[^“”"]*[“”"]|“[^”"]*[”"]|"[^"]*"|»[^«]*«|«[^»]*»/gu;

type ClaimState = { replaced: boolean };

/** Ersetzt die erste Versand-Behauptung durch den ehrlichen Satz und streicht weitere; Trenner bleiben stehen. */
function correctParts(text: string, state: ClaimState): string {
  return text
    .split(/((?<=[.!?:])[ \t]+|\n+)/)
    .map((part) => {
      const plain = part.replace(QUOTED, "");
      if (!plain.trim() || plain.trim().endsWith("?") || NEGATION.test(plain) || OTHERS.test(plain)) return part;
      const en = SEND_CLAIMS_EN.some((re) => re.test(plain));
      if (!en && !SEND_CLAIMS_DE.some((re) => re.test(plain))) return part;
      if (state.replaced) return "";
      state.replaced = true;
      return en ? SEND_TRUTH_EN : SEND_TRUTH;
    })
    .join("");
}

/**
 * Ersetzt erfundene Versand-Meldungen („Lage per Telegram geschrieben:“) durch {@link SEND_TRUTH}. Nur der betroffene
 * Satz bzw. die betroffene Zeile ändert sich; Fragen, verneinte Sätze, Sätze über Dritte, Zitate und der Kanal
 * `telegram` bleiben unberührt. Ob in dieser Runde wirklich etwas nach außen ging, prüft der Aufrufer (turn.ts).
 */
export function correctFalseSendClaim(text: string, channel: string): string {
  if (channel === "telegram") return text;
  const state: ClaimState = { replaced: false };
  const out = correctParts(text, state);
  return state.replaced
    ? out
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text;
}

/**
 * Dieselbe Korrektur im Live-Strom: hält nur den gerade unfertigen Satz zurück und gibt jeden fertigen Satz schon
 * korrigiert weiter – sonst stünde (und klänge, Stimme N3c) die erfundene Meldung schon da, bevor `done` sie ersetzt.
 * `active()` wird je Satz gefragt (aus, sobald in der Runde wirklich etwas über Telegram zugestellt werden kann).
 */
export class SendClaimStream {
  private buf = "";
  private readonly state: ClaimState = { replaced: false };
  constructor(private readonly active: () => boolean = () => true) {}

  /** Neuer Schnipsel → was davon jetzt (korrigiert) raus darf; der unfertige Satz wartet. */
  push(chunk: string): string {
    this.buf += chunk;
    let cut = -1;
    for (const m of this.buf.matchAll(/[.!?:](?=\s)|\n/g)) cut = m.index + m[0].length;
    if (cut < 0) return "";
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return this.active() ? correctParts(ready, this.state) : ready;
  }

  /** Ende des Stroms: den Rest (letzter Satz ohne Satzzeichen danach) ausgeben. */
  end(): string {
    const rest = this.buf;
    this.buf = "";
    return rest && this.active() ? correctParts(rest, this.state) : rest;
  }
}
