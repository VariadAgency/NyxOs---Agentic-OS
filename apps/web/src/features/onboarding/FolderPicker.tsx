// Folder picker of the onboarding: a calm sheet that starts in the home folder, a breadcrumb, the subfolders
// (Git repos marked, repos inside counted) and one clear action – "Diesen Ordner wählen". Lists via
// `GET /api/setup/browse` (bridge RPC `setup.browse`, directories only, read only). Full screen on phones.
import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useBrowseFolder, type SetupBrowseResult } from "./onboardingApi";
import { ErrorLine, StatusPill } from "./ui";

/** Breadcrumb parts of `path`: the home folder as "~", everything else from "/". */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const inHome = path === home || path.startsWith(home.endsWith("/") ? home : `${home}/`);
  const base = inHome ? { label: "~", path: home } : { label: "/", path: "/" };
  const rest = path.slice(base.path.length).split("/").filter(Boolean);
  const out = [base];
  let cur = base.path;
  for (const part of rest) {
    cur = cur === "/" ? `/${part}` : `${cur}/${part}`;
    out.push({ label: part, path: cur });
  }
  return out;
}

/** "/Users/alex/code" → "~/code" (display only). */
export function shortPath(path: string, home?: string | null): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function FolderGlyph({ repo }: { repo: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cn("h-4.5 w-4.5 shrink-0", repo ? "text-a-acc" : "text-a-mut")} fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2.75 5.75a1.5 1.5 0 0 1 1.5-1.5h3.3l1.7 1.9h6.5a1.5 1.5 0 0 1 1.5 1.5v6.6a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z" strokeLinejoin="round" />
    </svg>
  );
}

function Listing({ data, onOpen }: { data: SetupBrowseResult; onOpen: (path: string) => void }) {
  if (data.entries.length === 0) return <p className="px-1 py-6 text-center text-callout text-a-mut">{t("Hier sind keine weiteren Ordner.")}</p>;
  return (
    <ul className="grid gap-0.5">
      {data.entries.map((e) => (
        <li key={e.path}>
          <button
            type="button"
            onClick={() => onOpen(e.path)}
            className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-a-p3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-a-acc"
          >
            <FolderGlyph repo={e.isRepo} />
            <span className="min-w-0 flex-1 truncate text-callout text-a-ink">{e.name}</span>
            {e.isRepo && <StatusPill tone="mut">{t("Git-Projekt")}</StatusPill>}
            {!e.isRepo && (e.repoCount ?? 0) > 0 && <StatusPill tone="ok">{e.repoCount === 1 ? t("1 Projekt") : t("{n} Projekte", { n: e.repoCount ?? 0 })}</StatusPill>}
            <span aria-hidden className="text-a-mut">
              ›
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FolderPicker({ open, onClose, onPick, busy = false }: { open: boolean; onClose: () => void; onPick: (path: string) => void; busy?: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  const browse = useBrowseFolder(path, open);
  const data = browse.data;
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // Start in the home folder every time the picker opens; give focus back to the button that opened it.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setPath(null);
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open]);

  if (!open) return null;
  const current = data?.path ?? null;
  const canPick = current !== null && current !== "/" && !busy;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim sm:p-4" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-picker-title"
        onClick={(e) => e.stopPropagation()}
        className="grid h-full w-full grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 bg-a-p2 p-4 shadow-pop focus:outline-none sm:h-auto sm:max-h-[min(640px,85vh)] sm:max-w-lg sm:rounded-2xl sm:border sm:border-a-line"
      >
        <div className="flex items-center gap-2">
          <h2 id="folder-picker-title" className="text-headline font-semibold text-a-ink">
            {t("Ordner auswählen")}
          </h2>
          <Button variant="ghost" className="ml-auto" onClick={onClose} aria-label={t("Schließen")}>
            ✕
          </Button>
        </div>

        <nav aria-label={t("Pfad")} className="flex min-w-0 flex-wrap items-center gap-1">
          {data &&
            crumbs(data.path, data.home).map((c, i, all) => (
              <span key={c.path} className="flex min-w-0 items-center gap-1">
                {i > 0 && (
                  <span aria-hidden className="text-a-mut">
                    /
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setPath(c.path)}
                  aria-current={i === all.length - 1 ? "location" : undefined}
                  className={cn("max-w-[14rem] truncate rounded-md px-1.5 py-0.5 font-mono text-caption transition-colors duration-150 hover:bg-a-p3", i === all.length - 1 ? "text-a-ink" : "text-a-mut")}
                >
                  {c.label}
                </button>
              </span>
            ))}
          {data?.parent && (
            <Button variant="ghost" className="ml-auto" onClick={() => setPath(data.parent)}>
              {t("Eine Ebene höher")}
            </Button>
          )}
        </nav>

        <div className="cc-scroll -mx-1 min-h-40 overflow-y-auto px-1" aria-live="polite" aria-busy={browse.isFetching}>
          {browse.isLoading && (
            <div className="grid gap-1.5" aria-label={t("Lädt …")}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-a-p3/60" />
              ))}
            </div>
          )}
          {browse.error && (
            <div className="grid justify-items-start gap-2 py-4">
              <ErrorLine text={friendlyError(browse.error)} />
              <div className="flex gap-2">
                <Button onClick={() => void browse.refetch()}>{t("Erneut versuchen")}</Button>
                {path !== null && <Button variant="ghost" onClick={() => setPath(null)}>{t("Zum Home-Ordner")}</Button>}
              </div>
            </div>
          )}
          {data && !browse.error && <Listing data={data} onOpen={setPath} />}
          {data?.truncated && <p className="px-1 pt-2 text-caption text-a-mut">{t("Nicht alle Ordner werden gezeigt.")}</p>}
        </div>

        <div className="grid gap-2 border-t border-a-line pt-3 sm:flex sm:items-center">
          <p className="min-w-0 flex-1 truncate font-mono text-caption text-a-mut" title={current ?? undefined}>
            {current ? shortPath(current, data?.home) : "\u00a0"}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("Abbrechen")}
            </Button>
            <Button variant="primary" className="flex-1 sm:flex-none" disabled={!canPick} onClick={() => current && onPick(current)}>
              {t("Diesen Ordner wählen")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
