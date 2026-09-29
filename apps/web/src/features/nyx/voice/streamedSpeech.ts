// Einen Satz von Nyx gestreamt sprechen – gemeinsam für den Begleiter
// (`voice/speaker.ts`) und den Nyx-Tab (`tab/voice/speaker.ts`). Der erste Ton kommt, während der Server noch rechnet.
//
// Regeln:
// - Nur wenn der Browser es kann (Web Audio + ReadableStream) und der Kontext der Seite mitkommt (derselbe, den
//   `unlock.ts` in Safari weckt). Sonst `null` → der Sprecher nimmt den Ganz-WAV-Weg.
// - Scheitert der Stream vor dem ersten Ton, meldet `started` "failed": der Sprecher holt denselben Satz als ganzes
//   WAV (nichts hat geklungen, also nie doppelt). Danach 5 Minuten gleich der Ganz-WAV-Weg (kein doppeltes Warten).
// - Ducken über einen eigenen GainNode je Satz (wie `audio.volume` im Ganz-WAV-Weg).
// - Tempo nur über `speed` an den Server – nie `playbackRate`.
import { playNyxSpeechStream } from "../../../lib/nyxSpeechStream";

/** Lautstärke beim „Ducken“ (du könntest reden – erst die Transkription entscheidet). */
export const DUCK_VOLUME = 0.25;

const RETRY_STREAM_MS = 5 * 60_000;
/** So lange darf ein angehaltener Kontext (Safari ohne Geste) zum Aufwachen brauchen, sonst Ganz-WAV-Weg. */
const WAKE_WAIT_MS = 500;
/** Grobe Sprechdauer je Zeichen (Piper/Pocket, Tempo 1) – nur für „gehört bis hier“ beim Unterbrechen. */
const SECONDS_PER_CHAR = 0.06;

let streamOffUntil = 0;

/** Läuft der Kontext (oder wacht er gleich auf)? Ein angehaltener Kontext spielt nichts – der Satz hinge sonst. */
async function contextRunning(ctx: AudioContext): Promise<boolean> {
  // Als Funktion gelesen: der Zustand ändert sich zwischen den Abfragen (resume läuft asynchron).
  const running = () => (ctx.state as AudioContextState | undefined) === "running" || ctx.state === undefined;
  if (running()) return true;
  void ctx.resume?.()?.catch(() => undefined);
  const deadline = performance.now() + WAKE_WAIT_MS;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    if (running()) return true;
  }
  return false;
}

/** Nach einem Fehler wieder sofort streamen (Tests, Stimme neu gewählt). */
export function resetSpeechStreamBackoff(): void {
  streamOffUntil = 0;
}

export function speechStreamSupported(ctx: AudioContext | null): ctx is AudioContext {
  return (
    !!ctx &&
    ctx.state !== "closed" &&
    typeof ctx.createGain === "function" &&
    typeof ctx.createBufferSource === "function" &&
    typeof ReadableStream !== "undefined" &&
    typeof Response !== "undefined" &&
    "body" in Response.prototype &&
    Date.now() >= streamOffUntil
  );
}

/** "playing" = erster Ton eingeplant · "failed" = nichts geklungen → Ganz-WAV-Weg · "stopped" = abgebrochen. */
export type StreamStart = "playing" | "failed" | "stopped";

export interface StreamedSentence {
  started: Promise<StreamStart>;
  /** Satz zu Ende (gespielt, abgebrochen oder mittendrin gescheitert). Lehnt nie ab. */
  done: Promise<void>;
  stop(): void;
  /** Pegel 0–1 für die Animation. */
  level(): number;
  duck(on: boolean): void;
  /** Wie viel vom Satz schon geklungen hat (0–1, geschätzt). */
  heardFraction(): number;
}

export interface StreamSentenceOptions {
  /** Gemeinsamer, bei der Geste geweckter AudioContext. `null` → kein Stream. */
  context: AudioContext | null;
  voice?: string | null;
  /** Englische Stimme für englische Sätze. */
  voiceEn?: string | null;
  speed?: number;
  signal?: AbortSignal;
  /** Satz beginnt schon leise (du redest gerade). */
  ducked?: boolean;
}

export function streamSentence(text: string, opts: StreamSentenceOptions): StreamedSentence | null {
  const ctx = opts.context;
  if (!speechStreamSupported(ctx) || opts.signal?.aborted) return null;
  let gain: GainNode;
  try {
    gain = ctx.createGain();
    gain.gain.value = opts.ducked ? DUCK_VOLUME : 1;
    gain.connect(ctx.destination);
  } catch {
    return null;
  }
  let stopped = false;
  let firstSoundAt = 0;
  const playback = playNyxSpeechStream(text, { voice: opts.voice, voiceEn: opts.voiceEn, speed: opts.speed, context: ctx, signal: opts.signal, output: gain });
  const started = playback.started.then(
    async (): Promise<StreamStart> => {
      // Safari: Kontext noch nicht per Geste geweckt → nichts klingt. Abbrechen (still, also nie doppelt) und das
      // ganze WAV nehmen – das <audio>-Element meldet sich dann selbst, statt die Warteschlange hängen zu lassen.
      if (!(await contextRunning(ctx))) {
        playback.stop();
        return stopped ? "stopped" : "failed";
      }
      if (stopped) return "stopped";
      firstSoundAt = performance.now();
      return "playing";
    },
    (): StreamStart => {
      if (stopped || opts.signal?.aborted) return "stopped";
      streamOffUntil = Date.now() + RETRY_STREAM_MS;
      return "failed";
    },
  );
  const done = playback.done.then(
    () => undefined,
    () => undefined,
  );
  void done.then(() => {
    try {
      gain.disconnect();
    } catch {
      // schon getrennt
    }
  });
  return {
    started,
    done,
    stop() {
      stopped = true;
      playback.stop();
    },
    level: () => playback.level(),
    duck(on) {
      gain.gain.value = on ? DUCK_VOLUME : 1;
    },
    heardFraction() {
      if (!firstSoundAt) return 0;
      const estimate = Math.max(0.5, text.length * SECONDS_PER_CHAR);
      return Math.min(0.95, (performance.now() - firstSoundAt) / 1000 / estimate);
    },
  };
}
