// Alle Container des Servers, getrennt nach NyxOS / jedem anderen Projekt — jede Gruppe einzeln mit Pfeil
// aufklappbar (Zustand hält ContainerSection).
// Ganze Zeile klickbar → Logs klappen darunter auf (ruhige Zeilen, Status als Pill, Zeit in Mono). Sparklines nur aus echten Messpunkten (ab dem zweiten Punkt).
import { t, type ContainerGroup, type ContainerInfo } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { Sparkline } from "../../components/charts/Sparkline";
import { cn } from "../../lib/cn";
import { ContainerLogView } from "./ContainerLogView";
import { ageWords, containerBuckets, containerStatus, formatBytes, formatCpu, isSteadyRunning, uptime, type ContainerBucket, type ContainerLight, type ContainerTone } from "./serverView";

const TONE_PILL: Record<ContainerTone, string> = {
  ok: "bg-a-ok/10 text-a-ok",
  wait: "bg-a-wait/10 text-a-wait",
  bad: "bg-a-bad/12 text-a-bad",
  idle: "bg-a-idle/15 text-a-mut",
};
const TONE_DOT: Record<ContainerTone, string> = {
  ok: "bg-a-ok",
  wait: "bg-a-wait",
  bad: "bg-a-bad",
  idle: "bg-a-idle",
};
/** Bereichs-Farben (bunt, unterscheidbar — nie grau/weiß/schwarz); unbekannte Gruppen bekommen Türkis. */
const GROUP_COLOR: Partial<Record<ContainerGroup, string>> = { nyxos: "var(--a-done)", andere: "var(--a-conf)" };

function Metric({ label, value, history, color, title }: { label: string; value: string; history: number[]; color: string; title: string }) {
  return (
    <div className="grid w-[92px] grid-cols-[minmax(0,1fr)] gap-0.5 overflow-hidden" title={title}>
      <span className="flex items-baseline justify-between gap-1 font-mono text-label">
        <span className="text-a-mut">{label}</span>
        <span className="tabular-nums text-a-ink">{value}</span>
      </span>
      <div className="h-4">{history.length > 1 && <Sparkline values={history} height={16} color={color} />}</div>
    </div>
  );
}

function ContainerRow({ c, open, focused, onToggle, dozzleUrl, now }: { c: ContainerInfo; open: boolean; focused: boolean; onToggle: () => void; dozzleUrl: string | null; now: number }) {
  const status = containerStatus(c);
  const up = isSteadyRunning(c) ? uptime(c.startedAt, now) : null;
  const age = ageWords(c.imageCreatedAt, now);
  const tag = c.imageVersion ?? c.imageTag;
  const ref = useRef<HTMLLIElement>(null);
  // Klick auf ein Kästchen der Kompakt-Kachel springt hierher (jsdom kennt scrollIntoView nicht).
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [focused]);
  return (
    <li ref={ref} className={cn("grid gap-2 rounded-lg", focused && "ring-2 ring-a-acc/60")} data-container={c.name} data-focused={focused ? "true" : undefined}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "grid w-full grid-cols-[10px_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc md:grid-cols-[10px_minmax(0,1fr)_auto]",
          open && "bg-a-p2",
        )}
      >
        <span className={cn("mt-1.5 h-2 w-2 rounded-full", TONE_DOT[status.tone], status.tone === "ok" && "animate-[pulse_2s_ease-in-out_infinite] motion-reduce:animate-none")} aria-hidden />
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-mono text-callout text-a-ink" title={c.name}>
              {c.name}
            </span>
            <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-label", TONE_PILL[status.tone])}>{status.label}</span>
            {c.restartCount > 0 && (
              <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-label", c.restartCount >= 5 ? "bg-a-bad/12 text-a-bad" : "bg-a-wait/10 text-a-wait")} title={t("So oft hat Docker den Container neu gestartet")}>
                {t("{n}× neu gestartet", { n: c.restartCount })}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-label text-a-mut">
            <span className="min-w-0 truncate" title={c.image}>
              {c.image.replace(/:[^:/]+$/, "")}
              {tag && <span className="text-a-ink">:{tag}</span>}
            </span>
            {age && <span>{age}</span>}
            {up && <span>{t("läuft seit {time}", { time: up })}</span>}
            {c.ports.length > 0 && (
              <span className="min-w-0 [overflow-wrap:anywhere]" title={t("Ports (nur Anzeige)")}>
                {c.ports.join(" · ")}
              </span>
            )}
          </div>
        </div>
        <div className="col-start-2 flex items-start gap-3 md:col-start-auto">
          {c.state === "running" ? (
            <>
              <Metric label="CPU" value={formatCpu(c.cpuPercent)} history={c.cpuHistory} color="var(--a-acc)" title={t("CPU in % eines Kerns (echte Messpunkte seit dem Öffnen)")} />
              <Metric
                label="RAM"
                value={formatBytes(c.memBytes)}
                history={c.memHistory}
                color="var(--a-done)"
                title={c.memLimitBytes ? t("{used} von {limit} erlaubt", { used: formatBytes(c.memBytes), limit: formatBytes(c.memLimitBytes) }) : t("Arbeitsspeicher")}
              />
            </>
          ) : (
            <span className="min-w-0 text-left text-label text-a-mut md:w-[196px] md:text-right">{t("keine Messwerte (läuft nicht)")}</span>
          )}
          <span aria-hidden className={cn("mt-0.5 text-label text-a-mut transition-transform duration-150", open && "rotate-90")}>
            ▸
          </span>
        </div>
      </button>
      {open && (
        <div className="pl-[22px]">
          <ContainerLogView id={c.id} name={c.name} dozzleUrl={dozzleUrl} />
        </div>
      )}
    </li>
  );
}

export const LIGHT_CLASS: Record<ContainerLight, string> = { green: "bg-a-ok", yellow: "bg-a-wait", red: "bg-a-bad" };
export const LIGHT_WORD: Record<ContainerLight, string> = { green: t("läuft"), yellow: t("läuft mit Problem"), red: t("läuft nicht") };

export function bucketColor(b: ContainerBucket): string {
  return GROUP_COLOR[b.group] ?? "var(--a-teal)";
}

/** Kleine Ampel-Zahlen einer Gruppe („5 ● 1 ● 0 ●“), Farbe nur am Punkt, Zahl daneben. */
export function LightCounts({ lights }: { lights: Record<ContainerLight, number> }) {
  return (
    <span className="flex items-center gap-2 font-mono text-label tabular-nums text-a-mut">
      {(["green", "yellow", "red"] as const)
        .filter((l) => lights[l] > 0)
        .map((l) => (
          <span key={l} className="flex items-center gap-1" title={`${lights[l]} ${LIGHT_WORD[l]}`}>
            <span className={cn("h-2 w-2 rounded-sm", LIGHT_CLASS[l])} aria-hidden />
            {lights[l]}
          </span>
        ))}
    </span>
  );
}

/** Liste nach Gruppen (NyxOS, jedes andere Projekt einzeln) — jede Gruppe mit Pfeil
 * einzeln auf- und zuklappbar. Die Zeile eines Containers öffnet darunter seine Logs. */
export function ContainerGroups({
  containers,
  openGroups,
  onToggleGroup,
  focusId,
  dozzleUrl,
  now = Date.now(),
}: {
  containers: ContainerInfo[];
  openGroups: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  focusId?: string | null;
  dozzleUrl: string | null;
  now?: number;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const buckets = containerBuckets(containers);
  return (
    <div className="grid gap-2">
      {buckets.map((b) => {
        const open = openGroups.has(b.key);
        return (
          <section key={b.key} className="rounded-xl border border-a-line bg-a-p" aria-label={b.label} data-group={b.key}>
            <button
              type="button"
              onClick={() => onToggleGroup(b.key)}
              aria-expanded={open}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc"
            >
              <span aria-hidden className={cn("text-caption text-a-mut transition-transform duration-150", open && "rotate-90")}>
                ▸
              </span>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: bucketColor(b) }} aria-hidden />
              <span className="font-display text-headline font-medium text-a-ink">{b.label}</span>
              <span className="font-mono text-caption tabular-nums text-a-mut">
                {t("{running} von {total} laufen", { running: b.running, total: b.containers.length })}
              </span>
              {b.troubled > 0 && <span className="rounded-full bg-a-bad/12 px-2 py-0.5 text-label text-a-bad">{t("{n} gestört", { n: b.troubled })}</span>}
              <span className="ml-auto">
                <LightCounts lights={b.lights} />
              </span>
            </button>
            {open && (
              <ul className="grid gap-0.5 border-t border-a-line p-1.5">
                {b.containers.map((c) => (
                  <ContainerRow key={c.id} c={c} open={openId === c.id} focused={focusId === c.id} onToggle={() => setOpenId((o) => (o === c.id ? null : c.id))} dozzleUrl={dozzleUrl} now={now} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
