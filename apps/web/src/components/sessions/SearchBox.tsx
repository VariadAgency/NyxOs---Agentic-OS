import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { SearchHit } from "../../lib/api";
import { useSearch } from "../../hooks/useSessionApi";
import { BAUSTELLE_NONE } from "../../hooks/useSessionsRoute";
import { artLabel } from "../../lib/arts";
import { cn } from "../../lib/cn";
import { SEARCH_FIELD_LABEL } from "../../lib/searchField";
import { MicButton } from "../../features/voice/MicButton";

function hitHref(hit: SearchHit): string {
  const parts = [`/sessions`, hit.art, hit.baustelle?.slug ?? BAUSTELLE_NONE, hit.sessionId];
  const qs = hit.position !== null ? `?at=${hit.position}` : "";
  return parts.join("/") + qs;
}

/** Sucht über `/api/search`: Titel, erste Prompts, Dateipfade, Chat-Text — auch geschlossener Sessions. */
export function SearchBox() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // In schmaler Kopfleiste (Container < 860 px) steht die Suche nur als Symbol da und
  // klappt beim Klick auf; leer und ohne Fokus klappt sie wieder ein.
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Eingeklappt wird per Klick außerhalb (nicht per Blur: der Mikrofon-Knopf nimmt beim Drücken den
  // Fokus, die Aufnahme darf dabei nicht verschwinden).
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: PointerEvent) => {
      if (!query && wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [expanded, query]);
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const search = useSearch(query);
  const hits = search.data?.hits ?? [];

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQuery("");
    navigate(hitHref(hit));
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={t("Suchen")}
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className={cn(
          "h-(--a-ctl-h) w-(--a-ctl-h) items-center justify-center rounded-md border border-a-line bg-a-p2 text-a-mut hover:text-a-ink",
          expanded ? "hidden" : "flex @min-[860px]:hidden",
        )}
      >
        <span aria-hidden="true">⌕</span>
      </button>
      <div
        className={cn(
          "h-(--a-ctl-h) w-[240px] items-center gap-2 rounded-md border border-a-line bg-a-p2 pl-2.5 pr-1 text-a-mut focus-within:border-a-acc @min-[1300px]:w-[280px]",
          expanded ? "flex" : "hidden @min-[860px]:flex",
        )}
      >
        <label className="flex min-w-0 flex-1 items-center gap-2">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          role="combobox"
          data-nyx="suche"
          aria-expanded={open}
          aria-controls="session-search-results"
          value={query}
          placeholder={t("Suchen")}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          ref={inputRef}
          onFocus={() => query && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              const hit = hits[activeIndex];
              if (hit) go(hit);
            } else if (e.key === "Escape") {
              setOpen(false);
              if (!query) setExpanded(false);
            }
          }}
          className="w-full bg-transparent text-caption text-a-ink outline-none placeholder:text-a-mut"
        />
        </label>
        {/* Diktat statt tippen: Ergebnis landet direkt im Suchfeld (VoiceTarget "search"). Eigenes
            Element außerhalb des <label> — sonst würde sein Klick-Bereich den Fokus aufs Suchfeld
            ziehen und der Knopf den Feldnamen für Screenreader mit einfärben. */}
        <MicButton compact target="search" shortcutKey={null} onResult={(r) => { setQuery(r.text); setOpen(true); }} />
        <span className="shrink-0 rounded border border-a-line px-1.5 font-mono text-label text-a-mut">⌘K</span>
      </div>
      {open && query.trim() && (
        <div id="session-search-results" role="listbox" className="cc-scroll absolute right-0 top-full z-20 mt-1 max-h-80 w-[360px] overflow-y-auto rounded-md border border-a-line bg-a-p shadow-lg">
          {search.isLoading && <div className="p-3 text-caption text-a-mut">{t("Suche …")}</div>}
          {search.isError && <div className="p-3 text-caption text-a-mut">{t("Suche gerade nicht verfügbar.")}</div>}
          {!search.isLoading && !search.isError && hits.length === 0 && <div className="p-3 text-caption text-a-mut">{t("Keine Treffer.")}</div>}
          {hits.map((hit, index) => (
            <button
              key={`${hit.sessionKey}-${hit.field}-${hit.position ?? index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(hit)}
              className={`block w-full min-w-0 border-b border-a-line px-3 py-2 text-left last:border-0 ${index === activeIndex ? "bg-a-p2" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-2 text-caption text-a-ink">
                <span className="min-w-0 flex-1 truncate">{hit.title ?? hit.sessionId}</span>
                <span className="ml-auto shrink-0 font-mono text-label text-a-mut">{SEARCH_FIELD_LABEL[hit.field]}</span>
              </div>
              <div className="min-w-0 truncate text-label text-a-mut" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
              <div className="mt-0.5 min-w-0 truncate text-label text-a-mut">
                {artLabel(hit.art)}
                {hit.baustelle ? ` → ${hit.baustelle.label}` : ""}
                {hit.closed ? ` · ${t("geschlossen")}` : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
