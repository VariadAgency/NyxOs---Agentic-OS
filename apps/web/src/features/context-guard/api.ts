// Kontext-Wächter — Fetch-Helfer + React-Query-Hooks. Eigene Datei statt `lib/api.ts`:
// PUT/DELETE-Wege, die `lib/api.ts` bisher nicht kennt, ohne die gemeinsame Datei anzufassen.
import { t, type ContextGuardSessionView, type ContextGuardSettingsSnapshot, type ContextGuardThresholdsInput, resolveContextGuardThresholds, type ResolvedContextGuardThresholds } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("Server antwortet mit {status}", { status: res.status }));
  return (await res.json()) as T;
}

async function writeJson<T>(method: "PUT" | "POST" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein JSON
    }
    throw new Error(detail || t("Server antwortet mit {status}", { status: res.status }));
  }
  return (await res.json()) as T;
}

const KEY_SETTINGS = ["context-guard", "settings"] as const;
const keySession = (sessionId: string) => ["context-guard", "session", sessionId] as const;

export function useContextGuardSettings() {
  return useQuery({ queryKey: KEY_SETTINGS, queryFn: () => getJson<ContextGuardSettingsSnapshot>("/api/context-guard/settings") });
}

/** Schwellenfarben (`ContextRing` in `SessionCard`/`InfoPanel`) — dieselbe Reihenfolge wie
 * der Server (`context-guard/tick.ts` `checkSession`): Session-Override > Haiku > Modell-Override >
 * Standard. Eine einzige `useContextGuardSettings()`-Abfrage bedient alle Karten (react-query
 * cached/teilt sie), also keine Anfrage je Karte. `null`, solange die Einstellungen noch laden —
 * `ContextRing` fällt dann auf den Start-Standard (60/80) zurück. */
export function useSessionContextThresholds(sessionKey: string, models: string[]): ResolvedContextGuardThresholds | null {
  const settings = useContextGuardSettings();
  const snapshot = settings.data;
  if (!snapshot) return null;
  const isHaiku = models.some((m) => /haiku/i.test(m));
  const lastModel = models[models.length - 1] ?? null;
  const modelOverride = (lastModel && snapshot.models.find((m) => m.model === lastModel)) || null;
  const sessionOverride = snapshot.sessions.find((s) => s.sessionKey === sessionKey) ?? null;
  return resolveContextGuardThresholds({ defaults: snapshot.default, haiku: snapshot.haiku, modelOverride, sessionOverride, isHaiku });
}

export function useContextGuardSession(sessionId: string | null) {
  return useQuery({
    queryKey: keySession(sessionId ?? ""),
    queryFn: () => getJson<ContextGuardSessionView>(`/api/context-guard/sessions/${encodeURIComponent(sessionId as string)}`),
    enabled: sessionId !== null,
    // Kurz pollen genügt,
    // damit ein manueller Klick ("Jetzt komprimieren") sich sofort im Badge zeigt.
    refetchInterval: 15_000,
  });
}

function useInvalidateSettings() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY_SETTINGS });
}

export function useSaveDefaultThresholds() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: ContextGuardThresholdsInput) => writeJson("PUT", "/api/context-guard/settings/default", input),
    onSuccess: invalidate,
  });
}

export function useSaveHaikuThresholds() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: ContextGuardThresholdsInput) => writeJson("PUT", "/api/context-guard/settings/haiku", input),
    onSuccess: invalidate,
  });
}

export function useSaveModelThresholds() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: ({ model, input }: { model: string; input: ContextGuardThresholdsInput }) => writeJson("PUT", `/api/context-guard/settings/model/${encodeURIComponent(model)}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteModelThresholds() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (model: string) => writeJson("DELETE", `/api/context-guard/settings/model/${encodeURIComponent(model)}`),
    onSuccess: invalidate,
  });
}

export function useSaveSessionThresholds(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ContextGuardThresholdsInput) => writeJson("PUT", `/api/context-guard/settings/session/${encodeURIComponent(sessionId)}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keySession(sessionId) }),
  });
}

export function useDeleteSessionThresholds(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => writeJson("DELETE", `/api/context-guard/settings/session/${encodeURIComponent(sessionId)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keySession(sessionId) }),
  });
}

export function useCompactNow(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => writeJson<{ sent: boolean; queued?: boolean; reason?: string }>("POST", `/api/context-guard/sessions/${encodeURIComponent(sessionId)}/compact-now`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keySession(sessionId) }),
  });
}
