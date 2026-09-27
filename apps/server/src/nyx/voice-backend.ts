// Anbindung an den Stimmen-Dienst `nyx-voice` (Container im Projekt „nyxos“, Netz
// `nyxos-voice`, kein Host-Port). Die API ist der einzige Weg dorthin: sie prüft Anmeldung + CSRF und
// übersetzt Fehler in Sätze (routes/nyx-voice.ts). Telegram und der Nyx-Kern nutzen dieselbe
// Schnittstelle direkt im Prozess (`createApp(…).nyxVoice`).
import type { NyxImportableVoice, NyxVoiceFormat, NyxVoiceImport, NyxVoiceSpeakRequest } from "@nyxos/shared";

/** Rohzustand eines Teils, wie ihn der Dienst unter `/health` meldet (infra/nyx-voice/nyx_voice/service.py). */
export interface NyxVoiceRawPart {
  id: string;
  state: string;
  ready: boolean;
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  loadMs: number | null;
  license?: string;
  /** (nur Stimmen): Anzeige-Name, Motor, Warmlauf-RTF, echtes Streaming. */
  label?: string;
  engine?: string;
  rtf?: number | null;
  streaming?: boolean;
  /** (nur Stimmen): Sprache der Stimme; fehlt bei älteren Diensten (= Deutsch). */
  language?: string;
}

export interface NyxVoiceRawStatus {
  stt: NyxVoiceRawPart & { model: string; language: string };
  tts: NyxVoiceRawPart & {
    voice: string;
    voices: NyxVoiceRawPart[];
    /** importierbare Stimmen (fehlt bei älteren Diensten). */
    importable?: NyxImportableVoice[];
    preferred?: string;
    fallback?: string;
    /** englische Stimme (spricht gerade / gewünscht / Ersatz); null = keine englische Stimme geladen. */
    voiceEn?: string | null;
    preferredEn?: string | null;
    fallbackEn?: string | null;
  };
  threads: number;
  uptimeS: number;
}

export interface NyxVoiceRawTranscript {
  text: string;
  language: string;
  ms: number;
  audioSeconds: number;
  model: string;
}

export interface NyxVoiceSpeech {
  audio: Uint8Array;
  contentType: string;
  voice: string;
  /** Rechenzeit im Dienst (Synthese + Kodierung). */
  ms: number;
  audioSeconds: number;
}

/** gestreamte Sprachausgabe — WAV-Kopf (offene Länge) + PCM 16 bit mono in Stücken. */
export interface NyxVoiceSpeechStream {
  body: ReadableStream<Uint8Array>;
  voice: string;
  /** alle Stimmen in Reihenfolge (Sprachwechsel = Stimmwechsel im selben Strom). */
  voices?: string[];
  sampleRate: number;
  /** Die gewünschte Stimme war nicht bereit, eine Ersatzstimme spricht. */
  fallback: boolean;
}

/**
 * `code`: `offline` (Dienst nicht erreichbar/Zeitlimit), `loading`/`error` (Modell noch nicht bereit),
 * `not_configured` (lokal: Stimmen-Paket nicht installiert), `starting` (lokal: Dienst startet gerade),
 * `bad_audio`, `empty_audio`, `too_large`, `bad_text`, `text_too_long`, `bad_voice`, `bad_speed`,
 * `bad_format`, `failed`. `detail` ist NUR fürs Protokoll, nie für die Oberfläche.
 */
export class NyxVoiceBackendError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface NyxVoiceBackend {
  status(): Promise<NyxVoiceRawStatus>;
  transcribe(audio: Uint8Array, opts: { mime: string; language: string }): Promise<NyxVoiceRawTranscript>;
  speak(req: NyxVoiceSpeakRequest, format: NyxVoiceFormat): Promise<NyxVoiceSpeech>;
  /** Stimme zur Laufzeit dazuholen (Katalog-Kennung oder sherpa-onnx-Adresse); lädt im Dienst im Hintergrund. */
  importVoice?(req: NyxVoiceImport): Promise<NyxVoiceRawPart & { added: boolean }>;
  /** Ton stückweise; `signal` bricht die Rechnung im Dienst ab (Browser hat aufgehört zu hören). */
  speakStream?(req: NyxVoiceSpeakRequest, signal?: AbortSignal): Promise<NyxVoiceSpeechStream>;
}

const STATUS_TIMEOUT_MS = 2500;
/** 25 MB Audio (≈ 25 Min) brauchen auf 3 Kernen deutlich unter einer Minute; großzügige Obergrenze. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const SPEAK_TIMEOUT_MS = 60_000;
/** Bis der Dienst mit dem Kopf antwortet (Warteschlange vor der Stimme); danach läuft der Ton, solange er fließt. */
const STREAM_START_TIMEOUT_MS = 30_000;

export class HttpNyxVoiceBackend implements NyxVoiceBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Schlüssel des lokalen Stimmen-Pakets (Dienst auf 127.0.0.1 verlangt ihn); im Server-Modus keiner. */
    private readonly token: string | null = null,
  ) {}

  private async call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    const headers = { ...(init.headers as Record<string, string> | undefined), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, signal: signal ?? AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new NyxVoiceBackendError("offline", 503, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : "failed";
    throw new NyxVoiceBackendError(code, res.status, typeof body?.message === "string" ? body.message : `HTTP ${res.status}`);
  }

  async status(): Promise<NyxVoiceRawStatus> {
    const res = await this.call("/health", { method: "GET" }, STATUS_TIMEOUT_MS);
    const body = (await res.json().catch(() => null)) as NyxVoiceRawStatus | null;
    if (!body?.stt || !body.tts) throw new NyxVoiceBackendError("offline", 503, "unerwartete Antwort von /health");
    return body;
  }

  async transcribe(audio: Uint8Array, opts: { mime: string; language: string }): Promise<NyxVoiceRawTranscript> {
    const res = await this.call(`/transcribe?language=${encodeURIComponent(opts.language)}`, { method: "POST", headers: { "content-type": opts.mime }, body: audio }, TRANSCRIBE_TIMEOUT_MS);
    return (await res.json()) as NyxVoiceRawTranscript;
  }

  async speak(req: NyxVoiceSpeakRequest, format: NyxVoiceFormat): Promise<NyxVoiceSpeech> {
    const res = await this.call(`/speak?format=${format}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }, SPEAK_TIMEOUT_MS);
    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? (format === "wav" ? "audio/wav" : "audio/ogg"),
      voice: res.headers.get("x-nyx-voice") ?? req.voice ?? "",
      ms: Number(res.headers.get("x-nyx-ms") ?? "0") || 0,
      audioSeconds: Number(res.headers.get("x-nyx-audio-seconds") ?? "0") || 0,
    };
  }

  async importVoice(req: NyxVoiceImport): Promise<NyxVoiceRawPart & { added: boolean }> {
    const res = await this.call("/voices/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }, STATUS_TIMEOUT_MS * 4);
    return (await res.json()) as NyxVoiceRawPart & { added: boolean };
  }

  async speakStream(req: NyxVoiceSpeakRequest, signal?: AbortSignal): Promise<NyxVoiceSpeechStream> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    if (signal?.aborted) ctrl.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    const startTimer = setTimeout(() => ctrl.abort(new DOMException("Zeitlimit bis zum ersten Ton", "TimeoutError")), STREAM_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.call("/speak?stream=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }, STREAM_START_TIMEOUT_MS, ctrl.signal);
    } catch (e) {
      signal?.removeEventListener("abort", onAbort);
      throw e;
    } finally {
      clearTimeout(startTimer);
    }
    if (!res.body) {
      signal?.removeEventListener("abort", onAbort);
      throw new NyxVoiceBackendError("failed", 502, "Stream ohne Inhalt");
    }
    return {
      body: res.body,
      voice: res.headers.get("x-nyx-voice") ?? req.voice ?? "",
      voices: (res.headers.get("x-nyx-voices") ?? "").split(",").filter(Boolean),
      sampleRate: Number(res.headers.get("x-nyx-sample-rate") ?? "0") || 0,
      fallback: res.headers.get("x-nyx-fallback") === "1",
    };
  }
}

/** Nur wenn `NYXOS_NYX_VOICE_URL` gesetzt ist (Compose setzt sie) — sonst `null` = „nicht eingerichtet“. */
export function nyxVoiceBackendFromEnv(env: NodeJS.ProcessEnv = process.env): NyxVoiceBackend | null {
  const url = env.NYXOS_NYX_VOICE_URL?.trim();
  return url ? new HttpNyxVoiceBackend(url) : null;
}
