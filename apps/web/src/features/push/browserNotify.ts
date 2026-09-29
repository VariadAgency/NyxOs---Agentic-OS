// Push-Weg „Browser“: der Server schickt über die bestehende /live-Verbindung `{ type: "push", … }`, dieses
// Modul zeigt daraus eine System-Mitteilung (Web Notifications API) — solange ein NyxOS-Fenster offen ist.
// Kein Doppel auf dem Rechner der Brücke: zeigt die Brücke die Mitteilung schon (`macShown`), bleibt der Browser
// auf einem Mac still. Der Test-Knopf zeigt immer beide, damit man jeden Weg einzeln sieht.
import type { PushLiveMessage } from "@nyxos/shared";

export type BrowserPushMessage = PushLiveMessage & { macShown?: boolean };

export type BrowserPermission = NotificationPermission | "unsupported";

export function browserPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Fragt einmal nach Erlaubnis (nur nach einem Klick — Browser verbieten das sonst). */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (browserPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function isMacBrowser(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  // iPad meldet sich ebenfalls als „MacIntel“, hat aber Touch — dort gibt es keine Brücke.
  return /mac/i.test(platform) && navigator.maxTouchPoints <= 1;
}

export function isBrowserPushMessage(msg: unknown): msg is BrowserPushMessage {
  const m = msg as Partial<BrowserPushMessage> | null;
  return !!m && m.type === "push" && typeof m.title === "string" && typeof m.message === "string";
}

/** Öffnet den Pfad in der App, ohne die Seite neu zu laden (react-router hört auf `popstate`). */
function openPath(path: string | null): void {
  window.focus();
  if (!path || !path.startsWith("/")) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function showBrowserPush(msg: BrowserPushMessage): void {
  if (browserPermission() !== "granted") return;
  if (msg.kind !== "test" && msg.macShown && isMacBrowser()) return;
  try {
    const n = new Notification(msg.title, { body: msg.message, tag: msg.kind === "test" ? "nyxos-test" : undefined, icon: "/icon-192.png" });
    n.onclick = () => {
      openPath(msg.path);
      n.close();
    };
  } catch {
    // Manche Browser (z. B. Android Chrome) erlauben `new Notification` nur über einen Service Worker — dann still.
  }
}
