// Aufrufe für „Dateien“ (Finder). Alle Wege brauchen die Anmeldung — `authFetch` öffnet bei 401
// den Anmelde-Dialog und wiederholt danach. Bilder/PDF/Download laufen über normale URLs (Cookie reicht).
import { t, type FinderCountsResult, type FinderListResult, type FinderRootsResponse, type FinderSearchResult, type FinderStatResult, type FinderTextResponse, type FinderWriteBody, type FinderWriteResult } from "@nyxos/shared";
import { ApiError } from "../../lib/api";
import { authFetch } from "../terminal/authClient";

/** Fehler mit dem Satz des Servers (schon verständlich formuliert) und dessen Code. */
export class FinderApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly code: string | null,
  ) {
    super(message, status);
  }
}

async function readError(res: Response): Promise<FinderApiError> {
  let body: { error?: string; code?: string } = {};
  try {
    body = (await res.json()) as { error?: string; code?: string };
  } catch {
    // kein JSON
  }
  const fallback = res.status === 401 ? t("Bitte anmelden, dann sind die Dateien da.") : t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen.");
  return new FinderApiError(body.error ?? fallback, res.status, body.code ?? null);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url, { method: "GET" });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

function qs(root: string, rel: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ root, p: rel, ...extra }).toString();
}

export const fetchRoots = () => getJson<FinderRootsResponse>("/api/finder/roots");
export const fetchList = (root: string, rel: string) => getJson<FinderListResult>(`/api/finder/list?${qs(root, rel)}`);
export const fetchCounts = (root: string, rel: string) => getJson<FinderCountsResult>(`/api/finder/counts?${qs(root, rel)}`);
export const fetchStat = (root: string, rel: string) => getJson<FinderStatResult>(`/api/finder/stat?${qs(root, rel)}`);
export const fetchText = (root: string, rel: string) => getJson<FinderTextResponse>(`/api/finder/text?${qs(root, rel)}`);
export const searchFiles = (root: string, rel: string, q: string) => getJson<FinderSearchResult>(`/api/finder/search?${qs(root, rel, { q })}`);

export async function writeText(body: FinderWriteBody): Promise<FinderWriteResult> {
  const res = await authFetch("/api/finder/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as FinderWriteResult;
}

export function rawUrl(root: string, rel: string, download = false): string {
  return `/api/finder/raw?${qs(root, rel, download ? { download: "1" } : {})}`;
}

export function thumbUrl(root: string, rel: string, size = 320): string {
  return `/api/finder/thumb?${qs(root, rel, { size: String(size) })}`;
}

/** Adresse im Reiter „Dateien“: Ordner `p`, gewählt `sel`, geöffnet `open`. */
export function finderHref(root: string, opts: { dir?: string; sel?: string; open?: string } = {}): string {
  const p = new URLSearchParams({ root });
  if (opts.dir !== undefined) p.set("p", opts.dir);
  if (opts.sel) p.set("sel", opts.sel);
  if (opts.open) p.set("open", opts.open);
  return `/files?${p.toString()}`;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}
