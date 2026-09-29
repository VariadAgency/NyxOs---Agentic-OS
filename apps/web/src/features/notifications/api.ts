// Notifications – client for `/api/notifications/*` (contract: packages/shared/src/notifications.ts).
import {
  t,
  type NotifyFeedback,
  type NotifyFeedbackResponse,
  type NotifyHistoryResponse,
  type NotifyPreviewRequest,
  type NotifyPreviewResponse,
  type NotifySettingsPatch,
  type NotifySettingsResponse,
  type PushTestResponse,
} from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/http";
import { authFetch } from "../terminal/authClient";

export const NOTIFY_SETTINGS_KEY = ["notify", "settings"] as const;
export const NOTIFY_HISTORY_KEY = ["notify", "history"] as const;

async function send<T>(method: "POST" | "PATCH", url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // no JSON
    }
    throw new ApiError(detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

export function useNotifySettings() {
  return useQuery({
    queryKey: NOTIFY_SETTINGS_KEY,
    queryFn: async (): Promise<NotifySettingsResponse> => {
      const res = await fetch("/api/notifications/settings");
      if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
      return (await res.json()) as NotifySettingsResponse;
    },
    // "you are here/away right now" stays roughly current.
    refetchInterval: 60_000,
  });
}

export function usePatchNotifySettings(onSaved?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: NotifySettingsPatch) => send<NotifySettingsResponse>("PATCH", "/api/notifications/settings", patch),
    onSuccess: (next) => {
      qc.setQueryData(NOTIFY_SETTINGS_KEY, next);
      // Rule suggestions depend on the levels.
      void qc.invalidateQueries({ queryKey: NOTIFY_HISTORY_KEY });
      void qc.invalidateQueries({ queryKey: ["push-subscribe"] });
      onSaved?.();
    },
  });
}

export function useNotifyHistory() {
  return useQuery({
    queryKey: NOTIFY_HISTORY_KEY,
    queryFn: async (): Promise<NotifyHistoryResponse> => {
      const res = await fetch("/api/notifications/history?limit=50");
      if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
      return (await res.json()) as NotifyHistoryResponse;
    },
    refetchInterval: 60_000,
  });
}

export function useNotifyFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, value }: { id: number; value: NotifyFeedback }) => send<NotifyFeedbackResponse>("POST", `/api/notifications/history/${id}/feedback`, { value }),
    // Visible at once (button pressed), the server confirms afterwards; suggestions come with the reload.
    onMutate: ({ id, value }) => {
      qc.setQueryData<NotifyHistoryResponse>(NOTIFY_HISTORY_KEY, (old) => (old ? { ...old, items: old.items.map((i) => (i.id === id ? { ...i, feedback: value } : i)) } : old));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: NOTIFY_HISTORY_KEY }),
  });
}

export function useNotifyPreview() {
  return useMutation({ mutationFn: (req: NotifyPreviewRequest) => send<NotifyPreviewResponse>("POST", "/api/notifications/preview", req) });
}

export function usePushTest() {
  return useMutation({
    mutationFn: async (): Promise<PushTestResponse> => {
      const body = await send<Partial<PushTestResponse> | null>("POST", "/api/push/test", {});
      // Guard the answer: without the list (older server) never crash.
      const results = Array.isArray(body?.results) ? body.results.filter((r) => !!r && typeof r.detail === "string" && ["mac", "browser", "ntfy"].includes(r.channel)) : [];
      return { results };
    },
  });
}
