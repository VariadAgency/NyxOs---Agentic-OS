// Nyx-Denken: trennt Gedanken von der Antwort. Das Modell schreibt oft VOR einem Werkzeug-Aufruf ein paar Sätze
// („Ich prüfe erst …“, „Ah nee, doch nicht.“). Die gingen bisher als `delta` raus – angezeigt UND vorgelesen. Jetzt gilt:
// Text eines Abschnitts (zwischen zwei Werkzeug-Aufrufen) wird erst zurückgehalten. Kommt danach ein Werkzeug, war es ein
// Gedanke (`thought`, eingeklappt angezeigt, nie gesprochen); endet die Runde, ist es die Antwort. Beim ersten Werkzeug
// kommt genau EINE kurze Zwischenmeldung (`filler`, z. B. „Ich schau mir das mal an.“), die die Stimme sprechen darf.
import { messageLanguage } from "./prompt.js";

/** Ab so vielen Zeichen ohne Werkzeug ist der Abschnitt fast sicher die Antwort → ab dann live streamen. */
export const ANSWER_RELEASE_CHARS = 400;

export type GateEvent =
  | { type: "delta"; text: string }
  /** `retract`: dieser Text war schon als Antwort gestreamt und ist zurückzunehmen (Entwurf leeren). */
  | { type: "thought"; text: string; retract?: true }
  | { type: "filler"; text: string };

/**
 * (der Nutzer: „Ich weiß, ich gucke danach“, „Ich schau mir das mal an.“): ein ganzer, natürlicher Satz statt
 * „Ich schau mal.“. Fest je Frage (Hash), damit Wiederholungen gleich klingen, über viele Fragen abwechselnd.
 */
export const FILLERS = {
  de: ["Ich schau mir das mal an.", "Moment, ich schau kurz nach.", "Alles klar, ich guck da mal rein.", "Okay, ich schau gleich nach."],
  en: ["Let me take a look.", "One moment, let me check.", "Alright, let me look into that.", "Okay, checking now."],
} as const;

export function fillerFor(message: string): string {
  const list = FILLERS[messageLanguage(message)];
  let h = 0;
  for (const ch of message.trim()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return list[h % list.length] ?? list[0];
}

export class AnswerGate {
  private held = "";
  private streamed = "";
  private fillerSent = false;
  readonly thoughts: string[] = [];
  private readonly filler: string;
  private readonly releaseChars: number;

  constructor(o: { filler: string; releaseChars?: number }) {
    this.filler = o.filler;
    this.releaseChars = o.releaseChars ?? ANSWER_RELEASE_CHARS;
  }

  /** Neuer Text-Schnipsel des Modells. */
  push(text: string): GateEvent[] {
    if (!text) return [];
    if (this.streamed) {
      this.streamed += text;
      return [{ type: "delta", text }];
    }
    this.held += text;
    if (this.held.length < this.releaseChars) return [];
    const out = this.held;
    this.streamed = out;
    this.held = "";
    return [{ type: "delta", text: out }];
  }

  /** Das Modell ruft ein Werkzeug: der bisherige Abschnitt war Denken. */
  tool(): GateEvent[] {
    const out: GateEvent[] = [];
    const segment = (this.streamed || this.held).trim();
    if (segment) {
      this.thoughts.push(segment);
      out.push(this.streamed ? { type: "thought", text: segment, retract: true } : { type: "thought", text: segment });
    }
    this.held = "";
    this.streamed = "";
    if (!this.fillerSent) {
      this.fillerSent = true;
      out.push({ type: "filler", text: this.filler });
    }
    return out;
  }

  /** Runde fertig: der zurückgehaltene letzte Abschnitt ist die Antwort. */
  end(): GateEvent[] {
    const rest = this.held;
    this.held = "";
    if (!rest) return [];
    this.streamed += rest;
    return [{ type: "delta", text: rest }];
  }

  /**
   * bisher geschriebene Antwort bei einem Abbruch (nach `end()`): nur der Abschnitt nach dem letzten
   * Werkzeug. Anders als `answer()` KEIN Rückfall auf Gedanken – ein Gedanke gehört nie als Antwort in den Faden.
   */
  partial(): string {
    return (this.streamed + this.held).trim();
  }

  /** Endtext ohne Gedanken: Motoren, die alle Runden zusammen liefern (Reserve-API), schneiden hier die Gedanken ab. */
  answer(finalText: string): string {
    let text = finalText;
    for (const t of this.thoughts) {
      const trimmed = text.trimStart();
      if (trimmed.startsWith(t)) text = trimmed.slice(t.length);
    }
    // Bestand der Endtext nur aus Gedanken (Modell hörte nach dem Werkzeug auf), lieber ihn zeigen als nichts.
    return text.trim() || finalText.trim();
  }
}
