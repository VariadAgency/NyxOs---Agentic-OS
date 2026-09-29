// Nyx-Farbfolge: blau → rot → orange mit Such-Animation → grün, ohne Flackern.
// Geprüft: die ruhige Abfolge (Sequencer mit künstlicher Uhr), die Ursache (Zwischenmeldung „Ich schau mal.“ schaltete
// die Leisten-Schleife auf „spricht“ und damit die Werkzeug-Phase ab) und dass die sichtbare Aura im Nyx-Tab der
// Abfolge folgt. Farben: Tokens --a-nyx-listen/-think/-tool/-speak, Ruhe = --a-nyx.
import type { HaikuStreamEvent } from "@nyxos/shared";
import { act, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_TOKEN } from "../src/features/nyx/tab/net3d/visual";
import {
  NYX_MIN_DWELL_MS,
  NYX_TOOL_ROUND_MS,
  nyxSequenceAdvance,
  nyxSequenceInput,
  nyxSequenceNextAt,
  nyxSequenceStart,
  type NyxSequence,
  type NyxVisualStep,
} from "../src/features/nyx/visualSequence";
import { emitNyxLive } from "../src/lib/liveBus";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const css = (rel: string) => readFileSync(resolve(__dirname, "../src", rel), "utf8");
const appCss = css("app.css");
const auraCss = css("components/brand/nyxAura.css");
const tabCss = css("features/nyx/tab/nyxTab.css");

// ── Leisten-Schleife: Sprecher und Strom als Attrappen ──
interface FakeSpeaker {
  sound(text: string): void;
}
const h = vi.hoisted(() => ({ speakers: [] as FakeSpeaker[] }));
vi.mock("../src/features/nyx/voice/vad", () => ({
  startVad: async () => ({ stop: () => {}, setGuard: () => {}, level: () => 0, speaking: () => false }),
}));
vi.mock("../src/features/nyx/voice/serverVoice", () => ({ transcribe: async () => ({ text: "" }), synthesize: async () => null }));
vi.mock("../src/features/nyx/voice/speaker", () => ({
  createSpeaker: (opts: { onSpeakingChange?: (on: boolean) => void }) => {
    let speaking = "";
    const s = {
      sound(text: string) {
        speaking = text;
        opts.onSpeakingChange?.(!!text);
      },
      push() {},
      say() {},
      end: async () => {},
      cancel() {},
      dropQueued() {},
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
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { NyxAura } from "../src/components/brand/NyxAura";

const step = (state: NyxVisualStep["state"], tool: string | null = null): NyxVisualStep => ({ state, tool });

/** Folge über eine Zeitleiste abspielen: [ms, roher Zustand]. */
function play(events: [number, NyxVisualStep][], until: number, every = 50): { t: number; state: string; tool: string | null }[] {
  let seq: NyxSequence = nyxSequenceStart(step("idle"), 0);
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
const at = (trace: ReturnType<typeof play>, t: number) => trace.find((x) => x.t === t)?.state;
/** Die Folge der sichtbaren Zustände ohne Wiederholungen. */
const order = (trace: ReturnType<typeof play>) => trace.map((x) => x.state).filter((s, i, a) => s !== a[i - 1]);

describe("Sequencer: ruhige Farbfolge", () => {
  it("Sprechen → blau → rot → orange → grün → lila, jede Phase mindestens so lang wie vorgesehen", () => {
    // Knopf gehalten, dann Server/Strom so schnell wie heute: denkt 0 ms, Werkzeug nach 150 ms, erste Antwort nach 400 ms, fertig nach 900 ms.
    const trace = play(
      [
        [0, step("listening")],
        [NYX_MIN_DWELL_MS.listening, step("thinking")],
        [NYX_MIN_DWELL_MS.listening + 150, step("tool", "git_lage")],
        [NYX_MIN_DWELL_MS.listening + 400, step("speaking")],
        [NYX_MIN_DWELL_MS.listening + 900, step("idle")],
      ],
      6000,
    );
    expect(order(trace)).toEqual(["listening", "thinking", "tool", "speaking", "idle"]);
    const first = (s: string) => trace.find((x) => x.state === s)?.t ?? -1;
    const last = (s: string) => [...trace].reverse().find((x) => x.state === s)?.t ?? -1;
    expect(last("listening") - first("listening")).toBeGreaterThanOrEqual(NYX_MIN_DWELL_MS.listening - 50);
    expect(last("thinking") - first("thinking")).toBeGreaterThanOrEqual(NYX_MIN_DWELL_MS.thinking - 50);
    expect(last("tool") - first("tool")).toBeGreaterThanOrEqual(1500);
    expect(last("speaking") - first("speaking")).toBeGreaterThanOrEqual(NYX_MIN_DWELL_MS.speaking - 50);
    expect(trace.find((x) => x.state === "tool")?.tool).toBe("git_lage");
  });

  it("frühes delta schneidet die Werkzeug-Runde nicht ab – grün erst, wenn die Runde durch ist", () => {
    let seq = nyxSequenceStart(step("thinking"), 0);
    seq = nyxSequenceInput(seq, step("tool", "sessions_suchen"), 1000);
    expect(seq.shown.state).toBe("tool");
    seq = nyxSequenceInput(seq, step("speaking"), 1100); // Antwort beginnt 100 ms nach dem Werkzeug
    expect(seq.shown).toEqual(step("tool", "sessions_suchen"));
    expect(nyxSequenceNextAt(seq)).toBe(1000 + NYX_TOOL_ROUND_MS);
    expect(nyxSequenceAdvance(seq, 1000 + NYX_TOOL_ROUND_MS - 1).shown.state).toBe("tool");
    expect(nyxSequenceAdvance(seq, 1000 + NYX_TOOL_ROUND_MS).shown.state).toBe("speaking");
  });

  it("läuft das Werkzeug länger, endet die angefangene Runde (keine halbe Animation)", () => {
    let seq = nyxSequenceStart(step("tool", "git_lage"), 0);
    seq = nyxSequenceInput(seq, step("speaking"), 2000); // mitten in Runde 2
    expect(nyxSequenceNextAt(seq)).toBe(2 * NYX_TOOL_ROUND_MS);
  });

  it("nach „done“ + Sprecher aus → lila; ein kurzes „denkt“ dazwischen blitzt nicht auf", () => {
    const trace = play(
      [
        [0, step("speaking")],
        [100, step("thinking")],
        [150, step("speaking")],
        [2000, step("idle")],
      ],
      4000,
    );
    expect(order(trace)).toEqual(["speaking", "idle"]); // Vorlesen aus der Ruhe: kein Blau davor
    expect(at(trace, 2000)).toBe("idle");
  });

  it("viele schnelle Werkzeuge hinken nicht endlos nach (höchstens drei Schritte warten)", () => {
    let seq = nyxSequenceStart(step("thinking"), 0);
    for (let i = 0; i < 10; i++) seq = nyxSequenceInput(seq, step("tool", `w${i}`), 900 + i * 20);
    expect(seq.queue.length).toBeLessThanOrEqual(3);
    expect(seq.queue.at(-1)?.tool).toBe("w9");
  });

  it("Zuhören wirft alte Werkzeug-Runden weg (nur die laufende endet)", () => {
    let seq = nyxSequenceStart(step("tool", "a"), 0);
    seq = nyxSequenceInput(seq, step("tool", "b"), 100);
    seq = nyxSequenceInput(seq, step("listening"), 200);
    expect(seq.queue.map((q) => q.state)).toEqual(["listening"]);
  });
});

describe("Ursache: Zwischenmeldung schaltete die Werkzeug-Phase nach ~0,5 s ab", () => {
  it("„Ich schau mal.“ klingt während des Werkzeugs → Leiste bleibt „tool“; erst die Antwort ist „speaking“", async () => {
    h.speakers.length = 0;
    const mod = await import("../src/features/haiku/haikuApi");
    let emit: (ev: HaikuStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const spy = vi.spyOn(mod, "streamHaikuChat").mockImplementation(
      (_b, on) =>
        new Promise<void>((resolve) => {
          emit = on;
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useNyxVoiceLoop({ listening: false, context: () => ({ path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null }) }));
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = result.current.send("Was ist im Git los?", { channel: "voice" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit({ type: "filler", text: "Ich schau mal." });
      emit({ type: "status", status: "tool", tool: "git_lage" });
    });
    expect(result.current.state).toBe("tool");
    const sp = h.speakers.at(-1);
    act(() => sp?.sound("Ich schau mal.")); // Zwischenmeldung klingt (~0,5 s nach dem Werkzeug)
    expect(result.current.state).toBe("tool");
    expect(result.current.tool).toBe("git_lage");
    act(() => emit({ type: "delta", text: "Der Build ist grün." }));
    expect(result.current.state).toBe("speaking");
    await act(async () => {
      finish();
      await sending;
    });
    spy.mockRestore();
    expect(result.current.state).toBe("idle");
  });
});

describe("Zwischenmeldung beim getippten Chat (Zentrum/Nyx-Feld) macht nicht grün", () => {
  it("say(filler, { filler: true }) klingt → Schleife bleibt ruhig; eine echte Antwort (speakAnswer) ist „speaking“", () => {
    h.speakers.length = 0;
    const { result } = renderHook(() => useNyxVoiceLoop({ listening: false, context: () => ({ path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null }) }));
    act(() => result.current.say("Moment, ich schau kurz nach.", { filler: true }));
    const sp = h.speakers.at(-1);
    act(() => sp?.sound("Moment, ich schau kurz nach."));
    expect(result.current.state).toBe("idle");
    act(() => sp?.sound(""));
    act(() => result.current.speakAnswer("Der Build ist grün."));
    act(() => sp?.sound("Der Build ist grün."));
    expect(result.current.state).toBe("speaking");
  });
});

describe("Farben über Tokens", () => {
  it("Zustand → eigenes Nyx-Token, gleich in Netz, Tab und Aura", () => {
    expect(STATE_TOKEN).toEqual({ idle: "--a-nyx", listening: "--a-nyx-listen", thinking: "--a-nyx-think", tool: "--a-nyx-tool", speaking: "--a-nyx-speak" });
    for (const t of ["--a-nyx-listen", "--a-nyx-think", "--a-nyx-tool", "--a-nyx-speak"]) {
      expect(appCss).toMatch(new RegExp(`${t}:\\s*#[0-9a-f]{6};`, "i"));
    }
    for (const [state, token] of Object.entries(STATE_TOKEN)) {
      if (state === "idle") continue;
      expect(tabCss).toMatch(new RegExp(`\\[data-tone="${state}"\\][^}]*var\\(${token}\\)`));
      expect(auraCss).toMatch(new RegExp(`\\[data-state="${state}"\\][^}]*var\\(${token}\\)`));
    }
  });
});

describe("Aura: Such-Punkte nur beim Werkzeug", () => {
  it("Werkzeug zeigt die Punkte-Wolke (eine Runde = NYX_TOOL_ROUND_MS), andere Zustände nicht", () => {
    const { rerender } = render(<NyxAura state="tool" size={28} />);
    const seek = screen.getByTestId("nyx-aura-seek");
    expect(seek.querySelectorAll("circle").length).toBeGreaterThanOrEqual(5);
    expect(seek.getAttribute("style")).toContain(`--nyx-seek-round: ${NYX_TOOL_ROUND_MS}ms`);
    rerender(<NyxAura state="speaking" size={28} />);
    expect(screen.queryByTestId("nyx-aura-seek")).toBeNull();
    rerender(<NyxAura state="tool" size={14} />);
    expect(screen.queryByTestId("nyx-aura-seek")).toBeNull(); // zu klein für Punkte
  });
});

// ── Nyx-Tab: sichtbare Aura folgt der Abfolge ──
describe("Nyx-Tab: Aura und Netz folgen der ruhigen Abfolge", () => {
  beforeEach(() => {
    localStorage.clear();
    __primeAuthForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
        if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [{ name: "git_lage", description: "Git-Lage" }] });
        if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
        if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
        return jsonResponse({}, { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Werkzeug → Antwort 200 ms später: Aura bleibt eine volle Runde orange, dann grün, am Ende lila", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <NyxTab />
      </MemoryRouter>,
    );
    const net = await screen.findByRole("img", { name: /Nyx ruht/ });
    const aura = () => document.querySelector(".nyx-title [data-testid='nyx-aura']") as Element;
    const tone = () => document.querySelector('[data-nyx="nyx-tab"]')?.getAttribute("data-tone");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const live = (state: string, tool?: string) => act(() => emitNyxLive({ type: "nyx.state", state, ...(tool ? { tool } : {}), at: new Date().toISOString() } as never));
    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    live("thinking");
    // Kein Blau-Blitz mehr (Blau heißt nur: der Nutzer spricht) – direkt rot.
    expect(aura().getAttribute("data-state")).toBe("thinking");
    live("tool", "git_lage");
    await wait(NYX_MIN_DWELL_MS.thinking);
    expect(aura().getAttribute("data-state")).toBe("tool");
    expect(net).toHaveAttribute("data-tool", "git_lage");
    await wait(200);
    live("speaking");
    await wait(NYX_TOOL_ROUND_MS - 400);
    expect(aura().getAttribute("data-state")).toBe("tool"); // Such-Runde läuft zu Ende
    expect(tone()).toBe("tool");
    await wait(250);
    expect(aura().getAttribute("data-state")).toBe("speaking");
    expect(net).toHaveAttribute("data-state", "speaking");
    live("idle");
    await wait(NYX_MIN_DWELL_MS.speaking);
    expect(aura().getAttribute("data-state")).toBe("idle");
    expect(tone()).toBe("idle");
  });
});
