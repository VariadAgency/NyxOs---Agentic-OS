// ElevenLabs als zweiter Stimmen-Anbieter (optional, eigener API-Schlüssel vom Nutzer).
//   GET  https://api.elevenlabs.io/v1/voices                                  → Stimmen des Kontos
//   POST https://api.elevenlabs.io/v1/text-to-speech/{id}/stream?output_format=pcm_24000
//        → rohes PCM 16 bit mono little-endian, 24 kHz, stückweise (derselbe Strom-Vertrag wie nyx-voice: davor ein
//          44-Byte-WAV-Kopf mit offener Länge, s. packages/shared/src/nyx-voice.ts)
// Der Schlüssel geht nur als Kopfzeile `xi-api-key` an ElevenLabs – nie ins Protokoll, nie an den Browser.
import type { ElevenLabsModel, ElevenLabsVoice } from "@nyxos/shared";

export const ELEVENLABS_BASE = "https://api.elevenlabs.io";
/** Name im Geheimnis-Speicher (secrets/store.ts). */
export const ELEVENLABS_SECRET = "elevenlabs.api-key";
export const ELEVENLABS_SAMPLE_RATE = 24_000;
const VOICES_TIMEOUT_MS = 8_000;
/** Bis ElevenLabs mit dem ersten Byte antwortet; danach fließt der Ton, solange er kommt. */
const STREAM_START_TIMEOUT_MS = 12_000;
/** ElevenLabs erlaubt 0,7 … 1,2 als Tempo. */
const EL_SPEED_MIN = 0.7;
const EL_SPEED_MAX = 1.2;

/** `unauthorized` = Schlüssel falsch, `quota` = Guthaben/Limit, `offline` = nicht erreichbar, `failed` = sonst. */
export class ElevenLabsError extends Error {
  constructor(
    readonly code: "unauthorized" | "quota" | "offline" | "not_found" | "failed",
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function codeFor(status: number): ElevenLabsError["code"] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402 || status === 429) return "quota";
  if (status === 404) return "not_found";
  return "failed";
}

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new ElevenLabsError("offline", 503, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  if (res.ok) return res;
  // Nur den Status + ein kurzes Stück der Antwort merken (nie den Schlüssel, der steht nur in der Anfrage).
  const text = await res.text().catch(() => "");
  throw new ElevenLabsError(codeFor(res.status), res.status, `HTTP ${res.status} ${text.slice(0, 160)}`);
}

interface RawVoice {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  labels?: Record<string, unknown> | null;
  preview_url?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function listElevenLabsVoices(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ElevenLabsVoice[]> {
  const res = await call(fetchImpl, `${ELEVENLABS_BASE}/v1/voices`, {
    method: "GET",
    headers: { "xi-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { voices?: RawVoice[] } | null;
  const voices = Array.isArray(body?.voices) ? body.voices : [];
  return voices
    .map((v): ElevenLabsVoice | null => {
      const id = str(v.voice_id);
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
      const labels = v.labels ?? {};
      const description = ["gender", "age", "accent", "language", "description", "use_case"]
        .map((k) => str(labels[k]))
        .filter((x): x is string => !!x)
        .join(" · ");
      return { id, name: str(v.name) ?? id, category: str(v.category), description: description || null, previewUrl: str(v.preview_url) };
    })
    .filter((v): v is ElevenLabsVoice => v !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export interface ElevenLabsSpeakOptions {
  voiceId: string;
  model: ElevenLabsModel;
  text: string;
  /** 1 = normal; wird auf ElevenLabs' Bereich 0,7 … 1,2 begrenzt. */
  speed?: number;
  /** „de“ / „en“ – nur Flash v2.5 nimmt die Sprache als Hinweis an. */
  language?: string;
}

/** Streaming-WAV-Kopf (44 Byte, PCM 16 bit mono, Länge offen) – identisch zu nyx-voice `streaming_wav_header`. */
export function streamingWavHeader(sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 0xffffffff, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, 0xffffffff, true);
  return new Uint8Array(buf);
}

/**
 * Ton von ElevenLabs als WAV-Strom (Kopf + PCM). Fehler (Schlüssel, Guthaben, Netz) kommen VOR dem ersten Byte als
 * {@link ElevenLabsError} – der Aufrufer fällt dann auf die eigene Stimme zurück.
 */
export async function elevenLabsStream(apiKey: string, opts: ElevenLabsSpeakOptions, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException("Zeitlimit bis zum ersten Ton", "TimeoutError")), STREAM_START_TIMEOUT_MS);
  const speed = Math.min(EL_SPEED_MAX, Math.max(EL_SPEED_MIN, opts.speed ?? 1));
  const body: Record<string, unknown> = {
    text: opts.text,
    model_id: opts.model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed },
  };
  if (opts.model === "eleven_flash_v2_5" && (opts.language === "de" || opts.language === "en")) body.language_code = opts.language;
  let res: Response;
  try {
    res = await call(fetchImpl, `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/pcm" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    signal?.removeEventListener("abort", onAbort);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.body) {
    signal?.removeEventListener("abort", onAbort);
    throw new ElevenLabsError("failed", 502, "Antwort ohne Ton");
  }
  const reader = res.body.getReader();
  let headerSent = false;
  // PCM kann in ungeraden Stücken kommen: ein übriges Byte wird mit dem nächsten Stück verschickt (16-bit-Rahmen).
  let carry: Uint8Array | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(streamingWavHeader(ELEVENLABS_SAMPLE_RATE));
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        // Ein übriges Einzel-Byte ist kein ganzer 16-bit-Rahmen – mit Stille auffüllen statt still wegwerfen.
        if (carry) controller.enqueue(new Uint8Array([carry[0] ?? 0, 0]));
        carry = null;
        signal?.removeEventListener("abort", onAbort);
        controller.close();
        return;
      }
      let chunk = value;
      if (carry) {
        const joined = new Uint8Array(carry.length + chunk.length);
        joined.set(carry);
        joined.set(chunk, carry.length);
        chunk = joined;
        carry = null;
      }
      if (chunk.length % 2 === 1) {
        carry = chunk.slice(chunk.length - 1);
        chunk = chunk.slice(0, chunk.length - 1);
      }
      if (chunk.length) controller.enqueue(chunk);
    },
    cancel(reason) {
      signal?.removeEventListener("abort", onAbort);
      ctrl.abort(reason);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Endungen/Typen, die ElevenLabs als Stimm-Probe annimmt (hier bewusst eng: WAV und MP3). */
const CLONE_TYPES: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg" };

export function cloneSampleType(fileName: string, mime: string): string | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (CLONE_TYPES[ext]) return CLONE_TYPES[ext];
  if (/^audio\/(?:x-)?wav$|^audio\/wave$/.test(mime)) return "audio/wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "audio/mpeg";
  return null;
}

/**
 * „Instant Voice Clone“: eine Hörprobe (WAV/MP3, ≤ 10 MB) → neue Stimme im ElevenLabs-Konto.
 * POST /v1/voices/add (multipart: name, files). Antwort: voice_id.
 */
export async function cloneElevenLabsVoice(
  apiKey: string,
  sample: { name: string; fileName: string; type: string; bytes: Uint8Array },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("name", sample.name);
  form.append("files", new Blob([sample.bytes as Uint8Array<ArrayBuffer>], { type: sample.type }), sample.fileName);
  form.append("remove_background_noise", "true");
  const res = await call(fetchImpl, `${ELEVENLABS_BASE}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { voice_id?: unknown } | null;
  const id = str(body?.voice_id);
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ElevenLabsError("failed", 502, "Antwort ohne voice_id");
  return { id };
}
