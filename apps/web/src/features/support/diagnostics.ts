// "Diagnose anhängen": what a bug report carries along. Built in the browser, cleaned with the same rules the server
// uses again before forwarding (`sanitizeDiagnostics` in @nyxos/shared, idempotent) — so the preview in the sheet is
// exactly what is sent. The last few browser errors are collected from the start of the page (`installErrorLog`).
import { describeUserAgent, getLang, sanitizeDiagnostics, SUPPORT_LIMITS, type SupportDiagnostics, type SupportErrorEntry, type SupportState } from "@nyxos/shared";

const browserErrors: SupportErrorEntry[] = [];
let installed = false;

function remember(message: string): void {
  const text = message.trim();
  if (!text) return;
  browserErrors.push({ source: "browser", at: new Date().toISOString(), message: text.slice(0, 1000) });
  if (browserErrors.length > SUPPORT_LIMITS.errors) browserErrors.splice(0, browserErrors.length - SUPPORT_LIMITS.errors);
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return typeof reason === "string" ? reason : "";
}

/** Once at start (main.tsx): remember uncaught errors and rejected promises (only in memory, never sent by itself). */
export function installErrorLog(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("error", (e) => remember(e.error instanceof Error ? reasonText(e.error) : e.message));
  target.addEventListener("unhandledrejection", (e) => remember(reasonText(e.reason)));
}

export function recentBrowserErrors(): SupportErrorEntry[] {
  return [...browserErrors];
}

/** Tests only. */
export function __resetErrorLog(): void {
  browserErrors.length = 0;
}

export function buildDiagnostics(opts: {
  server: SupportState["diagnostics"] | undefined;
  version: string | undefined;
  mode: "local" | "server" | undefined;
  pathname: string;
  userName: string;
  userAgent?: string;
}): SupportDiagnostics {
  const { browser, os } = describeUserAgent(opts.userAgent ?? navigator.userAgent);
  const errors = [...recentBrowserErrors(), ...(opts.server?.errors ?? [])].sort((a, b) => a.at.localeCompare(b.at)).slice(-SUPPORT_LIMITS.errors);
  return sanitizeDiagnostics(
    {
      version: opts.server?.version ?? opts.version ?? "unknown",
      mode: opts.server?.mode ?? opts.mode ?? "unknown",
      os,
      browser,
      page: opts.pathname,
      language: getLang(),
      errors,
    },
    { words: opts.userName.split(/\s+/).filter(Boolean) },
  );
}
