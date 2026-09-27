import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { __primeAuthForTests } from "../src/features/terminal/authClient";

/** Eigener QueryClient je Test: keine Retries, kein Cache zwischen Tests. */
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init }));
}

/** Antwort von `/api/bridge/presence` (Standard: online, Server-Uhr = jetzt). */
export function presenceBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    state: "online",
    reason: null,
    since: new Date(now - 3_600_000).toISOString(),
    heartbeatAgeMs: 4_000,
    channelOpen: true,
    machine: { id: "m1", name: "macbook" },
    serverNow: new Date(now).toISOString(),
    ...over,
  };
}

/** Antwort von `/api/entries/import/status` (Standard: beide Quellen importiert). */
export function importStatusBody(over: { dateien?: Record<string, unknown>; ideen?: Record<string, unknown> } = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  const base = { state: "ok", message: null, lastRunAt: now, lastOkAt: now, lastDeliveryAt: now, counts: {} };
  return { dateien: { ...base, ...over.dateien }, ideen: { ...base, lastDeliveryAt: null, ...over.ideen } };
}

interface Routes {
  health?: () => Promise<Response>;
  machines?: () => Promise<Response>;
  /** `/api/bridge/presence` (Statuszeile Brücke). Standard: online. */
  bridgePresence?: () => Promise<Response>;
  /** `/api/bridge/presence/history` (Verlauf im Popover). Standard: leer. */
  bridgeHistory?: () => Promise<Response>;
  sessions?: () => Promise<Response>;
  categories?: () => Promise<Response>;
  search?: () => Promise<Response>;
  /** `/api/search/all` (⌘K sucht alles). Standard: keine Treffer. */
  searchAll?: (url: string) => Promise<Response>;
  /** `/api/entries` (Aufgaben/Ideen/Audits). */
  entries?: (url: string, init?: RequestInit) => Promise<Response>;
  /** `/api/entries/import/status` und `/import/run`. Standard: beide Quellen „ok“. */
  entriesImport?: (url: string, init?: RequestInit) => Promise<Response>;
  /** `/api/files` und `/api/files/sessions`. */
  files?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Überblick, Git, Konflikte, Server, Regeln. */
  overview?: () => Promise<Response>;
  /** `/api/changes` („Seit du weg warst“). Standard: nichts Neues. */
  changes?: () => Promise<Response>;
  git?: () => Promise<Response>;
  gitCatchups?: () => Promise<Response>;
  conflicts?: () => Promise<Response>;
  reservations?: () => Promise<Response>;
  server?: () => Promise<Response>;
  rules?: () => Promise<Response>;
  /** `/api/builds/summary` (Überblick „Betrieb“). Standard: keine Läufe. */
  builds?: () => Promise<Response>;
  /** `/api/haiku/report` (Überblick-Briefing-Zeile). Standard: noch kein Bericht. */
  haikuReport?: () => Promise<Response>;
  /** Für `/api/sessions/:id/transcript` und andere Pfade, die eine ID im Pfad tragen. */
  fallback?: (url: string, init?: RequestInit) => Promise<Response> | undefined;
}

/** Ersetzt globalThis.fetch mit festen Antworten für /health, /api/machines, /api/sessions, /api/categories, /api/search, und /api/overview, /api/git, /api/conflicts, /api/server, /api/rules. */
export function stubFetchRoutes(routes: Routes) {
  // Schreibende Aufrufe holen sich einen CSRF-Kopf (`lib/api.ts`
  // `writeJson`/`createReservation`/`deleteJson`) — ohne dieses Priming würde der ERSTE schreibende
  // Aufruf eines Tests eine stille `/api/auth/status`-Anfrage auslösen, die eine per
  // `mockImplementationOnce` für den eigentlichen Aufruf vorgesehene Antwort abfängt.
  __primeAuthForTests();
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/health") && routes.health) return routes.health();
    if (url.startsWith("/api/machines") && routes.machines) return routes.machines();
    if (url.startsWith("/api/bridge/presence/history")) return (routes.bridgeHistory ?? (() => jsonResponse({ events: [] })))();
    if (url.startsWith("/api/bridge/presence")) return (routes.bridgePresence ?? (() => jsonResponse(presenceBody())))();
    if (url.startsWith("/api/categories")) return (routes.categories ?? (() => jsonResponse({ categories: [] })))();
    if (url.startsWith("/api/search/all")) return (routes.searchAll ?? (() => jsonResponse({ q: "", groups: [], tookMs: 0 })))(url);
    if (url.startsWith("/api/search")) return (routes.search ?? (() => jsonResponse({ hits: [], tookMs: 0 })))();
    if (url.startsWith("/api/entries/import/")) return (routes.entriesImport ?? (() => jsonResponse(importStatusBody())))(url, init);
    if (url.startsWith("/api/entries")) return (routes.entries ?? (() => jsonResponse({ entries: [] })))(url, init);
    if (url.startsWith("/api/files")) return (routes.files ?? (() => Promise.reject(new Error("kein Files-Stub"))))(url, init);
    if (url.startsWith("/api/changes")) return (routes.changes ?? (() => jsonResponse({ since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date().toISOString(), capped: false, groups: [] })))();
    if (url.startsWith("/api/overview")) return (routes.overview ?? (() => Promise.reject(new Error("kein Overview-Stub"))))();
    if (url.startsWith("/api/git/catchups")) return (routes.gitCatchups ?? (() => jsonResponse({ catchups: [] })))();
    if (url.startsWith("/api/git")) return (routes.git ?? (() => Promise.reject(new Error("kein Git-Stub"))))();
    if (url.startsWith("/api/conflicts")) return (routes.conflicts ?? (() => Promise.reject(new Error("kein Conflicts-Stub"))))();
    if (url.startsWith("/api/reservations")) return (routes.reservations ?? (() => jsonResponse({ reservations: [] })))();
    if (url.startsWith("/api/server")) return (routes.server ?? (() => Promise.reject(new Error("kein Server-Stub"))))();
    if (url.startsWith("/api/rules")) return (routes.rules ?? (() => jsonResponse({ rules: [] })))();
    if (url.startsWith("/api/builds/summary")) return (routes.builds ?? (() => jsonResponse({ recent: [], groups: [] })))();
    if (url.startsWith("/api/haiku/report")) return (routes.haikuReport ?? (() => jsonResponse({ report: null })))();
    if (url.startsWith("/api/sessions/")) {
      const fallback = routes.fallback?.(url, init);
      if (fallback) return fallback;
    } else if (url.startsWith("/api/sessions") && routes.sessions) {
      return routes.sessions();
    }
    return Promise.reject(new Error(`Test hat keine Antwort für ${url} vorgesehen`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}
