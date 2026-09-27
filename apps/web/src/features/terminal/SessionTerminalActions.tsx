import { useState } from "react";
import { t } from "@nyxos/shared";
import { Button } from "../../components/ui/button";
import type { Session } from "../../lib/api";
import { friendlyError } from "../../lib/friendlyError";
import { TakeoverButton } from "./TakeoverButton";
import { useBridgeStatus, useKillSession } from "./terminalApi";

/**
 * Knöpfe im Kopf des Session-Vollbilds: „Im Terminal öffnen" (läuft in der NyxOS),
 * „In der NyxOS übernehmen" (läuft in einem eigenen Fenster oder gar nicht mehr → `--resume`,
 * altes Fenster nur nach Rückfrage beenden) und „Prozess beenden" (mit Bestätigung — Schließen
 * beendet NIE den Prozess).
 */
export function SessionTerminalActions({
  session,
  onOpenTerminal,
  onWatch,
  short = false,
  killInMenu = false,
  killOpen,
  onKillOpen,
}: {
  session: Session;
  onOpenTerminal: () => void;
  onWatch?: () => void;
  /** Kurze Beschriftungen im engen Kopf (voller Text im Hinweis). */
  short?: boolean;
  /** „Prozess beenden“ steht im Menü „⋯“ — der Knopf hier entfällt, die Rückfrage bleibt hier. */
  killInMenu?: boolean;
  /** Rückfrage von außen steuern (Menüeintrag im Kopf). Ohne: eigener Zustand. */
  killOpen?: boolean;
  onKillOpen?: (open: boolean) => void;
}) {
  const bridge = useBridgeStatus();
  const online = bridge.data?.online ?? false;
  const kill = useKillSession();
  const [ownConfirm, setOwnConfirm] = useState(false);
  const confirmKill = killOpen ?? ownConfirm;
  const setConfirmKill = onKillOpen ?? setOwnConfirm;
  const offlineTitle = online ? undefined : t("Brücke offline");
  const running = session.status === "running";

  return (
    <>
      {session.attachable ? (
        <Button onClick={onOpenTerminal} disabled={!online} title={offlineTitle ?? (short ? t("Im Terminal öffnen") : undefined)} aria-label={short ? t("Im Terminal öffnen") : undefined}>
          {short ? "Terminal" : t("Im Terminal öffnen")}
        </Button>
      ) : (
        <TakeoverButton session={session} onDone={onOpenTerminal} onWatch={onWatch} short={short} />
      )}
      {running && !killInMenu && (
        <Button variant="ghost" onClick={() => setConfirmKill(true)} disabled={!online} title={offlineTitle}>
          {t("Prozess beenden")}
        </Button>
      )}
      {confirmKill && (
        <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4" role="presentation" onClick={() => setConfirmKill(false)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="kill-title" className="grid w-full max-w-sm gap-3 rounded-2xl border border-a-line bg-a-p2 p-4 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <h2 id="kill-title" className="font-display text-callout font-semibold text-a-ink">
              {t("Prozess wirklich beenden?")}
            </h2>
            <p className="text-caption text-a-mut">
              {t("{tool} wird hart beendet, eine laufende Antwort geht verloren. Der Verlauf bleibt erhalten und lässt sich danach fortsetzen.", {
                tool: session.tool === "claude" ? "Claude" : "Codex",
              })}
            </p>
            {kill.isError && <p className="text-caption text-a-bad">{friendlyError(kill.error, t("Beenden hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmKill(false)} disabled={kill.isPending}>
                {t("Abbrechen")}
              </Button>
              <Button variant="warn" onClick={() => kill.mutate(session, { onSuccess: () => setConfirmKill(false) })} disabled={kill.isPending}>
                {kill.isPending ? t("Beende …") : t("Prozess beenden")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
