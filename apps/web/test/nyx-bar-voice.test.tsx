// Die Leisten-Stimme darf einen schon gestreamten Gedanken (ab 400 Zeichen) nicht weiter
// vorlesen, liest die Zwischenmeldung genau einmal und nimmt für die Antwort die Sprechfassung (`done.speak`),
// solange noch kein Satz der Antwort geklungen hat – und spricht nichts doppelt.
import type { HaikuStreamEvent } from "@nyxos/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface FakeSpeaker {
  id: number;
  pushed: string[];
  said: string[];
  cancelled: boolean;
  sound(text: string): void;
}
const h = vi.hoisted(() => ({ speakers: [] as FakeSpeaker[], events: [] as HaikuStreamEvent[] }));

vi.mock("../src/features/nyx/voice/vad", () => ({
  startVad: async () => ({ stop: () => {}, setGuard: () => {}, level: () => 0, speaking: () => false }),
}));
vi.mock("../src/features/nyx/voice/serverVoice", () => ({ transcribe: async () => ({ text: "" }) }));
vi.mock("../src/features/haiku/haikuApi", () => ({
  streamHaikuChat: async (_b: unknown, on: (ev: HaikuStreamEvent) => void) => {
    for (const ev of h.events) on(ev);
  },
}));
vi.mock("../src/features/nyx/voice/speaker", () => ({
  createSpeaker: (opts: { onSpeakingChange?: (on: boolean) => void }) => {
    let speaking = "";
    const s: FakeSpeaker & Record<string, unknown> = {
      id: h.speakers.length,
      pushed: [],
      said: [],
      cancelled: false,
      sound(text: string) {
        speaking = text;
        opts.onSpeakingChange?.(true);
      },
      push(d: string) {
        if (!s.cancelled) s.pushed.push(d);
      },
      say(t: string) {
        if (!s.cancelled) s.said.push(t);
      },
      end: async () => {},
      cancel() {
        s.cancelled = true;
      },
      dropQueued() {
        s.pushed.length = 0;
      },
      level: () => 0,
      speakingText: () => speaking,
      speakingSince: () => 0,
      isSpeaking: () => !!speaking,
      duck() {},
    };
    h.speakers.push(s);
    return s;
  },
}));

import { useNyxVoiceLoop } from "../src/features/nyx/useNyxVoiceLoop";

const CONTEXT = { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null };
const done = (text: string, speak: string): HaikuStreamEvent => ({ type: "done", messageId: 1, text, speak, sources: [], estimate: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } });

describe("Leisten-Stimme", () => {
  it("gestreamter Gedanke wird zurückgenommen → Stimme verworfen, danach nur Zwischenmeldung + Sprechfassung", async () => {
    h.speakers.length = 0;
    const thought = "Ah, ich prüfe erst die Sessions. ".repeat(15);
    h.events = [
      { type: "delta", text: thought },
      { type: "thought", text: thought.trim(), retract: true },
      { type: "filler", text: "Ich schau mal." },
      { type: "status", status: "tool", tool: "letzte_aktivitaet" },
      { type: "delta", text: "Zuletzt: **NyxOS** R3." },
      done("Zuletzt: **NyxOS** R3.", "Zuletzt: NyxOS R3."),
    ];
    const { result } = renderHook(() => useNyxVoiceLoop({ listening: false, context: () => CONTEXT }));
    await act(async () => {
      await result.current.send("Was war zuletzt?", { channel: "voice" });
    });
    const first = h.speakers[0];
    expect(first?.pushed.join("")).toBe(thought);
    expect(first?.cancelled).toBe(true); // Gedanke nicht weiter vorlesen
    const live = h.speakers.filter((s) => !s.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0]?.said).toEqual(["Ich schau mal.", "Zuletzt: NyxOS R3."]);
    expect(live[0]?.pushed).toEqual([]);
    expect(result.current.answer).toBe("Zuletzt: **NyxOS** R3.");
  });

  it("Zwischenmeldung klingt noch → sie klingt aus, dann die Sprechfassung statt Markdown (nichts doppelt)", async () => {
    h.speakers.length = 0;
    const { result } = renderHook(() => useNyxVoiceLoop({ listening: false, context: () => CONTEXT }));
    const mod = await import("../src/features/haiku/haikuApi");
    const spy = vi.spyOn(mod, "streamHaikuChat").mockImplementation(async (_b, on) => {
      on({ type: "filler", text: "Ich schau mal." });
      h.speakers[h.speakers.length - 1]?.sound("Ich schau mal.");
      on({ type: "delta", text: "Es sind **3** offen." });
      on(done("Es sind **3** offen.", "Es sind 3 offen."));
    });
    await act(async () => {
      await result.current.send("Wie viele offen?", { channel: "voice" });
    });
    spy.mockRestore();
    expect(h.speakers).toHaveLength(1);
    const sp = h.speakers[0];
    expect(sp?.cancelled).toBe(false); // Zwischenmeldung nicht abgeschnitten
    expect(sp?.pushed).toEqual([]); // roher Markdown-Text verworfen
    expect(sp?.said).toEqual(["Ich schau mal.", "Es sind 3 offen."]);
  });

  it("lange Antwort ohne Werkzeug, schon gesprochen → done spricht sie NICHT noch einmal", async () => {
    h.speakers.length = 0;
    const long = "Das ist ein langer Satz ohne Werkzeug. ".repeat(12);
    h.events = [{ type: "delta", text: long }];
    const { result } = renderHook(() => useNyxVoiceLoop({ listening: false, context: () => CONTEXT }));
    const mod = await import("../src/features/haiku/haikuApi");
    const spy = vi.spyOn(mod, "streamHaikuChat").mockImplementation(async (_b, on) => {
      on({ type: "delta", text: long });
      h.speakers[h.speakers.length - 1]?.sound("Das ist ein langer Satz ohne Werkzeug.");
      on(done(long, long.trim()));
    });
    await act(async () => {
      await result.current.send("Erzähl", { channel: "voice" });
    });
    spy.mockRestore();
    expect(h.speakers).toHaveLength(1);
    expect(h.speakers[0]?.cancelled).toBe(false);
    expect(h.speakers[0]?.said).toEqual([]);
  });
});
