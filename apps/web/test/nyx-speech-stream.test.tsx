// Gestreamte Stimme abspielen (`lib/nyxSpeechStream.ts`) — WAV-Kopf lesen, PCM über Stück-Grenzen
// hinweg richtig umrechnen, lückenlos einplanen, sofort still bei stop() (und der Server-Abruf bricht ab),
// Fehler als deutscher Satz.
import { describe, expect, it } from "vitest";
import { createPcm16Decoder, parseStreamHeader, playNyxSpeechStream } from "../src/lib/nyxSpeechStream";

function header(sampleRate: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode("RIFF"), 0);
  v.setUint32(4, 0xffffffff, true);
  h.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  h.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, 0xffffffff, true);
  return h;
}

function pcm(values: number[]): Uint8Array {
  const b = new Uint8Array(values.length * 2);
  const v = new DataView(b.buffer);
  values.forEach((x, i) => v.setInt16(i * 2, x, true));
  return b;
}

class FakeSource {
  buffer: { duration: number; data: Float32Array } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedEarly = false;
  playbackRate = { value: 1 };
  connect() {}
  start(t: number) {
    this.startedAt = t;
  }
  stop() {
    this.stoppedEarly = true;
  }
}

class FakeContext {
  currentTime = 1;
  sources: FakeSource[] = [];
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data, data };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++]);
      else ctrl.close();
    },
  });
}

describe("Stream-Kopf und PCM", () => {
  it("liest die Abtastrate aus dem Kopf, lehnt Fremdes ab", () => {
    expect(parseStreamHeader(header(24_000))).toEqual({ sampleRate: 24_000 });
    expect(parseStreamHeader(header(24_000).slice(0, 40))).toBeNull();
    const bad = header(24_000);
    bad[0] = 0x4f;
    expect(parseStreamHeader(bad)).toBeNull();
  });

  it("ein Wert, der über zwei Stücke geht, wird richtig zusammengesetzt", () => {
    const decode = createPcm16Decoder();
    const bytes = pcm([16384, -32768, 1000]);
    const a = decode(bytes.slice(0, 3));
    const b = decode(bytes.slice(3));
    expect([...a, ...b]).toEqual([0.5, -1, 1000 / 32768]);
  });
});

describe("playNyxSpeechStream", () => {
  it("spielt Stücke lückenlos hintereinander, meldet Stimme + ersten Ton, nie playbackRate", async () => {
    const ctx = new FakeContext();
    const rate = 16_000;
    const block = new Array(rate * 0.1).fill(8000); // 100 ms je Stück
    const body = pcm(block);
    let seenBody: unknown = null;
    const p = playNyxSpeechStream("Hallo Alex.", {
      voice: "pocket-juergen",
      speed: 1.1,
      context: ctx as unknown as AudioContext,
      fetchImpl: async (url, init) => {
        expect(url).toBe("/api/nyx/voice/speak?stream=1");
        seenBody = JSON.parse(String(init.body));
        return new Response(streamOf([header(rate).slice(0, 20), header(rate).slice(20), body.slice(0, 1001), body.slice(1001), body]), {
          headers: { "x-nyx-voice": "pocket-juergen", "x-nyx-voice-fallback": "0" },
        });
      },
    });
    const started = await p.started;
    expect(started).toMatchObject({ voice: "pocket-juergen", fallback: false, sampleRate: rate });
    expect(seenBody).toEqual({ text: "Hallo Alex.", voice: "pocket-juergen", speed: 1.1 });
    // Ende der Wiedergabe simulieren, sobald beide Stücke eingeplant sind
    for (let i = 0; i < 100 && ctx.sources.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    for (const s of ctx.sources) s.onended?.();
    const done = await p.done;
    expect(done.seconds).toBeCloseTo(0.2, 3);
    const starts = ctx.sources.map((s) => s.startedAt ?? 0);
    for (let i = 1; i < ctx.sources.length; i++) {
      const prev = ctx.sources[i - 1]?.buffer?.duration ?? 0;
      expect(starts[i]).toBeCloseTo((starts[i - 1] ?? 0) + prev, 6);
    }
    expect(ctx.sources.every((s) => s.playbackRate.value === 1)).toBe(true);
  });

  it("stop() macht sofort still und bricht den Abruf beim Server ab", async () => {
    const ctx = new FakeContext();
    let signal: AbortSignal | undefined;
    const pipe: { push: (b: Uint8Array) => void } = { push: () => undefined };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        pipe.push = (b) => c.enqueue(b);
      },
    });
    const p = playNyxSpeechStream("Ein langer Text.", {
      context: ctx as unknown as AudioContext,
      fetchImpl: async (_url, init) => {
        signal = init.signal ?? undefined;
        return new Response(stream, { headers: { "x-nyx-voice": "de_DE-thorsten-medium", "x-nyx-voice-fallback": "1" } });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    pipe.push(header(16_000));
    pipe.push(pcm(new Array(3200).fill(100)));
    const started = await p.started;
    expect(started.fallback).toBe(true);
    p.stop();
    expect(signal?.aborted).toBe(true);
    expect(ctx.sources[0]?.stoppedEarly).toBe(true);
    await expect(p.done).resolves.toMatchObject({ voice: "de_DE-thorsten-medium" });
  });

  it("Server-Fehler → deutscher Satz, keine Technik", async () => {
    const p = playNyxSpeechStream("Hi", {
      context: new FakeContext() as unknown as AudioContext,
      fetchImpl: async () => new Response(JSON.stringify({ error: "Die Stimme startet noch – Modell wird geladen …", reason: "loading" }), { status: 503 }),
    });
    await expect(p.started).rejects.toThrow("Die Stimme startet noch");
    await expect(p.done).rejects.toThrow("Die Stimme startet noch");
    const q = playNyxSpeechStream("Hi", {
      context: new FakeContext() as unknown as AudioContext,
      fetchImpl: async () => new Response(JSON.stringify({ error: "failed" }), { status: 502 }),
    });
    await expect(q.done).rejects.toThrow(/Nyx kann gerade nicht sprechen/);
  });
});
