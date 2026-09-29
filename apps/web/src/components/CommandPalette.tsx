import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { SEARCH_ALL_MAX_QUERY_LENGTH, SEARCH_MIN_QUERY_LENGTH, t, type SearchAllKind } from "@nyxos/shared";
import { askNyx } from "../features/haiku/askNyx";
import { NyxAura } from "./brand/NyxAura";
import { openLoginDialog } from "../features/terminal/authClient";
import { openNewSession } from "../features/terminal/terminalApi";
import { useSessions } from "../hooks/useSessions";
import { BAUSTELLE_NONE } from "../hooks/useSessionsRoute";
import { ApiError, searchEverything, type Session } from "../lib/api";
import { useAppInfo } from "../hooks/useAppInfo";
import { NAV_ITEMS, navLabel } from "../nav";
import { settingsPaletteItems } from "../features/settings/sections";
import { MicButton } from "../features/voice/MicButton";
import { CommandDialog, CommandEmptyBox, CommandGroupBox, CommandInputField, CommandItemRow, CommandListBox } from "./ui/command";
import { sessionLabel } from "../lib/sessionLabel";
import { openSupport, type SupportTab } from "../features/support/openSupport";

/** `/sessions/<art>/<baustelle-slug|_>/<sessionId>` — URL-Schlüssel ist die nackte Session-ID. */
function sessionPath(session: Session): string {
  return `/sessions/${session.art}/${session.baustelle?.slug ?? BAUSTELLE_NONE}/${session.id}`;
}

/**
 * Browser-Vollbild ein/aus. Vollbild
 * gibt es über ⌘K („Vollbild“) und die Taste F (`App.tsx`). Ohne Fullscreen-API (iPhone-Safari, Tests) passiert nichts.
 */
export function toggleFullscreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.();
  } catch {
    // Fullscreen-API nicht verfügbar oder verweigert – kein Absturz.
  }
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_SESSION_ITEMS = 30;
/** Hinweis-Zeilen (nicht wählbar) gut lesbar statt der 40 %-Deckkraft gesperrter Zeilen. */
const INFO_ROW = "text-a-mut data-[disabled=true]:opacity-100";
/** Tippen erst kurz abwarten, dann suchen (spart Anfragen je Tastendruck). */
const SEARCH_DEBOUNCE_MS = 140;

/** Symbol + Farbe je Art (Symbole wie in `nav.ts`). Kategorien bunt, nie grau. */
const KIND_META: Record<SearchAllKind, { icon: string; cls: string }> = {
  session: { icon: "▣", cls: "text-a-acc" },
  idee: { icon: "✦", cls: "text-a-wait" },
  auftrag: { icon: "☰", cls: "text-a-indigo" },
  audit: { icon: "⚑", cls: "text-a-conf" },
  skill: { icon: "❖", cls: "text-a-violet" },
  gedaechtnis: { icon: "✺", cls: "text-a-nyx" },
  agent: { icon: "⚙", cls: "text-a-codex" },
};

interface LocalItem {
  id: string;
  label: string;
  icon: string;
  /** Zusätzliche Suchwörter (nicht angezeigt). */
  words?: string;
  path?: string;
  hint?: string;
}

/** Feedback & Unterstützen: öffnet das Blatt direkt auf dem passenden Reiter (features/support/). */
const SUPPORT_ITEMS: (LocalItem & { tab: SupportTab })[] = [
  { id: "support-bug", tab: "bug", label: t("Fehler melden"), icon: "⚑", words: "bug fehler problem melden report feedback hilfe" },
  { id: "support-idea", tab: "idea", label: t("Idee schicken"), icon: "✦", words: "idee wunsch vorschlag feature entwickler feedback idea" },
  { id: "support-tokens", tab: "tokens", label: t("Buy me Tokens"), icon: "♥", words: "spenden spende unterstützen donate support tokens kaffee geld" },
];
/** Die Palette-Zeile „Vollbild“ (auch für die Suche: „Vollbild“, „Ansicht“, „fullscreen“). */
const FULLSCREEN_ITEM: LocalItem = { id: "fullscreen", label: t("Vollbild"), icon: "⤢", words: "vollbild ansicht fullscreen ganzer bildschirm full screen view" };
const NAV_LOCAL: LocalItem[] = NAV_ITEMS.map((item) =>
  item.status === "active" ? { id: item.id, label: item.label, icon: item.icon, words: `tab ${item.id}`, path: item.path } : { id: item.id, label: item.label, icon: item.icon, hint: item.hint },
);

/** Klein, ohne Akzente — „Aufträge“ findet man auch mit „auftrage“. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matchesLocal(item: LocalItem, q: string): boolean {
  const hay = fold(`${item.label} ${item.words ?? ""}`);
  return fold(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Hebt den Suchbegriff im Text hervor (React escaped den Rest — kein HTML aus dem Server). */
function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  const needle = q.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(n); at !== -1; at = lower.indexOf(n, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-a-acc/25 px-0.5 text-a-ink">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * ⌘K / Strg+K. Ohne Eingabe: Tabs, Einstellungen, letzte Sessions. Mit Eingabe: Tabs/
 * Einstellungen passend gefiltert, darunter alles vom Server gruppiert (`/api/search/all`: Sessions,
 * Ideen, Aufträge, Audits, Skills, Nyx-Gedächtnis, Agenten) und als letzte Zeile immer
 * „Nyx fragen: …“ (öffnet ⌘J mit der Frage, schickt nichts ab). Die Palette springt nur oder öffnet
 * Dialoge — nichts Riskantes passiert ohne eigene Bestätigung. ↑↓ + Enter wie gewohnt (cmdk).
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const sessions = useSessions();
  const [search, setSearch] = useState("");
  // Nach dem Kürzen erneut trimmen — der Server trimmt ebenso, sonst passt `all.data.q` nie zu `q`.
  const q = search.trim().slice(0, SEARCH_ALL_MAX_QUERY_LENGTH).trim();
  const debounced = useDebounced(q, SEARCH_DEBOUNCE_MS);
  const searching = q.length >= SEARCH_MIN_QUERY_LENGTH;
  const all = useQuery({
    queryKey: ["search-all", debounced],
    queryFn: ({ signal }) => searchEverything(debounced, signal),
    enabled: open && debounced.length >= SEARCH_MIN_QUERY_LENGTH,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 10_000,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };
  const ask = () => {
    onOpenChange(false);
    askNyx(q);
  };

  const info = useAppInfo().data;
  const local = info?.mode === "local";
  // Local mode: „Server“ is „Dieser Rechner“ (same route).
  const navAll = local
    ? NAV_LOCAL.map((i) => {
        const item = NAV_ITEMS.find((n) => n.id === i.id);
        return item ? { ...i, label: navLabel(item, true) } : i;
      })
    : NAV_LOCAL;
  // Every settings subpage (Allgemein + Nyx + Info & Hilfe) from the register, with its keywords (e.g. „Ruhezeit“
  // finds „Mitteilungen“), only the areas of this run mode. Without input only the Nyx settings (otherwise ~20
  // subpages fill the list); while typing all that match.
  const settingsAll = useMemo(() => settingsPaletteItems(local ? "local" : "server"), [local]);
  const navItems = q ? navAll.filter((i) => matchesLocal(i, q)) : navAll;
  // Whoever types „Telegram“ wants the row „Telegram“ – hits in the name before hits only in the keywords.
  const settingItems = q
    ? settingsAll.filter((i) => matchesLocal(i, q)).sort((a, b) => Number(matchesLocal({ ...b, words: "" }, q)) - Number(matchesLocal({ ...a, words: "" }, q)))
    : settingsAll.filter((i) => i.id === "set-nyx");
  const newSessionShown = !q || matchesLocal({ id: "new", label: t("Neue Session starten"), icon: "+", words: "neue session starten new start" }, q);
  const fullscreenShown = !q || matchesLocal(FULLSCREEN_ITEM, q);
  const supportItems = q ? SUPPORT_ITEMS.filter((i) => matchesLocal(i, q)) : SUPPORT_ITEMS;
  const sessionItems = q ? [] : (sessions.data ?? []).slice(0, MAX_SESSION_ITEMS);
  // Beim Weitertippen bleiben die vorigen Treffer stehen (keepPreviousData), bis die neuen da sind.
  const groups = searching ? (all.data?.groups ?? []) : [];
  const waiting = searching && groups.length === 0 && (debounced !== q || all.isFetching);
  const noHits = searching && groups.length === 0 && !waiting && !all.isError && all.data?.q === q;
  const needsLogin = all.error instanceof ApiError && all.error.status === 401;

  // Auswahl steuern: cmdk wählt beim Tippen die erste Zeile — solange die Treffer noch laden, ist das
  // „Nyx fragen“ ganz unten. Kämen die Treffer danach, bliebe die Auswahl dort hängen und Enter würde
  // Nyx fragen statt den obersten Treffer öffnen. Darum: neue Eingabe → erste wählbare Zeile; neue
  // Treffer → ebenso, außer der Nutzer hat inzwischen selbst mit den Pfeiltasten gewählt.
  const firstLocal = [...navItems, ...settingItems].find((i) => i.path);
  const firstHit = groups[0]?.hits[0];
  let firstValue = "";
  if (firstLocal) firstValue = `nav:${firstLocal.id}`;
  else if (!searching && newSessionShown) firstValue = "action:new-session";
  else if (q && fullscreenShown) firstValue = "action:fullscreen";
  else if (q && supportItems[0]) firstValue = `action:${supportItems[0].id}`;
  else if (firstHit && groups[0]) firstValue = `hit:${groups[0].kind}:0:${firstHit.path}`;
  else if (searching && needsLogin) firstValue = "action:login";
  else if (searching && all.isError) firstValue = "action:retry";
  else if (q) firstValue = "action:ask-nyx";
  const [selected, setSelected] = useState("");
  const autoSelected = useRef("");
  // Bewusst nur bei neuer Eingabe bzw. neuen Daten, nicht bei jedem Rendern.
  useEffect(() => {
    autoSelected.current = firstValue;
    setSelected(firstValue);
  }, [q, open]);
  useEffect(() => {
    const prev = autoSelected.current;
    autoSelected.current = firstValue;
    setSelected((cur) => (cur === "" || cur === prev ? firstValue : cur));
  }, [all.data, all.isError]);
  const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
  const status = !searching
    ? ""
    : needsLogin
      ? t("Zum Durchsuchen bitte anmelden")
      : all.isError
        ? t("Die Suche klappt gerade nicht")
        : waiting
          ? t("Suche läuft")
          : noHits
            ? t("Keine Treffer für {q}", { q })
            : hitCount === 1
              ? t("1 Treffer in 1 Gruppe")
              : hitCount > 0
                ? t(groups.length === 1 ? "{n} Treffer in {g} Gruppe" : "{n} Treffer in {g} Gruppen", { n: hitCount, g: groups.length })
                : "";

  const localRow = (item: LocalItem) =>
    item.path ? (
      <CommandItemRow key={item.id} value={`nav:${item.id}`} onSelect={() => item.path && go(item.path)}>
        {item.id === "nyx" ? <NyxAura size={16} /> : <span aria-hidden="true">{item.icon}</span>}
        {/* Eine Hülle um den Treffer: sonst wird jedes Stück („Voll“ + „bild“) ein eigenes Flex-Kind mit Lücke. */}
        <span className="min-w-0 truncate">
          <Highlight text={item.label} q={q} />
        </span>
      </CommandItemRow>
    ) : (
      <CommandItemRow key={item.id} value={`nav:${item.id}`} disabled>
        <span aria-hidden="true">{item.icon}</span>
        {item.label}
        <span className="ml-auto text-label text-a-mut">{item.hint}</span>
      </CommandItemRow>
    );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label={t("Befehlspalette")} shouldFilter={false} loop value={selected} onValueChange={setSelected}>
      <CommandInputField
        value={search}
        onValueChange={setSearch}
        maxLength={SEARCH_ALL_MAX_QUERY_LENGTH}
        placeholder={t("Suche alles oder frag Nyx …")}
        // Die Suchleiste ist auch Nyx' Eingang – statt der Lupe das lebendige Nyx-Logo.
        icon={<NyxAura size={20} />}
        after={<MicButton compact target="search" shortcutKey={null} onResult={(r) => setSearch(r.text)} />}
      />
      {/* Screenreader: Stand der Suche ansagen (die Zeilen selbst ändern sich still). */}
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
      <CommandListBox>
        <CommandEmptyBox>{t("Nichts gefunden.")}</CommandEmptyBox>

        {navItems.length + settingItems.length > 0 && (
          <CommandGroupBox heading={q ? t("Tabs & Einstellungen") : t("Tabs")}>
            {navItems.map(localRow)}
            {settingItems.map(localRow)}
          </CommandGroupBox>
        )}

        {fullscreenShown && (
          <CommandGroupBox heading={t("Ansicht")}>
            <CommandItemRow value="action:fullscreen" onSelect={() => (onOpenChange(false), toggleFullscreen())}>
              <span aria-hidden="true">{FULLSCREEN_ITEM.icon}</span>
              <span className="min-w-0 truncate">
                <Highlight text={FULLSCREEN_ITEM.label} q={q} />
              </span>
              <kbd className="ml-auto shrink-0 rounded border border-a-line px-1.5 font-mono text-label text-a-mut">F</kbd>
            </CommandItemRow>
          </CommandGroupBox>
        )}

        {supportItems.length > 0 && (
          <CommandGroupBox heading={t("Feedback & Unterstützen")}>
            {supportItems.map((item) => (
              <CommandItemRow key={item.id} value={`action:${item.id}`} data-nyx={item.id} onSelect={() => (onOpenChange(false), openSupport(item.tab))}>
                <span aria-hidden="true" className={item.tab === "tokens" ? "text-a-conf" : undefined}>
                  {item.icon}
                </span>
                <span className="min-w-0 truncate">
                  <Highlight text={item.label} q={q} />
                </span>
              </CommandItemRow>
            ))}
          </CommandGroupBox>
        )}

        {(newSessionShown || sessionItems.length > 0) && !searching && (
          <CommandGroupBox heading="Sessions">
            {newSessionShown && (
              <CommandItemRow value="action:new-session" data-nyx="neue-session" onSelect={() => (onOpenChange(false), openNewSession())}>
                + {t("Neue Session starten")}
              </CommandItemRow>
            )}
            {sessionItems.map((session) => (
              <CommandItemRow key={session.id} value={`recent:${session.id}`} onSelect={() => go(sessionPath(session))} className="min-w-0">
                <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                <span className="ml-auto shrink-0 text-label text-a-mut">{session.tool === "claude" ? "Claude" : "Codex"}</span>
              </CommandItemRow>
            ))}
          </CommandGroupBox>
        )}

        {groups.map((g) => {
          const meta = KIND_META[g.kind];
          return (
            <CommandGroupBox key={g.kind} heading={g.label} data-search-group={g.kind}>
              {g.hits.map((hit, i) => (
                <CommandItemRow
                  key={`${hit.path}-${i}`}
                  value={`hit:${g.kind}:${i}:${hit.path}`}
                  onSelect={() => go(hit.path)}
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2"
                >
                  <span aria-hidden="true" className={`mt-0.5 ${meta.cls}`}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="min-w-0 truncate">
                      <Highlight text={hit.title} q={q} />
                    </div>
                    {hit.snippet && (
                      <div className="min-w-0 truncate text-label text-a-mut">
                        <Highlight text={hit.snippet} q={q} />
                      </div>
                    )}
                  </div>
                </CommandItemRow>
              ))}
            </CommandGroupBox>
          );
        })}

        {searching && (waiting || noHits || all.isError) && (
          <CommandGroupBox heading={t("Suche")}>
            {needsLogin ? (
              <CommandItemRow value="action:login" onSelect={() => (onOpenChange(false), openLoginDialog({ forAction: true }))}>
                <span aria-hidden="true">→</span>
                {t("Zum Durchsuchen bitte anmelden")}
              </CommandItemRow>
            ) : all.isError ? (
              <CommandItemRow value="action:retry" onSelect={() => void all.refetch()}>
                <span aria-hidden="true">↻</span>
                {t("Die Suche klappt gerade nicht – Enter versucht es noch einmal")}
              </CommandItemRow>
            ) : waiting ? (
              <CommandItemRow value="info:waiting" disabled className={INFO_ROW}>
                <span aria-hidden="true">⌕</span>
                {t("Suche läuft …")}
              </CommandItemRow>
            ) : (
              <CommandItemRow value="info:none" disabled className={INFO_ROW}>
                <span aria-hidden="true">⌕</span>
                {/* Also stood below matching tabs/settings („no results“ next to results) – then it means the content search. */}
                {navItems.length + settingItems.length > 0 ? t("In den Inhalten nichts zu „{q}“ – frag doch Nyx", { q }) : t("Keine Treffer für „{q}“ – frag doch Nyx", { q })}
              </CommandItemRow>
            )}
          </CommandGroupBox>
        )}

        {q && (
          <CommandGroupBox heading="Nyx">
            <CommandItemRow value="action:ask-nyx" onSelect={ask} data-testid="palette-ask-nyx">
              <NyxAura size={18} />
              <span className="min-w-0 flex-1 truncate">
                {t("Nyx fragen: „{q}“", { q })}
              </span>
              <span className="ml-auto shrink-0 text-label text-a-mut">⌘J</span>
            </CommandItemRow>
          </CommandGroupBox>
        )}
      </CommandListBox>
    </CommandDialog>
  );
}
