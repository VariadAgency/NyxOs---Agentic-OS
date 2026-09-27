// EIN Zustandswort für Nyx – Nyx-Tab, Nyx-Zentrum und Nyx-Leiste sagen dasselbe.
// Vorher sagte der Tab „ruht“, während das Zentrum gleichzeitig „Bereit“ zeigte.
// Regel: Tut Nyx gerade etwas, zählt die Tätigkeit („hört zu“, „denkt nach“, „spricht“, „arbeitet“); sonst der
// Motor („bereit“, „nicht verbunden“, „aus“, „gestört“). Ob das Mikro im Tab gerade offen ist, zeigt der
// Mikro-Knopf selbst – das ist kein Zustand von Nyx.
import { t, type HaikuEngineState, type NyxState } from "@nyxos/shared";

export type NyxWordTone = "ready" | "listening" | "thinking" | "speaking" | "tool" | "wait" | "off" | "bad" | "unknown";

export interface NyxWord {
  /** Das Wort, klein geschrieben (steht hinter „Nyx“ oder allein in der Pille). */
  word: string;
  tone: NyxWordTone;
  /** Textfarbe (Tailwind-Klasse aus den Tokens --a-*). */
  text: string;
  /** Punktfarbe (Tailwind-Klasse aus den Tokens --a-*). */
  dot: string;
  /** Nyx ist gerade beschäftigt (Tätigkeit statt Ruhe). */
  active: boolean;
}

const ACTIVITY: Record<Exclude<NyxState, "idle">, NyxWord> = {
  // Dieselben Farben wie Aura und Netz (blau → rot → orange → grün).
  listening: { word: t("hört zu"), tone: "listening", text: "text-a-nyx-listen", dot: "bg-a-nyx-listen", active: true },
  thinking: { word: t("denkt nach"), tone: "thinking", text: "text-a-nyx-think", dot: "bg-a-nyx-think", active: true },
  speaking: { word: t("spricht"), tone: "speaking", text: "text-a-nyx-speak", dot: "bg-a-nyx-speak", active: true },
  tool: { word: t("arbeitet"), tone: "tool", text: "text-a-nyx-tool", dot: "bg-a-nyx-tool", active: true },
};

const ENGINE: Record<HaikuEngineState, NyxWord> = {
  ready: { word: t("bereit"), tone: "ready", text: "text-a-ok", dot: "bg-a-ok", active: false },
  // Same short word as the engine status (EngineStatus.tsx): a local install without an AI is "not connected", not "waiting for a token".
  waiting_token: { word: t("nicht verbunden"), tone: "wait", text: "text-a-wait", dot: "bg-a-wait", active: false },
  off: { word: t("aus"), tone: "off", text: "text-a-mut", dot: "bg-a-idle", active: false },
  error: { word: t("gestört"), tone: "bad", text: "text-a-bad", dot: "bg-a-bad", active: false },
};

const UNKNOWN: NyxWord = { word: t("wird geprüft"), tone: "unknown", text: "text-a-mut", dot: "bg-a-idle", active: false };

/** Zustand → Wort + Farbe. `engine` undefined = Motor-Zustand noch nicht bekannt. */
export function nyxStateWord(engine: HaikuEngineState | undefined, activity: NyxState = "idle"): NyxWord {
  if (activity !== "idle") return ACTIVITY[activity];
  if (!engine) return UNKNOWN;
  return ENGINE[engine] ?? ENGINE.error;
}
