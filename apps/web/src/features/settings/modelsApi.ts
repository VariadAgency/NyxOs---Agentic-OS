// Einstellungen → Modelle + Konnektoren. Server gibt nie Klartext eines Schlüssels zurück.
import type { ConnectorPatch, ConnectorSave, ConnectorView, McpTemplate, McpTestResult, ModelRole, ProviderSave, ProviderTest, ProviderView, ResolvedModel, RoleView, SecretsKeyState } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

/** Fehler mit dem Satz des Servers (oder einem einfachen Ersatz). */
export class SettingsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function send<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res =
    method === "GET"
      ? await fetch(url)
      : await authFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    const text = typeof data?.error === "string" ? data.error : res.status === 404 ? t("Das ist auf dem Server noch nicht eingespielt – kommt mit dem nächsten Deploy.") : t("Das hat nicht geklappt – bitte noch einmal versuchen.");
    throw new SettingsApiError(text, res.status);
  }
  return data as T;
}

export interface ProvidersResponse {
  providers: ProviderView[];
  secretsKey: SecretsKeyState;
  bridge: { online: boolean; localProxy: boolean };
}
export interface ConnectorsResponse {
  connectors: ConnectorView[];
  templates: McpTemplate[];
  secretsKey: SecretsKeyState;
  engineRemote: boolean;
}

export const MODELS_KEY = ["models"] as const;
const PROVIDERS_KEY = [...MODELS_KEY, "providers"] as const;
const ROLES_KEY = [...MODELS_KEY, "roles"] as const;
const CONNECTORS_KEY = ["mcp", "connectors"] as const;

export function useProviders() {
  return useQuery({ queryKey: PROVIDERS_KEY, queryFn: () => send<ProvidersResponse>("GET", "/api/models/providers"), retry: false });
}

export function useModelRoles() {
  return useQuery({ queryKey: ROLES_KEY, queryFn: () => send<{ roles: RoleView[] }>("GET", "/api/models/roles"), retry: false, staleTime: 30_000 });
}

export function useConnectors() {
  return useQuery({ queryKey: CONNECTORS_KEY, queryFn: () => send<ConnectorsResponse>("GET", "/api/mcp/connectors"), retry: false });
}

function useInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: MODELS_KEY });
    void client.invalidateQueries({ queryKey: CONNECTORS_KEY });
    void client.invalidateQueries({ queryKey: ["haiku", "status"] });
  };
}

export function useSaveProvider() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: ProviderSave }) => (id ? send<ProviderView>("PUT", `/api/models/providers/${encodeURIComponent(id)}`, input) : send<ProviderView>("POST", "/api/models/providers", input)),
    onSuccess: done,
  });
}

export function useDeleteProvider() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => send<{ ok: boolean }>("DELETE", `/api/models/providers/${encodeURIComponent(id)}`), onSuccess: done });
}

export function useTestProvider() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, model }: { id: string; model?: string }) => send<ProviderTest>("POST", `/api/models/providers/${encodeURIComponent(id)}/test`, model ? { model } : {}), onSuccess: done });
}

export function useAssignRole() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ role, providerId, model }: { role: ModelRole; providerId: string | null; model: string | null }) => send<{ active: ResolvedModel }>("PUT", `/api/models/roles/${role}`, { providerId, model }),
    onSuccess: done,
  });
}

export function useCreateConnector() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: ConnectorSave) => send<ConnectorView>("POST", "/api/mcp/connectors", input), onSuccess: done });
}

export function usePatchConnector() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, patch }: { id: number; patch: ConnectorPatch }) => send<ConnectorView>("PATCH", `/api/mcp/connectors/${id}`, patch), onSuccess: done });
}

export function useDeleteConnector() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: number) => send<{ ok: boolean }>("DELETE", `/api/mcp/connectors/${id}`), onSuccess: done });
}

export function useTestConnector() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: number) => send<McpTestResult>("POST", `/api/mcp/connectors/${id}/test`), onSuccess: done });
}

/** Geräte-Anmeldung (Higgsfield): Link holen und öffnen; der Server wartet selbst auf die Bestätigung. */
export function useStartDeviceLogin() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await send<{ verificationUri: string | null }>("POST", `/api/mcp/connectors/${id}/device/start`);
      if (r.verificationUri) window.open(r.verificationUri, "_blank", "noopener");
      return r;
    },
    onSuccess: done,
  });
}

/** „Anmelden“: Adresse vom Server holen und in einem neuen Fenster öffnen (Rückkehr meldet sich per postMessage). */
export async function startConnectorLogin(id: number): Promise<void> {
  const popup = window.open("about:blank", "nyxos-mcp-login", "width=560,height=720");
  try {
    const { url } = await send<{ url: string }>("POST", `/api/mcp/connectors/${id}/oauth/start`, { origin: window.location.origin });
    if (popup) popup.location.href = url;
    else window.location.href = url;
  } catch (e) {
    popup?.close();
    throw e;
  }
}
