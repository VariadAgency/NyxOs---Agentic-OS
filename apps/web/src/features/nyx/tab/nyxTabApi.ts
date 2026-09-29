// Aufrufe des Nyx-Tabs. Stimme = `/api/nyx/voice/*`, Gedächtnis = `/api/nyx/memory` (fehlt es, ehrlich leer),
// Ablage/Live-Stand = eigener Server-Teil (routes/nyx-tab.ts). Schreibend immer über
// `authFetch` (Anmeldung + CSRF an einer Stelle).
import { t, type HaikuCall, type NyxFile, type NyxLiveSnapshot, type NyxMemoryEntry, type NyxMemoryView, type NyxVoiceInfo } from "@nyxos/shared";
import { authFetch } from "../../terminal/authClient";

export class NyxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // kein JSON
  }
  return fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new NyxApiError(await messageOf(res, t("Der Server antwortet gerade nicht.")), res.status);
  return (await res.json()) as T;
}

// ───────────── Stimme ─────────────

export interface NyxVoiceStatus {
  stt: { model: string | null; ready: boolean };
  /** `voiceInfo` = alle Stimmen mit Namen (Vertrag `NyxVoiceInfo` in @nyxos/shared). */
  tts: {
    voice: string | null;
    ready: boolean;
    voiceInfo?: NyxVoiceInfo[];
    /** Stimme, die gerade englische Sätze spricht (älterer Server: fehlt). */
    voiceEn?: string | null;
  };
  /** `local` = Stimmen-Paket auf diesem Computer (älterer Server: fehlt = Server). */
  scope?: "server" | "local";
  /** Ein Satz für die Oberfläche + was zu tun ist (älterer Server: fehlt). */
  sentence?: string;
  fix?: string | null;
}

export const fetchVoiceStatus = () => getJson<NyxVoiceStatus>("/api/nyx/voice/status");

// ───────────── Live-Stand, Ablage ─────────────

export const fetchNyxLive = () => getJson<NyxLiveSnapshot>("/api/nyx/live");
export const fetchNyxFiles = (kind?: "image" | "upload") => getJson<{ files: NyxFile[] }>(`/api/nyx/files${kind ? `?kind=${kind}` : ""}`).then((b) => b.files);

export async function uploadNyxFile(file: Blob, name: string, threadId: number | null): Promise<NyxFile> {
  const res = await authFetch("/api/nyx/files", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-nyx-file-name": encodeURIComponent(name), ...(threadId ? { "x-nyx-thread": String(threadId) } : {}) },
    body: file,
  });
  if (!res.ok) throw new NyxApiError(await messageOf(res, t("Die Datei ist nicht angekommen – bitte noch einmal versuchen.")), res.status);
  return ((await res.json()) as { file: NyxFile }).file;
}

/** `question` = die Frage dieser Runde; kam die Meldung zu spät (neue Frage schon da), ändert der Server nichts. */
export async function saveInterrupted(threadId: number, heard: string, question?: string): Promise<void> {
  await authFetch(`/api/haiku/threads/${threadId}/interrupted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ heard, question }) });
}

// ───────────── Kontext / Kosten ─────────────

export interface CallDetail {
  call: Pick<HaikuCall, "id" | "status" | "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "costUsd" | "durationMs"> & { toolCalls: number | null; contextTokens: number | null };
  /** Werkzeug-Aufrufe dieser Antwort; `resultChars` = wie viel Kontext das Ergebnis gekostet hat. */
  tools: { name: string; ms: number; ok: boolean; resultChars: number; args?: unknown }[] | null;
}
export const fetchCall = (id: number) => getJson<CallDetail>(`/api/haiku/calls/${id}`);
export const fetchTools = () => getJson<{ tools: { name: string; description: string }[] }>("/api/haiku/tools").then((b) => b.tools);

// ───────────── Gedächtnis ─────────────
// Vertrag des Nyx-Kerns (packages/shared/src/nyx.ts): GET /api/nyx/memory → NyxMemoryView
// ({entries:[{id, category, fact, …}], usage, suggestions}) · PATCH /api/nyx/memory/:id {fact} · DELETE („vergessen“).

export type NyxMemoryItem = NyxMemoryEntry;

/** `null` = der Nyx-Kern hat noch kein Gedächtnis (Endpunkt fehlt) — ehrlich anzeigen, nicht als Fehler. */
export async function fetchMemory(): Promise<NyxMemoryItem[] | null> {
  const res = await fetch("/api/nyx/memory", { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new NyxApiError(await messageOf(res, t("Das Gedächtnis lässt sich gerade nicht laden.")), res.status);
  const body = (await res.json()) as Partial<NyxMemoryView>;
  return body.entries ?? [];
}

export async function updateMemory(id: NyxMemoryItem["id"], fact: string): Promise<void> {
  const res = await authFetch(`/api/nyx/memory/${encodeURIComponent(String(id))}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
  if (!res.ok) throw new NyxApiError(await messageOf(res, t("Ändern hat nicht geklappt.")), res.status);
}

export async function forgetMemory(id: NyxMemoryItem["id"]): Promise<void> {
  const res = await authFetch(`/api/nyx/memory/${encodeURIComponent(String(id))}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new NyxApiError(await messageOf(res, t("Vergessen hat nicht geklappt.")), res.status);
}
