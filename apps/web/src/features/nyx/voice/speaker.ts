// Nyx spricht – Satz für Satz, während die Antwort noch entsteht, und sofort abbrechbar.
//
// Übernommen und angepasst aus adewaskar/jarvis `src/lib/tts.ts` `createSpeaker` (MIT, © 2026 Aditya
// Dewaskar, s. NOTICE): Warteschlange, Audio für genau EINEN Satz voraus erzeugen, ein gemeinsamer
// AudioContext für alle Sätze (Chrome erlaubt nur ~6), `onpause = finish` (ein pausiertes <audio> feuert nie
// `ended`), `cancel()` löst `end()` immer auf. Geändert: Motor = `POST /api/nyx/voice/speak` statt
// ElevenLabs/Systemstimme; ohne Server-Stimme ehrlich stumm (bewusst kein Apple-/Browser-Ersatz).
import { readNyxSettings } from "../tab/settings";
import { createSentenceChunker } from "./chunker";
import { synthesize } from "./serverVoice";
import { DUCK_VOLUME, streamSentence, type StreamedSentence } from "./streamedSpeech";
import { registerAudioContext } from "./unlock";

export { DUCK_VOLUME };

export interface Speaker {
  /** Neues Stück Antwort-Text (Strom). */
  push(delta: string): void;
  /** Ganzen Satz vorne einreihen (z. B. „Moment.“). */
  say(text: string): void;
  /** Kein Text mehr – Rest sprechen; löst auf, wenn alles gesagt ist. */
  end(): Promise<void>;
  /** Sofort still (Unterbrechen). Löst `end()` immer auf. */
  cancel(): void;
  /** Ausgangs-Pegel 0–1 (für das Netz). */
  level(): number;
  /** Was gerade gesprochen wird (für den Echo-Filter). */
  speakingText(): string;
  /** Seit wann der aktuelle Satz läuft (performance.now(), 0 = still). */
  speakingSince(): number;
  isSpeaking(): boolean;
  /** Alles noch nicht Klingende verwerfen (Warteschlange + halber Satz), den laufenden Satz ausklingen lassen. */
  dropQueued(): void;
  /** Leiser stellen, solange unklar ist, ob du wirklich redest (Unterbrechen erst nach Worten). */
  duck(on: boolean): void;
}

let sharedCtx: AudioContext | null = null;
function outputContext(): AudioContext | null {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedCtx) {
      sharedCtx = new AudioCtx();
      registerAudioContext(sharedCtx);
    }
    if (sharedCtx.state === "suspended") void sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch {
    return null;
  }
}

interface Item {
  text: string;
  audio?: Promise<Blob | null>;
}

/** Nachlauf, in dem das Mikrofon noch Nyx' eigene Stimme hören kann (Echo-Filter). */
export const ECHO_TAIL_MS = 1800;

export function createSpeaker(opts: { voice?: string; voiceEn?: string; onSpeakingChange?: (speaking: boolean) => void } = {}): Speaker {
  const queue: Item[] = [];
  let cancelled = false;
  let pumping = false;
  let outLevel = 0;
  let current: HTMLAudioElement | null = null;
  /** Satz, der gerade gestreamt klingt (statt `current`). */
  let currentStream: StreamedSentence | null = null;
  let ducked = false;
  let speaking = "";
  let lastSpoken = "";
  let lastSpokenAt = 0;
  let since = 0;
  let drained: (() => void)[] = [];
  const abort = new AbortController();

  const settle = () => {
    const w = drained;
    drained = [];
    for (const r of w) r();
  };
  const setSpeaking = (t: string) => {
    if (t) {
      speaking = t;
      since = performance.now();
    } else {
      if (speaking) {
        lastSpoken = speaking;
        lastSpokenAt = performance.now();
      }
      speaking = "";
      since = 0;
    }
    opts.onSpeakingChange?.(!!t);
  };

  // Stimme und Tempo aus den Nyx-Einstellungen (vorher sprach die Leiste immer im Standard-Tempo mit
  // der Standard-Stimme – der Tempo-Regler wirkte nur im Nyx-Tab). Beim Sprechen gelesen, damit Änderungen sofort gelten.
  const voiceOpts = () => {
    const s = readNyxSettings();
    return { voice: opts.voice ?? s.voice ?? undefined, voiceEn: opts.voiceEn ?? s.voiceEn ?? undefined, speed: s.rate };
  };
  const prime = (item: Item | undefined) => {
    if (item && !item.audio) item.audio = synthesize(item.text, { ...voiceOpts(), signal: abort.signal });
  };

  const playBlob = (blob: Blob) =>
    new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = ducked ? DUCK_VOLUME : 1;
      current = audio;
      let read: (() => number) | null = null;
      const ctx = outputContext();
      if (ctx) {
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaElementSource(audio).connect(analyser);
          analyser.connect(ctx.destination);
          const bins = new Uint8Array(analyser.frequencyBinCount);
          read = () => {
            analyser.getByteFrequencyData(bins);
            let sum = 0;
            for (let i = 2; i < bins.length; i++) sum += bins[i] ?? 0;
            return Math.min(1, (sum / (bins.length - 2) / 255) * 3.5);
          };
        } catch {
          // Pegel ist nur Beiwerk
        }
      }
      let raf = 0;
      const tick = () => {
        outLevel = read ? read() : 0.45;
        raf = requestAnimationFrame(tick);
      };
      tick();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        outLevel = 0;
        URL.revokeObjectURL(url);
        if (current === audio) current = null;
        resolve();
      };
      audio.onended = finish;
      audio.onerror = finish;
      audio.onpause = finish;
      void audio.play().catch(finish);
    });

  /**
   * Satz gestreamt sprechen (erster Ton früher). `false` = nichts hat geklungen → Ganz-WAV-Weg.
   * Nur für Sätze, die noch nicht vorab als ganzes WAV geholt wurden (sonst liegt der Ton ja schon bereit).
   */
  const playStream = async (item: Item, s: StreamedSentence): Promise<boolean> => {
    currentStream = s;
    try {
      const start = await s.started;
      if (start === "failed") return false;
      if (start === "stopped" || cancelled) {
        s.stop();
        return true;
      }
      setSpeaking(item.text);
      let raf = 0;
      const tick = () => {
        outLevel = s.level();
        raf = requestAnimationFrame(tick);
      };
      tick();
      await s.done;
      cancelAnimationFrame(raf);
      outLevel = 0;
      if (!cancelled) setSpeaking(""); // nach cancel() schon still gemeldet
      return true;
    } finally {
      if (currentStream === s) currentStream = null;
    }
  };

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (cancelled) break;
        const item = queue.shift();
        if (!item) break;
        const stream = item.audio ? null : streamSentence(item.text, { context: outputContext(), ...voiceOpts(), signal: abort.signal, ducked });
        if (!stream) prime(item);
        prime(queue[0]); // genau ein Satz voraus (als ganzes WAV: liegt bereit, wenn der Satz davor endet)
        if (stream && (await playStream(item, stream))) continue;
        if (cancelled) break;
        prime(item); // Rückfall: Stream hat nicht geklungen
        const blob = await item.audio;
        if (cancelled) break;
        if (!blob) continue; // keine Server-Stimme: still weiter (Text steht in der Blase)
        setSpeaking(item.text);
        await playBlob(blob);
        setSpeaking("");
      }
    } finally {
      pumping = false;
      if (cancelled || !queue.length) settle();
    }
  }

  const chunker = createSentenceChunker((sentence) => {
    if (cancelled) return;
    queue.push({ text: sentence });
    void pump();
  });

  return {
    push: (delta) => {
      if (!cancelled) chunker.push(delta);
    },
    say(text) {
      if (cancelled || !text.trim()) return;
      queue.unshift({ text: text.trim() });
      void pump();
    },
    async end() {
      chunker.end();
      if (cancelled || (!pumping && !queue.length)) return;
      await new Promise<void>((r) => drained.push(r));
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      chunker.reset();
      queue.length = 0;
      if (current) {
        current.pause();
        current = null;
      }
      currentStream?.stop();
      currentStream = null;
      setSpeaking("");
      outLevel = 0;
      settle();
    },
    dropQueued() {
      chunker.reset();
      queue.length = 0;
    },
    level: () => outLevel,
    speakingText: () => speaking || (performance.now() - lastSpokenAt < ECHO_TAIL_MS ? lastSpoken : ""),
    speakingSince: () => since,
    isSpeaking: () => !!speaking,
    duck(on) {
      ducked = on;
      if (current) current.volume = on ? DUCK_VOLUME : 1;
      currentStream?.duck(on);
    },
  };
}
