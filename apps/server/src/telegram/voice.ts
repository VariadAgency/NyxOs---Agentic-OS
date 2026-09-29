// Stimme für Telegram — kleine Schnittstelle vor dem Stimmen-Dienst `nyx-voice` aus N3 (Container im
// Projekt „nyxos“, nur internes Netz). Sprachnachrichten kommen als OGG/Opus und gehen als OGG/Opus zurück
// (`sendVoice` nimmt nur OGG/Opus; N3 kodiert libopus 64k, 48 kHz, mono). erkannt wird Deutsch UND Englisch
// (keine feste Sprache), die erkannte Sprache kommt mit.
//
// Anschluss nach dem Merge: `adaptNyxVoiceBackend(createApp(...).nyxVoice)` — N3s `NyxVoiceBackend` ist hier
// nur strukturell getippt, damit beide Zweige unabhängig bauen. Bis dahin spricht {@link nyxVoiceFromEnv} den
// Dienst direkt über `NYXOS_NYX_VOICE_URL` an (dieselben Pfade wie N3s `HttpNyxVoiceBackend`).

import { t } from "@nyxos/shared";

export interface TelegramVoice {
  transcribe(audio: Uint8Array, mime: string): Promise<{ text: string; language?: string }>;
  speak(text: string): Promise<{ audio: Uint8Array; contentType: string; seconds: number }>;
  status(): Promise<{ ready: boolean; sentence: string }>;
}

/** Strukturell wie N3s `NyxVoiceBackend` (apps/server/src/nyx/voice-backend.ts). */
export interface NyxVoiceBackendLike {
  status(): Promise<{ stt: { ready: boolean }; tts: { ready: boolean } }>;
  transcribe(audio: Uint8Array, opts: { mime: string; language: string }): Promise<{ text: string; language?: string }>;
  speak(req: { text: string; voice?: string }, format: "ogg" | "wav"): Promise<{ audio: Uint8Array; contentType: string; audioSeconds: number }>;
}

export function adaptNyxVoiceBackend(backend: NyxVoiceBackendLike): TelegramVoice {
  return {
    transcribe: (audio, mime) => backend.transcribe(audio, { mime, language: "auto" }),
    async speak(text) {
      const r = await backend.speak({ text }, "ogg");
      return { audio: r.audio, contentType: r.contentType, seconds: r.audioSeconds };
    },
    async status() {
      try {
        const s = await backend.status();
        if (s.stt.ready && s.tts.ready) return { ready: true, sentence: t("Sprachnachrichten gehen hin und zurück.") };
        return { ready: false, sentence: t("Die Stimme auf dem Server lädt noch – Sprachnachrichten gehen gleich.") };
      } catch {
        return { ready: false, sentence: t("Die Stimme auf dem Server antwortet gerade nicht – Nyx schreibt dann nur.") };
      }
    },
  };
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SPEAK_TIMEOUT_MS = 60_000;

/** Direkt über HTTP (Pfade des Stimmen-Dienstes: `/health`, `/transcribe?language=de`, `/speak?format=ogg`). */
export function httpNyxVoice(baseUrl: string, fetchImpl: typeof fetch = fetch): TelegramVoice {
  const base = baseUrl.replace(/\/$/, "");
  const call = async (path: string, init: RequestInit, timeoutMs: number) => {
    const res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Stimmen-Dienst antwortet mit ${res.status}`);
    return res;
  };
  return adaptNyxVoiceBackend({
    status: async () => (await (await call("/health", { method: "GET" }, 2500)).json()) as { stt: { ready: boolean }; tts: { ready: boolean } },
    transcribe: async (audio, opts) =>
      (await (await call(`/transcribe?language=${encodeURIComponent(opts.language)}`, { method: "POST", headers: { "content-type": opts.mime }, body: audio }, TRANSCRIBE_TIMEOUT_MS)).json()) as { text: string; language?: string },
    speak: async (req, format) => {
      const res = await call(`/speak?format=${format}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }, SPEAK_TIMEOUT_MS);
      return { audio: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "audio/ogg", audioSeconds: Number(res.headers.get("x-nyx-audio-seconds") ?? "0") || 0 };
    },
  });
}

export function nyxVoiceFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramVoice | null {
  const url = env.NYXOS_NYX_VOICE_URL?.trim();
  return url ? httpNyxVoice(url) : null;
}
