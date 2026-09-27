// Einstellungen → Telegram. Vertrag: `packages/shared/src/telegram.ts`, Server `apps/server/src/routes/telegram.ts`.
// Das Bot-Token geht nur hinein (PUT), nie heraus — der Server meldet „gesetzt“ + letzte 4 Zeichen.
import { t, type TelegramPairingResult, type TelegramSettingsPatch, type TelegramStatus } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/http";
import { authFetch } from "../terminal/authClient";

export const TELEGRAM_STATUS_KEY = ["telegram", "status"] as const;

async function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body: unknown = {}): Promise<T> {
  const res = await authFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein JSON
    }
    throw new ApiError(detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

export function useTelegramStatus() {
  return useQuery({
    queryKey: TELEGRAM_STATUS_KEY,
    queryFn: async (): Promise<TelegramStatus> => {
      const res = await fetch("/api/telegram/status");
      if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
      return (await res.json()) as TelegramStatus;
    },
    // „verbindet …“ löst sich von selbst — dann schneller nachsehen.
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 2000 : 30_000),
  });
}

function useStatusMutation<V>(fn: (v: V) => Promise<TelegramStatus>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (next) => qc.setQueryData(TELEGRAM_STATUS_KEY, next) });
}

export const useSaveTelegramToken = () => useStatusMutation((token: string) => send<TelegramStatus>("PUT", "/api/telegram/token", { token }));
export const useRemoveTelegramToken = () => useStatusMutation(() => send<TelegramStatus>("DELETE", "/api/telegram/token"));
export const useUnpairTelegram = () => useStatusMutation(() => send<TelegramStatus>("DELETE", "/api/telegram/pairing"));
export const usePatchTelegramSettings = () => useStatusMutation((patch: TelegramSettingsPatch) => send<TelegramStatus>("PATCH", "/api/telegram/settings", patch));

export function useCreatePairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => send<TelegramPairingResult>("POST", "/api/telegram/pairing"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TELEGRAM_STATUS_KEY }),
  });
}

export function useTelegramTest() {
  return useMutation({ mutationFn: () => send<{ sent: boolean }>("POST", "/api/telegram/test") });
}
