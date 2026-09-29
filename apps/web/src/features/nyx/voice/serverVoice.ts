// Stimme über den eigenen Server.
//   POST /api/nyx/voice/transcribe  (Audio)            → {text, language, ms}
//   POST /api/nyx/voice/speak       {text, voice?}      → audio/ogg (bzw. ?format=wav)
// Fehlt die Server-Erkennung, fällt die Erkennung sauber auf den bestehenden Sprach-Weg
// (`/api/voice/transcribe`, Brücke) zurück; fehlt die Sprachausgabe, bleibt Nyx ehrlich stumm (Text bleibt).
import { t } from "@nyxos/shared";
import { authFetch } from "../../terminal/authClient";
import { speakRequestBody, type NyxSpeakLanguage } from "../../../lib/nyxSpeechStream";

export interface Transcript {
  text: string;
  ms: number;
  /** Welcher Weg erkannt hat: eigener Server oder der alte Weg über die Brücke. */
  via: "nyx" | "bridge";
}

/** Diese Antworten heißen „gibt es (noch) nicht“ – dann Rückfall statt Fehler. */
const MISSING = new Set([404, 405, 415, 501]);
const RETRY_MISSING_MS = 5 * 60_000;
let nyxSttMissingUntil = 0;
let nyxTtsMissingUntil = 0;

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const msg = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : null;
  return msg && !/^[a-z_]+$/.test(msg) ? msg : fallback;
}

export async function transcribe(audio: Blob, opts: { signal?: AbortSignal; audioSeconds?: number } = {}): Promise<Transcript> {
  const type = audio.type || "audio/webm";
  if (Date.now() >= nyxSttMissingUntil) {
    const started = performance.now();
    const res = await authFetch("/api/nyx/voice/transcribe", { method: "POST", headers: { "content-type": type }, body: audio, signal: opts.signal });
    if (res.ok) {
      const b = (await res.json()) as { text?: string; ms?: number };
      return { text: (b.text ?? "").trim(), ms: b.ms ?? Math.round(performance.now() - started), via: "nyx" };
    }
    if (!MISSING.has(res.status)) throw new Error(await errorText(res, t("Die Erkennung auf dem Server hat nicht geklappt – bitte noch einmal sprechen.")));
    nyxSttMissingUntil = Date.now() + RETRY_MISSING_MS;
  }
  const secs = (opts.audioSeconds ?? 0).toFixed(1);
  const res = await authFetch(`/api/voice/transcribe?target=haiku&audioSeconds=${secs}`, { method: "POST", headers: { "content-type": type }, body: audio, signal: opts.signal });
  if (!res.ok) throw new Error(await errorText(res, t("Die Erkennung hat nicht geklappt – bitte noch einmal sprechen.")));
  const b = (await res.json()) as { text?: string; tookMs?: number };
  return { text: (b.text ?? "").trim(), ms: b.tookMs ?? 0, via: "bridge" };
}

export type SpeakAvailability = "unknown" | "ready" | "missing";
let speakState: SpeakAvailability = "unknown";
const speakListeners = new Set<(s: SpeakAvailability) => void>();

export function speakAvailability(): SpeakAvailability {
  return speakState;
}
export function onSpeakAvailability(fn: (s: SpeakAvailability) => void): () => void {
  speakListeners.add(fn);
  return () => speakListeners.delete(fn);
}
function setSpeakState(s: SpeakAvailability) {
  if (s === speakState) return;
  speakState = s;
  for (const l of speakListeners) l(s);
}

function preferWav(): boolean {
  try {
    return new Audio().canPlayType('audio/ogg; codecs="opus"') === "";
  } catch {
    return true;
  }
}

/** Erzeugt die Stimme für einen Satz. `null` = keine Sprachausgabe verfügbar (ehrlich stumm). */
export async function synthesize(
  text: string,
  opts: { voice?: string | null; voiceEn?: string | null; language?: NyxSpeakLanguage; speed?: number; signal?: AbortSignal } = {},
): Promise<Blob | null> {
  if (Date.now() < nyxTtsMissingUntil) return null;
  try {
    const res = await authFetch(`/api/nyx/voice/speak${preferWav() ? "?format=wav" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(speakRequestBody(text, opts)),
      signal: opts.signal,
    });
    if (!res.ok) {
      if (MISSING.has(res.status) || res.status === 503) {
        nyxTtsMissingUntil = Date.now() + RETRY_MISSING_MS;
        setSpeakState("missing");
      }
      return null;
    }
    setSpeakState("ready");
    return await res.blob();
  } catch {
    return null;
  }
}
