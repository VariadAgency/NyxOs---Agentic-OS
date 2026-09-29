// Search field of the settings. Filters live over areas and single settings (`searchIndex.ts`) of the current run
// mode; ↑↓ selects, Enter jumps to the subpage at the spot, Esc clears, „/“ focuses it from anywhere on the page.
import { t } from "@nyxos/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAppMode } from "../../hooks/useAppInfo";
import { cn } from "../../lib/cn";
import { isModalOpen, isTypingTarget } from "../../lib/keyboard";
import { toneVar } from "../../lib/tones";
import { ALL_SECTIONS, sectionsForMode } from "./sections";
import { searchSettings, type SettingsHit } from "./searchIndex";

export function SettingsSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const mode = useAppMode();
  const sections = useMemo(() => sectionsForMode(ALL_SECTIONS, mode), [mode]);
  const hits = useMemo(() => searchSettings(value, sections), [value, sections]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [value]);

  // „/“ = search (as on many pages) – not while typing and not above a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (hit: SettingsHit | undefined) => {
    if (!hit) return;
    void navigate(hit.path, { state: { fromOverview: true } });
  };

  const searching = value.trim().length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="grid min-w-0 gap-2">
      <div className="relative min-w-0">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-a-mut">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && hits.length > 0) {
              e.preventDefault();
              setActive((a) => (a + 1) % hits.length);
            } else if (e.key === "ArrowUp" && hits.length > 0) {
              e.preventDefault();
              setActive((a) => (a - 1 + hits.length) % hits.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(hits[active]);
            } else if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
          aria-label={t("Einstellungen durchsuchen")}
          aria-controls={searching ? listId : undefined}
          aria-activedescendant={searching && hits.length > 0 ? optionId(active) : undefined}
          placeholder={t("Suchen – z. B. Ruhezeit")}
          data-nyx="settings-search"
          autoComplete="off"
          className="min-h-11 w-full min-w-0 rounded-xl border border-a-line bg-a-p py-2.5 pl-10 pr-12 font-body text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {!searching && (
          <kbd aria-hidden className="pointer-events-none absolute right-3 top-3 hidden rounded border border-a-line px-1.5 font-mono text-label text-a-mut md:block">
            /
          </kbd>
        )}
        {searching && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label={t("Suche leeren")}
            className="absolute inset-y-0 right-1 my-auto grid h-11 w-11 place-items-center rounded-lg text-a-mut hover:text-a-ink"
          >
            ×
          </button>
        )}
      </div>

      {searching && hits.length === 0 && <p className="px-1 py-3 text-callout text-a-mut">{t("Nichts gefunden. Versuch ein anderes Wort.")}</p>}
      {searching && hits.length > 0 && (
        <ul id={listId} role="listbox" aria-label={t("Treffer")} className="grid min-w-0 overflow-hidden rounded-xl border border-a-line bg-a-p">
          {hits.map((hit, i) => (
            <li
              key={hit.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              data-nyx={`settings-hit:${hit.path}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(hit)}
              className={cn(
                "flex min-h-12 min-w-0 cursor-pointer items-center gap-3 border-b border-a-line px-4 py-2.5 last:border-b-0",
                i === active ? "bg-a-p2" : "hover:bg-a-p2",
              )}
            >
              <span aria-hidden className="w-5 shrink-0 text-center text-headline" style={{ color: toneVar(hit.tone) }}>
                {hit.icon}
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-callout text-a-ink">{hit.label}</span>
                {hit.context && <span className="truncate text-caption text-a-mut">{hit.context}</span>}
              </span>
              <span aria-hidden className="text-a-mut">
                ›
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
