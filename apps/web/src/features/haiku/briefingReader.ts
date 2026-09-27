// Briefing zum Anhören: liest die Sprechfassung Satz für Satz über die Server-Stimme vor.
//
// Ablauf je Satz: Stimme beim Server anfragen (der NÄCHSTE Satz wird schon angefragt, während der aktuelle
// läuft) → abspielen → weiter. Tempo geht nur als `speed` an den Server, die Wiedergabe bleibt bei
// `playbackRate = 1` (bekannter Fehler: Safari/WebKit verzerrt bzw. ignoriert sonst das Tempo). Änderst du
// das Tempo, gilt es ab dem nächsten Satz (schon vorgeladene Sätze werden neu angefragt).
// Ohne Stimme: ehrlicher Hinweis, keine stille Wiedergabe. Blockiert der Browser den Ton (Autoplay), steht der
// Vorleser auf Pause mit „Weiter“ – ein Tipp startet denselben Satz.
import { t, type BriefSpeechSentence } from "@nyxos/shared";
import { reportNyxLevel } from "../nyx/voice/levelBus";
import { playbackLevelReader, wakePlaybackLevel } from "../nyx/voice/playbackLevel";
import { synthesize } from "../nyx/voice/serverVoice";

export type ReaderState = "idle" | "loading" | "playing" | "paused" | "done" | "error";

export interface ReaderSnapshot {
  state: ReaderState;
  /** Index des aktuellen Satzes (-1 = noch keiner). */
  index: number;
  sentence: BriefSpeechSentence | null;
  total: number;
  speed: number;
  /** Hinweis in einfachen Worten (Stimme fehlt, Ton blockiert). */
  message: string | null;
}

export interface PlayHandle {
  /** true = Ton läuft; false = der Browser hat ihn blockiert (braucht einen Tipp). */
  started: Promise<boolean>;
  /** Löst auf, wenn der Satz zu Ende ist (oder gestoppt wurde). */
  done: Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface ReaderDeps {
  synth(text: string, speed: number, signal: AbortSignal): Promise<Blob | null>;
  play(blob: Blob): PlayHandle;
  /** Im Klick aufrufen (synchron): schaltet den Ton für die folgenden Sätze frei (Safari/iOS). */
  unlock?(): void;
  /** Seite verlassen: Ton aus, Element und Blob-URLs freigeben. */
  dispose?(): void;
}

export interface BriefingReader {
  start(from?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setSpeed(speed: number): void;
  snapshot(): ReaderSnapshot;
}

export const NO_VOICE_TEXT = t("Die Stimme antwortet gerade nicht – bitte gleich noch einmal versuchen.");
export const BLOCKED_TEXT = t("Der Browser wartet auf dich: tippe auf „Weiter“, dann lese ich vor.");

export function createBriefingReader(sentences: BriefSpeechSentence[], deps: ReaderDeps, onChange: (s: ReaderSnapshot) => void, opts: { speed: number }): BriefingReader {
  let state: ReaderState = "idle";
  let index = -1;
  let speed = opts.speed;
  let message: string | null = null;
  let run = 0; // jede neue Wiedergabe bekommt eine Nummer; alte Schritte laufen ins Leere
  let abort = new AbortController();
  let handle: PlayHandle | null = null;
  const cache = new Map<number, { speed: number; audio: Promise<Blob | null> }>();

  const snapshot = (): ReaderSnapshot => ({ state, index, sentence: index >= 0 && state !== "idle" && state !== "done" ? (sentences[index] ?? null) : null, total: sentences.length, speed, message });
  const emit = () => onChange(snapshot());

  const audioFor = (i: number): Promise<Blob | null> | null => {
    const s = sentences[i];
    if (!s) return null;
    const hit = cache.get(i);
    if (hit && hit.speed === speed) return hit.audio;
    const audio = deps.synth(s.text, speed, abort.signal).catch(() => null);
    cache.set(i, { speed, audio });
    return audio;
  };

  async function playFrom(start: number, my: number) {
    for (let i = start; i < sentences.length; i++) {
      if (my !== run) return;
      const audio = audioFor(i);
      if (i === start) {
        index = i;
        state = "loading";
        emit();
      }
      const blob = await audio;
      if (my !== run) return;
      if (!blob) {
        state = "error";
        message = NO_VOICE_TEXT;
        handle = null;
        emit();
        return;
      }
      index = i;
      state = "playing";
      message = null;
      handle = deps.play(blob);
      emit();
      audioFor(i + 1); // genau ein Satz voraus
      const current = handle;
      const started = await current.started;
      if (my !== run) return;
      if (!started) {
        state = "paused";
        message = BLOCKED_TEXT;
        emit();
      }
      await current.done;
      if (my !== run) return;
      cache.delete(i);
    }
    if (my !== run) return;
    state = "done";
    index = -1;
    handle = null;
    emit();
  }

  return {
    start(from = 0) {
      run++;
      abort.abort();
      abort = new AbortController();
      cache.clear();
      handle?.stop();
      handle = null;
      message = null;
      void playFrom(Math.max(0, Math.min(from, sentences.length - 1)), run);
    },
    pause() {
      if (state !== "playing" || !handle) return;
      handle.pause();
      state = "paused";
      emit();
    },
    resume() {
      if (state !== "paused" || !handle) return;
      handle.resume();
      state = "playing";
      message = null;
      emit();
    },
    stop() {
      run++;
      abort.abort();
      cache.clear();
      handle?.stop();
      handle = null;
      state = "idle";
      index = -1;
      message = null;
      emit();
    },
    setSpeed(next) {
      if (next === speed) return;
      speed = next;
      // Schon vorgeladene Sätze mit altem Tempo neu anfragen (der laufende Satz spielt zu Ende).
      for (const [i, entry] of cache) if (i > index && entry.speed !== speed) cache.delete(i);
      if (state === "playing" || state === "paused") audioFor(index + 1);
      emit();
    },
    snapshot,
  };
}

// ───────────────────────────── Browser-Teile ─────────────────────────────

/** 10 ms Stille (WAV) – nur, um das Element im Klick für Safari freizuschalten. */
const SILENCE =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const isNotAllowed = (err: unknown) => err instanceof DOMException && err.name === "NotAllowedError";

/**
 * EIN `<audio>` für alle Sätze eines Vorlesens (wie Nyx' Sprecher). Safari/iOS erlaubt Ton ohne neuen Tipp nur
 * einem Element, das schon einmal im Klick gestartet wurde – mit einem neuen `Audio()` je Satz wäre der Ton ab
 * Satz 2 wieder gesperrt. `unlock()` läuft deshalb synchron im Klick auf „Vorlesen“.
 * Tempo immer 1 (das Tempo kommt vom Server). Blob-URLs werden am Satzende bzw. bei Stopp freigegeben.
 */
export function createBrowserReaderDeps(): ReaderDeps {
  let el: HTMLAudioElement | null = null;
  let stopCurrent: (() => void) | null = null;
  const element = () => {
    if (!el) {
      el = new Audio();
      el.preload = "auto";
    }
    return el;
  };

  return {
    synth: (text, speed, signal) => synthesize(text, { speed, signal }),
    unlock() {
      wakePlaybackLevel(); // Pegel fürs Nyx-Logo ab dem ersten Satz
      if (stopCurrent) return; // ein Satz läuft schon – das Element ist frei
      const a = element();
      a.src = SILENCE;
      void Promise.resolve(a.play()).catch(() => {});
    },
    play(blob) {
      stopCurrent?.();
      const audio = element();
      const url = URL.createObjectURL(blob);
      audio.src = url;
      audio.playbackRate = 1;
      // Das Nyx-Logo bewegt sich mit der Vorlese-Stimme (gemeinsamer Pegel, solange der Satz läuft).
      const unreport = reportNyxLevel(playbackLevelReader(audio));
      let finished = false;
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => (resolveDone = r));
      const finish = () => {
        if (finished) return;
        finished = true;
        unreport();
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", finish);
        if (stopCurrent === stop) stopCurrent = null;
        URL.revokeObjectURL(url);
        resolveDone();
      };
      const stop = () => {
        audio.pause();
        finish();
      };
      stopCurrent = stop;
      audio.addEventListener("ended", finish);
      audio.addEventListener("error", finish);
      const started = (async () => {
        try {
          await audio.play();
          return true;
        } catch (err) {
          if (isNotAllowed(err)) return false;
          finish();
          return true;
        }
      })();
      return {
        started,
        done,
        pause: () => audio.pause(),
        // „Weiter“ ist immer ein Tipp – bleibt der Ton trotzdem gesperrt, nicht still zum nächsten Satz springen.
        resume: () => void audio.play().catch((err: unknown) => (isNotAllowed(err) ? undefined : finish())),
        stop,
      };
    },
    dispose() {
      stopCurrent?.();
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
      el = null;
    },
  };
}
