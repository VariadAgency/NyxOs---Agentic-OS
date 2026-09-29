// „Betrieb & Zugriff“ – access to /api/hosting/*. Everything through `authFetch` (sign-in + CSRF, 401 → dialog),
// because with NYXOS_AUTH_READS=1 (on in local mode, required as soon as an outside address is allowed) reading needs it too.
import { t, type HostingCheckRequest, type HostingCheckResult, type HostingProfileInput, type HostingProfileView, type HostingSecretId, type HostingSecretView, type HostingStatus } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

export const HOSTING_STATUS_KEY = ["hosting", "status"] as const;
export const HOSTING_PROFILE_KEY = ["hosting", "profile"] as const;
const STATUS_POLL_MS = 30_000;

export class HostingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(url, init.body || (init.method && init.method !== "GET") ? { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } } : init);
  const data = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) throw new HostingApiError(data?.error ?? t("Server antwortet mit {status}", { status: res.status }), res.status, data?.code ?? null);
  return data as T;
}

export function useHostingStatus() {
  return useQuery({ queryKey: HOSTING_STATUS_KEY, queryFn: () => call<HostingStatus>("/api/hosting/status"), refetchInterval: STATUS_POLL_MS, retry: false });
}

export function useHostingProfile() {
  return useQuery({ queryKey: HOSTING_PROFILE_KEY, queryFn: () => call<HostingProfileView>("/api/hosting/profile"), retry: false });
}

export function useSaveHostingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: HostingProfileInput) => call<HostingProfileView>("/api/hosting/profile", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (view) => {
      qc.setQueryData(HOSTING_PROFILE_KEY, view);
      void qc.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
    },
  });
}

export function useHostingCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: HostingCheckRequest) => call<HostingCheckResult>("/api/hosting/check", { method: "POST", body: JSON.stringify(req) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTING_PROFILE_KEY });
      void qc.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
    },
  });
}

export function useHostingSecret(id: HostingSecretId) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: HOSTING_PROFILE_KEY });
  const save = useMutation({
    mutationFn: (value: string) => call<HostingSecretView>(`/api/hosting/secrets/${id}`, { method: "PUT", body: JSON.stringify({ value }) }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => call<{ deleted: boolean }>(`/api/hosting/secrets/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  return { save, remove };
}
