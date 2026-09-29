// Stimmen-Einstellungen (Tabelle `nyx_voice_settings`, eine Zeile) und die Stimme „mit Einstellungen“:
// Ein Wrapper um den Stimmen-Dienst, den ALLE Sprecher nutzen (Nyx-Tab, Begleiter, Telegram):
//   - hängt das eigene Aussprache-Wörterbuch an jede Anfrage (der Dienst wendet es auf deutsche Sätze an, vor den
//     eingebauten Einträgen, s. infra/nyx-voice/nyx_voice/text_de.py),
//   - spricht gestreamt über ElevenLabs, wenn das der gewählte Anbieter ist und ein Schlüssel gesetzt ist – bei jedem
//     Fehler (Schlüssel, Guthaben, Netz) automatisch mit der eigenen Stimme weiter.
// Nicht gestreamt (Telegram-Sprachnachricht, ogg) bleibt immer die eigene Stimme – ElevenLabs liefert dort kein Opus.
import type { ElevenLabsModel, NyxLexiconEntry, NyxVoiceProvider, NyxVoiceSettings, NyxVoiceSettingsPatch, NyxVoiceSpeakRequest } from "@nyxos/shared";
import { ELEVENLABS_MODELS, getLang } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nyxVoiceSettings } from "../db/schema.js";
import { ELEVENLABS_SAMPLE_RATE, ELEVENLABS_SECRET, ElevenLabsError, elevenLabsStream } from "./elevenlabs.js";
import type { NyxVoiceBackend, NyxVoiceSpeechStream } from "./voice-backend.js";

export interface StoredVoiceSettings {
  provider: NyxVoiceProvider;
  elevenlabsVoiceId: string | null;
  elevenlabsVoiceName: string | null;
  elevenlabsModel: ElevenLabsModel;
  lexicon: NyxLexiconEntry[];
  updatedAt: string | null;
}

export const DEFAULT_VOICE_SETTINGS: StoredVoiceSettings = {
  provider: "local",
  elevenlabsVoiceId: null,
  elevenlabsVoiceName: null,
  elevenlabsModel: "eleven_multilingual_v2",
  lexicon: [],
  updatedAt: null,
};

function asModel(v: string): ElevenLabsModel {
  return (ELEVENLABS_MODELS as readonly string[]).includes(v) ? (v as ElevenLabsModel) : DEFAULT_VOICE_SETTINGS.elevenlabsModel;
}

export async function loadVoiceSettings(db: Db): Promise<StoredVoiceSettings> {
  const [row] = await db.select().from(nyxVoiceSettings).where(eq(nyxVoiceSettings.id, 1)).limit(1);
  if (!row) return DEFAULT_VOICE_SETTINGS;
  return {
    provider: row.provider === "elevenlabs" ? "elevenlabs" : "local",
    elevenlabsVoiceId: row.elevenlabsVoiceId,
    elevenlabsVoiceName: row.elevenlabsVoiceName,
    elevenlabsModel: asModel(row.elevenlabsModel),
    lexicon: Array.isArray(row.lexicon) ? row.lexicon : [],
    updatedAt: row.updatedAt,
  };
}

/** Doppelte Wörter (Groß/Klein egal): der letzte Eintrag gewinnt; Reihenfolge sonst wie eingegeben. */
export function dedupeLexicon(entries: NyxLexiconEntry[]): NyxLexiconEntry[] {
  const byWord = new Map<string, NyxLexiconEntry>();
  for (const e of entries) {
    const key = e.word.trim().toLowerCase();
    byWord.delete(key);
    byWord.set(key, { word: e.word.trim(), say: e.say.trim() });
  }
  return [...byWord.values()];
}

export async function saveVoiceSettings(db: Db, patch: NyxVoiceSettingsPatch): Promise<StoredVoiceSettings> {
  const cur = await loadVoiceSettings(db);
  const next = {
    provider: patch.provider ?? cur.provider,
    elevenlabsVoiceId: patch.elevenlabsVoiceId !== undefined ? patch.elevenlabsVoiceId : cur.elevenlabsVoiceId,
    elevenlabsVoiceName: patch.elevenlabsVoiceName !== undefined ? patch.elevenlabsVoiceName : cur.elevenlabsVoiceName,
    elevenlabsModel: patch.elevenlabsModel ?? cur.elevenlabsModel,
    lexicon: patch.lexicon ? dedupeLexicon(patch.lexicon) : cur.lexicon,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(nyxVoiceSettings)
    .values({ id: 1, ...next })
    .onConflictDoUpdate({ target: nyxVoiceSettings.id, set: next });
  return next;
}

export function publicVoiceSettings(s: StoredVoiceSettings, key: { set: boolean; last4: string | null }): NyxVoiceSettings {
  return {
    provider: s.provider,
    elevenlabs: { keySet: key.set, last4: key.last4, voiceId: s.elevenlabsVoiceId, voiceName: s.elevenlabsVoiceName, model: s.elevenlabsModel },
    lexicon: s.lexicon,
    updatedAt: s.updatedAt,
  };
}

export interface ConfiguredVoiceDeps {
  settings: () => Promise<StoredVoiceSettings>;
  /** Klartext-Schlüssel oder null (nicht gesetzt / Speicher-Schlüssel fehlt). */
  elevenLabsKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Anfrage an den eigenen Dienst: nur seine Felder + das Wörterbuch (Anfrage-Einträge gehen vor gespeicherten).
 * Ohne `defaultLanguage` gilt die Sprache der App: sie wählt die Stimme, wenn der Text keine Sprache erkennen lässt. */
export function localRequest(req: NyxVoiceSpeakRequest, lexicon: NyxLexiconEntry[]): NyxVoiceSpeakRequest {
  const { provider: _p, elevenVoice: _e, lexicon: reqLexicon, ...rest } = req;
  const merged = dedupeLexicon([...lexicon, ...(reqLexicon ?? [])]);
  const withLang = { ...rest, defaultLanguage: rest.defaultLanguage ?? getLang() };
  return merged.length ? { ...withLang, lexicon: merged } : withLang;
}

export class ConfiguredVoiceBackend implements NyxVoiceBackend {
  constructor(
    private readonly inner: NyxVoiceBackend,
    private readonly deps: ConfiguredVoiceDeps,
  ) {}

  private async settingsSafe(): Promise<StoredVoiceSettings> {
    try {
      return await this.deps.settings();
    } catch (e) {
      this.deps.log?.("nyx-voice-settings-fehler", { error: e instanceof Error ? e.message : String(e) });
      return DEFAULT_VOICE_SETTINGS;
    }
  }

  status() {
    return this.inner.status();
  }

  transcribe(audio: Uint8Array, opts: { mime: string; language: string }) {
    return this.inner.transcribe(audio, opts);
  }

  get importVoice(): NyxVoiceBackend["importVoice"] {
    return this.inner.importVoice?.bind(this.inner);
  }

  async speak(req: NyxVoiceSpeakRequest, format: "ogg" | "wav") {
    const s = await this.settingsSafe();
    return this.inner.speak(localRequest(req, s.lexicon), format);
  }

  async speakStream(req: NyxVoiceSpeakRequest, signal?: AbortSignal): Promise<NyxVoiceSpeechStream> {
    const s = await this.settingsSafe();
    const provider = req.provider ?? "auto";
    const wantEleven = provider === "elevenlabs" || (provider === "auto" && s.provider === "elevenlabs");
    const voiceId = req.elevenVoice ?? s.elevenlabsVoiceId;
    let elevenFailed = false;
    if (wantEleven && voiceId) {
      const out = await this.tryEleven(req, s, voiceId, signal);
      if (out) return out;
      elevenFailed = true;
    }
    if (!this.inner.speakStream) throw new ElevenLabsError("failed", 501, "lokale Stimme kann nicht streamen");
    const local = await this.inner.speakStream(localRequest(req, s.lexicon), signal);
    // ElevenLabs wurde versucht, sprach aber nicht → als Ersatzstimme markieren (Oberfläche zeigt „Ersatz“).
    return elevenFailed ? { ...local, fallback: true } : local;
  }

  private async tryEleven(req: NyxVoiceSpeakRequest, s: StoredVoiceSettings, voiceId: string, signal?: AbortSignal): Promise<NyxVoiceSpeechStream | null> {
    let key: string | null = null;
    try {
      key = await this.deps.elevenLabsKey();
    } catch (e) {
      this.deps.log?.("nyx-voice-elevenlabs-fehler", { code: "key", error: e instanceof Error ? e.message : String(e) });
    }
    if (!key) return null;
    try {
      const body = await elevenLabsStream(
        key,
        { voiceId, model: s.elevenlabsModel, text: req.text, speed: req.speed, language: req.language === "de" || req.language === "en" ? req.language : undefined },
        this.deps.fetchImpl ?? fetch,
        signal,
      );
      return { body, voice: `elevenlabs:${voiceId}`, voices: [`elevenlabs:${voiceId}`], sampleRate: ELEVENLABS_SAMPLE_RATE, fallback: false };
    } catch (e) {
      // Automatischer Rückfall auf die eigene Stimme; protokolliert wird nur der Grund, nie der Schlüssel.
      const err = e instanceof ElevenLabsError ? e : new ElevenLabsError("failed", 500, String(e));
      this.deps.log?.("nyx-voice-elevenlabs-fehler", { code: err.code, status: err.status, detail: err.detail.slice(0, 200) });
      return null;
    }
  }
}

export { ELEVENLABS_SECRET };
