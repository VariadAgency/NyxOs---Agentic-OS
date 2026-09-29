// Was du gerade siehst — geht mit jeder Frage an Haiku mit (HaikuContext) und steht als
// Transparenz-Zeile oben im Panel („Sieht: Sessions › Coding › nyxos“).
import { t, type HaikuContext } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { BAUSTELLE_NONE, BAUSTELLE_OHNE } from "../../hooks/useSessionsRoute";
import type { Session } from "../../lib/api";
import { artLabel } from "../../lib/arts";
import { NAV_ITEMS } from "../../nav";

const EXTRA_TAB_LABELS: Record<string, string> = {
  einstellungen: t("Einstellungen"),
  briefing: t("Briefing"),
  inbox: t("Entscheidungen"),
};

/** Tabs mit Großansicht eines Eintrags: `/<tab>/…/<id>` → letzte Stelle ist die Eintrags-ID. */
const ENTRY_TABS = new Set(["tasks", "ideas", "audits"]);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function tabLabel(tab: string): string {
  const nav = NAV_ITEMS.find((item) => item.status === "active" && item.path === `/${tab}`);
  if (nav) return nav.label;
  return EXTRA_TAB_LABELS[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1);
}

export interface HaikuContextView {
  context: HaikuContext;
  /** Anzeige-Text ohne „Sieht:“, z. B. „Sessions › Coding › nyxos“. */
  crumbs: string[];
}

export function useHaikuContext(): HaikuContextView {
  const location = useLocation();
  const qc = useQueryClient();
  const segments = location.pathname.split("/").filter(Boolean).map(decode);
  const params = new URLSearchParams(location.search);
  const tab = segments[0] ?? null;

  const filters: Record<string, string> = {};
  let openSessionId: string | null = null;
  let openEntryId: string | null = null;
  let title: string | null = null;
  const crumbs: string[] = tab ? [tabLabel(tab)] : [];

  if (tab === "sessions") {
    const [, art, baustelle, id] = segments;
    const sessions = qc.getQueryData<Session[]>(["sessions"]) ?? [];
    const session = id ? sessions.find((s) => s.id === id || s.sessionId === id) : undefined;
    if (art && art !== "_") {
      filters.art = art;
      crumbs.push(artLabel(art));
    }
    if (baustelle && baustelle !== BAUSTELLE_NONE) {
      filters.baustelle = baustelle;
      const known = sessions.find((s) => s.baustelle?.slug === baustelle)?.baustelle?.label;
      crumbs.push(baustelle === BAUSTELLE_OHNE ? t("Ohne Baustelle") : (known ?? baustelle));
    }
    const tool = params.get("tool");
    if (tool) filters.tool = tool;
    if (id) {
      openSessionId = id;
      title = session?.title ?? null;
      crumbs.push(title ?? `Session ${id.length > 14 ? `${id.slice(0, 12)}…` : id}`);
    }
  } else if (tab && ENTRY_TABS.has(tab)) {
    // Großansicht als Stapel `?e=<id>,<id>` über der Liste – die oberste ist die geöffnete.
    const stack = (params.get("e") ?? "").split(",").filter((x) => /^\d{1,12}$/.test(x));
    openEntryId = stack.at(-1) ?? null;
    if (openEntryId) crumbs.push(t("Eintrag {id}", { id: openEntryId }));
  }

  if (!title && typeof document !== "undefined") {
    const heading = document.querySelector("main h1")?.textContent?.trim();
    if (heading) title = heading.slice(0, 300);
  }

  return {
    context: { path: `${location.pathname}${location.search}`.slice(0, 500), tab, filters, openSessionId, openEntryId, title },
    crumbs,
  };
}
