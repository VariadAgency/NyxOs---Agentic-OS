// Sprechen statt tippen (whisper.cpp). Vertrag zwischen Server (`apps/server/src/voice`)
// und Web (`apps/web/src/features/voice`). Einsatz laut GOAL: Suchfeld/⌘K jetzt, Haiku-Panel und
// Terminal-Eingabe später — `target` unten ist genau die dafür bereitgestellte Schnittstelle.
import { z } from "zod";
import { t } from "./i18n/index.js";

/** Wo die Erkennung lief — "mac" über die Brücke (schnell, wenn online), sonst "server" (Fallback). */
export const VoiceEngineSchema = z.enum(["mac", "server"]);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

/** Wohin Haiku das strukturierte Diktat einordnen soll (Schnittstelle für P3-Terminal/P7-Haiku,
 * hier nur benannt, die jeweilige Phase entscheidet, was sie damit tut). */
export const VoiceTargetSchema = z.enum(["search", "haiku", "terminal"]);
export type VoiceTarget = z.infer<typeof VoiceTargetSchema>;

export const VoiceTranscribeResultSchema = z.object({
  text: z.string(),
  engine: VoiceEngineSchema,
  tookMs: z.number().int().nonnegative(),
  /** Sekunden Audio, die erkannt wurden — Grundlage für "Echtzeit-Faktor" in Messungen. */
  audioSeconds: z.number().nonnegative(),
});
export type VoiceTranscribeResult = z.infer<typeof VoiceTranscribeResultSchema>;

/** Fachwörter, die als Anfangs-Prompt an whisper.cpp gehen — eine Quelle der
 * Wahrheit für Server (`voice/whisper.ts`) und die Mess-Tabelle im Abschlussbericht. */
export const VOICE_INITIAL_PROMPT_DE =
  "Worktree, Opus, Haiku, Codex, NyxOS, Sonnet, Xcode, Deploy, Backend, Frontend, Pull Request, Sitzung, Terminal, Datenbank";
/** Dasselbe Vokabular für englisches Diktat (App-Sprache Englisch). */
export const VOICE_INITIAL_PROMPT_EN =
  "Worktree, Opus, Haiku, Codex, NyxOS, Sonnet, Xcode, deploy, backend, frontend, pull request, session, terminal, database";

/** Anfangs-Prompt passend zur Sprache des Diktats (whisper.cpp auf dem Rechner bzw. im Server-Prozess). */
export function voiceInitialPrompt(language: string): string {
  return language === "en" ? VOICE_INITIAL_PROMPT_EN : VOICE_INITIAL_PROMPT_DE;
}

// ───────────────────────────── Sprache läuft auf dem Rechner (Brücke) ─────────────────────────────
// Standard ist jetzt der eigene Stimmen-Dienst auf dem Server (Container nyx-voice, 3 CPUs/4 GB,
// s. nyx-voice.ts); die Brücke unten ist der Rückfall. Die Begründung darunter galt für whisper.cpp in der API.
// Entscheidung: whisper.cpp NICHT ins Server-Abbild. Ein Server wird oft mit anderen Diensten geteilt, die API
// hat 1 CPU / 1 GB; `ggml-small` braucht allein ~0,9 GB RAM und auf einem geteilten x86-Kern ein Vielfaches
// der Zeit. Auf dem Rechner liegen whisper-cli + ffmpeg (Homebrew) und die Modelle schon, Metal rechnet ein
// Diktat in < 1 s. Der Server reicht das Audio per RPC an die Brücke (wie `run_build`).

/** Fähigkeit, die die Brücke im `hello` meldet (ältere Brücken kennen die Sprache noch nicht). */
export const BRIDGE_CAP_VOICE = "voice";
/** Brücke nimmt `language: "auto"` (Deutsch UND Englisch ohne Vorgabe). Ältere Brücken bekommen weiter ein Kürzel. */
export const BRIDGE_CAP_VOICE_AUTO = "voice_auto";

/** Größtes Diktat, das über die Brücke geht (≈ 5 Min Opus-Audio). */
export const VOICE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export const VOICE_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/x-wav"] as const;

export const VoiceBridgeRequestSchema = z.object({
  /** Audio (Browser-Aufnahme) als Base64. */
  audioB64: z
    .string()
    .min(1)
    .max(Math.ceil((VOICE_MAX_AUDIO_BYTES * 4) / 3) + 8),
  /** Nur der Mime-Typ entscheidet die Dateiendung; sonst übernimmt die Brücke nichts vom Server. */
  mime: z.enum(VOICE_MIME_TYPES),
  /** Sprachkürzel oder `auto` = Whisper erkennt die Sprache selbst (nur Brücken mit {@link BRIDGE_CAP_VOICE_AUTO}). */
  language: z
    .string()
    .regex(/^(?:auto|[a-z]{2})$/)
    .default("de"),
});
export type VoiceBridgeRequest = z.infer<typeof VoiceBridgeRequestSchema>;

/** `server_starting`/`server_offline` = der Stimmen-Dienst auf dem Server (Standard) lädt noch bzw.
 * läuft nicht UND die Brücke kann auch nicht einspringen. */
export type VoiceUnavailableReason = "whisper_missing" | "ffmpeg_missing" | "model_missing" | "bridge_offline" | "bridge_outdated" | "server_starting" | "server_offline";

export type VoiceProbeResult = { ok: true; model: string } | { ok: false; reason: VoiceUnavailableReason; detail: string };

export type VoiceBridgeResult = { outcome: "done"; text: string; tookMs: number; model: string } | { outcome: "unavailable"; reason: VoiceUnavailableReason; detail: string };

/** Antwort von `GET /api/voice/health` (200 = bereit, 503 = nicht bereit, mit Satz + Schritt). */
export interface VoiceHealth {
  ok: boolean;
  engine: VoiceEngine | null;
  model: string | null;
  sentence: string;
  fix: string | null;
  /** Kurz-Grund für Technik-Ansichten (Verbindungen), nie direkt in der UI. */
  reason: VoiceUnavailableReason | null;
}

/** Ein Satz in einfacher Sprache + was der Nutzer bzw. Claude tun kann. */
export function voiceUnavailableSentence(reason: VoiceUnavailableReason): { sentence: string; fix: string } {
  switch (reason) {
    case "bridge_offline":
      return { sentence: t("Sprache läuft über deinen Mac – die Brücke ist gerade nicht verbunden."), fix: t("Mac aufwecken; die Brücke verbindet sich von selbst neu.") };
    case "bridge_outdated":
      return { sentence: t("Die Brücke ist noch auf altem Stand und kann noch keine Sprache erkennen."), fix: t("NyxOS aktualisieren (nyxos update) – die neue Brücke kann Sprache erkennen.") };
    case "whisper_missing":
      return { sentence: t("Auf dem Rechner fehlt die Spracherkennung (whisper.cpp)."), fix: t("Im Terminal auf dem Rechner: {cmd}", { cmd: "brew install whisper-cpp" }) };
    case "ffmpeg_missing":
      return { sentence: t("Auf dem Rechner fehlt ffmpeg, das die Aufnahme für die Erkennung umwandelt."), fix: t("Im Terminal auf dem Rechner: {cmd}", { cmd: "brew install ffmpeg" }) };
    case "server_starting":
      return { sentence: t("Stimme startet noch – das Sprachmodell auf dem Server lädt."), fix: t("Kurz warten – das passiert nur beim allerersten Start.") };
    case "server_offline":
      return { sentence: t("Die Stimme läuft gerade nicht, und die Brücke kann nicht einspringen."), fix: t("Stimmen-Dienst starten (Server-Modus: docker compose --profile voice up -d).") };
    case "model_missing":
      return {
        sentence: t("Auf dem Rechner liegt noch kein Sprachmodell für die Erkennung."),
        fix: t("Modell laden: {cmd}", { cmd: 'curl -L --create-dirs -o "$HOME/Library/Application Support/NyxOS/whisper/ggml-small.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' }),
      };
  }
}
