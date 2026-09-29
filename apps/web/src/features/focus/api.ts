// Focus button – `GET/PUT /api/focus` (contract: packages/shared/src/focus.ts). Changes from other windows (or from Nyx,
// or the expiry) arrive live through `/live` `{ type: "focus" }` (useLiveSocket).
import { t, type FocusPut, type FocusResponse } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/http";
import { authFetch } from "../terminal/authClient";

export const FOCUS_KEY = ["focus"] as const;
/** Notice the expiry even without a live connection (keeps the "until 19:00" label current). */
const REFRESH_MS = 60_000;

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    return "";
  }
}

export function useFocus() {
  return useQuery({
    queryKey: FOCUS_KEY,
    queryFn: async (): Promise<FocusResponse> => {
      const res = await fetch("/api/focus");
      if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
      return (await res.json()) as FocusResponse;
    },
    refetchInterval: REFRESH_MS,
    placeholderData: (prev) => prev,
  });
}

export function useSetFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: FocusPut): Promise<FocusResponse> => {
      const res = await authFetch("/api/focus", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const detail = await readError(res);
        throw new ApiError(res.status === 401 ? t("Nicht angemeldet – bitte zuerst anmelden.") : detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
      }
      return (await res.json()) as FocusResponse;
    },
    onSuccess: (data) => qc.setQueryData(FOCUS_KEY, data),
  });
}
