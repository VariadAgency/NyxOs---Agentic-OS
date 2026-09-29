// Stimme auf dem Server — Vertrag zwischen API (`apps/server/src/routes/nyx-voice.ts`), Nyx-Tab
//, Telegram und dem Container `nyx-voice` (infra/nyx-voice).
//   POST /api/nyx/voice/transcribe  Audio (webm/ogg/mp4/wav, ≤ 25 MB) → {text, language, ms}
//   POST /api/nyx/voice/speak       {text, voice?, speed?} → audio/ogg (Opus), ?format=wav → audio/wav
//   POST /api/nyx/voice/speak?stream=1 → audio/wav in Stücken: 44-Byte-Kopf mit offener Länge, dann
//                                   PCM 16 bit mono little-endian, sobald gerechnet (erster Ton sofort). Kopfzeilen:
//                                   x-nyx-voice, x-nyx-sample-rate, x-nyx-voice-fallback („1“ = Ersatzstimme sprach)
//   GET  /api/nyx/voice/status      → {stt:{model,ready}, tts:{voice,ready,voiceInfo}} + Satz für die Oberfläche
import { z } from "zod";
import { getLang, t } from "./i18n/index.js";

/** Größte Aufnahme (≈ 25 Minuten Opus). */
export const NYX_VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Längster Text je `speak`-Aufruf — längere Antworten satzweise schicken (`splitSpeakable`). */
export const NYX_VOICE_MAX_TEXT_CHARS = 2000;
export const NYX_VOICE_MIN_SPEED = 0.5;
export const NYX_VOICE_MAX_SPEED = 2;

// ─────────── Aussprache, Anbieter, ElevenLabs ───────────

export const NYX_LEXICON_MAX_ENTRIES = 300;
/** Ein Aussprache-Eintrag: ganzes Wort (Groß/Klein egal) → so spricht die deutsche Stimme es. */
export const NyxLexiconEntrySchema = z.object({
  word: z.string().trim().min(1).max(60),
  say: z.string().trim().min(1).max(120),
});
export type NyxLexiconEntry = z.infer<typeof NyxLexiconEntrySchema>;

export const ELEVENLABS_MODELS = ["eleven_multilingual_v2", "eleven_flash_v2_5"] as const;
export type ElevenLabsModel = (typeof ELEVENLABS_MODELS)[number];
export type NyxVoiceProvider = "local" | "elevenlabs";

/** Stimmen-Einstellungen (Server, eine Zeile). Der ElevenLabs-Schlüssel steht NIE hier drin, nur ob er gesetzt ist. */
export interface NyxVoiceSettings {
  provider: NyxVoiceProvider;
  elevenlabs: {
    keySet: boolean;
    /** Letzte 4 Zeichen zur Wiedererkennung (oder null). */
    last4: string | null;
    voiceId: string | null;
    voiceName: string | null;
    model: ElevenLabsModel;
  };
  lexicon: NyxLexiconEntry[];
  /** Eingebaute Einträge des Stimmen-Dienstes gelten immer; eigene gehen vor. */
  updatedAt: string | null;
}

export const NyxVoiceSettingsPatchSchema = z
  .object({
    provider: z.enum(["local", "elevenlabs"]),
    elevenlabsVoiceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    elevenlabsVoiceName: z.string().trim().max(120).nullable(),
    elevenlabsModel: z.enum(ELEVENLABS_MODELS),
    lexicon: z.array(NyxLexiconEntrySchema).max(NYX_LEXICON_MAX_ENTRIES),
  })
  .partial()
  .strict();
export type NyxVoiceSettingsPatch = z.infer<typeof NyxVoiceSettingsPatchSchema>;

export const ElevenLabsKeyPutSchema = z.object({ value: z.string().trim().min(10).max(200) }).strict();

export interface ElevenLabsVoice {
  id: string;
  name: string;
  /** z. B. „premade“, „cloned“, „professional“. */
  category: string | null;
  /** Kurze Beschreibung aus den Merkmalen (Akzent, Geschlecht, Alter …). */
  description: string | null;
  previewUrl: string | null;
}

/** importierbare Stimme (Katalog des Stimmen-Dienstes, nur geprüfte freie Lizenzen). */
export interface NyxImportableVoice {
  id: string;
  label: string;
  language: NyxVoiceLanguage;
  engine: string;
  license: string;
  sizeBytes: number;
  installed: boolean;
}

/** Nur Piper-Pakete aus den sherpa-onnx-Releases (der Dienst prüft zusätzlich gegen seinen Katalog). */
export const NYX_VOICE_IMPORT_URL = /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\/vits-piper-[a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-(?:x_low|low|medium|high)\.tar\.bz2$/;
export const NyxVoiceImportSchema = z.union([
  z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
  z.object({ url: z.string().trim().max(300).regex(NYX_VOICE_IMPORT_URL) }).strict(),
]);
export type NyxVoiceImport = z.infer<typeof NyxVoiceImportSchema>;

/** ElevenLabs „Instant Voice Clone“ – Probe höchstens 10 MB (WAV/MP3). */
export const ELEVENLABS_CLONE_MAX_BYTES = 10 * 1024 * 1024;

export const NyxVoiceSpeakRequestSchema = z.object({
  text: z.string().trim().min(1).max(NYX_VOICE_MAX_TEXT_CHARS),
  /** Stimmen-Kennung aus `status.tts.voices` (z. B. `de_DE-thorsten-high`); ohne Angabe die Standard-Stimme. */
  voice: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** eigene englische Stimme für englische Sätze (z. B. `pocket-en-george`); ohne Angabe die Server-Standard. */
  voiceEn: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** `auto` (Standard) = Sprache je Satz erkennen; `de`/`en` = ganzer Text in dieser Sprache. */
  language: z.enum(["auto", "de", "en"]).optional(),
  /** Tempo, 1 = normal. */
  speed: z.number().min(NYX_VOICE_MIN_SPEED).max(NYX_VOICE_MAX_SPEED).optional(),
  /** `auto` (Standard) = wie in den Einstellungen; `local` = immer die eigene Stimme (Hörprobe lokaler Stimmen);
   *  `elevenlabs` = ElevenLabs (Hörprobe), mit `elevenVoice` eine bestimmte ElevenLabs-Stimme. */
  provider: z.enum(["auto", "local", "elevenlabs"]).optional(),
  elevenVoice: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** eigene Aussprache-Einträge (Wort → gesprochen) nur für diese Anfrage, z. B. Hörprobe im Editor. */
  lexicon: z.array(NyxLexiconEntrySchema).max(NYX_LEXICON_MAX_ENTRIES).optional(),
  /** Sprache, wenn der Text selbst keine erkennen lässt („Okay.“) – ohne Angabe die Sprache der App. */
  defaultLanguage: z.enum(["de", "en"]).optional(),
});
export type NyxVoiceSpeakRequest = z.infer<typeof NyxVoiceSpeakRequestSchema>;
export type NyxVoiceFormat = "ogg" | "wav";

/** Größe des WAV-Kopfs vor dem PCM beim Streamen (`?stream=1`). */
export const NYX_VOICE_STREAM_HEADER_BYTES = 44;
/** Stimme, die immer bereitsteht und einspringt, wenn die gewünschte fehlt (klein, schnell). */
export const NYX_VOICE_FALLBACK = "de_DE-thorsten-medium";

/** eine installierte Stimme — für die Auswahl in den Einstellungen. */
export interface NyxVoiceInfo {
  id: string;
  /** Anzeige-Name, z. B. „Jürgen (natürlich)“. */
  label: string;
  ready: boolean;
  state: NyxVoicePartState;
  /** `pocket` (Kyutai Pocket TTS) oder `piper`. */
  engine: string;
  /** Liefert Ton schon während der Rechnung (echtes Streaming statt satzweise). */
  streaming: boolean;
  /** Rechenzeit/Tonlänge beim Warmlauf (kleiner = schneller), `null` solange unbekannt. */
  rtf: number | null;
  /** Sprache der Stimme — jede Stimme spricht genau eine (kein Mehrsprachen-Modell). */
  language: NyxVoiceLanguage;
}

/** Nyx versteht und spricht Deutsch und Englisch, mit getrennten Stimmen. */
export type NyxVoiceLanguage = "de" | "en";

/** Zustand eines Teils (Erkennung oder Stimme). `offline` = Dienst antwortet nicht, `not_configured` = nicht eingerichtet. */
export type NyxVoicePartState = "ready" | "waiting" | "downloading" | "loading" | "error" | "offline" | "not_configured";

export interface NyxVoicePart {
  ready: boolean;
  state: NyxVoicePartState;
  /** Download-Fortschritt in Prozent (nur beim Laden), sonst `null`. */
  progress: number | null;
  /** Größe des Modell-Downloads in Bytes (für „lädt Modell (0,5 GB)“). */
  bytesTotal: number | null;
}

/** Wo die Stimme läuft: `server` = Container im Server-Modus, `local` = Stimmen-Paket auf diesem Computer. */
export type NyxVoiceScope = "server" | "local";

export interface NyxVoiceStatus {
  /** fehlt bei älteren Servern (= `server`). */
  scope?: NyxVoiceScope;
  stt: NyxVoicePart & { model: string | null; language: string | null };
  tts: NyxVoicePart & {
    /** Stimme, die gerade spricht (gewünschte oder Ersatz). */
    voice: string | null;
    voices: string[];
    /** alle Stimmen mit Namen + Zustand (für die Auswahl). */
    voiceInfo?: NyxVoiceInfo[];
    /** Stimmen mit geprüfter freier Lizenz, die man in den Einstellungen dazuholen kann. */
    importable?: NyxImportableVoice[];
    /** Gewünschte Standard-Stimme (Server-Einstellung `NYX_TTS_DEFAULT`). */
    preferred?: string | null;
    /** Ersatzstimme, falls die gewünschte nicht bereit ist. */
    fallback?: string | null;
    /** Stimme, die gerade englische Sätze spricht. */
    voiceEn?: string | null;
    /** gewünschte englische Standard-Stimme (Server-Einstellung `NYX_TTS_DEFAULT_EN`). */
    preferredEn?: string | null;
    /** englische Ersatzstimme. */
    fallbackEn?: string | null;
  };
  /** Ein Satz in einfacher Sprache für die Oberfläche. */
  sentence: string;
  /** Was der Nutzer bzw. Claude tun kann (oder `null`, wenn alles läuft). */
  fix: string | null;
}

export interface NyxVoiceTranscribeResult {
  text: string;
  language: string;
  /** Rechenzeit der Erkennung (ohne Netz). */
  ms: number;
  /** Zeit vom Eingang der Anfrage bis zur Antwort in der API (inkl. Weg zum Dienst). */
  totalMs: number;
  audioSeconds: number;
  model: string;
  /** `server` = Stimmen-Dienst, `mac` = Rückfall über die Brücke. */
  engine: "server" | "mac";
}

/** Fehler-Antwort aller drei Routen. `reason` ist ein Kurz-Grund für Technik-Ansichten, nie direkt in der UI. */
export interface NyxVoiceError {
  error: string;
  fix?: string | null;
  reason?: string;
}

export const NYX_VOICE_FIX_START = "Stimmen-Dienst starten (Server-Modus: docker compose --profile voice up -d).";

/**
 * Die Erkennung hört „Nyx“ als „Nücks/Nüks/Nüx/Nicks“ (N0-Messung).
 * Nur ganze Wörter vor Satzzeichen/Leerraum/Ende; „nix“ bleibt (echtes Wort).
 */
const NYX_MISHEARD = /(?<!\p{L})(?:Nücks|Nüks|Nüx|Nicks)(?=[,.!?:;]|\s|$)/gu;
export function fixNyxName(text: string): string {
  return text.replace(NYX_MISHEARD, "Nyx");
}

/**
 * English: the recogniser writes "Nyx" as "Nix"/"Nicks". "Nix" is also a real package manager, so only the
 * sure cases change: "Nicks"/"Nyks" anywhere, "Nix" only when someone talks to Nyx — at the start of the text
 * or after a greeting ("Hey Nix, …", "Okay Nix") and in "I am Nix"/"I'm Nix".
 */
const NYX_MISHEARD_EN = /(?<!\p{L})(?:Nicks|Nyks)(?=[,.!?:;]|\s|$)/gu;
const NYX_ADDRESSED_EN = /(^\s*|(?<!\p{L})(?:hey|hi|hello|okay|ok|thanks|thank you|I am|I'm)[,\s]+)Nix(?=[,.!?:;]|\s|$)/giu;
export function fixNyxNameEn(text: string): string {
  return text.replace(NYX_MISHEARD_EN, "Nyx").replace(NYX_ADDRESSED_EN, (_m, lead: string) => `${lead}Nyx`);
}

/** Corrections for recognised text in the language it was heard in. */
export function fixTranscriptFor(text: string, language: string | null | undefined): string {
  return language === "en" ? fixNyxNameEn(text) : fixTranscript(text);
}

/**
 * Fachwörter, die die Erkennung verhört. Nur SICHERE Korrekturen: „Bild/Boot“ sind echte Wörter und
 * werden nur in der festen Wendung „… auf de[mn] Mac/Markt“ zu „Build auf dem Mac“; „Boilt/Boild“ gibt es nicht.
 */
const TRANSCRIPT_FIXES: readonly (readonly [RegExp, string])[] = [
  [/(?<!\p{L})(?:Boilt|Boild|Bilt|Bild|Boot|Built)\s+auf\s+de[mn]\s+(?:Mac|Mäc|Mack|Meck|Markt)(?!\p{L})/giu, "Build auf dem Mac"],
  [/(?<!\p{L})(?:Boilt|Boild)(?!\p{L})/gu, "Build"],
];

/** Alle Korrekturen für erkannten Text (Name „Nyx“ + Fachwörter) – für jede Erkennung über die API. */
export function fixTranscript(text: string): string {
  let out = fixNyxName(text);
  for (const [re, word] of TRANSCRIPT_FIXES) out = out.replace(re, word);
  return out;
}

/** „0,5 GB“ bzw. „115 MB“ — für Sätze wie „lädt Modell (0,5 GB)“. */
export function formatModelSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 300_000_000) {
    const gb = (bytes / 1_000_000_000).toFixed(1);
    return `${getLang() === "en" ? gb : gb.replace(".", ",")} GB`;
  }
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Ein Satz je Zustand eines Teils (`what` = „Stimme“ steht für den ganzen Dienst, s. `nyxVoiceSentence`). */
export function nyxVoicePartSentence(part: NyxVoicePart, scope: NyxVoiceScope = "server"): { sentence: string; fix: string | null } {
  if (scope === "local") return localPartSentence(part);
  const size = formatModelSize(part.bytesTotal);
  switch (part.state) {
    case "ready":
      return { sentence: t("Stimme bereit."), fix: null };
    case "waiting":
    case "downloading":
      return {
        sentence: t("Stimme startet noch – lädt Modell{size} …{progress}", { size: size ? ` (${size})` : "", progress: part.progress !== null ? ` ${part.progress} %` : "" }),
        fix: t("Kurz warten – das passiert nur beim allerersten Start."),
      };
    case "loading":
      return { sentence: t("Stimme startet noch – Modell wird geladen …"), fix: t("Kurz warten, das dauert nur ein paar Sekunden.") };
    case "error":
      return { sentence: t("Die Stimme konnte ihr Modell nicht laden und versucht es in ein paar Minuten erneut."), fix: t("Claude schaut ins Protokoll: {cmd}", { cmd: "docker logs nyxos-nyx-voice" }) };
    case "offline":
      return { sentence: t("Die Stimme läuft gerade nicht."), fix: t(NYX_VOICE_FIX_START) };
    case "not_configured":
      return { sentence: t("Die Stimme ist auf diesem Server nicht eingerichtet."), fix: t(NYX_VOICE_FIX_START) };
  }
}

/** Dieselben Zustände für das Stimmen-Paket auf diesem Computer (lokaler Modus): kein Docker, kein Server. */
function localPartSentence(part: NyxVoicePart): { sentence: string; fix: string | null } {
  const size = formatModelSize(part.bytesTotal);
  switch (part.state) {
    case "ready":
      return { sentence: t("Stimme bereit."), fix: null };
    case "waiting":
    case "downloading":
      return {
        sentence: t("Stimme startet noch – lädt Modell{size} …{progress}", { size: size ? ` (${size})` : "", progress: part.progress !== null ? ` ${part.progress} %` : "" }),
        fix: t("Kurz warten – das passiert nur beim allerersten Start."),
      };
    case "loading":
      return { sentence: t("Stimme startet noch – Modell wird geladen …"), fix: t("Kurz warten, das dauert nur ein paar Sekunden.") };
    case "error":
      return { sentence: t("Die Stimme konnte ihr Modell nicht laden und versucht es in ein paar Minuten erneut."), fix: t("Internet prüfen. Protokoll: {cmd}", { cmd: "nyxos logs" }) };
    case "offline":
      return { sentence: t("Die Stimme läuft gerade nicht."), fix: t("Sie startet von selbst neu. Zustand prüfen: {cmd}", { cmd: "nyxos voice status" }) };
    case "not_configured":
      return { sentence: t("Die Stimme ist noch nicht installiert."), fix: t("Einstellungen → Nyx → Stimme: mit einem Klick installieren.") };
  }
}

/** Gesamtsatz: der Teil, der noch nicht bereit ist, bestimmt die Aussage (Erkennung zuerst). */
export function nyxVoiceSentence(
  stt: NyxVoicePart,
  tts: NyxVoicePart,
  names: { model: string | null; voice: string | null },
  scope: NyxVoiceScope = "server",
): { sentence: string; fix: string | null } {
  if (stt.ready && tts.ready) {
    const vars = { model: names.model ?? "?", voice: names.voice ?? "?" };
    return {
      sentence: scope === "local" ? t("Stimme bereit: Erkennung ({model}) und Sprachausgabe ({voice}) laufen auf diesem Computer.", vars) : t("Stimme bereit: Erkennung ({model}) und Sprachausgabe ({voice}) laufen auf dem Server.", vars),
      fix: null,
    };
  }
  return nyxVoicePartSentence(stt.ready ? tts : stt, scope);
}

// ─────────── Stimmen-Paket (nur lokaler Modus: `nyxos voice install`) ───────────
//   GET  /api/nyx/voice/pack          → VoicePackStatus
//   POST /api/nyx/voice/pack/install  → startet die Installation (gleicher Weg wie `nyxos voice install`)
//   POST /api/nyx/voice/pack/remove   → entfernt Stimme, Modelle, Python und Pakete

/** Schritte der Installation, in dieser Reihenfolge. */
export const VOICE_PACK_STEPS = ["check", "uv", "python", "packages", "ffmpeg", "done"] as const;
export type VoicePackStep = (typeof VOICE_PACK_STEPS)[number];

/**
 * `not_installed` · `installing` · `removing` · `starting` (Dienst startet) · `running` · `restarting` (Dienst
 * abgestürzt, startet gleich neu) · `failed` (letzte Installation schlug fehl) · `unsupported` (dieser Computer).
 */
export type VoicePackState = "not_installed" | "installing" | "removing" | "starting" | "running" | "restarting" | "failed" | "unsupported";

export interface VoicePackStatus {
  state: VoicePackState;
  installed: boolean;
  /** laufender Installationsschritt (sonst null). */
  step: VoicePackStep | null;
  /** Fortschritt des Schritts in Prozent (nur bei Downloads), sonst null. */
  progress: number | null;
  /** Ein Satz, wenn etwas schiefging (Installation oder Dienst), sonst null. */
  error: string | null;
  /** Ungefährer Download beim Installieren inkl. erstem Start (Bytes). */
  downloadBytes: number;
  /** ffmpeg aus dem Paket (`imageio-ffmpeg`) oder das des Systems. */
  ffmpeg: "imageio-ffmpeg" | "system" | null;
}

/** Programme (~0,1 GB) + Modelle beim ersten Start (Parakeet 0,49 GB, Thorsten 67 MB, Linda 116 MB). */
export const VOICE_PACK_DOWNLOAD_BYTES = 800_000_000;

/** Ein Satz je Fehler-Kennung von `nyxos voice install --json`. */
export function voicePackErrorSentence(code: string): string {
  switch (code) {
    case "busy":
      return t("Die Stimme wird gerade schon installiert.");
    case "unsupported":
      return t("Die Stimme gibt es nur für macOS und Linux (64 Bit).");
    case "source_missing":
      return t("Diese NyxOS-Version enthält die Stimme nicht – bitte zuerst aktualisieren.");
    case "disk":
      return t("Zu wenig freier Speicher – die Stimme braucht etwa 2 GB.");
    case "download":
    case "python":
      return t("Der Download ist fehlgeschlagen – bitte Internet prüfen und noch einmal versuchen.");
    case "checksum":
      return t("Eine heruntergeladene Datei war nicht in Ordnung – bitte noch einmal versuchen.");
    case "packages":
      return t("Die Sprach-Pakete ließen sich nicht installieren – bitte noch einmal versuchen.");
    case "ffmpeg":
      return t("Es fehlt ein ffmpeg mit Opus – bitte ffmpeg installieren und noch einmal versuchen.");
    default:
      return t("Die Installation hat nicht geklappt – bitte noch einmal versuchen.");
  }
}

/**
 * Text in sprechbare Stücke teilen: an Satzenden, der ERSTE Teil möglichst kurz (schneller erster Ton),
 * kein Teil länger als `max`. Zu lange Sätze werden an Komma/Semikolon, notfalls am Leerzeichen geteilt.
 * `parts.join(" ")` ergibt wieder den (an Leerraum normalisierten) Text.
 */
export function splitSpeakable(text: string, max = 240, firstMax = 90): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["“”»)]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) out.push(s);
    else out.push(...splitLong(s, max));
  }
  // Der erste Teil entscheidet über die Wartezeit bis zum ersten Ton: lange erste Sätze am Komma kürzen.
  const first = out[0];
  if (first && first.length > firstMax) out.splice(0, 1, ...splitLong(first, firstMax));
  return out;
}

function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    cut = cut > max / 3 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ─────────────────────────── Deutsch oder Englisch? ───────────────────────────
// Spiegel von infra/nyx-voice/nyx_voice/text_lang.py (gleiche Wortlisten, gleiche Regel): Funktionswörter zählen,
// Umlaute/ß zählen doppelt für Deutsch. Fachwörter (Build, Commit, Deploy, Session, Push …) stehen in KEINER Liste
// und kippen einen deutschen Satz nie ins Englische; Wörter beider Sprachen („in, an, was, will, okay“) zählen nicht.
const DE_WORDS = new Set(
  `der die das den dem des ein eine einen einem einer eines kein keine keinen keinem keiner und oder aber doch denn
ist sind bin bist seid war waren wird werden wurde wurden hat habe hast haben hatte hatten kann kannst können könnte
soll sollte sollen muss musst müssen darf dürfen möchte möchtest mag magst will willst
ich du er sie wir ihr mir mich dir dich ihm ihn uns euch sich mein meine meinen dein deine unser unsere euer ihre
nicht nichts noch schon auch nur mal jetzt gerade heute morgen gestern bitte danke ja nein genau gut sehr ganz
mit für von zu zum zur im ins vom beim am um bis nach über unter vor seit ohne gegen durch aus bei
was wer wie wo wann warum wieso weshalb welche welcher welches dass wenn weil ob als dann damit also
hier dort da dies diese dieser dieses alle alles viel viele mehr weniger etwas einfach wieder immer
läuft fertig gemacht machen mach mache macht gibt geht gehen sag sagen zeig zeige schau prüf prüfe fehlt hallo tschüss
klar perfekt verstanden erledigt prima gleich`.split(/\s+/),
);
const EN_WORDS = new Set(
  `the and or but is are was were be been being am do does did done have has had having can could should would
shall may might must i you he she it we they me him her us them my your his its our their mine yours
this that these those there here not no yes please thanks thank just now today tomorrow yesterday
with of to for from on at by about into over under after before without through
what who how where when why which whose if because then than
all some any every more less very really again always still already
it's i'm you're we're they're that's there's what's let's don't doesn't didn't can't won't isn't aren't wasn't
i've you've we've i'll you'll we'll i'd you'd
hi hello ready running works working failed fixed looks look let tell show give make go
good great nice perfect sure sorry fine morning evening night`.split(/\s+/),
);
// „check“ steht bewusst in KEINER Liste (deutsches Fachwort wie „Build“: „check mal die Session“).
const SHARED_WORDS = new Set(["okay", "ok", "hey", "in", "an", "was", "will", "war", "also", "so", "man", "hand", "rest", "top", "name", "art", "fast"]);

/** Punkte (Deutsch, Englisch) für einen Text. */
export function nyxLanguageScores(text: string): { de: number; en: number } {
  let de = 2 * (text.match(/[äöüÄÖÜß]/g)?.length ?? 0);
  let en = 0;
  for (const raw of text.match(/[A-Za-zÄÖÜäöüß'’]+/g) ?? []) {
    const w = raw.toLowerCase().replace(/’/g, "'").replace(/^'+|'+$/g, "");
    if (SHARED_WORDS.has(w)) continue;
    if (DE_WORDS.has(w)) de += 1;
    else if (EN_WORDS.has(w)) en += 1;
    else if (w === "a") en += 0.5;
  }
  return { de, en };
}

/**
 * Sprache eines Textes (z. B. einer Erkennung): „en“ nur, wenn englische Wörter überwiegen; unentschieden →
 * `fallback` (Standard Deutsch). Für kurze Rückmeldungen („Okay“) zählt also der Hinweis.
 */
export function guessVoiceLanguage(text: string, fallback: NyxVoiceLanguage = "de"): NyxVoiceLanguage {
  const { de, en } = nyxLanguageScores(text);
  if (en > de) return "en";
  if (de > en) return "de";
  return fallback;
}
