// Untere 3D-Leiste des Gehirns: Umkreisen/Fliegen, Alles einpassen, Tastenhilfe.
// Breit EINE Zeile, zu breit → waagrecht scrollbar (vorher bei 390 px zur schmalen Spalte gequetscht).
// Auf schmalen Bildschirmen ist die Tastenhilfe anfangs hinter „?“ eingeklappt, und die
// Leiste bricht um (sonst rechts abgeschnitten) – Knöpfe oben, die Hinweise darunter über die volle Breite, jeder Hinweis bleibt ganz. Wird das
// Fenster schmal, klappt die Tastenhilfe ein; wieder breit, ist sie wieder offen.
import { t } from "@nyxos/shared";
import { useState, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import type { Control3D } from "./scene3d";

const NARROW_QUERY = "(max-width: 640px)";

function isNarrow(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

function subscribeNarrow(cb: () => void): () => void {
  try {
    if (typeof window.matchMedia !== "function") return () => undefined;
    const mq = window.matchMedia(NARROW_QUERY);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  } catch {
    return () => undefined;
  }
}

export function Graph3DHelp({ control, onControlChange, onFit }: { control: Control3D; onControlChange: (m: Control3D) => void; onFit: () => void }) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const [helpOpen, setHelpOpen] = useState(() => !narrow);
  // Über die Schmal-Grenze gezogen: schmal → einklappen (die Hinweise lägen sonst über dem Gehirn), breit → zeigen.
  const [lastNarrow, setLastNarrow] = useState(narrow);
  if (narrow !== lastNarrow) {
    setLastNarrow(narrow);
    setHelpOpen(!narrow);
  }
  const fly = control === "fly";
  return (
    <div
      data-brain-overlay=""
      data-testid="brain-3d-bar"
      data-narrow={narrow ? "1" : "0"}
      className={cn(
        "cc-scroll pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-a-line bg-a-p/85 px-3 py-2 text-caption text-a-mut shadow-lg backdrop-blur",
        narrow ? "flex-wrap gap-y-1.5" : "flex-nowrap overflow-x-auto whitespace-nowrap",
      )}
    >
      <div role="radiogroup" aria-label={t("3D-Steuerung")} className="flex shrink-0 rounded-md border border-a-line bg-a-p2 p-0.5">
        {(
          [
            ["orbit", t("Umkreisen")],
            ["fly", t("Fliegen")],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={control === m}
            onClick={() => onControlChange(m)}
            className={cn("rounded px-2 py-0.5 text-caption whitespace-nowrap transition-colors duration-150", control === m ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onFit} className="shrink-0 rounded-md border border-a-line bg-a-p2 px-2 py-0.5 text-caption whitespace-nowrap text-a-ink transition-colors duration-150 hover:bg-a-p3">
        ⤢ {t("Alles einpassen")}
      </button>
      {helpOpen ? (
        <span
          className={cn("flex items-center gap-x-2.5", narrow ? "order-last basis-full flex-wrap gap-y-1" : "shrink-0 flex-nowrap")}
          data-testid="brain-3d-keys"
          title={
            fly
              ? t("Maus ziehen oder zwei Finger: umschauen · Rechts ziehen: schieben · Rad oder Kneifen: vor/zurück · WASD/Pfeile bewegen, Q/E runter/hoch, Shift schneller")
              : t("Maus ziehen oder zwei Finger: Kugel drehen · Rechts ziehen oder Shift+Ziehen: schieben · Klick: auswählen und hinfliegen · Rad oder Kneifen: zoomen zur Maus · WASD/Pfeile bewegen, Q/E runter/hoch, Shift schneller")
          }
        >
          <span className="whitespace-nowrap">{fly ? t("Zwei Finger: umschauen") : t("Zwei Finger: drehen")}</span>
          <span className="whitespace-nowrap">{t("Kneifen: zoomen")}</span>
          <span className="whitespace-nowrap">{t("Klick: hinfliegen")}</span>
          <span className="whitespace-nowrap">
            <Kbd>F</Kbd> {t("alles zeigen")}
          </span>
          <span className="whitespace-nowrap">
            <Kbd>V</Kbd> {fly ? t("umkreisen") : t("fliegen")}
          </span>
        </span>
      ) : null}
      <button type="button" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} aria-label={helpOpen ? t("Tastenhilfe ausblenden") : t("Tastenhilfe zeigen")} className="shrink-0 rounded px-1 text-label text-a-mut hover:text-a-ink">
        {helpOpen ? "✕" : "?"}
      </button>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-a-line bg-a-p2 px-1 font-mono text-label text-a-ink">{children}</kbd>;
}
