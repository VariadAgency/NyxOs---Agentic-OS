// Demo mode is look-only: every write under /api/* and /terminal/* is rejected with `403 { code: "demo_readonly" }`,
// except what browsing itself sends (sign-in, presence heartbeat, "recently opened") and talking to Nyx.
// Nyx' own writes are closed twice: its in-process `app_api` calls may only read (below), and in the demo its
// tool list holds only reading tools (`DEMO_NYX_TOOLS`, see `ToolRegistry.limitTo`).
import { t } from "@nyxos/shared";
import type { MiddlewareHandler } from "hono";
import { isInternalRequest } from "../nyx/appApi/internal.js";

export const DEMO_READONLY_CODE = "demo_readonly";

/** Writes the demo still accepts: method + exact path or path pattern (`:id` = one path segment). */
const ALLOWED_WRITES: readonly [method: string, path: string][] = [
  // sign-in and sign-out (passkey flows, status, CSRF refresh)
  ["*", "/api/auth/*"],
  // sent by the web app on its own while browsing
  ["POST", "/api/away/heartbeat"],
  ["POST", "/api/sessions/:id/opened"],
  // talking to Nyx: chat (creates the thread), "interrupted" mark, answers of the Nyx cursor, voice in and out
  ["POST", "/api/haiku/chat"],
  ["POST", "/api/haiku/threads/:id/interrupted"],
  ["POST", "/api/nyx/ui/reply"],
  ["POST", "/api/nyx/voice/speak"],
  ["POST", "/api/nyx/voice/transcribe"],
  ["POST", "/api/voice/transcribe"],
  // answers 409 itself ("no demo from inside the demo"), so the web app sees the same code as in server mode
  ["POST", "/api/demo/start"],
];

function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((w, i) => (w === ":id" ? (got[i] ?? "") !== "" : w === got[i]));
}

/** Is this write allowed in the demo? (GET/HEAD always are.) */
export function demoWriteAllowed(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (!path.startsWith("/api/") && !path.startsWith("/terminal/")) return true;
  return ALLOWED_WRITES.some(([m, p]) => (m === "*" || m === method) && matches(p, path));
}

/**
 * Middleware of the demo instance (registered before every route). `onRequest` sees every request (idle timer).
 * Nyx' in-process `app_api` requests may only read in the demo, even on paths the browser may write to.
 */
export function demoReadonlyGuard(onRequest?: () => void): MiddlewareHandler {
  return async (c, next) => {
    onRequest?.();
    const method = c.req.method;
    const path = c.req.path;
    const internalWrite = isInternalRequest(c.req.raw) && method !== "GET" && method !== "HEAD";
    if (internalWrite || !demoWriteAllowed(method, path)) {
      return c.json({ error: t("In der Demo kannst du dich nur umsehen. Richte NyxOS ein, um loszulegen."), code: DEMO_READONLY_CODE }, 403);
    }
    return next();
  };
}

/**
 * Nyx' tools in the demo: only those that read (or show something in the browser, whose writes the guard above
 * rejects). Everything else — ideas, questions, plans, approvals, memory, to-dos, schedules — does not exist there.
 * An allow-list on purpose: a tool added later stays out of the demo until someone puts it here.
 */
export const DEMO_NYX_TOOLS: readonly string[] = [
  "sessions_suchen",
  "lage",
  "sessions_zaehlen",
  "letzte_aktivitaet",
  "git_lage",
  "nachtlaeufe",
  "session_lesen",
  "freigaben_liste",
  "inbox_liste",
  "builds_liste",
  "ideen_suchen",
  "eintrag_suchen",
  "eintrag_lesen",
  "konflikte",
  "session_ergebnisse",
  "session_search",
  "mitteilungen_liste",
  "nutzung",
  "was_ist_neu",
  "server_lage",
  "show_image",
  "show_link",
  "app_api",
  "app_api_katalog",
  "ui_navigate",
  "ui_click",
  "ui_type",
  "ui_select",
  "ui_read_screen",
  "briefing_vorlesen",
];
