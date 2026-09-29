import { HEALTH_CHECK_LABEL, t, type HealthCheckName, type HostInfo, type PendingStep, type ServerSnapshot } from "@nyxos/shared";
import { useState } from "react";
import { PageShell } from "../../components/PageShell";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { useServerSnapshot } from "../../hooks/useServerSnapshot";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { RecentBuilds } from "../builds/RecentBuilds";
import { ContainerSection } from "./ContainerSection";
import { useHostInfo } from "./hostApi";
import { HostOverview } from "./HostOverview";
import { formatDuration, HostUnavailable } from "./HostTiles";
import { ConnectionSection, MachineSection, ServerMoreSections, useIsLocal } from "./ServerMore";
import { isTroubled, sshHostOf } from "./serverView";

/** Ein 503 von /health darf nicht als Konsolenfehler/leerer Zustand enden — die Pille
 * kommt aus `GET /api/server` (`data.health`), derselben Quelle wie die Kopfleiste, nie einer
 * eigenen zweiten `/health`-Anfrage. Ohne Störung ein ruhiger grüner Punkt, sonst der genaue Grund. */
function HealthBanner({ health }: { health: ServerSnapshot["health"] }) {
  if (health.ok) return null;
  const broken = (Object.keys(health.checks) as HealthCheckName[]).filter((name) => !health.checks[name]?.ok);
  return (
    <div className="grid gap-1.5 rounded-lg border border-a-bad/40 bg-a-bad/10 px-4 py-3 text-callout text-a-bad">
      {broken.map((name) => (
        <p key={name}>
          {t("Server-Teil {part} gestört: {error}", { part: t(HEALTH_CHECK_LABEL[name] ?? name), error: health.checks[name]?.error ?? t("unbekannter Fehler") })}
        </p>
      ))}
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-a-line bg-a-bg px-2 py-1 font-mono text-caption text-a-ink" title={command}>
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded-md border border-a-line px-2 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2 pointer-coarse:min-h-11"
      >
        {copied ? t("Kopiert") : t("Kopieren")}
      </button>
    </div>
  );
}

/** Nur, was WIRKLICH fehlt — mit genauem Schritt. Nichts fehlt → nichts steht hier. */
function PendingBox({ pending }: { pending: PendingStep[] }) {
  if (pending.length === 0) return null;
  return (
    <section className="grid gap-2 rounded-xl border border-a-wait/40 bg-a-wait/[.06] p-4" aria-label={t("Fehlt noch")} data-testid="server-pending">
      <h2 className="text-callout font-medium text-a-wait">{t("Fehlt noch ({n})", { n: pending.length })}</h2>
      <ul className="grid gap-3">
        {pending.map((p) => (
          <li key={p.id} className="grid gap-1">
            <p className="text-callout text-a-ink">
              <span className="font-medium">{p.title}:</span> {p.sentence}
            </p>
            <CopyCommand command={p.command} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Deploy-Protokoll als Zeitleiste, neuester Eintrag oben; die laufende Revision ist markiert. */
function DeployTimeline({ deploys, running }: { deploys: ServerSnapshot["deploys"]; running: string | null }) {
  return (
    <ol className="grid gap-0">
      {deploys.map((d, i) => {
        const live = !!running && !!d.gitRev && (d.gitRev.startsWith(running) || running.startsWith(d.gitRev));
        return (
          <li key={d.id} className="relative grid grid-cols-[16px_1fr] gap-x-2.5 pb-3 last:pb-0">
            <span className="relative flex justify-center">
              <span className={cn("z-10 mt-1 h-2 w-2 rounded-full", live ? "bg-a-ok" : "bg-a-acc")} />
              {i < deploys.length - 1 && <span className="absolute top-2.5 h-full w-px bg-a-line" />}
            </span>
            <div className="grid gap-0.5 text-callout">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-a-ink">{d.gitRev ?? "?"}</span>
                <span className="text-a-mut">{d.containerName}</span>
                {live && <span className="rounded-full bg-a-ok/10 px-2 py-0.5 text-label text-a-ok">{t("läuft jetzt")}</span>}
              </div>
              <span className="font-mono text-label text-a-mut">
                {formatDateTime(d.createdAt)} · {relativeTime(d.createdAt)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const DEPLOYS_SHOWN = 5;

function Deploys({ data }: { data: ServerSnapshot }) {
  const [all, setAll] = useState(false);
  if (data.deploys.length === 0) return <p className="text-callout text-a-mut">{t("Noch kein Deploy protokolliert – der nächste über scripts/deploy-all.sh trägt sich selbst ein.")}</p>;
  const shown = all ? data.deploys : data.deploys.slice(0, DEPLOYS_SHOWN);
  return (
    <div className="grid gap-2">
      <DeployTimeline deploys={shown} running={data.runningRevision} />
      {data.deploys.length > DEPLOYS_SHOWN && (
        <button type="button" onClick={() => setAll((a) => !a)} className="justify-self-start text-caption text-a-acc hover:underline">
          {all ? t("weniger anzeigen") : t("alle {n} Deploys anzeigen", { n: data.deploys.length })}
        </button>
      )}
    </div>
  );
}

/** Kopf: Name des Servers, Status, Laufzeit, wann gemessen. */
function ServerHead({ data, host, local }: { data: ServerSnapshot; host: HostInfo | undefined; local: boolean }) {
  const troubled = data.containers.filter(isTroubled).length;
  const ok = data.health.ok && data.nyxosHealthy && troubled === 0;
  const status = !data.health.ok || !data.nyxosHealthy ? { word: t("gestört"), cls: "bg-a-bad/10 text-a-bad", dot: "bg-a-bad" } : troubled > 0 ? { word: troubled === 1 ? t("1 Container gestört") : t("{n} Container gestört", { n: troubled }), cls: "bg-a-wait/10 text-a-wait", dot: "bg-a-wait" } : { word: t("läuft"), cls: "bg-a-ok/10 text-a-ok", dot: "bg-a-ok" };
  const measured = host?.checkedAt ?? data.docker.checkedAt;
  return (
    <header className="grid gap-1.5" data-testid="server-head">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="font-display text-title font-semibold text-a-ink">{local ? t("Dieser Rechner") : t("Server")}</h1>
        {host?.hostname && <span className="font-mono text-headline text-a-mut">{host.hostname}</span>}
        <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-caption", status.cls)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot, ok && "animate-[pulse_2s_ease-in-out_infinite] motion-reduce:animate-none")} aria-hidden />
          {status.word}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-label text-a-mut">
        {host?.uptimeSeconds !== null && host?.uptimeSeconds !== undefined && <span>{t("läuft seit {time}", { time: formatDuration(host.uptimeSeconds) })}</span>}
        {host?.os && <span>{host.os}</span>}
        {measured && <span>{t("gemessen {time}", { time: relativeTime(measured) })}</span>}
        {data.runningRevision && <span className="rounded-full bg-a-p3 px-2 py-0.5 text-a-ink">NyxOS {data.runningRevision}</span>}
        <span className={data.nyxosHealthy ? "text-a-ok" : "text-a-bad"}>{data.nyxosHealthy ? t("NyxOS-API läuft") : t("NyxOS-API gestört")}</span>
      </div>
    </header>
  );
}

/** Server-Tab: von oben nach unten — Kopf, Hinweise, alle Serverdaten („Auf einen Blick“ als Kachel-Raster,
 * Maschine im Detail), DANN die Container (kompakte Ampel-Kachel oder Liste nach Gruppen), danach Terminal,
 * Dateien und Betrieb (Deploys, Builds, Verbindung, Live-Logs). Im lokalen Modus beschreibt er diesen Rechner.
 * Fehlt etwas, steht genau das da — mit Befehl. */
export function Server() {
  const { data, isLoading, isError, refetch } = useServerSnapshot();
  const host = useHostInfo();
  const local = useIsLocal();

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4 md:p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="grid place-items-center p-10 text-center">
        <p className="mb-3 text-callout text-a-mut">{local ? t("Der Stand dieses Rechners konnte nicht geladen werden.") : t("Server-Stand konnte nicht geladen werden.")}</p>
        <button type="button" onClick={() => void refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      </div>
    );
  }

  return (
    <PageShell>
      <ServerHead data={data} host={host.data} local={local} />

      <HealthBanner health={data.health} />
      <PendingBox pending={Array.isArray(data.pending) ? data.pending : []} />

      <section className="grid gap-3" aria-label={t("Auf einen Blick")} data-server-section>
        <SectionTitle>{t("Auf einen Blick")}</SectionTitle>
        <HostOverview host={host.data} snapshot={data} local={local} />
        {host.error ? <HostUnavailable error={host.error} /> : null}
      </section>

      <MachineSection />

      {/* Die Container kommen direkt nach den Serverdaten, kompakt. Auf diesem Rechner (lokal) nur, wenn es
          wirklich einen Docker-Lesezugang gibt — NyxOS braucht dort kein Docker. */}
      {(!local || data.docker.available) && (
        <section className="grid gap-3" aria-label={t("Container")} data-server-section>
          <SectionTitle>{t("Container")}</SectionTitle>
          {data.docker.available ? (
            <ContainerSection data={data} />
          ) : (
            // Text in its own paragraph – as loose text next to a <span> the card had no child reaching the bottom
            // (two lines at 1024 px → the layout check reported a "stretched card").
            <Card className="text-callout text-a-mut">
              <p>
                <span className="text-a-ink">{data.docker.reason}</span> {t("Den Schritt dazu siehst du oben unter „Fehlt noch“.")}
              </p>
            </Card>
          )}
        </section>
      )}

      <ServerMoreSections sshHost={sshHostOf(data)} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-6">
        {/* Deploys der NyxOS gibt es nur im Server-Modus (Deploy-Skript); lokal aktualisiert `nyxos update`. */}
        {(!local || data.deploys.length > 0) && (
          <section className="grid gap-2" aria-label={t("Deploys")} data-server-section>
            <SectionTitle>{t("Deploys — NyxOS")}</SectionTitle>
            <Card className="p-3">
              <Deploys data={data} />
            </Card>
          </section>
        )}

        <section className="grid gap-2" aria-label={t("Letzte Builds")} data-server-section>
          <SectionTitle>{t("Letzte Builds")}</SectionTitle>
          <Card className="p-3">
            <RecentBuilds />
          </Card>
        </section>
      </div>

      <ConnectionSection sshHost={sshHostOf(data)} dozzleUrl={data.dozzleUrl ?? null} />

      {data.dozzleUrl && (
        <section className="grid gap-2" aria-label={t("Live-Logs")} data-server-section>
          <SectionTitle>{t("Live-Logs")}</SectionTitle>
          <Card className="flex flex-wrap items-center justify-between gap-2 text-callout">
            <span className="text-a-mut">{t("Alle Container live mitlesen, durchsuchen und mehrere nebeneinander: Dozzle (nur lesen, mit deiner Anmeldung).")}</span>
            <a href={data.dozzleUrl} target="_blank" rel="noreferrer" className="rounded-md border border-a-acc/40 px-3 py-1.5 text-a-acc transition-colors duration-150 hover:bg-a-acc/10">
              {t("Dozzle öffnen")} ↗
            </a>
          </Card>
        </section>
      )}
    </PageShell>
  );
}
