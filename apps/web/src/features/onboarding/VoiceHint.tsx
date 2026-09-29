// Einrichten → „Stimme“ (nur lokal, optional): ein Knopf installiert das Stimmen-Paket im Hintergrund (derselbe
// Weg wie in Einstellungen → Nyx → Stimme und `nyxos voice install`). Die Einrichtung geht dabei einfach weiter.
import { formatModelSize, t, type VoicePackStatus } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui/button";
import { friendlyError } from "../../lib/friendlyError";
import { useAppInfo } from "../../hooks/useAppInfo";
import { fetchVoicePack, installVoicePack, VOICE_PACK_KEY } from "../settings/nyx/nyxApi";
import { Block, ErrorLine, StatusPill } from "./ui";

const WORKING: VoicePackStatus["state"][] = ["installing", "starting", "restarting", "removing"];

export function VoiceHint() {
  const info = useAppInfo().data;
  const local = info?.mode === "local" && !info.demo;
  const qc = useQueryClient();
  const packQ = useQuery({
    queryKey: VOICE_PACK_KEY,
    queryFn: fetchVoicePack,
    enabled: local,
    retry: false,
    refetchInterval: (q) => (q.state.data && WORKING.includes(q.state.data.state) ? 2000 : false),
  });
  const install = useMutation({ mutationFn: installVoicePack, onSuccess: (s) => qc.setQueryData(VOICE_PACK_KEY, s) });
  const pack = packQ.data;
  if (!local || !pack || pack.state === "unsupported") return null;

  const status =
    pack.state === "running" ? (
      <StatusPill tone="ok">{t("installiert")}</StatusPill>
    ) : WORKING.includes(pack.state) ? (
      <StatusPill tone="wait">{t("wird installiert")}</StatusPill>
    ) : null;

  return (
    <Block title={t("Stimme")} badge={<StatusPill tone="mut">{t("optional")}</StatusPill>} status={status}>
      <p className="text-callout text-a-mut">{t("Nyx kann dir zuhören und antworten – auf Deutsch und Englisch, ganz auf diesem Computer.")}</p>
      {(pack.state === "not_installed" || pack.state === "failed") && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => install.mutate()} disabled={install.isPending}>
            {t("Stimme installieren")}
          </Button>
          <span className="text-caption text-a-mut">{t("Einmalig etwa {size} Download. Läuft im Hintergrund – du kannst weitermachen.", { size: formatModelSize(pack.downloadBytes) })}</span>
        </div>
      )}
      {WORKING.includes(pack.state) && <p className="text-caption text-a-mut">{t("Läuft im Hintergrund – du kannst weitermachen. Den Stand siehst du unter Einstellungen → Nyx → Stimme.")}</p>}
      <ErrorLine text={pack.error ?? (install.isError ? friendlyError(install.error, t("Die Installation ließ sich nicht starten.")) : null)} />
    </Block>
  );
}
