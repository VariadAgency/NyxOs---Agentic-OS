// API der Nyx-Einstellungen (Profil + Vorlagen). Schreiben über `authFetch` (Anmeldung + CSRF).
import { t } from "@nyxos/shared";
import type { ElevenLabsVoice, NyxPreset, NyxPresetCreate, NyxPresetsResponse, NyxProfile, NyxProfileResponse, NyxVoiceSettings, NyxVoiceSettingsPatch, NyxVoiceStatus, VoicePackStatus } from "@nyxos/shared";
import { authFetch } from "../../terminal/authClient";

export const PROFILE_KEY = ["nyx", "profile"] as const;
export const PRESETS_KEY = ["nyx", "presets"] as const;

/** Fehler mit dem (schon übersetzten) Satz vom Server, falls es einen gibt – `friendlyError` filtert Technik. */
class NyxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function send<T>(method: "GET" | "PUT" | "POST" | "DELETE", url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (method !== "GET") {
    // Der Server verlangt für jede schreibende Anfrage JSON als Inhaltstyp – auch beim Löschen.
    init.headers = { "content-type": "application/json" };
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  const res = await authFetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein Text vom Server
    }
    throw new NyxApiError(detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

export const fetchNyxProfile = () => send<NyxProfileResponse>("GET", "/api/nyx/profile");
export const saveNyxProfile = (p: NyxProfile) => send<NyxProfileResponse>("PUT", "/api/nyx/profile", p);
export const fetchNyxPresets = () => send<NyxPresetsResponse>("GET", "/api/nyx/presets");
export const createNyxPreset = (p: NyxPresetCreate) => send<{ preset: NyxPreset }>("POST", "/api/nyx/presets", p);
export const deleteNyxPreset = (id: string) => send<{ ok: true }>("DELETE", `/api/nyx/presets/${encodeURIComponent(id)}`);

// ─── Stimme (Anbieter, ElevenLabs, Aussprache) ───

export const VOICE_SETTINGS_KEY = ["nyx", "voice-settings"] as const;
/** Voller Stimmen-Zustand (inkl. importierbarer Stimmen) – eigener Schlüssel, der Nyx-Tab nutzt eine schmalere Form. */
export const VOICE_STATUS_FULL_KEY = ["nyx", "voice-status-full"] as const;
export const fetchVoiceStatusFull = () => send<NyxVoiceStatus>("GET", "/api/nyx/voice/status");
export const ELEVEN_VOICES_KEY = ["nyx", "elevenlabs-voices"] as const;

export const fetchVoiceSettings = () => send<NyxVoiceSettings>("GET", "/api/nyx/voice/settings");
export const saveVoiceSettings = (patch: NyxVoiceSettingsPatch) => send<NyxVoiceSettings>("PUT", "/api/nyx/voice/settings", patch);
export const saveElevenLabsKey = (value: string) => send<NyxVoiceSettings>("PUT", "/api/nyx/voice/elevenlabs/key", { value });
export const deleteElevenLabsKey = () => send<NyxVoiceSettings>("DELETE", "/api/nyx/voice/elevenlabs/key");
export const fetchElevenLabsVoices = () => send<{ voices: ElevenLabsVoice[] }>("GET", "/api/nyx/voice/elevenlabs/voices").then((b) => b.voices);

/** Stimme aus dem Katalog (Kennung) oder per sherpa-onnx-Adresse dazuholen; lädt auf dem Server im Hintergrund. */
export const importVoice = (req: { id: string } | { url: string }) => send<{ id: string; added: boolean; state: string }>("POST", "/api/nyx/voice/import", req);

/** ElevenLabs „Instant Voice Clone“ – Hörprobe als multipart (Datei + Name + Bestätigung). */
export async function cloneElevenLabsVoice(name: string, file: File): Promise<{ id: string; name: string }> {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  form.append("consent", "1");
  const res = await authFetch("/api/nyx/voice/elevenlabs/clone", { method: "POST", body: form });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new NyxApiError(detail || t("Die Stimme ließ sich nicht anlegen."), res.status);
  }
  return (await res.json()) as { id: string; name: string };
}

/**
 * Hörprobe: gestreamt sprechen lassen (nur so spricht auch ElevenLabs), ganz abholen und als WAV abspielbar machen
 * (der Strom-Kopf hat eine offene Länge – hier werden die echten Längen eingetragen).
 */
export async function fetchProbeAudio(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ blob: Blob; voice: string; fallback: boolean }> {
  const res = await authFetch("/api/nyx/voice/speak?stream=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new NyxApiError(detail || t("Die Hörprobe hat nicht geklappt."), res.status);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 44) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(40, bytes.length - 44, true);
  }
  return { blob: new Blob([bytes], { type: "audio/wav" }), voice: res.headers.get("x-nyx-voice") ?? "", fallback: res.headers.get("x-nyx-voice-fallback") === "1" };
}

// ─── Stimmen-Paket (nur lokal: `nyxos voice install` über den Knopf) ───

export const VOICE_PACK_KEY = ["nyx", "voice-pack"] as const;
export const fetchVoicePack = () => send<VoicePackStatus>("GET", "/api/nyx/voice/pack");
export const installVoicePack = () => send<VoicePackStatus>("POST", "/api/nyx/voice/pack/install", {});
export const removeVoicePack = () => send<VoicePackStatus>("POST", "/api/nyx/voice/pack/remove", {});
