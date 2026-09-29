// API-Aufrufe fürs Web — Aufgaben/Ideen/Audits teilen sich diese Aufrufe.
import type { CreateEntryInput, Entry, EntryDetail, EntryImportStatus, EntryKind, EntryStage } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { ApiError } from "../../lib/api";
import { authFetch } from "../terminal/authClient";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

// Schreibende /api/*-Wege brauchen eine Passkey-Sitzung + CSRF-Kopf (`terminal/auth.ts` `needsAuth`).
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

export interface StartPlan {
  slug: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  tmuxSocket: string;
  tmuxSession: string;
  goalPathHint: string | null;
  kind: "app" | "nyxos";
}

export function fetchEntries(filter: { q?: string; kind?: EntryKind; stage?: EntryStage } = {}): Promise<Entry[]> {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.stage) params.set("stage", filter.stage);
  const qs = params.toString();
  return getJson<{ entries: Entry[] }>(`/api/entries${qs ? `?${qs}` : ""}`).then((b) => b.entries);
}

export function fetchEntryDetail(id: number): Promise<EntryDetail> {
  return getJson<EntryDetail>(`/api/entries/${id}`);
}

export function fetchStartPlan(id: number): Promise<StartPlan> {
  return getJson<StartPlan>(`/api/entries/${id}/start-plan`);
}

export function startEntry(id: number): Promise<{ ok: boolean; plan: StartPlan; command: string }> {
  return postJson(`/api/entries/${id}/start`, {});
}

/** Neuer Eintrag (Bug, Idee, Frage, Problem) — z. B. „Idee ablegen“ im Ideen-Tab. */
export function createEntry(input: CreateEntryInput): Promise<{ entry: Entry }> {
  return postJson("/api/entries", input);
}

export function promoteIdea(id: number, kind: "aufgabe" | "bug" = "aufgabe"): Promise<{ entry: Entry }> {
  return postJson(`/api/entries/${id}/promote`, { kind });
}

/** Stand des Imports (Aufgaben-Dateien von der Brücke). */
export function fetchImportStatus(): Promise<EntryImportStatus> {
  return getJson<EntryImportStatus>("/api/entries/import/status");
}

/** „Jetzt importieren“ — braucht die Anmeldung. */
export function runImport(): Promise<{ status: EntryImportStatus }> {
  return postJson("/api/entries/import/run", {});
}
