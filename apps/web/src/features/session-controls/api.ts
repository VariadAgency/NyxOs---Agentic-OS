// Abrufe der Session-Steuerung. Die Liste hängt nur an Werkzeug + Modell → lange zwischengespeichert;
// wechselt das Modell (neuer Schlüssel), wird neu gefragt.
import { t, type SessionControlRequest, type SessionControlResult, type SessionControlsView } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

const enc = encodeURIComponent;

/** An unexpected answer (e.g. an older server during an update) becomes an error state – never a crash of the session view. */
export function isSessionControlsView(x: unknown): x is SessionControlsView {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;
  const obj = (k: string) => (v[k] && typeof v[k] === "object" ? (v[k] as Record<string, unknown>) : null);
  const model = obj("model");
  const effort = obj("effort");
  const compact = obj("compact");
  return typeof v.tool === "string" && !!model && Array.isArray(model.options) && !!effort && Array.isArray(effort.levels) && !!compact && typeof compact.available === "boolean";
}

export function useSessionControls(sessionId: string, currentModel: string | null) {
  return useQuery({
    queryKey: ["session-controls", sessionId, currentModel ?? ""] as const,
    queryFn: async (): Promise<SessionControlsView> => {
      const res = await fetch(`/api/sessions/${enc(sessionId)}/controls`);
      if (!res.ok) throw new Error(t("Server antwortet mit {status}", { status: res.status }));
      const body: unknown = await res.json().catch(() => null);
      if (!isSessionControlsView(body)) throw new Error(t("Unerwartete Antwort vom Server"));
      return body;
    },
    staleTime: 10 * 60_000,
  });
}

export function useSetSessionControl(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SessionControlRequest): Promise<SessionControlResult> => {
      const res = await authFetch(`/api/sessions/${enc(sessionId)}/controls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        throw new Error(detail || t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen."));
      }
      return (await res.json()) as SessionControlResult;
    },
    // Die Zustell-Liste unter dem Chat zeigt, was noch auf die Pause wartet.
    onSettled: () => void qc.invalidateQueries({ queryKey: ["deliveries", sessionId] }),
  });
}
