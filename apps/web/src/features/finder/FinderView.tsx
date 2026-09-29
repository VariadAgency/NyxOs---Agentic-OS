// Reiter „Dateien“ wie der macOS-Finder: verschiedene Darstellungen (Symbole, Liste, Spalten, Galerie),
// sauber sortiert, mit einer Spaltenansicht wie im echten Finder.
//
// Aufbau: links Favoriten (auf schmalen Bildschirmen oben als Leiste), oben Werkzeugleiste (Zurück/Vor,
// Ordner hoch, Darstellung, Sortieren, Suche), darunter die Pfadleiste, dann die Ansicht. Zustand steckt in der
// Adresse (`root`, `p` = Ordner, `sel` = Auswahl, `open` = geöffnete Datei, `q` = Suche) — Browser-Zurück
// funktioniert, Links auf eine Datei lassen sich teilen. Ansicht/Sortierung/Spaltenbreiten werden gemerkt.
import { t, type FinderEntry } from "@nyxos/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router";
import { matchesQuery, PHONE_QUERY, useTouch } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/cn";
import { FilesView } from "../files/FilesView";
import { parentOf } from "./api";
import { useUrlNav, type FinderNav } from "./nav";
import { useFinderSource } from "./source";
import { ColumnsView } from "./ColumnsView";
import { FileViewer } from "./FileViewer";
import { ListError } from "./ListError";
import { errorText, useEntries, useRoots, useSearch } from "./hooks";
import { isSortSpec, isViewMode, isWidths, usePref, VIEW_MODES, type FinderViewMode } from "./prefs";
import { QuickLook } from "./Preview";
import { SORT_LABEL, sortEntries, type SortBy, type SortSpec } from "./sort";
import { GalleryView, IconsView, ListView } from "./views";

const SEARCH_DELAY_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function ctl(active = false) {
  return cn("inline-flex h-(--a-ctl-h) items-center justify-center rounded-lg border px-2.5 text-caption transition-colors disabled:opacity-40", active ? "border-a-acc/50 bg-a-acc/12 text-a-acc" : "border-a-line text-a-ink hover:bg-a-p3");
}

/** Dateien-Tab: Dateien über die Brücke, Zustand in der Adresse. */
export function FinderView() {
  const nav = useUrlNav();
  return <FinderBrowser nav={nav} />;
}

/**
 * Der Finder selbst — Datenquelle über `useFinderSource()` (Brücke oder Server), Zustand über `nav`
 * (Adresse oder eigener Verlauf). Dateien-Tab und Server-Seite nutzen genau diese Ansicht.
 */
export function FinderBrowser({ nav }: { nav: FinderNav }) {
  const src = useFinderSource();
  const params = nav.params;
  const smart = src.sessions ? params.get("smart") : null;
  const roots = useRoots();
  const root = src.parseRoot(params.get("root"), roots.data?.roots);
  const dir = params.get("p") ?? "";
  const sel = params.get("sel");
  const open = params.get("open");
  const qParam = params.get("q") ?? "";

  // Auf dem Handy passt die Spalten-Ansicht nicht – dort startet die Liste (eigene Wahl bleibt gespeichert).
  const [view, setView] = usePref<FinderViewMode>(`${src.prefPrefix}.view`, matchesQuery(PHONE_QUERY) ? "liste" : src.defaultView, isViewMode);
  const touch = useTouch();
  const [sort, setSort] = usePref<SortSpec>(`${src.prefPrefix}.sort`, { by: "name", dir: "asc" }, isSortSpec);
  const [showHidden, setShowHidden] = usePref<boolean>(`${src.prefPrefix}.hidden`, false, (v) => typeof v === "boolean");
  const [widths, setWidths] = usePref<number[]>(`${src.prefPrefix}.columnWidths`, [], isWidths);
  const [quick, setQuick] = useState(false);
  const [qInput, setQInput] = useState(qParam);
  const q = useDebounced(qInput.trim(), SEARCH_DELAY_MS);

  const rootInfo = roots.data?.roots.find((r) => r.id === root);
  const rootLabel = t(rootInfo?.label ?? src.fallbackRoots.find((r) => r.id === root)?.label ?? "Dateien");
  const listing = useEntries(root, smart ? null : dir, sort, showHidden);
  const search = useSearch(root, dir, smart ? "" : q);
  const searching = q.length > 0 && !smart;
  const searchEntries = useMemo(() => (search.data ? sortEntries(showHidden ? search.data.hits : search.data.hits.filter((e) => !e.hidden), sort) : []), [search.data, sort, showHidden]);
  // Die geöffnete bzw. gewählte Datei kann tiefer liegen als `p` (Spalten, Suche) → deren Ordner laden.
  const focusRel = open ?? sel;
  const focusDir = focusRel !== null ? parentOf(focusRel) : null;
  const focusListing = useEntries(root, focusDir !== null && focusDir !== dir ? focusDir : null, sort, showHidden);
  const focusEntries = focusDir === dir ? listing.entries : focusListing.entries;
  const selEntry = sel ? (focusEntries.find((e) => e.rel === sel) ?? searchEntries.find((e) => e.rel === sel) ?? null) : null;
  const openEntry = open ? (focusEntries.find((e) => e.rel === open) ?? searchEntries.find((e) => e.rel === open) ?? null) : null;

  // Suche in der Adresse mitführen (ersetzt, kein neuer Verlaufseintrag je Tastendruck).
  useEffect(() => {
    if ((params.get("q") ?? "") === q) return;
    const next = new URLSearchParams(params);
    if (q) next.set("q", q);
    else next.delete("q");
    nav.set(next, { replace: true });
    // Absicht: nur auf die entprellte Eingabe reagieren
  }, [q]);

  const update = useCallback(
    (patch: Record<string, string | null>, opts: { replace?: boolean; state?: unknown } = {}) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      nav.set(next, { replace: opts.replace, state: opts.state });
    },
    [params, nav],
  );

  const goDir = useCallback((rel: string, selectRel: string | null = null) => update({ p: rel, sel: selectRel, open: null, q: null, smart: null }), [update]);
  const select = useCallback((rel: string) => update({ sel: rel }, { replace: true }), [update]);
  const openFile = useCallback(
    (e: FinderEntry) => {
      if (e.isDir) {
        setQInput("");
        goDir(e.rel);
        return;
      }
      update({ sel: e.rel, open: e.rel }, { state: { finderOpened: true } });
    },
    [goDir, update],
  );
  const closeViewer = useCallback(() => {
    if ((nav.state as { finderOpened?: boolean } | null)?.finderOpened) nav.back();
    else update({ open: null }, { replace: true });
  }, [nav, update]);
  /** Eintrag aus einer Ordner-Vorschau: dessen Ordner öffnen und ihn markieren. */
  const reveal = useCallback(
    (child: FinderEntry) => {
      setQuick(false);
      setQInput("");
      goDir(parentOf(child.rel), child.rel);
    },
    [goDir],
  );

  // Liste der aktuell sichtbaren Einträge (für Tastatur/Übersicht außerhalb der Spalten).
  const visible = searching ? searchEntries : listing.entries;
  const quickEntries = view === "spalten" && !searching ? focusEntries : visible;
  const quickEntry = sel ? (quickEntries.find((e) => e.rel === sel) ?? selEntry) : null;
  const moveInList = useCallback(
    (list: FinderEntry[], delta: number) => {
      if (list.length === 0) return;
      const idx = sel ? list.findIndex((e) => e.rel === sel) : -1;
      const next = idx === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, idx + delta));
      const target = list[next];
      if (target) select(target.rel);
    },
    [sel, select],
  );

  const gridRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (view === "spalten" && !searching) return; // eigene Steuerung in ColumnsView
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const perRow = view === "symbole" ? Math.max(1, Math.floor((gridRef.current?.clientWidth ?? 600) / 120)) : 1;
    const current = visible.find((x) => x.rel === sel) ?? null;
    if (e.key === "ArrowDown") moveInList(visible, view === "galerie" ? 1 : perRow);
    else if (e.key === "ArrowUp") moveInList(visible, view === "galerie" ? -1 : -perRow);
    else if (e.key === "ArrowRight" && view !== "liste") moveInList(visible, 1);
    else if (e.key === "ArrowLeft" && view !== "liste") moveInList(visible, -1);
    else if (e.key === "Enter" && current) openFile(current);
    else if (e.key === " " && current) setQuick(true);
    else if ((e.key === "Backspace" || (e.metaKey && e.key === "ArrowUp")) && dir) goDir(parentOf(dir), dir);
    else return;
    e.preventDefault();
  };

  const bridge = roots.data?.bridge ?? null;
  const listError = listing.error;
  const needsLogin = src.isLoginError(listError) || src.isLoginError(roots.error);

  // Pfadleiste: gewählte Datei (Spalten) bzw. aktueller Ordner.
  const crumbTarget = view === "spalten" && sel && !searching ? sel : dir;
  const crumbs = crumbTarget ? crumbTarget.split("/") : [];

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Favoriten */}
      <nav aria-label={t("Favoriten")} className="shrink-0 border-a-line bg-a-p/60 md:w-[196px] md:border-r">
        <div className="hidden px-4 pt-4 pb-1 font-mono text-label tracking-wide text-a-mut uppercase md:block">{t("Favoriten")}</div>
        <ul className="cc-scroll flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
          {(roots.data?.roots ?? src.fallbackRoots).map((r) => {
            const on = !smart && r.id === root;
            const label = t(r.label);
            const cls = cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-callout", on ? "bg-a-p3 font-medium text-a-ink" : "text-a-ink/85 hover:bg-a-p2", !r.exists && "opacity-50");
            const inner = (
              <>
                <span aria-hidden="true" className="w-4 text-center text-callout" style={{ color: src.rootColor(r.id) }}>
                  {r.icon}
                </span>
                {label}
              </>
            );
            return (
              <li key={r.id} className="shrink-0">
                {nav.rootHref ? (
                  <Link to={nav.rootHref(r.id)} onClick={() => setQInput("")} aria-current={on ? "page" : undefined} className={cls} title={r.abs || label}>
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={!r.exists}
                    onClick={() => {
                      setQInput("");
                      update({ root: r.id, p: "", sel: null, open: null, q: null });
                    }}
                    aria-current={on ? "page" : undefined}
                    className={cls}
                    title={r.abs || label}
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {src.sessions && (
        <>
        <div className="hidden px-4 pt-3 pb-1 font-mono text-label tracking-wide text-a-mut uppercase md:block">{t("Intelligent")}</div>
        <ul className="hidden p-2 pt-0 md:block">
          <li>
            <Link to="/files?smart=sessions" aria-current={smart ? "page" : undefined} className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-callout", smart ? "bg-a-p3 font-medium text-a-ink" : "text-a-ink/85 hover:bg-a-p2")}>
              <span aria-hidden="true" className="w-4 text-center" style={{ color: "var(--a-wait)" }}>
                ◷
              </span>
              {t("Von Sessions")}
            </Link>
          </li>
        </ul>
        </>
        )}
      </nav>

      {smart ? (
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto">
          <FilesView embedded />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Werkzeugleiste */}
          <div className="flex flex-wrap items-center gap-2 border-b border-a-line bg-a-p/40 px-3 py-2">
            <div className="flex gap-1">
              <button type="button" className={ctl()} disabled={nav.canBack === false} onClick={nav.back} aria-label={t("Zurück")}>
                ‹
              </button>
              <button type="button" className={ctl()} disabled={nav.canForward === false} onClick={nav.forward} aria-label={t("Vor")}>
                ›
              </button>
              <button type="button" className={ctl()} disabled={!dir} onClick={() => goDir(parentOf(dir), dir)} aria-label={t("Übergeordneter Ordner")}>
                ↑
              </button>
            </div>
            <h1 className="min-w-0 flex-1 truncate font-display text-headline font-semibold text-a-ink">{dir ? dir.split("/").pop() : rootLabel}</h1>
            <div role="group" aria-label={t("Darstellung")} className="inline-flex rounded-lg border border-a-line p-0.5">
              {VIEW_MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={view === m.id} aria-label={m.label} title={m.label} onClick={() => setView(m.id)} className={cn("cc-hit inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-caption", view === m.id ? "bg-a-acc/15 font-medium text-a-acc" : "text-a-mut hover:text-a-ink")}>
                  <span aria-hidden="true">{m.glyph}</span>
                  <span aria-hidden="true" className="hidden lg:inline">
                    {m.label}
                  </span>
                </button>
              ))}
            </div>
            <label className="inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-lg border border-a-line px-2 text-caption text-a-mut">
              <span className="hidden sm:inline">{t("Sortieren")}</span>
              <select aria-label={t("Sortieren nach")} value={sort.by} onChange={(e) => setSort({ by: e.target.value as SortBy, dir: sort.dir })} className="bg-transparent text-a-ink outline-none">
                {(Object.keys(SORT_LABEL) as SortBy[]).map((k) => (
                  <option key={k} value={k} className="bg-a-p">
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
              <button type="button" aria-label={sort.dir === "asc" ? t("Aufsteigend – umdrehen") : t("Absteigend – umdrehen")} onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })} className="text-a-ink">
                {sort.dir === "asc" ? "▲" : "▼"}
              </button>
            </label>
            <label className="inline-flex h-(--a-ctl-h) cursor-pointer items-center gap-1.5 rounded-lg border border-a-line px-2 text-caption text-a-mut">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[var(--a-acc)]" />
              {t("Versteckte")}
            </label>
            <label className="flex h-(--a-ctl-h) min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-a-line bg-a-p px-2.5 focus-within:border-a-acc/60 sm:max-w-[280px]">
              <span aria-hidden="true" className="text-a-mut">
                ⌕
              </span>
              <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t("In „{place}“ suchen …", { place: dir ? dir.split("/").pop() : rootLabel })} aria-label={t("Dateien suchen")} className="w-full bg-transparent text-caption text-a-ink outline-none placeholder:text-a-mut" />
            </label>
          </div>

          {/* Pfadleiste */}
          <nav aria-label={t("Pfad")} className="cc-scroll flex items-center gap-1 overflow-x-auto border-b border-a-line px-3 py-1.5 text-caption whitespace-nowrap">
            <button type="button" onClick={() => goDir("")} className="rounded px-1.5 py-0.5 text-a-ink hover:bg-a-p3">
              {rootLabel}
            </button>
            {crumbs.map((seg, i) => {
              const rel = crumbs.slice(0, i + 1).join("/");
              const lastCrumb = i === crumbs.length - 1;
              return (
                <span key={rel} className="flex items-center gap-1">
                  <span aria-hidden="true" className="text-a-mut">
                    ›
                  </span>
                  <button
                    type="button"
                    onClick={() => (lastCrumb && sel === rel && selEntry && !selEntry.isDir ? openFile(selEntry) : goDir(rel))}
                    className={cn("rounded px-1.5 py-0.5 hover:bg-a-p3", lastCrumb ? "font-medium text-a-ink" : "text-a-mut")}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </nav>

          {bridge === "offline" && (
            <div role="status" className="flex flex-wrap items-center gap-2 border-b border-a-wait/40 bg-a-wait/10 px-4 py-2 text-caption text-a-ink">
              <span className="flex-1">{t("Die Brücke ist gerade nicht verbunden. Sobald sie wieder läuft, sind die Dateien wieder da.")}</span>
              <button type="button" className={ctl()} onClick={() => void roots.refetch()}>
                {t("Noch einmal prüfen")}
              </button>
            </div>
          )}
          {bridge === "outdated" && (
            <div role="status" className="border-b border-a-wait/40 bg-a-wait/10 px-4 py-2 text-caption text-a-ink">
              {t("Die Brücke ist noch auf altem Stand und kennt die Dateien-Ansicht nicht. Nach dem nächsten Update der Brücke geht es.")}
            </div>
          )}
          {needsLogin && (
            <div role="status" className="flex flex-wrap items-center gap-2 border-b border-a-acc/40 bg-a-acc/10 px-4 py-2 text-caption text-a-ink">
              <span className="flex-1">{src.loginText}</span>
              <button type="button" className={ctl(true)} onClick={src.login}>
                {t("Anmelden")}
              </button>
            </div>
          )}

          <div ref={gridRef} tabIndex={-1} onKeyDown={onKeyDown} className="cc-scroll min-h-0 flex-1 overflow-y-auto outline-none">
            {searching ? (
              <div>
                <div className="px-4 pt-3 pb-1 text-caption text-a-mut">
                  {search.isLoading
                    ? t("Sucht …")
                    : `${searchEntries.length === 1 ? t("1 Treffer für „{q}“ in {place}", { q, place: dir ? dir.split("/").pop() : rootLabel }) : t("{n} Treffer für „{q}“ in {place}", { n: searchEntries.length, q, place: dir ? dir.split("/").pop() : rootLabel })}${search.data?.truncated ? ` ${t("(Suche wurde begrenzt – genauer suchen)")}` : ""}`}
                </div>
                {search.isError && <p className="px-4 py-2 text-caption text-a-mut">{errorText(search.error)}</p>}
                <ListView root={root} entries={searchEntries} selected={sel} onSelect={(e) => select(e.rel)} onOpen={openFile} sort={sort} onSort={setSort} showPath />
              </div>
            ) : view === "spalten" ? (
              <ColumnsView root={root} rootLabel={rootLabel} baseDir={dir} selected={sel} sort={sort} showHidden={showHidden} widths={widths} onWidths={setWidths} onSelect={select} onOpen={openFile} onQuickLook={() => setQuick(true)} />
            ) : listing.isLoading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3, 4].map((k) => (
                  <div key={k} className="h-6 animate-pulse rounded bg-a-p2" />
                ))}
              </div>
            ) : listError && !needsLogin ? (
              <ListError error={listError} label={rootLabel} onRetry={() => void listing.refetch()} />
            ) : listing.entries.length === 0 && !needsLogin ? (
              <div className="p-10 text-center text-callout text-a-mut">{t("Dieser Ordner ist leer.")}</div>
            ) : view === "symbole" ? (
              <IconsView root={root} entries={listing.entries} selected={sel} onSelect={(e) => select(e.rel)} onOpen={openFile} />
            ) : view === "liste" ? (
              <ListView root={root} entries={listing.entries} selected={sel} onSelect={(e) => select(e.rel)} onOpen={openFile} sort={sort} onSort={setSort} />
            ) : (
              <GalleryView root={root} entries={listing.entries} selected={sel} onSelect={(e) => select(e.rel)} onOpen={openFile} />
            )}
          </div>
          <div className="border-t border-a-line px-3 py-1 text-label text-a-mut">
            {listing.data ? `${listing.entries.length === 1 ? t("1 Objekt") : t("{n} Objekte", { n: listing.entries.length })}${listing.data.truncated ? ` ${t("(gekürzt)")}` : ""}` : ""}
            {listing.data && !listing.data.writable ? ` · ${t("nur lesen")}` : ""}
            {!touch && ` · ${t("Leertaste = Übersicht · Enter = Öffnen")}`}
          </div>
        </div>
      )}

      {quick && quickEntry && (
        <QuickLook
          root={root}
          entry={quickEntry}
          onClose={() => setQuick(false)}
          onMove={(d) => moveInList(quickEntries, d)}
          onOpen={() => {
            setQuick(false);
            openFile(quickEntry);
          }}
          onReveal={reveal}
        />
      )}

      {open && (
        <FileViewer
          root={root}
          rel={open}
          entry={openEntry}
          siblings={focusEntries}
          onClose={closeViewer}
          onNavigate={(rel) => update({ open: rel, sel: rel }, { replace: true, state: nav.state })}
          onReveal={() => update({ open: null, sel: open, p: view === "spalten" ? dir : parentOf(open) }, { replace: true })}
        />
      )}
    </div>
  );
}
