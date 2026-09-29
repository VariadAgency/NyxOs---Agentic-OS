// Seitentitel je Tab. Zentral aus der Leisten-Definition
// (`nav.ts`), nicht in jeder Seite einzeln: „Überblick · NyxOS“, „Nyx · NyxOS“ …; eine offene Session trägt
// ihren Namen. `index.html` behält „NyxOS“ als Startwert, bis React läuft.
import { t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { fetchSessions } from "../lib/api";
import { LOCAL_SEGMENT_LABELS, NAV_ITEMS } from "../nav";
import { useAppInfo } from "./useAppInfo";

export const APP_TITLE = "NyxOS";

/** Erstes Pfadsegment → Name des Tabs aus der Leiste; dazu Routen ohne eigenen Leisten-Eintrag. */
const SEGMENT_LABEL: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.flatMap((item) => (item.status === "active" ? [[item.path.split("/")[1] ?? "", item.label]] : []))),
  einstellungen: t("Einstellungen"),
};

const SESSION_PATH = /^\/sessions\/[^/]+\/[^/]+\/([^/]+)/;

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** ID einer offenen Session aus dem Pfad (`/sessions/:art/:baustelle/:id`), sonst null. */
export function sessionIdFromPath(pathname: string): string | null {
  const m = SESSION_PATH.exec(pathname);
  return m?.[1] ? decode(m[1]) : null;
}

/** Titel für einen Pfad; `sessionTitle` = Name der offenen Session, falls bekannt; `local` = lokaler Modus („Dieser Rechner“). */
export function pageTitle(pathname: string, sessionTitle?: string | null, local = false): string {
  const segment = pathname.split("/")[1] ?? "";
  const name = sessionTitle?.trim() || (local && LOCAL_SEGMENT_LABELS[segment]) || SEGMENT_LABEL[segment];
  return name ? `${name} · ${APP_TITLE}` : APP_TITLE;
}

/** Setzt `document.title` passend zur Route. Einmal in der App eingehängt. */
export function usePageTitle(): void {
  const { pathname } = useLocation();
  const sessionId = sessionIdFromPath(pathname);
  // Nur auf einer Session-Seite: dieselbe Abfrage wie die Seite selbst (geteilter Cache, kein zusätzlicher Abruf).
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: fetchSessions, enabled: sessionId !== null });
  const session = sessionId ? sessions.data?.find((s) => s.id === sessionId || s.sessionId === sessionId) : undefined;
  const local = useAppInfo().data?.mode === "local";
  const title = pageTitle(pathname, session?.title ?? null, local);
  useEffect(() => {
    document.title = title;
  }, [title]);
  // Beim Aushängen (Tests, Abmelden) nicht den Titel des letzten Tabs stehen lassen.
  useEffect(() => () => void (document.title = APP_TITLE), []);
}
