// Sprechen statt tippen. Registrierung in app.ts eine Zeile. `target` (search/haiku/
// terminal) ist die Schnittstelle für P3 (Terminal-Eingabe) und P7 (Haiku-Panel) — der Server tut
// mit dem Ergebnis nichts Zielspezifisches, er gibt nur den erkannten Text zurück.
//
// Standard ist jetzt der Stimmen-Dienst AUF DEM SERVER (Container `nyx-voice`, routes/nyx-voice.ts).
// Die Brücke (RPC `transcribe`) bleibt der Rückfall, solange der Dienst lädt oder nicht läuft.
// Ein lokales whisper-cli (WHISPER_BIN + WHISPER_MODEL_PATH) bleibt nur für einen Server-Prozess auf dem
// Mac (Probe-Stack, Tests).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_CAP_VOICE,
  fixTranscriptFor,
  getLang,
  NYX_VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MIME_TYPES,
  VoiceTargetSchema,
  voiceUnavailableSentence,
  type VoiceBridgeResult,
  type VoiceHealth,
  type VoiceProbeResult,
  type VoiceUnavailableReason, t } from "@nyxos/shared";
import { bodyLimit } from "hono/body-limit";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import { NyxVoiceBackendError, type NyxVoiceBackend } from "../nyx/voice-backend.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { ffmpegBinFromEnv, toWav16kMono } from "../voice/convert.js";
import { probeWhisper, transcribeFile, whisperConfigFromEnv, type WhisperConfig } from "../voice/whisper.js";

export interface VoiceRouteDeps {
  whisperConfig?: WhisperConfig;
  ffmpegBin?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  bridgeHub?: Pick<BridgeHub, "online" | "supports" | "rpc">;
  /** Stimmen-Dienst auf dem Server. `undefined` = aus der Umgebung (`NYXOS_NYX_VOICE_URL`), `null` = keiner. */
  nyx?: NyxVoiceBackend | null;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};
const PROBE_TIMEOUT_MS = 5000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;

type MacVoice = { ok: true; model: string } | { ok: false; reason: VoiceUnavailableReason };
export type MacTranscript = { ok: true; text: string; tookMs: number; model: string } | { ok: false; status: 502 | 503; error: string; fix: string | null; reason: VoiceUnavailableReason | "bridge_failed" };

/** Kann die Brücke gerade erkennen? (Rückfall für Server-Stimme) */
export async function macVoiceProbe(hub: Pick<BridgeHub, "online" | "supports" | "rpc"> | undefined): Promise<MacVoice> {
  if (!hub?.online) return { ok: false, reason: "bridge_offline" };
  if (!hub.supports(BRIDGE_CAP_VOICE)) return { ok: false, reason: "bridge_outdated" };
  const res = await hub.rpc("voice_probe", {}, PROBE_TIMEOUT_MS);
  const probe = res.ok ? (res.result as VoiceProbeResult | undefined) : undefined;
  if (probe?.ok) return { ok: true, model: probe.model };
  return { ok: false, reason: probe && !probe.ok ? probe.reason : "bridge_offline" };
}

/** Diktat über die Brücke (Audio als Base64, höchstens 8 MB, nur die Browser-Formate). */
export async function transcribeOnMac(hub: Pick<BridgeHub, "rpc">, audio: Uint8Array, mime: (typeof VOICE_MIME_TYPES)[number], language = "de"): Promise<MacTranscript> {
  const res = await hub.rpc("transcribe", { audioB64: Buffer.from(audio).toString("base64"), mime, language }, TRANSCRIBE_TIMEOUT_MS);
  const out = res.ok ? (res.result as VoiceBridgeResult | undefined) : undefined;
  if (!out) return { ok: false, status: 502, error: t("Die Erkennung auf dem Rechner hat nicht geklappt – bitte noch einmal versuchen."), fix: null, reason: "bridge_failed" };
  if (out.outcome === "unavailable") {
    const s = voiceUnavailableSentence(out.reason);
    return { ok: false, status: 503, error: s.sentence, fix: s.fix, reason: out.reason };
  }
  return { ok: true, text: out.text, tookMs: out.tookMs, model: out.model };
}

/** Passt die Aufnahme über die Brücke? (Format + Größe) */
export function macCanTake(mime: string, bytes: number): mime is (typeof VOICE_MIME_TYPES)[number] {
  return (VOICE_MIME_TYPES as readonly string[]).includes(mime) && bytes <= VOICE_MAX_AUDIO_BYTES;
}

type Engine = { kind: "nyx"; model: string } | { kind: "mac"; model: string } | { kind: "server" } | { kind: "none"; reason: VoiceUnavailableReason };

function unhealthy(reason: VoiceUnavailableReason): VoiceHealth {
  const s = voiceUnavailableSentence(reason);
  return { ok: false, engine: null, model: null, sentence: s.sentence, fix: s.fix, reason };
}

export function registerVoiceRoutes(app: Hono<Env>, deps: VoiceRouteDeps = {}): void {
  const whisperConfig = deps.whisperConfig ?? whisperConfigFromEnv();
  const ffmpegBin = deps.ffmpegBin ?? ffmpegBinFromEnv();
  const log = deps.log ?? (() => {});
  const hub = deps.bridgeHub;
  const nyx = deps.nyx ?? null;

  /** Wo kann gerade erkannt werden? Server-Stimme zuerst, dann Mac, dann lokales whisper (nur Probe/Tests). */
  async function engine(): Promise<Engine> {
    let serverReason: VoiceUnavailableReason | null = null;
    if (nyx) {
      try {
        const st = await nyx.status();
        if (st.stt.ready) return { kind: "nyx", model: st.stt.model };
        serverReason = "server_starting";
      } catch {
        serverReason = "server_offline";
      }
    }
    const mac = await macVoiceProbe(hub);
    if (mac.ok) return { kind: "mac", model: mac.model };
    if (whisperConfig.modelPath && (await probeWhisper(whisperConfig)).ok) return { kind: "server" };
    return { kind: "none", reason: serverReason ?? mac.reason };
  }

  app.get("/api/voice/health", async (c) => {
    const e = await engine();
    if (e.kind === "none") return c.json(unhealthy(e.reason), 503);
    const body: VoiceHealth =
      e.kind === "nyx"
        ? { ok: true, engine: "server", model: e.model, sentence: `Sprache bereit: Erkennung auf dem Server (${e.model}).`, fix: null, reason: null }
        : e.kind === "mac"
          ? { ok: true, engine: "mac", model: e.model, sentence: `Sprache bereit: Erkennung auf deinem Mac (${e.model}).`, fix: null, reason: null }
          : { ok: true, engine: "server", model: null, sentence: "Sprache bereit: Erkennung im Server-Prozess.", fix: null, reason: null };
    return c.json(body);
  });

  app.post("/api/voice/transcribe", bodyLimit({ maxSize: NYX_VOICE_MAX_AUDIO_BYTES, onError: (c) => c.json({ error: t("Die Aufnahme ist zu lang – bitte kürzer sprechen (höchstens etwa 25 Minuten).") }, 413) }), async (c) => {
    const mimeRaw = (c.req.header("content-type") ?? "audio/webm").split(";")[0]?.trim() ?? "audio/webm";
    const mime = (VOICE_MIME_TYPES as readonly string[]).includes(mimeRaw) ? (mimeRaw as (typeof VOICE_MIME_TYPES)[number]) : "audio/webm";
    const targetRaw = c.req.query("target") ?? "search";
    const target = VoiceTargetSchema.safeParse(targetRaw).success ? targetRaw : "search";
    const audioSeconds = Number(c.req.query("audioSeconds") ?? "0") || 0;
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ error: t("Die Aufnahme war leer – bitte noch einmal sprechen.") }, 400);

    const e = await engine();
    if (e.kind === "none") {
      const h = unhealthy(e.reason);
      return c.json({ error: h.sentence, fix: h.fix, reason: h.reason }, 503);
    }
    if (e.kind === "nyx" && nyx) {
      try {
        const out = await nyx.transcribe(body, { mime, language: getLang() });
        log("voice-transcribe", { engine: "nyx", tookMs: out.ms, chars: out.text.length, target });
        // Dictation follows the app language; German mishearing fixes only apply to German text.
        return c.json({ text: fixTranscriptFor(out.text, out.language), engine: "server", tookMs: out.ms, audioSeconds: audioSeconds || out.audioSeconds, target });
      } catch (err) {
        log("voice-transcribe-fehler", { engine: "nyx", error: String(err) });
        if (err instanceof NyxVoiceBackendError && (err.code === "bad_audio" || err.code === "empty_audio")) return c.json({ error: t("Die Aufnahme ließ sich nicht lesen – bitte noch einmal aufnehmen.") }, 422);
        // Server-Stimme fiel zwischen Prüfung und Aufruf aus: Mac springt ein, wenn er kann.
        if (!hub || !macCanTake(mime, body.byteLength) || !(await macVoiceProbe(hub)).ok) return c.json({ error: t("Die Erkennung hat nicht geklappt – bitte noch einmal versuchen.") }, 502);
      }
    }
    if (e.kind !== "server" && hub) {
      if (body.byteLength > VOICE_MAX_AUDIO_BYTES) return c.json({ error: t("Die Aufnahme ist zu lang für die Erkennung auf dem Rechner – bitte kürzer sprechen (höchstens etwa 5 Minuten).") }, 413);
      const out = await transcribeOnMac(hub, body, mime, getLang());
      if (!out.ok) {
        log("voice-transcribe-fehler", { engine: "mac", error: out.reason });
        return c.json(out.status === 503 ? { error: out.error, fix: out.fix, reason: out.reason } : { error: out.error }, out.status);
      }
      log("voice-transcribe", { engine: "mac", tookMs: out.tookMs, chars: out.text.length, target });
      return c.json({ text: fixTranscriptFor(out.text, getLang()), engine: "mac", tookMs: out.tookMs, audioSeconds, target });
    }

    const dir = await mkdtemp(join(tmpdir(), "nyxos-voice-"));
    const inputPath = join(dir, `in.${EXT_BY_MIME[mime] ?? "webm"}`);
    const wavPath = join(dir, "out.wav");
    try {
      await writeFile(inputPath, body);
      await toWav16kMono(ffmpegBin, inputPath, wavPath);
      const result = await transcribeFile(whisperConfig, wavPath, { audioSeconds, engine: "server", language: getLang() });
      log("voice-transcribe", { engine: "server", tookMs: result.tookMs, chars: result.text.length, target });
      return c.json({ ...result, text: fixTranscriptFor(result.text, getLang()), target });
    } catch (err) {
      log("voice-transcribe-fehler", { engine: "server", error: String(err) });
      return c.json({ error: t("Die Erkennung hat nicht geklappt – bitte noch einmal versuchen.") }, 500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
