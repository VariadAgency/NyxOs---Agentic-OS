// „Dateien“ — nur lesende Abfragen.
import { t, type FileAreaId, type FileModeFilter, type FileSessions, type FilesOverview } from "@nyxos/shared";
import { ApiError } from "../../lib/api";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

export function fetchFiles(filter: { q: string; mode: FileModeFilter; area: FileAreaId | null }): Promise<FilesOverview> {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.mode !== "alle") params.set("mode", filter.mode);
  if (filter.area) params.set("area", filter.area);
  const qs = params.toString();
  return getJson<FilesOverview>(`/api/files${qs ? `?${qs}` : ""}`);
}

export function fetchFileSessions(path: string): Promise<FileSessions> {
  return getJson<FileSessions>(`/api/files/sessions?path=${encodeURIComponent(path)}`);
}
