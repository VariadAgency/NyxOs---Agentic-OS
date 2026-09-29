// Einstellungen → Nyx → Stimme, nur lokal: das Stimmen-Paket mit einem Klick installieren (derselbe Weg wie
// `nyxos voice install`), dabei jeden Schritt zeigen, danach den Download der Sprachmodelle – und wieder entfernen.
// Von oben nach unten: ein Satz, was das ist, dann EIN Knopf bzw. der Fortschritt.
import { formatModelSize, t, VOICE_PACK_STEPS, type NyxVoiceStatus, type VoicePackStatus, type VoicePackStep } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { fetchVoicePack, fetchVoiceStatusFull, installVoicePack, removeVoicePack, VOICE_PACK_KEY, VOICE_STATUS_FULL_KEY } from "./nyxApi";

const BTN = "rounded-lg border border-a-line px-3 py-1.5 text-caption text-a-ink transition-colors hover:bg-a-p2 disabled:opacity-50";
const BTN_PRIMARY = "rounded-lg border border-transparent bg-a-primary px-4 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50";

const STEP_LABEL: Record<VoicePackStep, () => string> = {
  check: () => t("Speicherplatz prüfen"),
  uv: () => t("Installationsprogramm laden"),
  python: () => t("Python einrichten"),
  packages: () => t("Sprach-Pakete installieren"),
  ffmpeg: () => t("Ton-Umwandlung prüfen"),
  done: () => t("Fertig"),
};
/** Schritte, die der Nutzer zählt („Fertig“ ist kein eigener Schritt). */
const VISIBLE_STEPS: VoicePackStep[] = VOICE_PACK_STEPS.filter((s) => s !== "done");
const BUSY: VoicePackStatus["state"][] = ["installing", "removing", "starting", "restarting"];

function Bar({ value, label }: { value: number | null; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(value !== null ? { "aria-valuenow": value } : {})} className="h-1.5 w-full overflow-hidden rounded-full bg-a-p3">
      <div className={cn("h-full rounded-full bg-a-acc transition-[width] duration-500", value === null && "w-1/3 animate-pulse")} style={value !== null ? { width: `${Math.max(3, value)}%` } : undefined} />
    </div>
  );
}

/** `onState` meldet dem Rest der Seite, ob das Paket installiert ist (sonst bleiben die Stimmen-Listen leer). */
export function VoicePackBlock({ onState }: { onState?: (installed: boolean) => void }) {
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const packQ = useQuery({
    queryKey: VOICE_PACK_KEY,
    queryFn: fetchVoicePack,
    retry: false,
    refetchInterval: (q) => (q.state.data && BUSY.includes(q.state.data.state) ? 1000 : false),
  });
  const pack = packQ.data;
  const running = pack?.state === "running";
  // Nach dem Installieren lädt der Dienst seine Sprachmodelle: bis beide Teile bereit sind, alle 2 s nachsehen.
  const voiceQ = useQuery({
    queryKey: VOICE_STATUS_FULL_KEY,
    queryFn: fetchVoiceStatusFull,
    enabled: running,
    retry: false,
    refetchInterval: (q) => (running && !(q.state.data?.stt.ready && q.state.data.tts.ready) ? 2000 : false),
  });
  const voice: NyxVoiceStatus | undefined = running ? voiceQ.data : undefined;
  const ready = !!voice?.stt.ready && !!voice.tts.ready;

  useEffect(() => {
    if (pack) onState?.(pack.installed);
  }, [pack, onState]);
  // Stimme fertig: auch die schmale Form (Nyx-Tab, Vorlesen) neu holen.
  useEffect(() => {
    if (ready) void qc.invalidateQueries({ queryKey: ["nyx", "voice-status"] });
  }, [ready, qc]);

  const install = useMutation({ mutationFn: installVoicePack, onSuccess: (s) => qc.setQueryData(VOICE_PACK_KEY, s) });
  const remove = useMutation({
    mutationFn: removeVoicePack,
    onSuccess: (s) => {
      setConfirmRemove(false);
      qc.setQueryData(VOICE_PACK_KEY, s);
      void qc.invalidateQueries({ queryKey: VOICE_STATUS_FULL_KEY });
    },
  });

  // Kein lokaler Modus (Server, Demo) oder älterer Server: der Block fehlt einfach.
  if (!pack) return null;

  const stepIndex = pack.step ? VISIBLE_STEPS.indexOf(pack.step) : -1;
  const modelPart = voice && !voice.stt.ready ? voice.stt : voice && !voice.tts.ready ? voice.tts : null;

  return (
    <div className="grid min-w-0 gap-2.5 rounded-lg border border-a-line bg-a-p2 p-3" data-nyx="stimme-paket" data-state={pack.state}>
      <div className="grid gap-0.5">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Stimme auf diesem Computer")}</h3>
        <p className="text-caption text-a-mut">{t("Nyx hört dir zu und antwortet – auf Deutsch und Englisch. Alles läuft auf diesem Computer, deine Stimme geht nicht ins Internet.")}</p>
      </div>

      {(pack.state === "not_installed" || pack.state === "failed") && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={BTN_PRIMARY} disabled={install.isPending} onClick={() => install.mutate()} data-nyx="stimme-installieren">
            {install.isPending ? t("Startet …") : t("Stimme installieren")}
          </button>
          <span className="text-caption text-a-mut">{t("Einmalig etwa {size} Download, danach ohne Internet.", { size: formatModelSize(pack.downloadBytes) })}</span>
        </div>
      )}

      {pack.state === "installing" && (
        <div className="grid gap-1.5" aria-live="polite">
          <p className="text-callout text-a-ink">
            {pack.step && stepIndex >= 0 ? t("Schritt {n} von {total}: {step} …", { n: stepIndex + 1, total: VISIBLE_STEPS.length, step: STEP_LABEL[pack.step]() }) : t("Wird installiert …")}
          </p>
          <Bar value={pack.progress} label={t("Installation")} />
          <p className="text-caption text-a-mut">{t("Das dauert meist ein bis drei Minuten. Du kannst die Seite dabei verlassen.")}</p>
        </div>
      )}

      {pack.state === "starting" && (
        <div className="grid gap-1.5" aria-live="polite">
          <p className="text-callout text-a-ink">{t("Die Stimme startet …")}</p>
          <Bar value={null} label={t("Start")} />
        </div>
      )}

      {running && !ready && (
        <div className="grid gap-1.5" aria-live="polite">
          <p className="text-callout text-a-ink">{voice?.sentence ?? t("Die Stimme startet …")}</p>
          <Bar value={modelPart?.progress ?? null} label={t("Sprachmodelle")} />
          <p className="text-caption text-a-mut">{t("Beim ersten Start lädt die Stimme ihre Sprachmodelle – das passiert nur einmal.")}</p>
        </div>
      )}

      {running && ready && (
        <p className="text-callout text-a-ok" data-nyx="stimme-bereit">
          {t("Die Stimme läuft auf diesem Computer ✓")}
        </p>
      )}

      {pack.state === "restarting" && <p className="text-callout text-a-wait">{t("Die Stimme ist gerade ausgefallen und startet gleich neu.")}</p>}
      {pack.state === "removing" && <p className="text-callout text-a-mut">{t("Die Stimme wird entfernt …")}</p>}

      {pack.error && <p className="text-caption text-a-bad">{pack.error}</p>}
      {install.isError && <p className="text-caption text-a-bad">{friendlyError(install.error, t("Die Installation ließ sich nicht starten."))}</p>}
      {remove.isError && <p className="text-caption text-a-bad">{friendlyError(remove.error, t("Die Stimme ließ sich nicht entfernen."))}</p>}

      {pack.installed && pack.state !== "removing" && pack.state !== "installing" && (
        <div className="flex flex-wrap items-center gap-2">
          {!confirmRemove ? (
            <button type="button" className={BTN} onClick={() => setConfirmRemove(true)}>
              {t("Stimme entfernen …")}
            </button>
          ) : (
            <>
              <span className="text-caption text-a-ink">{t("Stimme und Sprachmodelle löschen? Du kannst sie später wieder installieren.")}</span>
              <button type="button" className={cn(BTN, "border-a-bad/60 text-a-bad")} disabled={remove.isPending} onClick={() => remove.mutate()}>
                {t("Ja, entfernen")}
              </button>
              <button type="button" className={BTN} onClick={() => setConfirmRemove(false)}>
                {t("Abbrechen")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
