// Abschnitte der Server-Seite — Maschine im Detail (vor den Containern), Terminal + Dateien (nach den
// Containern) und die Verbindungs-Karte. Eigene Datei, damit Server.tsx übersichtlich bleibt.
import { t } from "@nyxos/shared";
import { SectionTitle } from "../../components/ui/Card";
import { useAppInfo } from "../../hooks/useAppInfo";
import { ConnectionCard } from "./ConnectionCard";
import { useHostInfo, useHostRoots } from "./hostApi";
import { HostSection } from "./HostTiles";
import { ServerFinder } from "./ServerFinder";
import { ServerTerminal } from "./ServerTerminal";

/** Lokaler Modus: der Server-Tab beschreibt „diesen Rechner“. */
export function useIsLocal(): boolean {
  return useAppInfo().data?.mode === "local";
}

export function MachineSection() {
  const local = useIsLocal();
  return (
    <section className="grid gap-3" aria-label={t("Maschine im Detail")} data-server-section>
      <SectionTitle>{t("Maschine im Detail")}</SectionTitle>
      <HostSection local={local} />
    </section>
  );
}

/** Terminal und Dateien (nur lesen). Auf diesem Rechner (lokal) nur, wenn eingerichtet: das Terminal mit einem
 * SSH-Host (wie das geht, sagt die Verbindungs-Karte), die Dateien mit eingetragenen Ordnern (sonst gibt es den
 * Dateien-Tab) — keine Server-Hinweise wie „der nächste Deploy hängt … ein“. */
export function ServerMoreSections({ sshHost = null }: { sshHost?: string | null } = {}) {
  const local = useIsLocal();
  const roots = useHostRoots(local);
  const showTerminal = !local || !!sshHost;
  const showFiles = !local || !!roots.error || (roots.data ?? []).some((r) => r.exists);
  return (
    <>
      {showTerminal && (
        <section className="grid gap-2" aria-label={t("Terminal")} data-server-section>
          <SectionTitle>{t("Terminal")}</SectionTitle>
          <ServerTerminal />
        </section>
      )}
      {showFiles && (
        <section className="grid gap-2" aria-label={t("Dateien")} data-server-section>
          <SectionTitle>{local ? t("Dateien auf diesem Rechner") : t("Dateien auf dem Server")}</SectionTitle>
          <ServerFinder />
        </section>
      )}
    </>
  );
}

export function ConnectionSection({ sshHost = null, dozzleUrl = null }: { sshHost?: string | null; dozzleUrl?: string | null }) {
  const host = useHostInfo();
  const local = useIsLocal();
  return (
    <section className="grid gap-2" aria-label={t("Verbindung")} data-server-section>
      <SectionTitle>{t("Verbindung")}</SectionTitle>
      <ConnectionCard tailscale={host.data ? host.data.tailscale : null} sshHost={sshHost} dozzleUrl={dozzleUrl} local={local} />
    </section>
  );
}
