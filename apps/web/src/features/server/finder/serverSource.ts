// Datenquelle „Server“ für den Finder des Dateien-Tabs (features/finder/source.tsx). Liest über
// `/api/server/files/*` — NUR LESEN: kein Speichern, Umbenennen, Löschen, Verschieben, Hochladen.
// Gesperrtes (Geheimnis-Dateien, s. server/hostfs.ts `isSecretPath`) kommt als `secret`: kein Inhalt, kein Download.
import { HOSTFS_MAX_BYTES, finderExt, t, finderKindOf, type FinderEntry, type HostFsEntry, type HostFsListResult, type HostFsRoot, type HostFsSearchResult, type HostFsTextResponse } from "@nyxos/shared";
import type { FinderSource, SourceRoot } from "../../finder/source";
import { HostApiError, isLoginError } from "../hostApi";

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

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** Rasterbilder liefert der Server eingebettet (SVG nie — kann Skript enthalten). */
const RASTER = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]);

const ROOT_LOOK: Record<string, { icon: string; color: string }> = {
  home: { icon: "⌂", color: "acc" },
  srv: { icon: "▤", color: "lime" },
  opt: { icon: "▥", color: "violet" },
  log: { icon: "≡", color: "wait" },
  nyxos: { icon: "◆", color: "claude" },
};

/** Logs: das Neueste steht am Ende — bei großen Dateien das Ende laden. */
function isLogName(name: string, root: string): boolean {
  const n = name.toLowerCase();
  return /\.log(\.\d+)?$/.test(n) || /(^|[._-])(syslog|messages|journal)$/.test(n) || root === "log";
}

export function toFinderEntry(e: HostFsEntry): FinderEntry {
  return {
    name: e.name,
    rel: e.rel,
    kind: finderKindOf(e.name, e.isDir),
    isDir: e.isDir,
    size: e.size,
    mtimeMs: e.mtimeMs,
    children: null,
    hidden: e.name.startsWith("."),
    secret: e.locked,
    link: e.link,
  };
}

function toRoot(r: HostFsRoot): SourceRoot {
  return { id: r.id, label: r.label, icon: ROOT_LOOK[r.id]?.icon ?? "▢", abs: r.hostPath, exists: r.exists, writable: false };
}

const inlineImage = (e: FinderEntry) => !e.secret && !e.isDir && e.kind === "image" && RASTER.has(finderExt(e.name)) && e.size <= HOSTFS_MAX_BYTES;
const rawUrl = (root: string, rel: string, download = false) => `/api/server/files/raw?${qs({ root, p: rel, ...(download ? { download: "1" } : {}) })}`;

export function createServerSource(login: () => void): FinderSource {
  return {
    key: "server-finder",
    prefPrefix: "nyx.serverFinder",
    defaultView: "spalten",
    parseRoot: (raw, roots) => {
      const existing = (roots ?? []).filter((r) => r.exists);
      if (raw && (roots === undefined || existing.some((r) => r.id === raw))) return raw;
      return existing[0]?.id ?? raw ?? "home";
    },
    fallbackRoots: [],
    rootColor: (id) => `var(--a-${ROOT_LOOK[id]?.color ?? "acc"})`,
    fetchRoots: async () => {
      const body = await getJson<{ roots?: HostFsRoot[] }>("/api/server/files/roots");
      return { bridge: "online", roots: (body.roots ?? []).map(toRoot) };
    },
    fetchList: async (root, rel) => {
      const body = await getJson<HostFsListResult>(`/api/server/files/list?${qs({ root, p: rel })}`);
      return { rel: body.rel, entries: (body.entries ?? []).map(toFinderEntry), truncated: body.truncated === true, writable: false };
    },
    fetchCounts: null,
    fetchText: async (root, rel) => {
      const name = rel.split("/").pop() ?? rel;
      // `part` gilt nur für Dateien über 2 MB (sonst kommt die ganze Datei).
      const part = isLogName(name, root) ? "tail" : "head";
      const body = await getJson<HostFsTextResponse>(`/api/server/files/text?${qs({ root, p: rel, part })}`);
      return { rel: body.rel, name: body.name, content: body.content, size: body.size, mtimeMs: body.mtimeMs, sha256: "", writable: false };
    },
    search: async (root, rel, q) => {
      const body = await getJson<HostFsSearchResult>(`/api/server/files/search?${qs({ root, p: rel, q })}`);
      return { rel: body.rel, q: body.q, hits: (body.entries ?? []).map(toFinderEntry), truncated: body.truncated === true };
    },
    rawUrl,
    thumbUrl: (root, entry) => (inlineImage(entry) ? rawUrl(root, entry.rel) : null),
    canInline: inlineImage,
    // Große Textdateien liefert der Server gekürzt (Anfang bzw. Ende) — die Vorschau darf sie also laden.
    maxTextBytes: Number.POSITIVE_INFINITY,
    canDownload: (e) => !e.isDir && !e.secret && e.size <= HOSTFS_MAX_BYTES,
    write: null,
    secretText: t("Gesperrt, weil hier ein Geheimnis liegen kann (Zugangsdaten, Schlüssel, Datenbank oder Sicherung). NyxOS zeigt die Datei nie an."),
    sessions: false,
    markdownLinks: false,
    isLoginError,
    loginText: t("Die Dateien auf dem Server siehst du nach der Anmeldung."),
    login,
  };
}
