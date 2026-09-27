// Nyx-Farbfolge: blau, dann rot, dann orange mit der Such-Animation, dann grün – ohne Flackern.
// Die rohen Zustände (Server `nyx.state`, Strom-Ereignisse status/tool/delta/done, Stimme an/aus) wechseln oft in
// Millisekunden. Diese Folge macht daraus eine ruhige, sichtbare Abfolge, die in Leiste, Nyx-Feld und Nyx-Tab gleich ist:
//   blau (hört zu / Eingabe) → rot (denkt nach) → orange (Werkzeug, sucht sich Punkte aus dem Netz) → grün (antwortet)
//   → lila (fertig, ruht).
// Regeln:
//   • Jeder sichtbare Zustand bleibt mindestens `NYX_MIN_DWELL_MS` stehen (kein Flackern).
//   • Die Werkzeug-Phase läuft immer volle Such-Runden (`NYX_TOOL_ROUND_MS`) – auch wenn die Antwort schon beginnt,
//     geht es erst am Ende der Runde nach grün.
//   • Blau heißt nur: du sprichst (beim Tippen leuchtet Nyx nicht blau auf).
//   • Die Werkzeug-Phase einer Frage bricht nicht ab (sonst live gemessen: orange → 0,8 s rot → grün):
//     „denkt“ zwischen zwei Werkzeugen und bis die echte Antwort kommt, bleibt orange mit dem letzten Werkzeug.
//     Erst die Antwort (grün, langsam eingeblendet: `NYX_SPEAK_BLEND_MS`), Zuhören oder Ruhe beenden sie.
//   • Zwischenzustände, die nichts bedeuten (z. B. ein kurzes „denkt“ zwischen zwei Sätzen), werden übersprungen;
//     Denken vor der Antwort, Werkzeug-Runden und die Antwort bleiben in der Warteschlange (höchstens `MAX_QUEUE`,
//     damit nichts nachhinkt).
// Reine Funktionen mit übergebener Uhrzeit (testbar ohne Zeitgeber), dazu ein kleiner Hook für React.
import { useEffect, useState } from "react";
import type { NyxVisualState } from "./netModel";

export interface NyxVisualStep {
  state: NyxVisualState;
  tool: string | null;
}

/** Eine Runde der Such-Animation (Aura-Punkte werden angezogen, Netz-Knoten leuchten auf) in ms. */
export const NYX_TOOL_ROUND_MS = 1600;

/** So lange bleibt ein Zustand mindestens sichtbar (ms). Werkzeug: volle Runden, siehe `NYX_TOOL_ROUND_MS`. */
export const NYX_MIN_DWELL_MS: Record<NyxVisualState, number> = {
  idle: 0,
  listening: 400,
  thinking: 800,
  tool: NYX_TOOL_ROUND_MS,
  speaking: 700,
};

/** So lange blendet Nyx nach grün über (Tab, Aura, 3D-Netz) – „langsam grün“, kein Sprung. */
export const NYX_SPEAK_BLEND_MS = 1400;

/** Ab so langer Ruhe (ms) ist die Frage vorbei und eine laufende Werkzeug-Phase beendet (kürzer = nur ein Blip). */
const IDLE_ENDS_TOOL_PHASE_MS = 250;

/** Mehr wartende Schritte zeigt Nyx nicht nach (zehn schnelle Werkzeuge ≠ 16 s Orange nach der Antwort). */
const MAX_QUEUE = 3;

interface Queued extends NyxVisualStep {
  /** Wann der rohe Zustand kam (ms). */
  at: number;
  /** Bleibt in der Warteschlange, auch wenn Neueres kommt (Werkzeug-Runde, Antwort, kurzes Blau beim Absenden). */
  keep: boolean;
}

export interface NyxSequence {
  shown: NyxVisualStep;
  /** Seit wann `shown` sichtbar ist (ms). */
  since: number;
  queue: Queued[];
  /** Letzter roher Zustand (nur neue Werte zählen). */
  raw: NyxVisualStep;
  /** Werkzeug der laufenden Werkzeug-Phase (null = keine): „denkt“ zählt dann als dieses Werkzeug. */
  toolPhase: string | null;
}

const same = (a: NyxVisualStep, b: NyxVisualStep) => a.state === b.state && (a.state !== "tool" || a.tool === b.tool);
export function nyxSequenceStart(raw: NyxVisualStep, now: number): NyxSequence {
  const step = { state: raw.state, tool: raw.state === "tool" ? raw.tool : null };
  return { shown: step, since: now, queue: [], raw: step, toolPhase: step.state === "tool" ? step.tool : null };
}

/** Ein neuer roher Zustand kommt an. Gibt eine neue Folge zurück (die alte bleibt unverändert). */
export function nyxSequenceInput(seq: NyxSequence, input: NyxVisualStep, now: number): NyxSequence {
  let raw: NyxVisualStep = { state: input.state, tool: input.state === "tool" ? input.tool : null };
  let toolPhase = seq.toolPhase;
  // Ruhe, die länger als ein Blip anhielt, war das Ende der Frage (z. B. Fehler ohne Antwort, noch in der
  // Such-Runde) – die nächste getippte Frage beginnt dann rot, nicht im alten Orange.
  const idle = seq.raw.state === "idle" ? seq.queue.at(-1) : undefined;
  if (idle?.state === "idle" && now - idle.at >= IDLE_ENDS_TOOL_PHASE_MS) toolPhase = null;
  if (raw.state === "tool") toolPhase = raw.tool ?? toolPhase ?? "";
  else if (raw.state === "thinking" && toolPhase !== null) raw = { state: "tool", tool: toolPhase || null };
  else if (raw.state === "speaking" || raw.state === "listening") toolPhase = null;
  // (Ruhe beendet die Phase erst, wenn sie wirklich sichtbar wird – ein kurzer Blip mitten im Werkzeug zählt nicht.)
  if (same(raw, seq.raw)) return toolPhase === seq.toolPhase ? seq : { ...seq, toolPhase };
  let queue = [...seq.queue];
  // Wer zuhört, braucht nicht auf alte Werkzeug-Runden zu warten – nur die laufende endet noch.
  if (raw.state === "listening") queue = [];
  // Unwichtige Zwischenschritte fallen weg, wenn schon wieder etwas Neues kommt.
  while (queue.length > 0 && !queue[queue.length - 1]?.keep) queue.pop();
  const last = queue.at(-1) ?? seq.shown;
  if (!same(raw, last)) {
    // „Denkt“ vor der Antwort gehört zur Folge (rot); „denkt“ zwischen zwei Sätzen ist nur eine Lücke.
    const keep = raw.state === "tool" || raw.state === "speaking" || (raw.state === "thinking" && last.state !== "speaking");
    queue.push({ ...raw, at: now, keep });
  }
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  return nyxSequenceAdvance({ ...seq, queue, raw, toolPhase }, now);
}

/** Frühester Zeitpunkt, an dem `shown` dem nächsten Schritt weichen darf. */
function dueAt(seq: NyxSequence, next: Queued): number {
  const min = NYX_MIN_DWELL_MS[seq.shown.state];
  if (seq.shown.state !== "tool") return seq.since + min;
  // Werkzeug: die Runde, in der der nächste Schritt ankam, läuft zu Ende (mindestens eine ganze Runde).
  const rounds = Math.max(1, Math.ceil((next.at - seq.since) / NYX_TOOL_ROUND_MS));
  return seq.since + rounds * NYX_TOOL_ROUND_MS;
}

/** Die Folge bis `now` weiterschalten. */
export function nyxSequenceAdvance(seq: NyxSequence, now: number): NyxSequence {
  let cur = seq;
  for (;;) {
    const next = cur.queue[0];
    if (!next) return cur;
    const due = dueAt(cur, next);
    if (due > now) return cur;
    const toolPhase = next.state === "idle" ? null : cur.toolPhase;
    cur = { ...cur, shown: { state: next.state, tool: next.tool }, since: Math.max(due, next.at), queue: cur.queue.slice(1), toolPhase };
  }
}

/** Wann sich die Anzeige als Nächstes ändert (ms) – null = erst beim nächsten rohen Zustand. */
export function nyxSequenceNextAt(seq: NyxSequence): number | null {
  const next = seq.queue[0];
  return next ? dueAt(seq, next) : null;
}

/**
 * Hook: roher Zustand rein, ruhiger sichtbarer Zustand raus (Leiste, Nyx-Feld, Nyx-Tab).
 * `now` ist austauschbar (Tests); Standard ist `Date.now`, das auch Vitests künstliche Uhr bedient.
 */
export function useNyxVisualSequence(state: NyxVisualState, tool: string | null, now: () => number = Date.now): NyxVisualStep {
  const [seq, setSeq] = useState(() => nyxSequenceStart({ state, tool }, now()));
  useEffect(() => {
    setSeq((s) => nyxSequenceInput(s, { state, tool }, now()));
  }, [state, tool, now]);
  const at = nyxSequenceNextAt(seq);
  useEffect(() => {
    if (at === null) return;
    const t = setTimeout(() => setSeq((s) => nyxSequenceAdvance(s, now())), Math.max(0, at - now()));
    return () => clearTimeout(t);
  }, [at, now]);
  return seq.shown;
}
