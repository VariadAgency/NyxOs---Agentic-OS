// „Zuletzt geöffnet“: Öffnen einer Session merken und die Liste lesen.
//
// Entscheidung (s. `apps/server/src/routes/recent.ts`): der Server ist die Quelle, damit die Liste
// auf allen Geräten gleich ist. Schreiben braucht die Anmeldung. Ohne Anmeldung (oder wenn der
// Server gerade nicht antwortet) merkt sich der Browser das Öffnen still in localStorage und reicht
// es beim nächsten angemeldeten Öffnen nach. Nie ein Anmelde-Dialog, nie eine Fehlermeldung —
// das Merken ist Beiwerk und darf dich nicht stören.
import type { Tool } from "@nyxos/shared";
import type { SessionState } from "../../lib/api";
import { csrfHeader, fetchAuthStatus } from "../terminal/authClient";
import { getJson } from "../../lib/http";
import type { ToolFilter } from "../../hooks/useSessionsRoute";

export interface RecentItem {
  sessionKey: string;
  sessionId: string;
  tool: Tool;
  title: string | null;
  state: SessionState;
  art: string;
  baustelle: { slug: string; label: string } | null;
  openedAt: string;
  openCount: number;
  lastActivityAt: string | null;
}

export interface LocalOpen {
  sessionKey: string;
  openedAt: string;
}

export const LOCAL_KEY = "nyxos:recent-opens";
const LOCAL_MAX = 50;

export function readLocalOpens(): LocalOpen[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is LocalOpen => !!x && typeof x === "object" && typeof (x as LocalOpen).sessionKey === "string" && typeof (x as LocalOpen).openedAt === "string");
  } catch {
    return [];
  }
}

function writeLocalOpens(list: LocalOpen[]): void {
  try {
    if (list.length === 0) window.localStorage.removeItem(LOCAL_KEY);
    else window.localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LOCAL_MAX)));
  } catch {
    // Speicher voll/gesperrt (privates Fenster) — dann eben nicht gemerkt.
  }
}

function rememberLocally(sessionKey: string, openedAt: string): void {
  writeLocalOpens([{ sessionKey, openedAt }, ...readLocalOpens().filter((o) => o.sessionKey !== sessionKey)]);
}

/** `true`, wenn der Server das Öffnen übernommen hat (oder die Session dort nicht mehr existiert). */
async function postOpen(sessionKey: string, openedAt: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/opened`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await csrfHeader()) },
      body: JSON.stringify({ openedAt }),
    });
    // 404: Session gibt es serverseitig nicht (mehr) — nicht weiter lokal aufheben.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// Nur EIN Nachreichen gleichzeitig: zwei schnell geöffnete Sessions würden sonst dieselben lokalen
// Einträge doppelt senden (und `open_count` doppelt zählen).
let flushing: Promise<void> | null = null;

/** Reicht lokal gemerkte Öffnungen nach (nach dem Anmelden). */
function flushLocalOpens(): Promise<void> {
  flushing ??= doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(): Promise<void> {
  const pending = readLocalOpens();
  if (pending.length === 0) return;
  const left: LocalOpen[] = [];
  for (const open of pending) if (!(await postOpen(open.sessionKey, open.openedAt))) left.push(open);
  // Während des Nachreichens neu gemerkte Einträge nicht verlieren.
  const added = readLocalOpens().filter((o) => !pending.some((p) => p.sessionKey === o.sessionKey && p.openedAt === o.openedAt));
  writeLocalOpens([...added, ...left]);
}

/** Beim Öffnen einer Session aufrufen. Wirft nie. */
export async function recordSessionOpen(sessionKey: string, now: Date = new Date()): Promise<void> {
  const openedAt = now.toISOString();
  try {
    const status = await fetchAuthStatus();
    if (!status.authenticated) {
      rememberLocally(sessionKey, openedAt);
      return;
    }
    if (await postOpen(sessionKey, openedAt)) await flushLocalOpens();
    else rememberLocally(sessionKey, openedAt);
  } catch {
    rememberLocally(sessionKey, openedAt);
  }
}

export function fetchRecentSessions(tool: ToolFilter): Promise<RecentItem[]> {
  const qs = tool === "alle" ? "" : `?tool=${tool}`;
  return getJson<{ items: RecentItem[] }>(`/api/recent-sessions${qs}`).then((body) => body.items);
}
