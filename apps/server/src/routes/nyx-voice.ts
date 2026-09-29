// Stimme auf dem Server (Vertrag: packages/shared/src/nyx-voice.ts). Registrierung in app.ts eine Zeile.
//   GET  /api/nyx/voice/status      immer 200: Zustand von Erkennung + Stimme und EIN Satz für die Oberfläche
//   POST /api/nyx/voice/transcribe  Audio roh (≤ 25 MB) → {text, language, ms, …}; Rückfall: Brücke
//                                   (ohne ?language keine feste Sprache — „auto“; `language` = erkannt de/en)
//   POST /api/nyx/voice/speak       {text, voice?, voiceEn?, language?, speed?} → audio/ogg (Opus) bzw. ?format=wav
//                                   (Sprache je Satz, Deutsch mit `voice`, Englisch mit eigener Stimme `voiceEn`)
//   POST /api/nyx/voice/speak?stream=1 → audio/wav in Stücken (Kopf mit offener Länge + PCM), erster
//                                   Ton sobald gerechnet; bricht der Browser ab, hört auch der Dienst auf zu rechnen
// Anmeldung + CSRF gelten wie für alle schreibenden /api-Wege (app.ts, `auth.gate`); nur die JSON-Pflicht
// entfällt für das Audio von `transcribe`. Fehler kommen als einfacher Satz (+ Schritt), nie als Technik-Text.
import {
  BRIDGE_CAP_VOICE_AUTO,
  fixTranscriptFor,
  guessVoiceLanguage,
  nyxLanguageScores,
  NYX_VOICE_MAX_AUDIO_BYTES,
  NYX_VOICE_MAX_TEXT_CHARS,
  NyxVoiceSpeakRequestSchema,
  NyxVoiceSettingsPatchSchema,
  NyxVoiceImportSchema,
  ElevenLabsKeyPutSchema,
  ELEVENLABS_CLONE_MAX_BYTES,
  nyxVoicePartSentence,
  nyxVoiceSentence,
  type NyxVoiceInfo,
  type NyxVoicePart,
  type NyxVoiceScope,
  type NyxVoicePartState,
  type NyxVoiceStatus,
  type NyxVoiceTranscribeResult,
  getLang,
  t,
  voicePackErrorSentence,
} from "@nyxos/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../app.js";
import { NyxVoiceBackendError, type NyxVoiceBackend, type NyxVoiceRawPart } from "../nyx/voice-backend.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { macCanTake, macVoiceProbe, transcribeOnMac } from "./voice.js";
import type { Db } from "../db/client.js";
import { cloneElevenLabsVoice, cloneSampleType, ELEVENLABS_SECRET, ElevenLabsError, listElevenLabsVoices } from "../nyx/elevenlabs.js";
import { loadVoiceSettings, publicVoiceSettings, saveVoiceSettings } from "../nyx/voice-settings.js";
import { SecretsKeyError, type SecretStore } from "../secrets/store.js";
import type { LocalVoicePack } from "../voice/local-pack.js";

export interface NyxVoiceRouteDeps {
  backend: NyxVoiceBackend | null;
  /** Stimmen-Einstellungen (Aussprache, ElevenLabs). Ohne Angabe fehlen die Einstellungs-Wege. */
  settings?: { db: Db; secrets: SecretStore; fetchImpl?: typeof fetch };
  bridgeHub?: Pick<BridgeHub, "online" | "supports" | "rpc">;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Lokaler Modus: das Stimmen-Paket auf diesem Computer (Knopf „installieren“, Sätze ohne Docker). */
  pack?: LocalVoicePack;
}

const KNOWN_STATES: NyxVoicePartState[] = ["ready", "waiting", "downloading", "loading", "error"];
/** Diese Fehler heißen „Dienst gerade nicht nutzbar“ → Rückfall (Mac) bzw. 503 mit Zustands-Satz.
 * `starting`/`not_configured` kommen nur vom lokalen Stimmen-Paket (startet gerade / nicht installiert). */
const UNAVAILABLE = new Set(["offline", "loading", "error", "starting", "not_configured"]);

function part(raw: NyxVoiceRawPart | undefined): NyxVoicePart {
  if (!raw) return { ready: false, state: "offline", progress: null, bytesTotal: null };
  const known = (KNOWN_STATES as string[]).includes(raw.state) ? (raw.state as NyxVoicePartState) : "loading";
  // Ganz geladen, aber noch „downloading“: der Dienst entpackt das Archiv (Parakeet ≈ 30 s) – das ist schon Laden.
  const state = known === "downloading" && raw.bytesTotal > 0 && raw.bytesDone >= raw.bytesTotal ? "loading" : known;
  const downloading = state === "downloading" && raw.bytesTotal > 0;
  return {
    ready: raw.ready === true && state === "ready",
    state,
    // Während des Downloads höchstens 99 % — „100 %“ hieße fertig, dabei folgt noch das Entpacken.
    progress: downloading ? Math.min(99, Math.round((raw.bytesDone / raw.bytesTotal) * 100)) : null,
    bytesTotal: raw.bytesTotal > 0 ? raw.bytesTotal : null,
  };
}

function missing(state: "offline" | "not_configured"): NyxVoicePart {
  return { ready: false, state, progress: null, bytesTotal: null };
}

/** Teil-Zustand für einen Dienst, der nicht antwortet: nicht installiert, startet gerade oder aus. */
function unreachable(err: unknown): NyxVoicePart {
  const code = err instanceof NyxVoiceBackendError ? err.code : "offline";
  if (code === "not_configured") return missing("not_configured");
  if (code === "starting") return { ready: false, state: "loading", progress: null, bytesTotal: null };
  return missing("offline");
}

/** Zustand für Oberfläche, Telegram und Verbindungs-Prüfung — wirft nie. `scope` wählt die Sätze (lokal ohne Docker). */
export async function readNyxVoiceStatus(backend: NyxVoiceBackend | null, scope: NyxVoiceScope = "server"): Promise<NyxVoiceStatus> {
  if (!backend) {
    const p = missing("not_configured");
    return { scope, stt: { ...p, model: null, language: null }, tts: { ...p, voice: null, voices: [] }, ...nyxVoicePartSentence(p, scope) };
  }
  try {
    const raw = await backend.status();
    const stt = part(raw.stt);
    const tts = part(raw.tts);
    const voiceInfo: NyxVoiceInfo[] = raw.tts.voices.map((v) => {
      const p = part(v);
      return {
        id: v.id,
        label: v.label || v.id,
        ready: p.ready,
        state: p.state,
        engine: v.engine ?? "piper",
        streaming: v.streaming === true,
        rtf: typeof v.rtf === "number" ? v.rtf : null,
        // älterer Dienst ohne Angabe hatte nur deutsche Stimmen.
        language: v.language === "en" ? "en" : "de",
      };
    });
    return {
      scope,
      stt: { ...stt, model: raw.stt.model, language: raw.stt.language },
      tts: {
        ...tts,
        voice: raw.tts.voice,
        voices: raw.tts.voices.map((v) => v.id),
        voiceInfo,
        ...(Array.isArray(raw.tts.importable) ? { importable: raw.tts.importable } : {}),
        preferred: raw.tts.preferred ?? null,
        fallback: raw.tts.fallback ?? null,
        voiceEn: raw.tts.voiceEn ?? null,
        preferredEn: raw.tts.preferredEn ?? null,
        fallbackEn: raw.tts.fallbackEn ?? null,
      },
      // der Satz nennt die Stimme der App-Sprache (englische Oberfläche → englische Stimme).
      ...nyxVoiceSentence(stt, tts, { model: raw.stt.model, voice: getLang() === "en" ? (raw.tts.voiceEn ?? raw.tts.voice) : raw.tts.voice }, scope),
    };
  } catch (err) {
    const p = unreachable(err);
    return { scope, stt: { ...p, model: null, language: null }, tts: { ...p, voice: null, voices: [] }, ...nyxVoicePartSentence(p, scope) };
  }
}

export function registerNyxVoiceRoutes(app: Hono<Env>, deps: NyxVoiceRouteDeps): void {
  const { backend, bridgeHub: hub, pack } = deps;
  const log = deps.log ?? (() => {});
  const scope: NyxVoiceScope = pack ? "local" : "server";

  /** 503 mit dem Satz des Teils, der gerade fehlt (`which`), frisch aus dem Dienst gelesen. */
  async function unavailable(c: Context<Env>, which: "stt" | "tts", code: string) {
    const st = await readNyxVoiceStatus(backend, scope);
    const p = st[which].ready ? missing("offline") : st[which];
    const s = nyxVoicePartSentence(p, scope);
    return c.json({ error: s.sentence, fix: s.fix, reason: code }, 503);
  }

  app.get("/api/nyx/voice/status", async (c) => c.json(await readNyxVoiceStatus(backend, scope)));

  // Stimmen-Paket (nur lokal): Zustand, installieren (gleicher Weg wie `nyxos voice install`), entfernen.
  // Anmeldung + CSRF wie alle schreibenden /api-Wege (app.ts, `auth.gate`).
  if (pack) {
    app.get("/api/nyx/voice/pack", (c) => c.json(pack.status()));
    app.post("/api/nyx/voice/pack/install", (c) => {
      const r = pack.install();
      if (!r.ok) return c.json({ ...pack.status(), error: voicePackErrorSentence(r.reason), reason: r.reason }, 409);
      log("stimme-installieren", {});
      return c.json(pack.status(), 202);
    });
    app.post("/api/nyx/voice/pack/remove", (c) => {
      const r = pack.remove();
      if (!r.ok) return c.json({ ...pack.status(), error: voicePackErrorSentence(r.reason), reason: r.reason }, 409);
      log("stimme-entfernen", {});
      return c.json(pack.status(), 202);
    });
  }

  if (deps.settings) registerVoiceSettingsRoutes(app, deps.settings, log);

  // Stimme importieren — Katalog-Kennung oder sherpa-onnx-Piper-Adresse; der Dienst lädt sie im Hintergrund.
  app.post("/api/nyx/voice/import", async (c) => {
    const parsed = NyxVoiceImportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("Bitte eine Stimme aus der Liste wählen oder eine Adresse von github.com/k2-fsa/sherpa-onnx (tts-models, vits-piper-….tar.bz2) einfügen."), reason: "bad_import" }, 400);
    if (!backend?.importVoice) {
      const s = nyxVoicePartSentence(missing(backend ? "offline" : "not_configured"), scope);
      return c.json({ error: s.sentence, fix: s.fix, reason: "not_configured" }, 503);
    }
    try {
      const out = await backend.importVoice(parsed.data);
      log("nyx-voice-import", { id: out.id, added: out.added });
      return c.json({ id: out.id, added: out.added, state: out.state });
    } catch (err) {
      const e = err instanceof NyxVoiceBackendError ? err : new NyxVoiceBackendError("failed", 500, String(err));
      log("nyx-voice-import-fehler", { code: e.code, detail: e.detail });
      if (e.code === "not_allowed") return c.json({ error: t("Diese Stimme hat keine geprüfte freie Lizenz – sie lässt sich nicht importieren."), reason: e.code }, 400);
      if (e.code === "bad_import") return c.json({ error: t("Diese Adresse ist kein erlaubtes Stimmen-Paket."), reason: e.code }, 400);
      if (e.code === "engine_missing") return c.json({ error: t("Diese Stimme braucht ein Zusatzpaket, das auf diesem Computer fehlt."), reason: e.code }, 400);
      if (UNAVAILABLE.has(e.code)) return unavailable(c, "tts", e.code);
      return c.json({ error: t("Das Importieren hat nicht geklappt – bitte noch einmal versuchen."), reason: "failed" }, 502);
    }
  });

  app.post(
    "/api/nyx/voice/transcribe",
    bodyLimit({ maxSize: NYX_VOICE_MAX_AUDIO_BYTES, onError: (c) => c.json({ error: t("Die Aufnahme ist zu lang – höchstens etwa 25 Minuten (25 MB)."), reason: "too_large" }, 413) }),
    async (c) => {
      const started = performance.now();
      const mime = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
      if (!mime.startsWith("audio/") && mime !== "application/octet-stream") return c.json({ error: t("Bitte eine Tonaufnahme schicken (z. B. webm, ogg oder wav)."), reason: "bad_type" }, 415);
      // keine Sprache erzwingen — Parakeet v3 (bzw. Whisper auf dem Rechner) erkennt Deutsch und Englisch selbst.
      const langRaw = c.req.query("language") ?? "auto";
      const language = /^(?:auto|[a-z]{2})$/.test(langRaw) ? langRaw : "auto";
      // Hinweis nur für kurze, unentschiedene Aufnahmen („Okay“): sonst die Sprache der App.
      const hint = language === "en" || language === "de" ? language : getLang();
      const audio = new Uint8Array(await c.req.arrayBuffer());
      if (audio.byteLength === 0) return c.json({ error: t("Die Aufnahme war leer – bitte noch einmal sprechen."), reason: "empty_audio" }, 400);

      let serverCode = "not_configured";
      if (backend) {
        try {
          const out = await backend.transcribe(audio, { mime, language });
          // Lässt der Text keine Sprache erkennen („Okay“), gilt der Hinweis (Sprache der App), nicht der des Dienstes.
          const scores = nyxLanguageScores(out.text);
          const lang = scores.de !== scores.en && (out.language === "de" || out.language === "en") ? out.language : guessVoiceLanguage(out.text, hint);
          // Korrekturen („Nücks“ → Nyx, „Boilt“ → Build) sind deutsche Verhörer: nur auf deutschen Text.
          const body: NyxVoiceTranscribeResult = { text: lang === "de" || lang === "en" ? fixTranscriptFor(out.text, lang) : out.text, language: lang, ms: out.ms, totalMs: Math.round(performance.now() - started), audioSeconds: out.audioSeconds, model: out.model, engine: "server" };
          log("nyx-voice-transcribe", { engine: "server", ms: out.ms, totalMs: body.totalMs, audioSeconds: out.audioSeconds, chars: out.text.length });
          return c.json(body);
        } catch (err) {
          const e = err instanceof NyxVoiceBackendError ? err : new NyxVoiceBackendError("failed", 500, String(err));
          log("nyx-voice-transcribe-fehler", { code: e.code, detail: e.detail });
          if (e.code === "bad_audio" || e.code === "empty_audio") return c.json({ error: t("Die Aufnahme ließ sich nicht lesen – bitte noch einmal aufnehmen."), reason: e.code }, 422);
          if (e.code === "too_large") return c.json({ error: t("Die Aufnahme ist zu lang – höchstens etwa 25 Minuten (25 MB)."), reason: e.code }, 413);
          if (!UNAVAILABLE.has(e.code)) return c.json({ error: t("Die Erkennung hat nicht geklappt – bitte noch einmal versuchen."), reason: "failed" }, 502);
          serverCode = e.code;
        }
      }

      // Rückfall: Brücke, wenn sie das Format kann und die Aufnahme klein genug ist.
      if (hub && macCanTake(mime, audio.byteLength) && (await macVoiceProbe(hub)).ok) {
        // Neue Brücke (BRIDGE_CAP_VOICE_AUTO): Whisper erkennt die Sprache selbst. Ältere nehmen nur Kürzel → Hinweis Deutsch.
        const macLanguage = language === "auto" && !hub.supports(BRIDGE_CAP_VOICE_AUTO) ? hint : language;
        const out = await transcribeOnMac(hub, audio, mime, macLanguage);
        if (out.ok) {
          const lang = guessVoiceLanguage(out.text, hint);
          const body: NyxVoiceTranscribeResult = { text: lang === "de" || lang === "en" ? fixTranscriptFor(out.text, lang) : out.text, language: lang, ms: out.tookMs, totalMs: Math.round(performance.now() - started), audioSeconds: 0, model: out.model, engine: "mac" };
          log("nyx-voice-transcribe", { engine: "mac", ms: out.tookMs, chars: out.text.length, serverCode });
          return c.json(body);
        }
        log("nyx-voice-transcribe-fehler", { engine: "mac", reason: out.reason });
      }
      if (serverCode === "not_configured") {
        const s = nyxVoicePartSentence(missing("not_configured"), scope);
        return c.json({ error: s.sentence, fix: s.fix, reason: "not_configured" }, 503);
      }
      return unavailable(c, "stt", serverCode);
    },
  );

  app.post("/api/nyx/voice/speak", async (c) => {
    const format = c.req.query("format") ?? "ogg";
    if (format !== "ogg" && format !== "wav") return c.json({ error: t("Format bitte ogg oder wav."), reason: "bad_format" }, 400);
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = NyxVoiceSpeakRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      const error =
        field === "voice" || field === "voiceEn"
          ? t("Diese Stimme gibt es nicht.")
          : field === "language"
            ? t("Die Sprache bitte als auto, de oder en angeben.")
          : field === "speed"
            ? t("Das Tempo muss zwischen 0,5 und 2 liegen.")
          : field === "lexicon"
            ? t("Jeder Aussprache-Eintrag braucht ein Wort (bis 60 Zeichen) und wie es klingen soll (bis 120 Zeichen).")
          : field === "provider" || field === "elevenVoice"
            ? t("Diesen Stimmen-Anbieter gibt es nicht.")
            : t("Bitte einen Text zum Sprechen schicken (höchstens {n} Zeichen, lange Antworten satzweise).", { n: NYX_VOICE_MAX_TEXT_CHARS });
      return c.json({ error, reason: `bad_${typeof field === "string" ? field : "text"}` }, 400);
    }
    if (!backend) {
      const s = nyxVoicePartSentence(missing("not_configured"), scope);
      return c.json({ error: s.sentence, fix: s.fix, reason: "not_configured" }, 503);
    }
    const speakFailed = async (err: unknown) => {
      const e = err instanceof NyxVoiceBackendError ? err : new NyxVoiceBackendError("failed", 500, String(err));
      log("nyx-voice-speak-fehler", { code: e.code, detail: e.detail });
      if (UNAVAILABLE.has(e.code)) return unavailable(c, "tts", e.code);
      if (e.code === "bad_voice") return c.json({ error: t("Diese Stimme ist auf dem Server nicht installiert."), reason: e.code }, 400);
      if (e.code === "bad_language") return c.json({ error: t("Die Sprache bitte als auto, de oder en angeben."), reason: e.code }, 400);
      if (e.code === "bad_lexicon") return c.json({ error: t("Das Aussprache-Wörterbuch passt nicht – bitte in den Nyx-Einstellungen prüfen."), reason: e.code }, 400);
      if (e.code === "text_too_long" || e.code === "bad_text" || e.code === "bad_speed") return c.json({ error: t("Diesen Text kann die Stimme so nicht sprechen – bitte kürzer oder satzweise schicken."), reason: e.code }, 400);
      return c.json({ error: t("Die Sprachausgabe hat nicht geklappt – bitte noch einmal versuchen."), reason: "failed" }, 502);
    };
    // gestreamt — der Körper des Dienstes fließt ungepuffert durch, Abbruch des Browsers bricht auch ihn ab.
    if (c.req.query("stream") === "1") {
      if (!backend.speakStream) return c.json({ error: t("Die Stimme kann auf diesem Server noch nicht stückweise sprechen."), reason: "no_stream" }, 501);
      try {
        const started = performance.now();
        const out = await backend.speakStream(parsed.data, c.req.raw.signal);
        log("nyx-voice-speak", { stream: true, startMs: Math.round(performance.now() - started), chars: parsed.data.text.length, voice: out.voice, fallback: out.fallback });
        return new Response(out.body, {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "cache-control": "no-store",
            "x-nyx-voice": out.voice,
            "x-nyx-voices": (out.voices ?? [out.voice]).join(","),
            "x-nyx-sample-rate": String(out.sampleRate),
            "x-nyx-voice-fallback": out.fallback ? "1" : "0",
          },
        });
      } catch (err) {
        return speakFailed(err);
      }
    }
    try {
      const out = await backend.speak(parsed.data, format);
      log("nyx-voice-speak", { ms: out.ms, chars: parsed.data.text.length, audioSeconds: out.audioSeconds, format });
      return c.body(out.audio as Uint8Array<ArrayBuffer>, 200, {
        "content-type": out.contentType,
        "cache-control": "no-store",
        "x-nyx-voice": out.voice,
        "x-nyx-voice-ms": String(out.ms),
        "x-nyx-audio-seconds": String(out.audioSeconds),
      });
    } catch (err) {
      return speakFailed(err);
    }
  });
}

// ─────────── Stimmen-Einstellungen + ElevenLabs ───────────
//   GET    /api/nyx/voice/settings              → NyxVoiceSettings (Schlüssel nur als „gesetzt“ + letzte 4 Zeichen)
//   PUT    /api/nyx/voice/settings              NyxVoiceSettingsPatch → NyxVoiceSettings
//   PUT    /api/nyx/voice/elevenlabs/key        {value} → prüft den Schlüssel bei ElevenLabs, speichert verschlüsselt
//   DELETE /api/nyx/voice/elevenlabs/key        → Schlüssel weg, Anbieter zurück auf „eigene Stimme“
//   GET    /api/nyx/voice/elevenlabs/voices     → {voices: ElevenLabsVoice[]}

const ELEVEN_SENTENCE: Record<ElevenLabsError["code"], string> = {
  unauthorized: "ElevenLabs kennt diesen Schlüssel nicht – bitte den API-Schlüssel prüfen.",
  quota: "Bei ElevenLabs ist das Guthaben oder Limit erreicht.",
  offline: "ElevenLabs ist gerade nicht erreichbar – bitte später noch einmal versuchen.",
  not_found: "Diese ElevenLabs-Stimme gibt es nicht (mehr).",
  failed: "ElevenLabs hat nicht geantwortet wie erwartet – bitte später noch einmal versuchen.",
};

function registerVoiceSettingsRoutes(app: Hono<Env>, deps: NonNullable<NyxVoiceRouteDeps["settings"]>, log: (msg: string, extra?: Record<string, unknown>) => void): void {
  const { db, secrets } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function current() {
    const [settings, key] = await Promise.all([loadVoiceSettings(db), secrets.info(ELEVENLABS_SECRET)]);
    return publicVoiceSettings(settings, key);
  }

  function elevenFail(c: Context<Env>, e: unknown) {
    if (e instanceof SecretsKeyError) return c.json({ error: e.message, reason: `secrets_${e.state}` }, 503);
    const err = e instanceof ElevenLabsError ? e : new ElevenLabsError("failed", 500, String(e));
    log("nyx-voice-elevenlabs-fehler", { code: err.code, status: err.status });
    return c.json({ error: t(ELEVEN_SENTENCE[err.code]), reason: err.code }, err.code === "unauthorized" ? 400 : 502);
  }

  app.get("/api/nyx/voice/settings", async (c) => c.json(await current()));

  app.put("/api/nyx/voice/settings", async (c) => {
    const parsed = NyxVoiceSettingsPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      const error = field === "lexicon" ? t("Jeder Aussprache-Eintrag braucht ein Wort (bis 60 Zeichen) und wie es klingen soll (bis 120 Zeichen).") : t("Diese Einstellung passt nicht.");
      return c.json({ error, reason: `bad_${typeof field === "string" ? field : "settings"}` }, 400);
    }
    if (parsed.data.provider === "elevenlabs" && !(await secrets.has(ELEVENLABS_SECRET))) {
      return c.json({ error: t("Bitte zuerst einen ElevenLabs-Schlüssel eintragen."), reason: "no_key" }, 400);
    }
    await saveVoiceSettings(db, parsed.data);
    log("nyx-voice-settings", { fields: Object.keys(parsed.data) });
    return c.json(await current());
  });

  app.put("/api/nyx/voice/elevenlabs/key", async (c) => {
    const parsed = ElevenLabsKeyPutSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("Das sieht nicht nach einem ElevenLabs-Schlüssel aus."), reason: "bad_key" }, 400);
    try {
      // Erst prüfen, dann speichern: ein Tippfehler landet so nie im Speicher.
      await listElevenLabsVoices(parsed.data.value, fetchImpl);
      await secrets.setSecret(ELEVENLABS_SECRET, parsed.data.value);
    } catch (e) {
      return elevenFail(c, e);
    }
    log("nyx-voice-elevenlabs-schluessel", { set: true });
    return c.json(await current());
  });

  app.delete("/api/nyx/voice/elevenlabs/key", async (c) => {
    await secrets.deleteSecret(ELEVENLABS_SECRET);
    const s = await loadVoiceSettings(db);
    if (s.provider === "elevenlabs") await saveVoiceSettings(db, { provider: "local" });
    log("nyx-voice-elevenlabs-schluessel", { set: false });
    return c.json(await current());
  });

  // Instant Voice Clone: Hörprobe (WAV/MP3 ≤ 10 MB) + Name + Bestätigung, dass der Nutzer die Stimme nutzen darf.
  app.post(
    "/api/nyx/voice/elevenlabs/clone",
    bodyLimit({ maxSize: ELEVENLABS_CLONE_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: t("Die Hörprobe ist zu groß – höchstens 10 MB."), reason: "too_large" }, 413) }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      const name = String(form?.get("name") ?? "").trim();
      const consent = form?.get("consent") === "1";
      if (!form || !(file instanceof File) || file.size === 0) return c.json({ error: t("Bitte eine Hörprobe (WAV oder MP3) auswählen."), reason: "no_file" }, 400);
      if (file.size > ELEVENLABS_CLONE_MAX_BYTES) return c.json({ error: t("Die Hörprobe ist zu groß – höchstens 10 MB."), reason: "too_large" }, 413);
      if (!name || name.length > 60) return c.json({ error: t("Bitte einen Namen für die Stimme eingeben (bis 60 Zeichen)."), reason: "bad_name" }, 400);
      if (!consent) return c.json({ error: t("Bitte bestätigen, dass du diese Stimme verwenden darfst."), reason: "no_consent" }, 400);
      const type = cloneSampleType(file.name, file.type);
      if (!type) return c.json({ error: t("Bitte eine WAV- oder MP3-Datei nehmen."), reason: "bad_type" }, 415);
      try {
        const key = await secrets.getSecret(ELEVENLABS_SECRET);
        if (!key) return c.json({ error: t("Bitte zuerst einen ElevenLabs-Schlüssel eintragen."), reason: "no_key" }, 400);
        const out = await cloneElevenLabsVoice(key, { name, fileName: file.name || `probe.${type === "audio/wav" ? "wav" : "mp3"}`, type, bytes: new Uint8Array(await file.arrayBuffer()) }, fetchImpl);
        log("nyx-voice-elevenlabs-klon", { bytes: file.size });
        return c.json({ id: out.id, name });
      } catch (e) {
        return elevenFail(c, e);
      }
    },
  );

  app.get("/api/nyx/voice/elevenlabs/voices", async (c) => {
    try {
      const key = await secrets.getSecret(ELEVENLABS_SECRET);
      if (!key) return c.json({ error: t("Bitte zuerst einen ElevenLabs-Schlüssel eintragen."), reason: "no_key" }, 400);
      return c.json({ voices: await listElevenLabsVoices(key, fetchImpl) });
    } catch (e) {
      return elevenFail(c, e);
    }
  });
}
