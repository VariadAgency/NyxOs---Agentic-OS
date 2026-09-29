// Opening the "Feedback & Unterstützen" sheet: it lives in the address (`?support=bug|idea|tokens`), so every page
// can open it, the browser's back button closes it and Nyx can open it with a plain `navigate`.
import { closeNavDrawer } from "../../lib/navDrawer";

export const SUPPORT_TABS = ["bug", "idea", "tokens"] as const;
export type SupportTab = (typeof SUPPORT_TABS)[number];
export const SUPPORT_PARAM = "support";
export const OPEN_SUPPORT_EVENT = "nyxos:open-support";

export function isSupportTab(v: string | null): v is SupportTab {
  return v !== null && (SUPPORT_TABS as readonly string[]).includes(v);
}

/** Opens the sheet on a tab (from anywhere, also outside the router: the sheet listens for the event). */
export function openSupport(tab: SupportTab = "bug"): void {
  closeNavDrawer();
  window.dispatchEvent(new CustomEvent<SupportTab>(OPEN_SUPPORT_EVENT, { detail: tab }));
}
