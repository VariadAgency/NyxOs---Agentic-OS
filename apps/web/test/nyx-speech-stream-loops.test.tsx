// Die gestreamte Stimme in beiden Sprach-Schleifen.
// - Stream-Weg wird genutzt, wenn der Browser es kann (erster Ton früher).
// - Rückfall auf das ganze WAV, wenn der Stream scheitert (nie doppelt abspielen).
// - stop()/Unterbrechen bricht den Stream sofort ab, auch beim Verlassen der Seite.
// - Ducken (leiser beim Reinsprechen) wirkt im Stream-Weg über einen GainNode.
// - Tempo nur über `speed` an den Server, playbackRate bleibt 1.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NyxSpeechPlayback, NyxSpeechStreamOptions } from "../src/lib/nyxSpeechStream";

const mocks = vi.hoisted(() => ({
  calls: [] as { text: string; opts: NyxSpeechStreamOptions; stop: ReturnType<typeof vi.fn>; finish: () => void; fail: (e: Error) => void; begin: () => void }[],
  /** Wie der nächste Stream reagiert: "play" = startet, "fail" = scheitert vor dem ersten Ton. */
  mode: "play" as "play" | "fail",
  synth: vi.fn(async (_t: string, _o?: unknown) => new Blob(["x"], { type: "audio/wav" }) as Blob | null),
}));

vi.mock("../src/lib/nyxSpeechStream", () => ({
  playNyxSpeechStream: (text: string, opts: NyxSpeechStreamOptions): NyxSpeechPlayback => {
    let resolveStarted!: () => void;
    let rejectStarted!: (e: Error) => void;
    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const started = new Promise<{ voice: string; fallback: boolean; sampleRate: number; firstSoundMs: number }>((res, rej) => {
      resolveStarted = () => res({ voice: "v", fallback: false, sampleRate: 16_000, firstSoundMs: 10 });
      rejectStarted = rej;
    });
    const done = new Promise<{ voice: string; fallback: boolean; seconds: number }>((res, rej) => {
      resolveDone = () => res({ voice: "v", fallback: false, seconds: 1 });
      rejectDone = rej;
    });
    started.catch(() => undefined);
    done.catch(() => undefined);
    const stop = vi.fn(() => {
      rejectStarted(new Error("abgebrochen"));
      resolveDone();
    });
    opts.signal?.addEventListener("abort", () => stop(), { once: true });
    const call = {
      text,
      opts,
      stop,
      begin: () => resolveStarted(),
      finish: () => resolveDone(),
      fail: (e: Error) => {
        rejectStarted(e);
        rejectDone(e);
      },
    };
    mocks.calls.push(call);
    if (mocks.mode === "play") queueMicrotask(() => call.begin());
    else queueMicrotask(() => call.fail(new Error("Nyx kann gerade nicht sprechen – die Antwort steht im Chat.")));
    return { started, done, stop, level: () => 0.6 };
  },
}));

vi.mock("../src/features/nyx/voice/serverVoice", () => ({
  synthesize: (text: string, o?: unknown) => mocks.synth(text, o),
  transcribe: async () => ({ text: "", ms: 0, via: "nyx" }),
}));
vi.mock("../src/features/nyx/voice/vad", () => ({
  startVad: async () => ({ stop: () => {}, setGuard: () => {}, level: () => 0, speaking: () => false }),
}));

import { createSpeaker as createBarSpeaker } from "../src/features/nyx/voice/speaker";
import { resetSpeechStreamBackoff, streamSentence } from "../src/features/nyx/voice/streamedSpeech";
import { createLevelDrive } from "../src/features/nyx/tab/voice/level";
import { createSpeaker as createTabSpeaker } from "../src/features/nyx/tab/voice/speaker";
import { useNyxVoiceLoop as useBarLoop } from "../src/features/nyx/useNyxVoiceLoop";

class FakeGain {
  gain = { value: 1 };
  connected = false;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}
const gains: FakeGain[] = [];
class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createGain() {
    const g = new FakeGain();
    gains.push(g);
    return g;
  }
  createBufferSource() {
    return { connect() {}, start() {}, stop() {}, playbackRate: { value: 1 } };
  }
  createAnalyser() {
    return { fftSize: 0, frequencyBinCount: 8, smoothingTimeConstant: 0, connect() {}, disconnect() {}, getByteFrequencyData() {} };
  }
  createMediaElementSource() {
    return { connect() {} };
  }
}
const audios: FakeAudio[] = [];
class FakeAudio {
  playbackRate = 1;
  volume = 1;
  preload = "";
  src = "";
  duration = 0;
  currentTime = 0;
  played = 0;
  onended: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    audios.push(this);
  }
  play() {
    this.played++;
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
  pause() {
    this.onpause?.();
  }
  canPlayType() {
    return "";
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.mode = "play";
  mocks.synth.mockClear();
  gains.length = 0;
  audios.length = 0;
  resetSpeechStreamBackoff();
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("Audio", FakeAudio);
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("Hilfe streamSentence (features/nyx/voice)", () => {
  it("ohne Web Audio → null (Ganz-WAV-Weg)", () => {
    expect(streamSentence("Hallo.", { context: null })).toBeNull();
  });

  it("Tempo geht als speed an den Server, Ducken über GainNode, stop bricht ab", async () => {
    const ctx = new FakeContext() as unknown as AudioContext;
    const s = streamSentence("Hallo Alex.", { context: ctx, voice: "pocket-juergen", speed: 1.3 });
    expect(s).not.toBeNull();
    await expect(s?.started).resolves.toBe("playing");
    const call = mocks.calls[0];
    expect(call?.opts).toMatchObject({ voice: "pocket-juergen", speed: 1.3, context: ctx });
    expect(call?.opts).not.toHaveProperty("playbackRate");
    expect(call?.opts.output).toBe(gains[0]);
    s?.duck(true);
    expect(gains[0]?.gain.value).toBeLessThan(1);
    s?.duck(false);
    expect(gains[0]?.gain.value).toBe(1);
    s?.stop();
    expect(call?.stop).toHaveBeenCalled();
    await s?.done;
  });

  it("scheitert der Stream vor dem ersten Ton → 'failed', danach eine Weile gleich der Ganz-WAV-Weg", async () => {
    mocks.mode = "fail";
    const ctx = new FakeContext() as unknown as AudioContext;
    const s = streamSentence("Hallo.", { context: ctx });
    await expect(s?.started).resolves.toBe("failed");
    expect(streamSentence("Noch was.", { context: ctx })).toBeNull();
  });

  it("Safari: Kontext bleibt angehalten → Stream still abbrechen, Ganz-WAV-Weg (Warteschlange hängt nicht)", async () => {
    const fake = new FakeContext();
    fake.state = "suspended";
    const s = streamSentence("Hallo.", { context: fake as unknown as AudioContext });
    await expect(s?.started).resolves.toBe("failed");
    expect(mocks.calls[0]?.stop).toHaveBeenCalled();
  });
});

describe("Begleiter-Sprecher (voice/speaker.ts)", () => {
  it("nutzt den Stream, nicht das ganze WAV", async () => {
    const sp = createBarSpeaker({ voice: "de_DE-thorsten-medium" });
    sp.say("Alles klar.");
    await waitFor(() => expect(mocks.calls).toHaveLength(1));
    expect(mocks.calls[0]?.opts.voice).toBe("de_DE-thorsten-medium");
    await waitFor(() => expect(sp.isSpeaking()).toBe(true));
    expect(sp.speakingText()).toBe("Alles klar.");
    expect(mocks.synth).not.toHaveBeenCalled();
    const ended = sp.end();
    mocks.calls[0]?.finish();
    await ended;
    expect(sp.isSpeaking()).toBe(false);
  });

  it("Rückfall: Stream scheitert → das ganze WAV spielt (genau einmal)", async () => {
    mocks.mode = "fail";
    const sp = createBarSpeaker();
    sp.say("Hallo.");
    await sp.end();
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.synth).toHaveBeenCalledTimes(1);
    expect(audios.reduce((n, a) => n + a.played, 0)).toBe(1);
    expect(audios.every((a) => a.playbackRate === 1)).toBe(true);
  });

  it("Ducken wirkt im Stream, cancel() stoppt sofort", async () => {
    const sp = createBarSpeaker();
    sp.say("Ein langer Satz.");
    await waitFor(() => expect(sp.isSpeaking()).toBe(true));
    sp.duck(true);
    expect(gains.at(-1)?.gain.value).toBeLessThan(1);
    sp.duck(false);
    expect(gains.at(-1)?.gain.value).toBe(1);
    sp.cancel();
    expect(mocks.calls[0]?.stop).toHaveBeenCalled();
    expect(sp.isSpeaking()).toBe(false);
  });
});

describe("Nyx-Tab-Sprecher (tab/voice/speaker.ts)", () => {
  const streamWith = (speed: number) => (text: string, context: AudioContext | null, signal: AbortSignal) => streamSentence(text, { context, signal, speed });

  it("nutzt den Stream mit speed; cancel() bricht ab und liefert Gehörtes", async () => {
    const synth = vi.fn(async () => new Blob());
    const onSentenceStart = vi.fn();
    const sp = createTabSpeaker(synth, createLevelDrive(), { onSentenceStart }, { stream: streamWith(1.2) });
    sp.push("Der Build ist grün. ");
    await waitFor(() => expect(onSentenceStart).toHaveBeenCalledWith("Der Build ist grün.", 0));
    expect(mocks.calls[0]?.opts.speed).toBe(1.2);
    expect(synth).not.toHaveBeenCalled();
    sp.duck(true);
    expect(gains.at(-1)?.gain.value).toBeLessThan(1);
    sp.cancel();
    expect(mocks.calls[0]?.stop).toHaveBeenCalled();
    sp.dispose();
  });

  it("Rückfall aufs ganze WAV, playbackRate bleibt 1, kein doppeltes Abspielen", async () => {
    mocks.mode = "fail";
    const synth = vi.fn(async () => new Blob());
    const onDrained = vi.fn();
    const sp = createTabSpeaker(synth, createLevelDrive(), { onDrained }, { stream: streamWith(1.3) });
    sp.push("Hallo Alex.");
    sp.end();
    await waitFor(() => expect(onDrained).toHaveBeenCalled());
    expect(mocks.calls).toHaveLength(1);
    expect(synth).toHaveBeenCalledTimes(1);
    const el = audios.at(-1);
    expect(el?.played).toBe(1);
    expect(el?.playbackRate).toBe(1);
    sp.dispose();
  });
});

describe("Schleife Begleiter (useNyxVoiceLoop)", () => {
  it("say() spricht über den Stream; Verlassen der Seite bricht ab", async () => {
    const CONTEXT = { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null };
    const { result, unmount } = renderHook(() => useBarLoop({ listening: false, context: () => CONTEXT as never }));
    act(() => result.current.say("Moment."));
    await waitFor(() => expect(mocks.calls).toHaveLength(1));
    await tick();
    unmount();
    expect(mocks.calls[0]?.stop).toHaveBeenCalled();
  });
});
