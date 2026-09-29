// Nyx spricht — Satz für Satz, während die Antwort noch strömt, genau einen Satz voraus erzeugt, sofort
// abbrechbar. Übernommen aus adewaskar/jarvis `src/lib/tts.ts` (`createSpeaker`: push/end/cancel, `pump`,
// `prime` „exactly one sentence ahead“, `audio.onpause` als Ende; MIT, s. NOTICE). Der Motor ist nicht mehr
// ElevenLabs/Browser, sondern der eigene Server (`POST /api/nyx/voice/speak`). Zusätzlich merkt er sich,
// was du schon gehört hast (für „unterbrochen“ im Verlauf) und liefert den Ausgangspegel fürs Netz.
import { t } from "@nyxos/shared";
import { createSentenceChunker } from "../../voice/chunker";
import { DUCK_VOLUME, type StreamedSentence } from "../../voice/streamedSpeech";
import { registerAudioContext } from "../../voice/unlock";
import { FALL_MS, followEnvelope, RISE_MS, type LevelDrive } from "./level";
import { heardText } from "../../voice/turn";

export type Synth = (text: string, signal: AbortSignal) => Promise<Blob>;

/**
 * Satz gestreamt starten (`streamSentence` aus `voice/streamedSpeech.ts`). Bekommt den Kontext des
 * Sprechers (derselbe, den `unlock.ts` in Safari weckt). `null` = geht nicht → Ganz-WAV-Weg über `Synth`.
 */
export type StreamSynth = (text: string, context: AudioContext | null, signal: AbortSignal, ducked: boolean) => StreamedSentence | null;

export interface SpeakerHooks {
  /** Ein Satz fängt an zu klingen (erster Satz = „erster Ton“ für die Messung). */
  onSentenceStart?: (text: string, index: number) => void;
  /** Alles gesagt (oder abgebrochen). */
  onDrained?: () => void;
  onError?: (message: string) => void;
}

export interface Speaker {
  push(delta: string): void;
  /** Text ist komplett — Rest noch sagen. */
  end(): void;
  /** Sofort still. Liefert, was du bis hierhin gehört hast. */
  cancel(): string;
  /** Neue Antwort (nach cancel/drain). */
  reset(): void;
  speaking(): boolean;
  /** performance.now() beim Start des aktuellen Satzes (für den Selbst-Echo-Schutz). */
  sentenceStartedAt(): number;
  /** Alles, was in dieser Antwort schon gesprochen wurde (für den Echo-Filter). */
  spokenText(): string;
  setRate(rate: number): void;
  /** Leiser, solange unklar ist, ob du wirklich redest (Unterbrechen erst nach echten Worten). */
  duck(on: boolean): void;
  dispose(): void;
}

interface Item {
  text: string;
  audio: Promise<Blob> | null;
}

export function createSpeaker(synth: Synth, drive: LevelDrive, hooks: SpeakerHooks = {}, source: { stream?: StreamSynth } = {}): Speaker {
  const el = new Audio();
  el.preload = "auto";
  // Tempo ohne Mickymaus-Stimme (Standard in allen aktuellen Browsern, hier ausdrücklich).
  (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let freq: Uint8Array<ArrayBuffer> | null = null;
  const ensureGraph = () => {
    if (ctx) return;
    try {
      // EIN geteilter Kontext für alle Sätze (Chrome erlaubt nur wenige gleichzeitig), Quelle nur einmal je Element.
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioCtx();
      registerAudioContext(ctx);
      const src = ctx.createMediaElementSource(el);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch {
      ctx = null;
    }
  };

  let queue: Item[] = [];
  let pumping = false;
  let cancelled = false;
  let ended = false;
  let controller = new AbortController();
  let current: Item | null = null;
  let startedAt = 0;
  let spoken: string[] = [];
  let heardDone: string[] = [];
  let index = 0;
  let raf = 0;
  let last = performance.now();
  let playing = false;
  let ducked = false;
  /** Satz, der gerade gestreamt klingt. */
  let currentStream: StreamedSentence | null = null;

  const levelLoop = () => {
    raf = requestAnimationFrame(levelLoop);
    const now = performance.now();
    const dt = now - last;
    last = now;
    let target = 0;
    if (playing && currentStream) {
      target = Math.min(1, currentStream.level());
    } else if (playing && analyser && freq) {
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 2; i < freq.length; i++) sum += freq[i] ?? 0;
      target = Math.min(1, (sum / (freq.length - 2) / 255) * 3);
    } else if (playing) {
      // Ohne Analyser (Web Audio blockiert): ein ruhiger Takt, damit das Netz trotzdem „spricht“.
      target = 0.45 + 0.25 * Math.sin(now / 90);
    }
    drive.output = followEnvelope(drive.output, target, target > drive.output ? RISE_MS : FALL_MS, dt);
  };
  raf = requestAnimationFrame(levelLoop);

  const prime = (item: Item | undefined) => {
    if (!item || item.audio) return;
    const signal = controller.signal;
    item.audio = synth(item.text, signal);
    item.audio.catch(() => undefined); // Fehler zeigt `speakOne`
  };

  const playBlob = (blob: Blob): Promise<void> =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        playing = false;
        el.onended = null;
        el.onpause = null;
        el.onerror = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      el.onended = finish;
      // Ein pausiertes <audio> feuert nie „ended“ — ohne das hinge die Warteschlange nach einem Abbruch.
      el.onpause = finish;
      el.onerror = finish;
      el.src = url;
      // Tempo macht der Server (speed) – hier nie zusätzlich dehnen (Safari: Artefakte).
      el.playbackRate = 1;
      void ctx?.resume();
      el.play().then(
        () => {
          playing = true;
        },
        () => finish(),
      );
    });

  /** Stream starten, solange für den Satz noch kein ganzes WAV unterwegs ist. */
  const startStream = (item: Item): StreamedSentence | null => {
    if (item.audio || !source.stream) return null;
    ensureGraph();
    return source.stream(item.text, ctx, controller.signal, ducked);
  };

  /** `false` = nichts hat geklungen (Stream gescheitert) → Ganz-WAV-Weg. */
  const playStream = async (item: Item, s: StreamedSentence): Promise<boolean> => {
    // Schon vor dem ersten Ton merken: Ducken/Unterbrechen wirken auch, während der Server noch rechnet.
    currentStream = s;
    const start = await s.started;
    if (start !== "playing" || cancelled) {
      if (currentStream === s) currentStream = null;
      s.stop();
      return start !== "failed";
    }
    current = item;
    startedAt = performance.now();
    spoken.push(item.text);
    playing = true;
    hooks.onSentenceStart?.(item.text, index++);
    await s.done;
    playing = false;
    if (currentStream === s) currentStream = null;
    if (!cancelled) heardDone.push(item.text);
    current = null;
    return true;
  };

  const speakOne = async (item: Item, stream: StreamedSentence | null) => {
    if (stream && (await playStream(item, stream))) return;
    if (cancelled) return;
    let blob: Blob;
    try {
      prime(item);
      blob = await (item.audio as Promise<Blob>);
    } catch (e) {
      if (!cancelled) hooks.onError?.(e instanceof Error ? e.message : t("Nyx kann gerade nicht sprechen – die Antwort steht rechts im Chat."));
      return;
    }
    if (cancelled) return;
    current = item;
    startedAt = performance.now();
    spoken.push(item.text);
    hooks.onSentenceStart?.(item.text, index++);
    await playBlob(blob);
    if (!cancelled) heardDone.push(item.text);
    current = null;
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    ensureGraph();
    try {
      for (;;) {
        if (cancelled) break;
        const item = queue.shift();
        if (!item) break;
        const stream = startStream(item);
        if (!stream) prime(item);
        // Genau einen Satz voraus: alles auf einmal anzustoßen hieße vier gleichzeitige Erzeugungen auf dem Server.
        // Der vorausgeholte Satz kommt als ganzes WAV – er liegt bereit, wenn der gestreamte davor endet.
        prime(queue[0]);
        await speakOne(item, stream);
      }
    } finally {
      pumping = false;
      if (!cancelled && queue.length === 0 && ended) hooks.onDrained?.();
      else if (!cancelled && queue.length > 0) void pump();
    }
  };

  const chunker = createSentenceChunker((sentence) => {
    if (cancelled) return;
    queue.push({ text: sentence, audio: null });
    void pump();
  });

  return {
    duck(on) {
      ducked = on;
      el.volume = on ? DUCK_VOLUME : 1;
      currentStream?.duck(on);
    },
    push(delta) {
      if (cancelled) return;
      chunker.push(delta);
    },
    end() {
      if (cancelled) return;
      ended = true;
      chunker.end();
      if (!pumping && queue.length === 0) hooks.onDrained?.();
    },
    cancel() {
      const fraction = currentStream
        ? currentStream.heardFraction()
        : current && el.duration > 0 && Number.isFinite(el.duration)
          ? el.currentTime / el.duration
          : 0;
      const heard = heardText(heardDone, current ? { text: current.text, fraction } : null);
      cancelled = true;
      controller.abort();
      queue = [];
      chunker.reset();
      currentStream?.stop();
      currentStream = null;
      try {
        el.pause();
      } catch {
        // schon still
      }
      playing = false;
      return heard;
    },
    reset() {
      el.volume = 1;
      ducked = false;
      cancelled = false;
      ended = false;
      controller = new AbortController();
      queue = [];
      current = null;
      spoken = [];
      heardDone = [];
      index = 0;
      chunker.reset();
    },
    speaking: () => playing || pumping,
    sentenceStartedAt: () => startedAt,
    spokenText: () => spoken.join(" "),
    setRate() {
      // Die Stimme kommt schon im gewünschten Tempo vom Server (speed) – hier nichts dehnen.
    },
    dispose() {
      cancelAnimationFrame(raf);
      controller.abort();
      currentStream?.stop();
      currentStream = null;
      try {
        el.pause();
      } catch {
        // egal
      }
      void ctx?.close();
      drive.output = 0;
    },
  };
}
