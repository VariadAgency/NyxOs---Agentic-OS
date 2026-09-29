// Abfragen für Host-Daten und den Server-Finder. Beides verlangt die Anmeldung (auth.ts). Automatische
// Abfragen laufen mit normalem fetch (ohne Anmelde-Dialog beim bloßen Öffnen des Tabs) — bei 401 zeigt die
// Kachel einen Knopf „Anmelden“, der über authFetch den Anmelde-Dialog öffnet.
import { t, type HostFsEntry, type HostFsListResult, type HostFsRoot, type HostFsTextResponse, type HostInfo } from "@nyxos/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { authFetch } from "../terminal/authClient";

export class HostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = res.status === 401 ? t("Bitte anmelden, dann sind die Server-Daten da.") : t("Das hat gerade nicht geklappt.");
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error && res.status !== 401) msg = body.error;
    } catch {
      // kein JSON
    }
    throw new HostApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

const qs = (root: string, rel: string) => new URLSearchParams({ root, p: rel }).toString();
const retry = (n: number, e: unknown) => n < 1 && !(e instanceof HostApiError && e.status < 500);

export function isLoginError(e: unknown): boolean {
  return e instanceof HostApiError && e.status === 401;
}

/** Öffnet den Anmelde-Dialog (authFetch) und lädt danach alle Server-Abfragen neu. */
export function useHostLogin(): () => void {
  const client = useQueryClient();
  return useCallback(() => {
    void authFetch("/api/server/files/roots")
      .then(() => client.invalidateQueries({ queryKey: ["server-host"] }))
      .catch(() => undefined);
  }, [client]);
}

/** Antwort absichern: fehlende Listen/Felder nie als Absturz enden lassen. Unbekannte Felder (neuere oder
 * ältere Server) laufen unverändert durch. */
function normalizeHost(h: Partial<HostInfo>): HostInfo {
  return {
    ...h,
    checkedAt: h.checkedAt ?? new Date().toISOString(),
    hostname: h.hostname ?? null,
    os: h.os ?? null,
    kernel: h.kernel ?? null,
    cpuModel: h.cpuModel ?? null,
    cores: h.cores ?? null,
    cpuPercent: h.cpuPercent ?? null,
    load: Array.isArray(h.load) ? h.load : null,
    uptimeSeconds: h.uptimeSeconds ?? null,
    bootedAt: h.bootedAt ?? null,
    memTotal: h.memTotal ?? null,
    memAvailable: h.memAvailable ?? null,
    swapTotal: h.swapTotal ?? null,
    swapFree: h.swapFree ?? null,
    temperatures: Array.isArray(h.temperatures) ? h.temperatures : [],
    disks: Array.isArray(h.disks) ? h.disks : [],
    network: Array.isArray(h.network) ? h.network : [],
    // Nur veröffentlichte Container-Ports (mit Container-Name); ältere Antworten ohne Name fallen weg.
    ports: Array.isArray(h.ports) ? h.ports.filter((p) => typeof p?.container === "string") : [],
    containersRunning: h.containersRunning ?? null,
    containersTotal: h.containersTotal ?? null,
    dockerVersion: h.dockerVersion ?? null,
    tailscale: typeof h.tailscale === "boolean" ? h.tailscale : null,
    // Ältere Server kennen diese Felder noch nicht → leer statt Absturz.
    cpuCores: Array.isArray(h.cpuCores) ? h.cpuCores : [],
    cpuSplit: h.cpuSplit ?? null,
    cpuMHz: h.cpuMHz ?? null,
    virtualization: h.virtualization ?? null,
    processes: h.processes ?? { running: null, blocked: null, threads: null, forkRate: null },
    contextSwitchRate: h.contextSwitchRate ?? null,
    interruptRate: h.interruptRate ?? null,
    memDetail: h.memDetail ?? null,
    swapInRate: h.swapInRate ?? null,
    swapOutRate: h.swapOutRate ?? null,
    majorFaultRate: h.majorFaultRate ?? null,
    oomKills: h.oomKills ?? null,
    diskIo: Array.isArray(h.diskIo) ? h.diskIo : [],
    pressure: h.pressure ?? { cpu: null, memory: null, io: null },
    openFiles: h.openFiles ?? null,
    history: Array.isArray(h.history) ? h.history : [],
    docker: h.docker ?? null,
    missing: Array.isArray(h.missing) ? h.missing : [],
  } as HostInfo;
}

export function useHostInfo() {
  return useQuery({
    queryKey: ["server-host", "info"],
    queryFn: async () => normalizeHost(await getJson<Partial<HostInfo>>("/api/server/host")),
    refetchInterval: 10_000,
    retry,
  });
}

export function useHostRoots(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["server-host", "roots"],
    queryFn: async () => {
      const body = await getJson<{ roots?: HostFsRoot[] }>("/api/server/files/roots");
      return Array.isArray(body.roots) ? body.roots : [];
    },
    staleTime: 60_000,
    retry,
  });
}

export function useHostList(root: string | null, rel: string) {
  return useQuery({
    queryKey: ["server-host", "list", root, rel],
    queryFn: async (): Promise<HostFsEntry[]> => {
      const body = await getJson<Partial<HostFsListResult>>(`/api/server/files/list?${qs(root ?? "", rel)}`);
      return Array.isArray(body.entries) ? body.entries : [];
    },
    enabled: root !== null,
    staleTime: 5_000,
    retry,
  });
}

export function useHostText(root: string | null, rel: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["server-host", "text", root, rel],
    queryFn: () => getJson<HostFsTextResponse>(`/api/server/files/text?${qs(root ?? "", rel ?? "")}`),
    enabled: enabled && root !== null && rel !== null,
    staleTime: 5_000,
    retry,
  });
}

export function hostRawUrl(root: string, rel: string, download = false): string {
  return `/api/server/files/raw?${qs(root, rel)}${download ? "&download=1" : ""}`;
}
