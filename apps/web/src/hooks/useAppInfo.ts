// Version, run mode (local/server/demo), language, the user's name and the onboarding state.
import type { AppInfo, AppSettingsPatch } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAppInfo } from "../lib/appInfo";
import { authFetch } from "../features/terminal/authClient";

export const APP_INFO_KEY = ["app-info"] as const;

export function useAppInfo() {
  return useQuery({ queryKey: APP_INFO_KEY, queryFn: fetchAppInfo, staleTime: 60_000 });
}

/** The user's name from the onboarding (empty string until then). */
export function useUserName(): string {
  return useAppInfo().data?.settings.userName ?? "";
}

export async function saveAppSettings(patch: AppSettingsPatch): Promise<AppInfo> {
  const res = await authFetch("/api/app/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AppInfo;
}

export function useSaveAppSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveAppSettings,
    onSuccess: (info) => qc.setQueryData(APP_INFO_KEY, info),
  });
}
