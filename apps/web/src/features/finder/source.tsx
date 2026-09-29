// Datenquelle des Finders als Schnittstelle. Derselbe Finder (Ansichten, Vorschau, Übersicht, Tastatur)
// läuft mit zwei Quellen:
// - Brücke (Dateien-Tab): Dateien auf dem Rechner der Brücke, `/api/finder/*` — Markdown/Text speicherbar.
// - Server (Server-Seite, „Dateien“): `/api/server/files/*` — NUR LESEN (s. features/server/finder/serverSource.ts).
// Die Komponenten fragen die Quelle über `useFinderSource()`; ohne Provider gilt die Brücken-Quelle.
import {
  FINDER_ROOTS,
  FinderRootIdSchema,
  t,
  type FinderCountsResult,
  type FinderEntry,
  type FinderKind,
  type FinderRootsResponse,
  type FinderSearchResult,
  type FinderTextResponse,
  type FinderWriteBody,
  type FinderWriteResult,
} from "@nyxos/shared";
import { createContext, useContext, type ReactNode } from "react";
import { fetchCounts, fetchList, fetchRoots, fetchText, rawUrl, searchFiles, thumbUrl, writeText } from "./api";
import type { FinderViewMode } from "./prefs";
import { LoginRequiredError, openLoginDialog } from "../terminal/authClient";

/** Ein Ort der Seitenleiste (Favorit der Brücke oder Server-Wurzel). */
export interface SourceRoot {
  id: string;
  label: string;
  icon: string;
  /** Absoluter Pfad (Rechner der Brücke bzw. Host) — Anzeige und Zuordnung. */
  abs: string;
  exists: boolean;
  writable: boolean;
}

export interface SourceRoots {
  bridge: FinderRootsResponse["bridge"];
  roots: SourceRoot[];
}

export interface SourceList {
  rel: string;
  entries: FinderEntry[];
  truncated: boolean;
  writable: boolean;
  childrenPending?: boolean;
}

export type SourceText = Omit<FinderTextResponse, "root">;
export type SourceSearch = Omit<FinderSearchResult, "root">;
export type SourceCounts = Omit<FinderCountsResult, "root">;
export type SourceWrite = Omit<FinderWriteBody, "root"> & { root: string };

export interface FinderSource {
  /** Anfang der Abfrage-Schlüssel (TanStack Query) — getrennte Zwischenspeicher je Quelle. */
  key: string;
  /** Anfang der gemerkten Einstellungen (localStorage). */
  prefPrefix: string;
  defaultView: FinderViewMode;
  /** Wurzel aus der Adresse (bzw. der erste vorhandene Ort). */
  parseRoot: (raw: string | null, roots: SourceRoot[] | undefined) => string;
  /** Orte, solange die echte Liste noch lädt. */
  fallbackRoots: SourceRoot[];
  rootColor: (id: string) => string;
  fetchRoots: () => Promise<SourceRoots>;
  fetchList: (root: string, rel: string) => Promise<SourceList>;
  fetchCounts: ((root: string, rel: string) => Promise<SourceCounts>) | null;
  fetchText: (root: string, rel: string) => Promise<SourceText>;
  search: (root: string, rel: string, q: string) => Promise<SourceSearch>;
  rawUrl: (root: string, rel: string, download?: boolean) => string;
  /** Vorschaubild (oder `null` → Symbol). */
  thumbUrl: (root: string, entry: FinderEntry, size: number) => string | null;
  /** Darf die Vorschau die Datei eingebettet zeigen (Bild/PDF/Video/Audio)? */
  canInline: (entry: FinderEntry) => boolean;
  /** Bis zu welcher Größe die Textvorschau lädt. */
  maxTextBytes: number;
  canDownload: (entry: FinderEntry) => boolean;
  /** Speichern (nur Brücke); `null` = nur lesen. */
  write: ((body: SourceWrite) => Promise<FinderWriteResult>) | null;
  /** Satz bei gesperrten Dateien. */
  secretText: string;
  /** Sessions an einer Datei und „Intelligent → Von Sessions“ (nur Brücke). */
  sessions: boolean;
  /** Links in Markdown-Dokumenten auf andere Dateien (nur Brücke, Adresse `/files`). */
  markdownLinks: boolean;
  /** Anmeldung nötig? */
  isLoginError: (e: unknown) => boolean;
  loginText: string;
  /** Anmelde-Dialog öffnen (danach lädt der Finder neu). */
  login: () => void;
}

const ROOT_COLORS: Record<string, string> = { downloads: "done", screenshots: "violet", obsidian: "conf", nyxos: "claude", app: "lime" };

const INLINE_KINDS = new Set<FinderKind>(["image", "pdf", "video", "audio"]);

/** Erster Favorit = Standard-Ort, wenn die Adresse keinen gültigen nennt. */
const DEFAULT_ROOT = FINDER_ROOTS[0].id;

export const bridgeSource: FinderSource = {
  key: "finder",
  prefPrefix: "nyx.finder",
  defaultView: "spalten",
  parseRoot: (raw) => {
    const parsed = FinderRootIdSchema.safeParse(raw ?? DEFAULT_ROOT);
    return parsed.success ? parsed.data : DEFAULT_ROOT;
  },
  fallbackRoots: FINDER_ROOTS.map((r) => ({ id: r.id, label: t(r.label), icon: r.icon, abs: "", exists: true, writable: r.writable })),
  rootColor: (id) => `var(--a-${ROOT_COLORS[id] ?? "acc"})`,
  fetchRoots,
  fetchList,
  fetchCounts,
  fetchText,
  search: searchFiles,
  rawUrl,
  thumbUrl: (root, entry, size) => ((entry.kind === "image" || entry.kind === "pdf") && !entry.secret ? thumbUrl(root, entry.rel, size > 160 ? 640 : 320) : null),
  canInline: (entry) => INLINE_KINDS.has(entry.kind),
  maxTextBytes: 2 * 1024 * 1024,
  canDownload: (entry) => !entry.isDir && !entry.secret,
  write: (body) => writeText({ ...body, root: FinderRootIdSchema.parse(body.root) }),
  secretText: t("Diese Datei enthält vermutlich Zugangsdaten. Sie wird hier nicht angezeigt."),
  sessions: true,
  markdownLinks: true,
  isLoginError: (e) => e instanceof LoginRequiredError,
  loginText: t("Deine Dateien sind persönlich — bitte kurz anmelden."),
  login: () => void openLoginDialog({ forAction: true }),
};

const FinderSourceContext = createContext<FinderSource>(bridgeSource);

export function FinderSourceProvider({ source, children }: { source: FinderSource; children: ReactNode }) {
  return <FinderSourceContext.Provider value={source}>{children}</FinderSourceContext.Provider>;
}

export function useFinderSource(): FinderSource {
  return useContext(FinderSourceContext);
}

