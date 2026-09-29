// Demo: every write is rejected by the server with `403 { code: "demo_readonly" }` (only browsing and the Nyx
// chat work). `authFetch` turns that into ONE calm, global notice (event below → `DemoNotice`) and throws
// `DemoReadonlyError`. `friendlyError` returns "" for it, so the usual red error lines stay empty instead of
// repeating the notice in every feature.
import { t } from "@nyxos/shared";

export const DEMO_READONLY_CODE = "demo_readonly";
export const DEMO_READONLY_EVENT = "nyxos:demo-readonly";

export function demoReadonlyText(): string {
  return t("In der Demo kannst du dich nur umsehen – richte NyxOS ein, um loszulegen.");
}

/** A write was rejected because this is the demo (not a real error — the global notice explains it). */
export class DemoReadonlyError extends Error {
  readonly status = 403;
  readonly code = DEMO_READONLY_CODE;
  constructor() {
    super(demoReadonlyText());
    this.name = "DemoReadonlyError";
  }
}

export function isDemoReadonly(e: unknown): e is DemoReadonlyError {
  return e instanceof DemoReadonlyError;
}

/** Show the global demo notice (several rejections at once → still one notice). */
export function announceDemoReadonly(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEMO_READONLY_EVENT));
}

export function onDemoReadonly(fn: () => void): () => void {
  window.addEventListener(DEMO_READONLY_EVENT, fn);
  return () => window.removeEventListener(DEMO_READONLY_EVENT, fn);
}
