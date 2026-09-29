// Farbfolge: „lila → sprechen blau → loslassen rot → Werkzeug orange → Antwort
// grün“. Die Werkzeug-Phase darf nicht abbrechen: zwischen Werkzeugen und bis die echte Antwort kommt bleibt Nyx orange
// (auch während „Ich schau mir das mal an.“ klingt), dann wird er LANGSAM grün. Blau nur, wenn der Nutzer spricht.
// Gemessen im Live-Browser vorher: idle → listening (Blitz) → thinking → tool → thinking (0,8 s rot) → speaking.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NYX_SPEAK_BLEND_MS,
  nyxSequenceAdvance,
  nyxSequenceInput,
  nyxSequenceStart,
  type NyxSequence,
  type NyxVisualStep,
} from "../src/features/nyx/visualSequence";

const step = (state: NyxVisualStep["state"], tool: string | null = null): NyxVisualStep => ({ state, tool });

function play(events: [number, NyxVisualStep][], until: number, start: NyxVisualStep = step("idle"), every = 50) {
  let seq: NyxSequence = nyxSequenceStart(start, 0);
  const out: { t: number; state: string; tool: string | null }[] = [];
  const queue = [...events];
  for (let t = 0; t <= until; t += every) {
    while (queue[0] && queue[0][0] <= t) {
      const [at, s] = queue.shift() as [number, NyxVisualStep];
      seq = nyxSequenceInput(seq, s, at);
    }
    seq = nyxSequenceAdvance(seq, t);
    out.push({ t, state: seq.shown.state, tool: seq.shown.tool });
  }
  return out;
}
const order = (trace: ReturnType<typeof play>) => trace.map((x) => x.state).filter((s, i, a) => s !== a[i - 1]);

describe("Werkzeug-Phase bricht nicht ab", () => {
  it("Sprechen: lila → blau → rot → orange → grün → lila (Zeitleiste wie live gemessen)", () => {
    const trace = play(
      [
        [500, step("listening")], // Knopf gedrückt
        [2500, step("thinking")], // losgelassen
        [4300, step("tool", "lage")],
        [4580, step("tool", "letzte_aktivitaet")],
        [4700, step("thinking")], // Lücke zwischen Werkzeug und Antwort (Modell schreibt)
        [9800, step("speaking")], // die echte Antwort
        [16000, step("idle")],
      ],
      20000,
    );
    expect(order(trace)).toEqual(["idle", "listening", "thinking", "tool", "speaking", "idle"]);
  });

  it("zwischen letztem Werkzeug und Antwort bleibt Nyx orange – auch wenn es 10 s dauert", () => {
    const trace = play(
      [
        [0, step("thinking")],
        [1000, step("tool", "sessions_suchen")],
        [1300, step("thinking")],
        [11000, step("speaking")],
      ],
      14000,
      step("thinking"),
    );
    const mid = trace.filter((x) => x.t >= 1000 && x.t < 11000);
    expect(new Set(mid.map((x) => x.state))).toEqual(new Set(["tool"]));
    // Das Werkzeug bleibt benannt (Chip/Statuszeile zeigen, was Nyx tut).
    expect(new Set(mid.map((x) => x.tool))).toEqual(new Set(["sessions_suchen"]));
    expect(trace.at(-1)?.state).toBe("speaking");
  });

  it("getippte Frage: kein Blau (Blau heißt: der Nutzer spricht)", () => {
    const trace = play(
      [
        [0, step("thinking")],
        [2000, step("tool", "lage")],
        [9000, step("thinking")],
        [9800, step("speaking")],
        [15000, step("idle")],
      ],
      18000,
    );
    expect(order(trace)).toEqual(["thinking", "tool", "speaking", "idle"]);
  });

  it("ein kurzer Ruhe-Blip mitten im Werkzeug (Zustand kurz leer) zeigt weder lila noch blau", () => {
    const trace = play(
      [
        [0, step("thinking")],
        [1000, step("tool", "lage")],
        [1500, step("idle")],
        [1600, step("tool", "lage")],
        [5000, step("speaking")],
      ],
      8000,
      step("thinking"),
    );
    expect(order(trace)).toEqual(["thinking", "tool", "speaking"]);
  });

  it("Frage ohne Antwort (Fehler) endet, neue getippte Frage noch in der Such-Runde → rot, nicht altes Orange", () => {
    const trace = play(
      [
        [0, step("thinking")],
        [900, step("tool", "git")],
        [1500, step("thinking")],
        [2000, step("idle")],
        [2300, step("thinking")],
        [4500, step("idle")],
      ],
      7000,
      step("idle"),
    );
    expect(order(trace)).toEqual(["thinking", "tool", "thinking", "idle"]);
    expect(trace.find((x) => x.t === 3000)?.state).toBe("thinking");
  });

  it("nach der Antwort beginnt die nächste Frage wieder rot (die alte Werkzeug-Phase hängt nicht nach)", () => {
    const trace = play(
      [
        [0, step("tool", "lage")],
        [2000, step("speaking")],
        [5000, step("idle")],
        [8000, step("listening")],
        [9000, step("thinking")],
      ],
      11000,
      step("tool", "lage"),
    );
    expect(order(trace)).toEqual(["tool", "speaking", "idle", "listening", "thinking"]);
  });
});

describe("sanfter Übergang zu grün", () => {
  const css = (rel: string) => readFileSync(resolve(__dirname, "../src", rel), "utf8");
  it("grün blendet langsam ein (Tab, Aura) – mindestens 1,2 s", () => {
    expect(NYX_SPEAK_BLEND_MS).toBeGreaterThanOrEqual(1200);
    const tab = css("features/nyx/tab/nyxTab.css");
    const aura = css("components/brand/nyxAura.css");
    expect(tab).toMatch(/\.nyx-stage\[data-tone="speaking"\][^}]*transition:[^;]*--nyx-tone\s+1[2-9]\d\dms/);
    expect(aura).toMatch(/\.nyx-mark\[data-state="speaking"\][^}]*transition:[^;]*--nyx-mark-tint\s+1[2-9]\d\dms/);
  });
});
