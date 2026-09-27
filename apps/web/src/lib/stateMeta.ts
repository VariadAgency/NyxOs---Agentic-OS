// Zustandsfarben/-texte. Farben ausschließlich aus den Tokens
// (`app.css`), nie erfunden. "done_suggested"/"conflict" sind reserviert und werden nie
// von `computeSessionState` geliefert — die Einträge hier bereiten nur die Darstellung vor.
import { t } from "@nyxos/shared";
import type { SessionState } from "./api";

export type DisplayState = Exclude<SessionState, null> | "done_suggested" | "conflict" | "ended";

export interface StateMeta {
  label: string;
  dot: string;
  text: string;
  bg: string;
  /** 3-px-Statuskante links an Session-Karten. Eigenes, LITERALES Feld
   * statt `meta.text.replace("text-", "border-")` zur Laufzeit — Tailwinds Scanner findet
   * Klassennamen nur als wörtliche Zeichenketten im Quelltext, eine zusammengesetzte Zeichenkette
   * zur Laufzeit würde die CSS-Datei nicht erreichen. `border-l-*` statt `border-*`: nur die Kante links. */
  border: string;
}

export const STATE_META: Record<DisplayState, StateMeta> = {
  running: { label: t("läuft"), dot: "bg-a-ok", text: "text-a-ok", bg: "bg-a-ok/10", border: "border-l-a-ok" },
  waiting: { label: t("wartet auf dich"), dot: "bg-a-wait shadow-[0_0_0_3px_color-mix(in_srgb,var(--a-wait)_18%,transparent)]", text: "text-a-wait", bg: "bg-a-wait/10", border: "border-l-a-wait" },
  idle: { label: t("ruht"), dot: "bg-a-idle", text: "text-a-idle", bg: "bg-a-idle/15", border: "border-l-a-idle" },
  crashed: { label: t("abgestürzt"), dot: "bg-a-bad", text: "text-a-bad", bg: "bg-a-bad/10", border: "border-l-a-bad" },
  closed: { label: t("geschlossen"), dot: "bg-a-dim", text: "text-a-mut", bg: "bg-a-dim/10", border: "border-l-a-line" },
  ended: { label: t("beendet"), dot: "bg-a-dim", text: "text-a-mut", bg: "bg-a-dim/10", border: "border-l-a-line" },
  done_suggested: { label: t("fertig?"), dot: "bg-a-done", text: "text-a-done", bg: "bg-a-done/10", border: "border-l-a-done" },
  conflict: { label: t("Konflikt"), dot: "bg-a-conf", text: "text-a-conf", bg: "bg-a-conf/10", border: "border-l-a-conf" },
};

/** `null` (kein Zustand, sauber beendet) zeigt sich als "beendet". */
export function stateMeta(state: SessionState): StateMeta {
  return STATE_META[state ?? "ended"];
}
