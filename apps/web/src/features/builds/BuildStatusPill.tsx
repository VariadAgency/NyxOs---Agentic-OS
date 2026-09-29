// Build-Wächter — Anzeige an der Session (Reiter/Kopf) und als Überblick-Einzeiler
// ("Build-Status als Pill + Sparkline der letzten Läufe"). Die Einbindung in Überblick/Session-Kopf
// liegt dort; diese Datei liefert nur die einbindbare Komponente.
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";

import { locale, t, timeZone, type BuildStatus } from "@nyxos/shared";

export type { BuildStatus };

export interface BuildRunLite {
  status: BuildStatus;
  startedAt: string;
}

const STATUS_META: Record<BuildStatus, { label: string; dot: string; text: string; bg: string }> = {
  queued: { label: t("wartet"), dot: "bg-a-dim", text: "text-a-mut", bg: "bg-a-dim/10" },
  running: { label: t("baut …"), dot: "bg-a-wait animate-pulse motion-reduce:animate-none", text: "text-a-wait", bg: "bg-a-wait/10" },
  green: { label: t("grün"), dot: "bg-a-ok", text: "text-a-ok", bg: "bg-a-ok/10" },
  red: { label: t("rot"), dot: "bg-a-bad", text: "text-a-bad", bg: "bg-a-bad/10" },
  // Werkzeug/Ordner/Brücke fehlt — kein Fehler im Code, darum nicht rot.
  unavailable: { label: t("nicht eingerichtet"), dot: "bg-a-wait", text: "text-a-wait", bg: "bg-a-wait/10" },
};

/** Kleine Balken-Sparkline aus den letzten Läufen (neueste rechts) — kein Chart-Overhead nötig für
 * ein binäres grün/rot-Signal. `min-w-0` am Wrapper, damit sie in einem engen Grid nie aufreißt. */
function Sparkline({ runs }: { runs: BuildRunLite[] }) {
  const last = runs.slice(-12);
  return (
    <div
      className="flex min-w-0 items-end gap-[2px]"
      role="img"
      aria-label={t("Letzte {n} Läufe: {list}", { n: last.length, list: last.map((r) => STATUS_META[r.status].label).join(", ") })}
    >
      {last.map((r, i) => (
        <span
          key={i}
          className={cn("h-3 w-1 rounded-[1px]", r.status === "green" ? "bg-a-ok" : r.status === "red" ? "bg-a-bad" : r.status === "unavailable" ? "bg-a-wait/60" : "bg-a-dim/50")}
          title={`${STATUS_META[r.status].label} · ${new Date(r.startedAt).toLocaleTimeString(locale(), { timeZone: timeZone() })}`}
        />
      ))}
    </div>
  );
}

export interface BuildStatusPillProps {
  /** Letzter/aktueller Lauf; `null` = noch nie geprüft. */
  current: BuildRunLite | null;
  /** Verlauf für die Sparkline, älteste zuerst. */
  history?: BuildRunLite[];
  /** Erklärung des letzten Laufs (`describeBuildRun`): Überschrift + ein Satz, was los ist.
   * Mit Angabe erklärt die Plakette sich per Tooltip und per Klick (kleines Detail mit Weg zu den Builds). */
  view?: { headline: string; sentence: string } | null;
  className?: string;
}

/** Was du tun kannst — je Zustand ein kurzer Satz (nur wo es etwas zu tun gibt). */
const NEXT_STEP: Partial<Record<BuildStatus, string>> = {
  unavailable: t("Du musst nichts sofort tun: Geprüft wird automatisch, sobald das Fehlende da ist. Alle Läufe mit Details stehen unter Server → Letzte Builds."),
  red: t("Die Session sollte den Fehler beheben. Den Originaltext findest du unter Server → Letzte Builds."),
};

export function BuildStatusPill({ current, history = [], view = null, className }: BuildStatusPillProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!current) {
    return <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-a-line bg-a-p2 px-2 py-0.5 font-mono text-label text-a-mut", className)}>{t("noch nicht geprüft")}</span>;
  }
  const meta = STATUS_META[current.status];
  const inner = (
    <>
      <span className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />
        <span className={cn("font-mono text-label uppercase tracking-wide", meta.text)}>{meta.label}</span>
      </span>
      {history.length > 0 && <Sparkline runs={history} />}
    </>
  );
  const pillClass = cn("inline-flex min-w-0 items-center gap-2 rounded-full border border-a-line px-2 py-0.5", meta.bg, className);
  if (!view) return <span className={pillClass}>{inner}</span>;

  const next = NEXT_STEP[current.status];
  return (
    <span ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        data-testid="build-pill"
        title={t("{headline} – {sentence} (Klick: mehr)", { headline: view.headline, sentence: view.sentence })}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(pillClass, "cursor-pointer transition-colors duration-150 hover:border-a-acc/60 focus-visible:outline-2 focus-visible:outline-a-acc")}
      >
        {inner}
      </button>
      {open && (
        <div id={dialogId} role="dialog" aria-label={view.headline} className="cc-pop-sheet absolute top-full left-0 z-30 mt-1.5 grid w-80 gap-1.5 rounded-lg border border-a-line bg-a-p p-3 text-caption shadow-lg shadow-black/40">
          <b className="text-a-ink">{view.headline}</b>
          <p className="text-a-ink">{view.sentence}</p>
          {next && <p className="text-a-mut">{next}</p>}
          <Link to="/server" className="justify-self-start text-a-acc hover:underline" onClick={() => setOpen(false)}>
            {t("Alle Builds ansehen →")}
          </Link>
        </div>
      )}
    </span>
  );
}
