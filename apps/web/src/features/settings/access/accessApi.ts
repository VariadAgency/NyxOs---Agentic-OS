// Einstellungen → Zugänge. Werte gehen nur zum Server; zurück kommt Zustand + „endet auf …“.
import { t } from "@nyxos/shared";
import type { AccessBulkResult, AccessCheck, AccessId, AccessListResponse, AccessStatus, ModelCatalogResponse } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../../terminal/authClient";
import { MODELS_KEY, SettingsApiError } from "../modelsApi";

async function send<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = method === "GET" ? await fetch(url) : await authFetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    const text = typeof data?.error === "string" ? data.error : res.status === 404 ? t("Das ist auf dem Server noch nicht eingespielt – kommt mit dem nächsten Deploy.") : t("Das hat nicht geklappt – bitte noch einmal versuchen.");
    throw new SettingsApiError(text, res.status);
  }
  return data as T;
}

export const ACCESS_KEY = ["access"] as const;
const CATALOG_KEY = [...MODELS_KEY, "catalog"] as const;

export function useAccess() {
  return useQuery({ queryKey: ACCESS_KEY, queryFn: () => send<AccessListResponse>("GET", "/api/access"), retry: false, staleTime: 15_000 });
}

export function useModelCatalog() {
  return useQuery({ queryKey: CATALOG_KEY, queryFn: () => send<ModelCatalogResponse>("GET", "/api/models/catalog"), retry: false, staleTime: 60_000 });
}

function useDone() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ACCESS_KEY });
    void client.invalidateQueries({ queryKey: MODELS_KEY });
    void client.invalidateQueries({ queryKey: ["telegram"] });
    void client.invalidateQueries({ queryKey: ["mcp", "connectors"] });
  };
}

export function useSaveAccess() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, value }: { id: AccessId; value: string }) => send<AccessStatus>("PUT", `/api/access/${id}`, { value }), onSuccess: done });
}

export function useCheckAccess() {
  const done = useDone();
  return useMutation({ mutationFn: (id: AccessId) => send<{ check: AccessCheck; status: AccessStatus }>("POST", `/api/access/${id}/check`), onSuccess: done });
}

export function useRemoveAccess() {
  const done = useDone();
  return useMutation({ mutationFn: (id: AccessId) => send<AccessStatus>("DELETE", `/api/access/${id}`), onSuccess: done });
}

export function useBulkAccess() {
  const done = useDone();
  return useMutation({ mutationFn: (entries: { id: AccessId; value: string }[]) => send<AccessBulkResult>("POST", "/api/access/bulk", { entries }), onSuccess: done });
}
