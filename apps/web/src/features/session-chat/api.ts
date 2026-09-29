// Abrufe für den Session-Chat (Sperr-Zustand, Senden), „Kontext komprimieren“ und
// „Session zusammenfassen & prüfen“. Schreibende Wege über `authFetch` (Anmelde-Token, „Bitte
// anmelden“-Dialog bei abgelaufener Anmeldung, s. features/terminal/authClient.ts).
import { t, type ChatAvailability, type ChatSendResult, type SessionAudit, type SessionAuditView, type SessionDeliveryView } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("Server antwortet mit {status}", { status: res.status }));
  return (await res.json()) as T;
}

/** Schreibender Aufruf; Fehlertext vom Server (für Menschen formuliert) wird zur Fehlermeldung. */
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein JSON
    }
    throw new Error(detail || (res.status === 413 ? t("Die Anhänge sind zu groß.") : t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen.")));
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
export const chatKey = (sessionId: string) => ["session", sessionId, "chat"] as const;
export const auditsKey = (sessionId: string) => ["session-audits", sessionId] as const;

/** Darfst du hier gerade schreiben? (Dieselbe Regel prüft der Server beim Senden.) */
export function useChatAvailability(sessionId: string) {
  return useQuery({
    queryKey: chatKey(sessionId),
    queryFn: async () => {
      const r = await getJson<Partial<ChatAvailability>>(`/api/sessions/${sessionId}/chat`);
      // Nur eine echte Antwort zählt (ein älterer Server ohne diese Route liefert etwas anderes).
      if (typeof r?.canSend !== "boolean") throw new Error(t("Unerwartete Antwort"));
      return r as ChatAvailability;
    },
    refetchInterval: 10_000,
  });
}

export interface OutgoingAttachment {
  name: string;
  dataBase64: string;
}

export function useSendChatMessage(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; attachments: OutgoingAttachment[] }) => post<ChatSendResult>(`/api/sessions/${sessionId}/message`, body),
    onSettled: () => void qc.invalidateQueries({ queryKey: chatKey(sessionId) }),
  });
}

/** Was wartet auf eine Pause der Session (Freigabe-Bescheid, Inbox-Antwort, /compact, Chat)? */
export const deliveriesKey = (sessionId: string) => ["deliveries", sessionId] as const;
export function useSessionDeliveries(sessionId: string) {
  return useQuery({
    queryKey: deliveriesKey(sessionId),
    queryFn: async () => (await getJson<{ deliveries: SessionDeliveryView[] }>(`/api/sessions/${enc(sessionId)}/deliveries`)).deliveries ?? [],
    // Zusätzlich zum `/live`-Signal: Verfall/Zustellung passiert im 60-s-Takt des Servers.
    refetchInterval: 60_000,
  });
}

export function useCancelDelivery(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/deliveries/${id}`, { method: "DELETE", headers: { "content-type": "application/json" } });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? t("Zurückziehen hat nicht geklappt."));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: deliveriesKey(sessionId) }),
  });
}

/** „Kontext komprimieren“ über den Weg des Kontext-Wächters — nur, wenn die Session wartet. */
export function useCompactWhenWaiting(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ sent: boolean; reason?: string }>(`/api/context-guard/sessions/${enc(sessionId)}/compact-now`, { onlyWhenWaiting: true }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["context-guard", "session", sessionId] }),
  });
}

export function useSessionAudits(sessionId: string) {
  return useQuery({
    queryKey: auditsKey(sessionId),
    queryFn: async (): Promise<SessionAuditView> => {
      const r = await getJson<Partial<SessionAuditView>>(`/api/sessions/${sessionId}/audits`);
      if (!r?.engine || !Array.isArray(r.audits)) throw new Error(t("Unerwartete Antwort"));
      return { engine: r.engine, audits: r.audits };
    },
    // Solange eine Prüfung läuft, öfter nachsehen (zusätzlich zum `/live`-Signal).
    refetchInterval: (q) => (q.state.data?.audits[0]?.status === "running" ? 3_000 : 60_000),
  });
}

export function useStartAudit(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<SessionAudit>(`/api/sessions/${sessionId}/audits`, {}),
    onSuccess: (audit) => {
      qc.setQueryData<SessionAuditView>(auditsKey(sessionId), (prev) => (prev ? { ...prev, audits: [audit, ...prev.audits.filter((a) => a.id !== audit.id)] } : prev));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: auditsKey(sessionId) }),
  });
}
