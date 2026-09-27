// „Der Nutzer ist da“ – alle 30 s ein Herzschlag an den Server, aber NUR, solange dieses Fenster
// sichtbar ist UND in den letzten 2 Minuten Maus, Tastatur oder Touch benutzt wurden. Bleibt er aus, gilt der Nutzer
// nach N Minuten als weg, und Nyx meldet sich per ntfy/Telegram. Still: Fehler (z. B. nicht angemeldet) öffnen
// keinen Anmelde-Dialog – der Herzschlag ist nur ein Hinweis, keine Aktion des Nutzers.
import { PRESENCE_ACTIVE_WINDOW_MS, PRESENCE_HEARTBEAT_MS } from "@nyxos/shared";
import { useEffect } from "react";
import { csrfHeader } from "../features/terminal/authClient";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

async function sendHeartbeat(): Promise<void> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json", ...(await csrfHeader()) };
    await fetch("/api/away/heartbeat", { method: "POST", headers, body: "{}", keepalive: true });
  } catch {
    // Server kurz weg oder nicht angemeldet – nächster Versuch in 30 s.
  }
}

export function usePresenceHeartbeat(): void {
  useEffect(() => {
    let lastActivity = Date.now();
    let lastSent = 0;
    const visible = () => document.visibilityState === "visible";
    const active = () => Date.now() - lastActivity <= PRESENCE_ACTIVE_WINDOW_MS;
    const beat = () => {
      if (!visible() || !active()) return;
      lastSent = Date.now();
      void sendHeartbeat();
    };
    const onActivity = () => {
      lastActivity = Date.now();
      // Nach einer Pause sofort melden (nicht erst im nächsten 30-s-Takt) – aber nie öfter als der Takt.
      if (Date.now() - lastSent >= PRESENCE_HEARTBEAT_MS) beat();
    };
    const onVisibility = () => {
      if (visible()) onActivity();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
