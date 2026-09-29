// Motor-Zustand, sichtbar BEVOR du schreibst – im Panel und in den Einstellungen.
// bereit · wartet auf Token · aus · Fehler; nie ein totes „einschalten“: jeder Zustand hat den Knopf, der
// wirklich weiterhilft. Texte kommen (außer der Anleitung) vom Server (`engine.reason`), einfach formuliert.
import { describeModel, modelName, t, type HaikuEngineState, type HaikuStatus } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import { useAppInfo } from "../../hooks/useAppInfo";
import { cn } from "../../lib/cn";
import { fetchHaikuStatus } from "./haikuApi";
import { tRich } from "./richText";

/** Demo: Nyx ist dort immer ansprechbar (eigene KI oder Demo-Antworten) – „aus“/„wartet auf Token“ sähe nach Fehler aus. */
const demoReady = (s: HaikuStatus): HaikuStatus => (s.engine.state === "ready" ? s : { ...s, engine: { ...s.engine, state: "ready", reason: null } });

/** Status-Abfrage: nicht bereit → öfter nachsehen (Motor startet gerade, Token kam gerade an). `/live` stößt zusätzlich an. */
export function useHaikuStatus() {
  const demo = useAppInfo().data?.demo === true;
  return useQuery({
    queryKey: ["haiku", "status"],
    queryFn: fetchHaikuStatus,
    refetchInterval: (q) => (demo || q.state.data?.engine.state === "ready" ? 60_000 : 15_000),
    select: demo ? demoReady : undefined,
  });
}

export const LOOK: Record<HaikuEngineState, { label: string; short: string; dot: string; text: string; ring: string }> = {
  ready: { label: t("Bereit"), short: t("bereit"), dot: "bg-a-ok", text: "text-a-ok", ring: "var(--a-ok)" },
  waiting_token: { label: t("Noch keine KI verbunden"), short: t("nicht verbunden"), dot: "bg-a-wait", text: "text-a-wait", ring: "var(--a-wait)" },
  off: { label: t("Ausgeschaltet"), short: t("aus"), dot: "bg-a-idle", text: "text-a-mut", ring: "var(--a-idle)" },
  error: { label: t("Motor gestört"), short: t("gestört"), dot: "bg-a-bad", text: "text-a-bad", ring: "var(--a-bad)" },
};

/** Kleine Zeile: Punkt + Zustand (Panel-Kopf, Einstellungen). */
export function EngineStateLine({ status, className }: { status: HaikuStatus; className?: string }) {
  const look = LOOK[status.engine.state] ?? LOOK.error;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-mono text-label", look.text, className)} data-state={status.engine.state}>
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", look.dot)} />
      <span className="truncate">{look.label}</span>
      {status.engine.state === "ready" && status.engine.model && <span className="text-a-mut" title={describeModel(status.engine.model)}>· {modelName(status.engine.model)}</span>}
    </span>
  );
}

/** Drei Schritte, fertig zum Kopieren – was nur du kannst (braucht deinen Browser-Login). */
function TokenGuide() {
  const code = "rounded bg-a-bg px-1 py-px font-mono text-caption text-a-acc";
  return (
    <div className="grid gap-1.5">
      <ol aria-label={t("Anleitung KI verbinden")} className="grid list-decimal gap-1 pl-5 text-caption text-a-ink marker:text-a-mut">
        <li>{tRich("Claude-Programm installieren: {cmd}", { cmd: <code className={code}>curl -fsSL https://claude.ai/install.sh | bash</code> })}</li>
        <li>{tRich("Im Terminal {cmd} starten und im Browser mit deinem Claude-Konto anmelden.", { cmd: <code className={code}>claude</code> })}</li>
        <li>{t("Oder ohne Abo: in den Einstellungen unter „Zugänge“ einen API-Schlüssel eintragen.")}</li>
      </ol>
      <p className="text-caption text-a-mut">{t("Danach „Erneut prüfen“ – dann ist Nyx bereit.")}</p>
    </div>
  );
}

/**
 * Hinweis-Kasten, solange der Motor NICHT bereit ist (bei „bereit“ nichts). `where` bestimmt den Knopf bei „aus“:
 * im Panel ein Link in die Einstellungen, in den Einstellungen der Hinweis auf die Motor-Wahl darüber.
 */
export function EngineNotice({ status, onRetry, where, className }: { status: HaikuStatus; onRetry: () => void; where: "panel" | "settings"; className?: string }) {
  const [guideOpen, setGuideOpen] = useState(false);
  const guideId = useId();
  const { state, reason } = status.engine;
  if (state === "ready") return null;
  const look = LOOK[state] ?? LOOK.error;
  const button = "rounded-md border border-a-line bg-a-p3 px-2.5 py-1 text-caption text-a-ink hover:border-a-acc/60";

  return (
    <div role="status" className={cn("grid min-w-0 gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2.5", className)}>
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", look.dot)} />
        <div className="grid min-w-0 gap-0.5">
          <b className={cn("text-caption font-semibold", look.text)}>{look.label}</b>
          {reason && reason.replace(/\.$/, "") !== look.label && <span className="text-caption leading-snug text-a-mut">{reason}</span>}
        </div>
      </div>
      {state === "waiting_token" && (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} aria-expanded={guideOpen} aria-controls={guideId} onClick={() => setGuideOpen((v) => !v)}>
              {guideOpen ? t("Anleitung ausblenden") : t("Anleitung zeigen")}
            </button>
            <button type="button" className={button} onClick={onRetry}>
              {t("Erneut prüfen")}
            </button>
          </div>
          {guideOpen && (
            <div id={guideId}>
              <TokenGuide />
            </div>
          )}
        </>
      )}
      {state === "off" &&
        (where === "panel" ? (
          <div>
            <Link to="/einstellungen/nyx/motor" className={cn(button, "inline-block")}>
              {t("In Einstellungen einschalten")}
            </Link>
          </div>
        ) : (
          <span className="text-caption text-a-mut">{t("Zum Einschalten oben einen Motor wählen und speichern.")}</span>
        ))}
      {state === "error" && (
        <div>
          <button type="button" className={button} onClick={onRetry}>
            {t("Erneut prüfen")}
          </button>
        </div>
      )}
    </div>
  );
}
