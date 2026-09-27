// Gestreamte Stimme von Nyx abspielen — der erste Ton klingt, während der Server noch rechnet.
//
// Schnittstelle für die Sprach-Schleife (verdrahtet N-INT, `features/nyx/useNyxVoiceLoop.ts` / `voice/*`):
//
//   const p = playNyxSpeechStream("Alles klar, ich starte die Session.", { voice, speed, context, signal });
//   p.started   → Promise<{ voice, fallback, sampleRate, firstSoundMs }>  (erster Ton ist eingeplant)
//   p.done      → Promise<{ voice, fallback, seconds }>                   (alles gespielt; nach stop() sofort)
//   p.stop()    → sofort still + Server hört auf zu rechnen (Unterbrechen/Barge-in)
//   p.level()   → 0…1, Lautstärke gerade jetzt (für Kreis/Netz-Animation), 0 ohne AnalyserNode-Unterstützung
//
// Weg: `POST /api/nyx/voice/speak?stream=1` → audio/wav in Stücken (44-Byte-Kopf mit offener Länge, dann PCM
// 16 bit mono little-endian). Jedes Stück wird zu einem AudioBuffer und lückenlos hintereinander eingeplant.
// Tempo macht der Server (`speed`); hier nie `playbackRate` (sonst doppelt schnell + verzerrt).
// `context` möglichst mitgeben: EIN AudioContext für alles, im Klick geweckt (Safari startet ihn sonst „angehalten“).
// Fehler (Server weg, Stimme lädt) → `started`/`done` werden mit einem deutschen Satz abgelehnt, nie Technik-Text.
import { NYX_VOICE_STREAM_HEADER_BYTES, t } from "@nyxos/shared";
import { authFetch } from "../features/terminal/authClient";

export interface NyxSpeechStreamOptions {
  /** Deutsche Stimme (null = Standard des Servers). */
  voice?: string | null;
  /** Englische Stimme für englische Sätze (null = Standard des Servers). */
  voiceEn?: string | null;
  /** Sprache fest vorgeben; ohne Angabe erkennt der Server sie je Satz. */
  language?: NyxSpeakLanguage;
  /** Tempo 0,5 … 2 (Server rechnet es ein). */
  speed?: number;
  signal?: AbortSignal;
  /** Gemeinsamer AudioContext der Seite (empfohlen). Ohne: ein eigener, der mit `stop()`/Ende geschlossen wird. */
  context?: AudioContext;
  /** Ausgang statt `context.destination` (z. B. ein GainNode zum Ducken beim Reinsprechen). */
  output?: AudioNode;
  /** Nur für Tests: statt `authFetch`. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface NyxSpeechStarted {
  voice: string;
  /** Alle Stimmen, die in diesem Strom sprechen (Deutsch und/oder Englisch). */
  voices?: string[];
  /** Gewünschte Stimme war nicht bereit, eine Ersatzstimme spricht. */
  fallback: boolean;
  sampleRate: number;
  /** Zeit vom Aufruf bis zum ersten eingeplanten Ton. */
  firstSoundMs: number;
}

export interface NyxSpeechPlayback {
  started: Promise<NyxSpeechStarted>;
  done: Promise<{ voice: string; fallback: boolean; seconds: number }>;
  stop(): void;
  level(): number;
}

export type NyxSpeakLanguage = "auto" | "de" | "en";

/** Körper für `POST /api/nyx/voice/speak` — nur gesetzte Felder (Stimme DE/EN, Sprache, Tempo). */
export function speakRequestBody(
  text: string,
  opts: { voice?: string | null; voiceEn?: string | null; language?: NyxSpeakLanguage; speed?: number },
): Record<string, unknown> {
  return {
    text,
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.voiceEn ? { voiceEn: opts.voiceEn } : {}),
    ...(opts.language && opts.language !== "auto" ? { language: opts.language } : {}),
    ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
  };
}

/** WAV-Kopf des Streams: nur RIFF/WAVE mit PCM 16 bit mono; sonst `null`. */
export function parseStreamHeader(bytes: Uint8Array): { sampleRate: number } | null {
  if (bytes.byteLength < NYX_VOICE_STREAM_HEADER_BYTES) return null;
  const tag = (o: number) => String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt ") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const sampleRate = view.getUint32(24, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate < 8000 || sampleRate > 96_000) return null;
  return { sampleRate };
}

/**
 * PCM 16 bit little-endian → Float32. Stücke aus dem Netz können mitten in einem Wert enden: das übrige Byte
 * wird aufgehoben und vor das nächste Stück gesetzt.
 */
export function createPcm16Decoder(): (chunk: Uint8Array) => Float32Array {
  let carry: number | null = null;
  return (chunk) => {
    let bytes = chunk;
    if (carry !== null) {
      const joined = new Uint8Array(chunk.byteLength + 1);
      joined[0] = carry;
      joined.set(chunk, 1);
      bytes = joined;
      carry = null;
    }
    const whole = bytes.byteLength - (bytes.byteLength % 2);
    if (whole < bytes.byteLength) carry = bytes[bytes.byteLength - 1] ?? 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
    const out = new Float32Array(whole / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  };
}

/** Vorlauf, damit Netz-/Rechen-Schwankungen keine Lücken reißen; wächst nach jeder Lücke (bis MAX_LEAD_S). */
const START_LEAD_S = 0.15;
const MAX_LEAD_S = 0.5;
/** Winzige Stücke sammeln, bevor sie eingeplant werden (weniger Knoten, keine Knackser an Stoßstellen). */
const MIN_BLOCK_S = 0.08;

function errorSentence(status: number, body: { error?: unknown } | null): string {
  const msg = typeof body?.error === "string" && !/^[a-z_]+$/.test(body.error) ? body.error : null;
  if (msg) return msg;
  if (status === 401) return t("Bitte neu anmelden – dann spricht Nyx wieder.");
  if (status === 503) return t("Die Stimme startet noch – gleich noch einmal versuchen.");
  return t("Nyx kann gerade nicht sprechen – die Antwort steht im Chat.");
}

export function playNyxSpeechStream(text: string, opts: NyxSpeechStreamOptions = {}): NyxSpeechPlayback {
  const t0 = performance.now();
  const abort = new AbortController();
  const onOuterAbort = () => stop();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const ownContext = !opts.context;
  let ctx: AudioContext | null = opts.context ?? null;
  let analyser: AnalyserNode | null = null;
  let levelBuf: Float32Array<ArrayBuffer> | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  let stopped = false;
  let nextTime = 0;
  let lead = START_LEAD_S;
  let seconds = 0;
  let resolveStarted!: (v: NyxSpeechStarted) => void;
  let rejectStarted!: (e: Error) => void;
  const started = new Promise<NyxSpeechStarted>((res, rej) => {
    resolveStarted = res;
    rejectStarted = rej;
  });
  started.catch(() => undefined);
  let finishPlayback: (() => void) | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    void activeReader?.cancel().catch(() => undefined);
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        // schon zu Ende
      }
    }
    sources.clear();
    finishPlayback?.();
  }

  function ensureContext(): AudioContext {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
    }
    if (!analyser && typeof ctx.createAnalyser === "function") {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      levelBuf = new Float32Array(analyser.fftSize);
      analyser.connect(opts.output ?? ctx.destination);
    }
    void ctx.resume?.()?.catch(() => undefined);
    return ctx;
  }

  function schedule(samples: Float32Array, sampleRate: number): void {
    const c = ensureContext();
    const buffer = c.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser ?? opts.output ?? c.destination);
    // Lücke (Ton kam später als der vorige zu Ende war)? Dann ab jetzt mit mehr Vorlauf planen.
    if (nextTime > 0 && nextTime < c.currentTime) lead = Math.min(MAX_LEAD_S, lead + 0.1);
    nextTime = Math.max(nextTime, c.currentTime + lead);
    src.start(nextTime);
    nextTime += buffer.duration;
    seconds += buffer.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      if (sources.size === 0) finishPlayback?.();
    };
  }

  // Eigenen AudioContext SOFORT anlegen (noch in der Klick-Geste) — Safari/iOS weckt ihn sonst nie.
  if (!opts.context) {
    try {
      ensureContext();
    } catch {
      // ohne Web Audio: Fehler kommt beim Einplanen als Satz
    }
  }

  const done = (async () => {
    const doFetch = opts.fetchImpl ?? authFetch;
    let res: Response;
    try {
      res = await doFetch("/api/nyx/voice/speak?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(speakRequestBody(text, opts)),
        signal: abort.signal,
      });
    } catch {
      const e = new Error(stopped ? "abgebrochen" : t("Nyx kann gerade nicht sprechen – die Verbindung zum Server fehlt."));
      rejectStarted(e);
      if (stopped) return { voice: "", fallback: false, seconds: 0 };
      throw e;
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const e = new Error(errorSentence(res.status, body));
      rejectStarted(e);
      throw e;
    }
    const voice = res.headers.get("x-nyx-voice") ?? opts.voice ?? "";
    const fallback = res.headers.get("x-nyx-voice-fallback") === "1";
    const voicesHeader = res.headers.get("x-nyx-voices");
    const voices = voicesHeader ? voicesHeader.split(",").map((v) => v.trim()).filter(Boolean) : voice ? [voice] : [];
    const reader = res.body.getReader();
    activeReader = reader;
    if (stopped) void reader.cancel().catch(() => undefined);
    const decode = createPcm16Decoder();
    let head = new Uint8Array(0);
    let sampleRate = 0;
    let pending: Float32Array[] = [];
    let pendingLen = 0;
    let first = true;
    const flush = () => {
      if (!pendingLen || stopped) return;
      const block = new Float32Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        block.set(p, o);
        o += p.length;
      }
      pending = [];
      pendingLen = 0;
      schedule(block, sampleRate);
      if (first) {
        first = false;
        resolveStarted({ voice, voices, fallback, sampleRate, firstSoundMs: Math.round(performance.now() - t0) });
      }
    };
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end || stopped) break;
        let chunk = value;
        if (!sampleRate) {
          const joined = new Uint8Array(head.byteLength + chunk.byteLength);
          joined.set(head);
          joined.set(chunk, head.byteLength);
          if (joined.byteLength < NYX_VOICE_STREAM_HEADER_BYTES) {
            head = joined;
            continue;
          }
          const info = parseStreamHeader(joined);
          if (!info) throw new Error(t("Nyx kann gerade nicht sprechen – die Antwort steht im Chat."));
          sampleRate = info.sampleRate;
          chunk = joined.subarray(NYX_VOICE_STREAM_HEADER_BYTES);
        }
        const samples = decode(chunk);
        if (samples.length) {
          pending.push(samples);
          pendingLen += samples.length;
        }
        if (pendingLen >= sampleRate * MIN_BLOCK_S) flush();
      }
      flush();
    } catch (err) {
      if (!stopped) {
        // Abbruch mitten im Ton (Netz weg, Dienst neu gestartet): nie englischen Technik-Text zeigen.
        const known = err instanceof Error && /^Nyx /.test(err.message);
        const e = known ? (err as Error) : new Error(t("Nyx kann gerade nicht sprechen – die Antwort steht im Chat."));
        rejectStarted(e);
        stop();
        throw e;
      }
    }
    if (first) rejectStarted(new Error(stopped ? "abgebrochen" : t("Nyx hat nichts gesagt.")));
    if (!stopped && sources.size > 0) await new Promise<void>((r) => (finishPlayback = r));
    return { voice, fallback, seconds: Number(seconds.toFixed(2)) };
  })().finally(() => {
    opts.signal?.removeEventListener("abort", onOuterAbort);
    analyser?.disconnect();
    if (ownContext && ctx) void ctx.close?.().catch(() => undefined);
  });

  return {
    started,
    done,
    stop,
    level() {
      if (!analyser || !levelBuf) return 0;
      analyser.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (const v of levelBuf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / levelBuf.length) * 4);
    },
  };
}
