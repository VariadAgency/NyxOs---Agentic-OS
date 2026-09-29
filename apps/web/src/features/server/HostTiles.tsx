// „Maschine im Detail“ — gut gruppierte Karten statt eines Kachel-Teppichs: Prozessor (mit Kernen),
// Arbeitsspeicher (gestapelter Balken), Platten (Füllstand + Durchsatz), Druck, System, Netz und Ports.
// Die Temperatur steht nur als Kachel oben — und nur, wenn es Sensoren gibt („nicht verfügbar → weg“);
// der Grund steht in „Was NyxOS nicht sehen kann“. Karten mind. 360 px breit, nie gequetscht. Jede Farbe steht neben ihrem Wort; fehlt etwas, sagt die Karte das statt einer Zahl.
// Local mode (this computer, e.g. macOS without /proc): what the OS cannot report is left out — no row, no
// "not available", no container/Docker parts; a card without any data disappears.
import { locale, t, type HostInfo, type HostPressure } from "@nyxos/shared";
import type { ReactNode } from "react";
import { Sparkline } from "../../components/charts/Sparkline";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatDateTime } from "../../lib/format";
import { toneVar, type Tone } from "../../lib/tones";
import { isLoginError, useHostInfo, useHostLogin } from "./hostApi";
import { decimal, formatBytes } from "./serverView";

/** Dezimalzahl in der aktuellen Sprache („1,5“ / „1.5“). */
export const de = decimal;
const int = (n: number) => Math.round(n).toLocaleString(locale());

export function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t("{d} T {h} Std", { d, h });
  if (h > 0) return t("{h} Std {m} Min", { h, m });
  return t("{n} Min", { n: m });
}

export function formatRate(n: number | null): string {
  if (n === null) return t("misst …");
  return `${formatBytes(n)}/s`;
}

/** „1 Kern“ / „4 Kerne“. */
export const coresWord = (n: number) => (n === 1 ? t("1 Kern") : t("{n} Kerne", { n }));

/** Füllstand-Farbe: ruhig bis 75 %, gelb bis 90 %, dann rot. */
export function levelTone(pct: number, calm: Tone = "done"): Tone {
  return pct >= 90 ? "bad" : pct >= 75 ? "wait" : calm;
}

// ─────────────────────────────── Bausteine ───────────────────────────────

function DetailCard({ title, tone, testId, aside, children }: { title: string; tone: Tone; testId: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card className="grid min-w-0 content-start gap-3" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="flex min-w-0 items-center gap-2 font-display text-headline font-medium text-a-ink">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneVar(tone) }} aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        </h3>
        {aside && <span className="min-w-0 text-caption text-a-mut [overflow-wrap:anywhere]">{aside}</span>}
      </div>
      {children}
    </Card>
  );
}

function Bar({ pct, tone, label }: { pct: number | null; tone: Tone; label?: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-a-p3" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <span className="block h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: toneVar(tone) }} />
    </span>
  );
}

/** Zeile „Wort …… Wert“ (Wert rechts, tabular-nums). */
/** Überlauf: Passt „Beschriftung … Wert“ nicht in eine Zeile, rutscht der Wert rechtsbündig darunter;
 * lange Werte (Modellnamen, Pfade) brechen notfalls mitten im Wort um — nie über den Kartenrand. */
function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-callout" title={hint} data-row>
      <span className="min-w-0 text-a-mut [overflow-wrap:anywhere]">{label}</span>
      <span className="ml-auto min-w-0 max-w-full text-right tabular-nums text-a-ink [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-a-mut">{children}</span>;

interface Segment {
  label: string;
  value: number;
  tone: Tone;
}

/** Gestapelter Balken mit Legende darunter (Wort + Wert, Farbe nur am Punkt). */
function StackedBar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  return (
    <div className="grid gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-a-p3" role="img" aria-label={label}>
        {segments.map((s) => (
          <span key={s.label} className="h-full transition-[width] duration-500 ease-out" style={{ width: `${total > 0 ? Math.max(0, (s.value / total) * 100) : 0}%`, background: toneVar(s.tone) }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: toneVar(s.tone) }} aria-hidden />
            <span className="text-a-mut">{s.label}</span>
            <span className="tabular-nums text-a-ink">{formatBytes(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────── Karten ───────────────────────────────

function CpuCard({ h, local }: { h: HostInfo; local: boolean }) {
  // Local mode: a row whose value this OS never reports is left out (null stays null on macOS).
  const show = (v: unknown) => !local || (v !== null && v !== undefined);
  const rows = [h.load, h.processes.running, h.processes.threads, h.processes.forkRate, h.contextSwitchRate].some(show);
  const split = h.cpuSplit;
  const segs: Array<{ label: string; value: number; tone: Tone }> = split
    ? ([
        { label: t("Programme"), value: split.user, tone: "claude" },
        { label: t("System"), value: split.system, tone: "violet" },
        { label: t("wartet auf Platte"), value: split.iowait, tone: "wait" },
        { label: t("gestohlen (VM)"), value: split.steal, tone: "bad" },
      ] satisfies Array<{ label: string; value: number; tone: Tone }>).filter((s, i) => !local || i < 2 || s.value > 0) // this computer: disk wait/steal only when they occur (macOS has neither)
    : [];
  return (
    <DetailCard title={t("Prozessor")} tone="claude" testId="host-cpu" aside={[h.cores ? coresWord(h.cores) : null, h.cpuMHz ? `${de(h.cpuMHz / 1000, 2)} GHz` : null].filter(Boolean).join(" · ")}>
      <div className="grid gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="font-display text-title font-semibold tabular-nums" style={{ color: toneVar("claude") }}>
            {h.cpuPercent !== null ? `${de(h.cpuPercent)} %` : t("misst …")}
          </span>
          {h.cpuModel && <span className="ml-auto min-w-0 text-right text-caption text-a-mut [overflow-wrap:anywhere]">{h.cpuModel}</span>}
        </div>
        {split && (
          <>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-a-p3" role="img" aria-label={t("Aufteilung der CPU-Zeit")}>
              {segs.map((s) => (
                <span key={s.label} className="h-full" style={{ width: `${Math.max(0, s.value)}%`, background: toneVar(s.tone) }} />
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption">
              {segs.map((s) => (
                <li key={s.label} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: toneVar(s.tone) }} aria-hidden />
                  <span className="text-a-mut">{s.label}</span>
                  <span className="tabular-nums text-a-ink">{de(s.value)} %</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {h.cpuCores.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-4 gap-y-1.5" aria-label={t("Auslastung je Kern")}>
          {h.cpuCores.map((c) => (
            <li key={c.id} className="grid gap-0.5">
              <span className="flex items-baseline justify-between font-mono text-label">
                <span className="text-a-mut">{t("Kern {n}", { n: c.id })}</span>
                <span className="tabular-nums text-a-ink">{c.percent !== null ? `${Math.round(c.percent)} %` : "–"}</span>
              </span>
              <Bar pct={c.percent} tone={levelTone(c.percent ?? 0, "claude")} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-a-mut">{t("Kerne: zweiter Messpunkt folgt in 10 s.")}</p>
      )}
      {rows && (
        <div className="grid gap-1 border-t border-a-line pt-2">
          {show(h.load) && (
            <Row label={t("Last 1 / 5 / 15 Min")} hint={h.cores ? t("voll ausgelastet bei {n}", { n: de(h.cores) }) : undefined}>
              {h.load ? h.load.map((x) => de(x, 2)).join(" · ") : <Muted>{t("nicht verfügbar")}</Muted>}
            </Row>
          )}
          {show(h.processes.running) && <Row label={t("Prozesse laufen / warten")}>{h.processes.running !== null ? `${h.processes.running} / ${h.processes.blocked ?? 0}` : <Muted>–</Muted>}</Row>}
          {show(h.processes.threads) && <Row label={t("Threads gesamt")}>{h.processes.threads !== null ? int(h.processes.threads) : <Muted>–</Muted>}</Row>}
          {show(h.processes.forkRate) && (
            <Row label={t("Neue Prozesse")} hint={t("Wie viele Prozesse pro Sekunde gestartet werden")}>
              {h.processes.forkRate !== null ? `${int(h.processes.forkRate)} /s` : <Muted>{t("misst …")}</Muted>}
            </Row>
          )}
          {show(h.contextSwitchRate) && (
            <Row label={t("Kontextwechsel")} hint={t("Wie oft die CPU pro Sekunde zwischen Aufgaben wechselt")}>
              {h.contextSwitchRate !== null ? `${int(h.contextSwitchRate)} /s` : <Muted>{t("misst …")}</Muted>}
            </Row>
          )}
        </div>
      )}
    </DetailCard>
  );
}

function MemCard({ h, local }: { h: HostInfo; local: boolean }) {
  const show = (v: unknown) => !local || (v !== null && v !== undefined);
  const total = h.memTotal;
  const d = h.memDetail;
  const swapUsed = h.swapTotal !== null && h.swapFree !== null ? h.swapTotal - h.swapFree : null;
  const cache = d ? d.buffers + d.cached + d.reclaimable : null;
  const apps = total !== null && d && cache !== null ? Math.max(0, total - d.free - cache) : null;
  const usedPct = total && h.memAvailable !== null ? ((total - h.memAvailable) / total) * 100 : null;
  return (
    <DetailCard title={t("Arbeitsspeicher")} tone="indigo" testId="host-mem" aside={total !== null ? t("{size} gesamt", { size: formatBytes(total) }) : undefined}>
      {total !== null && d && apps !== null && cache !== null ? (
        <StackedBar
          label={t("Aufteilung des Arbeitsspeichers")}
          total={total}
          segments={[
            { label: t("Programme"), value: apps, tone: "indigo" },
            { label: t("Cache & Puffer"), value: cache, tone: "teal" },
            { label: t("frei"), value: d.free, tone: "mut" },
          ]}
        />
      ) : usedPct !== null ? (
        <Bar pct={usedPct} tone="indigo" />
      ) : local ? null : (
        <p className="text-callout text-a-mut">{t("nicht verfügbar")}</p>
      )}
      <div className="grid gap-1">
        {show(h.memAvailable) && (
          <Row label={t("Sofort verfügbar")} hint={t("Frei + Cache, den der Kernel sofort hergeben kann")}>
            {h.memAvailable !== null ? formatBytes(h.memAvailable) : <Muted>–</Muted>}
            {usedPct !== null && <span className="text-a-mut"> · {t("{n} % belegt", { n: Math.round(usedPct) })}</span>}
          </Row>
        )}
        {d && <Row label={t("Geteilt (tmpfs)")}>{formatBytes(d.shmem)}</Row>}
        {d && <Row label={t("Noch nicht geschrieben")} hint={t("Dirty: Daten, die noch auf die Platte müssen")}>{formatBytes(d.dirty)}</Row>}
      </div>
      <div className="grid gap-1 border-t border-a-line pt-2">
        <Row label={t("Auslagerung (Swap)")}>{h.swapTotal ? t("{used} von {total}", { used: formatBytes(swapUsed), total: formatBytes(h.swapTotal) }) : <Muted>{t("kein Swap eingerichtet")}</Muted>}</Row>
        {!!h.swapTotal && <Bar pct={swapUsed !== null && h.swapTotal ? (swapUsed / h.swapTotal) * 100 : null} tone="gold" />}
        {/* Swap activity needs a second measurement: locally it appears once it is there, instead of "measuring …". */}
        {show(h.swapInRate) && <Row label={t("Swap rein / raus")}>{h.swapInRate !== null ? `${formatRate(h.swapInRate)} / ${formatRate(h.swapOutRate)}` : <Muted>{t("misst …")}</Muted>}</Row>}
        {show(h.oomKills) && (
          <Row label={t("Wegen Speichermangel beendet")} hint={t("OOM-Kills seit dem letzten Neustart")}>
            {h.oomKills !== null ? <span style={{ color: h.oomKills > 0 ? toneVar("bad") : undefined }}>{h.oomKills === 0 ? t("nie") : `${int(h.oomKills)}×`}</span> : <Muted>–</Muted>}
          </Row>
        )}
      </div>
    </DetailCard>
  );
}

function DiskCard({ h, local }: { h: HostInfo; local: boolean }) {
  const ioSeries = h.history.map((p) => (p.diskRead ?? 0) + (p.diskWrite ?? 0));
  if (local && h.disks.length === 0 && h.diskIo.length === 0) return null;
  return (
    <DetailCard title={t("Platten")} tone="done" testId="host-disks">
      {h.disks.length === 0 ? (
        local ? null : <p className="text-callout text-a-mut">{t("Kein Ordner des Servers eingehängt.")}</p>
      ) : (
        <ul className="grid gap-3">
          {h.disks.map((d) => {
            const pct = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
            const tone = levelTone(pct);
            const inodePct = d.inodesTotal && d.inodesUsed !== null ? (d.inodesUsed / d.inodesTotal) * 100 : null;
            return (
              <li key={d.label} className="grid gap-1">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-callout">
                  <span className="min-w-0 font-mono text-a-ink [overflow-wrap:anywhere]">{d.label}</span>
                  <span className="ml-auto min-w-0 text-right tabular-nums text-a-mut [overflow-wrap:anywhere]">
                    <span style={{ color: toneVar(tone) }}>{Math.round(pct)} %</span> · {t("{free} frei von {total}", { free: formatBytes(d.freeBytes), total: formatBytes(d.totalBytes) })}
                  </span>
                </div>
                <Bar pct={pct} tone={tone} />
                {inodePct !== null && inodePct >= 50 && <span className="text-caption text-a-mut">{t("Datei-Einträge (Inodes) {n} % belegt", { n: Math.round(inodePct) })}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {(!local || h.diskIo.length > 0) && (
      <div className="grid gap-2 border-t border-a-line pt-2">
        <span className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Durchsatz")}</span>
        {h.diskIo.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Keine Platten-Zähler lesbar.")}</p>
        ) : (
          <ul className="grid gap-2">
            {h.diskIo.map((d) => (
              <li key={d.device} className="grid gap-1">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-callout">
                  <span className="font-mono text-a-ink">{d.device}</span>
                  <span className="ml-auto min-w-0 text-right tabular-nums text-a-mut [overflow-wrap:anywhere]">
                    {t("lesen")} <span className="text-a-ink">{formatRate(d.readRate)}</span> · {t("schreiben")} <span className="text-a-ink">{formatRate(d.writeRate)}</span>
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-3 font-mono text-label tabular-nums text-a-mut">
                  <span>{d.readIops !== null ? t("{read} / {write} Vorgänge/s", { read: de(d.readIops), write: de(d.writeIops ?? 0) }) : t("misst …")}</span>
                  <span>{d.busyPercent !== null ? t("{n} % beschäftigt", { n: Math.round(d.busyPercent) }) : ""}</span>
                </div>
                <Bar pct={d.busyPercent} tone={levelTone(d.busyPercent ?? 0, "done")} />
              </li>
            ))}
          </ul>
        )}
        {ioSeries.filter((v) => v > 0).length >= 3 && (
          <div className="grid gap-0.5">
            <Sparkline values={ioSeries} height={28} color={toneVar("done")} label={t("Platten-Durchsatz, letzte {n} Min", { n: Math.round((ioSeries.length * 10) / 60) })} />
            <span className="text-caption text-a-mut">{t("Durchsatz aller Platten, letzte {n} Min", { n: Math.max(1, Math.round((ioSeries.length * 10) / 60)) })}</span>
          </div>
        )}
      </div>
      )}
    </DetailCard>
  );
}

/** Druck in einfachen Worten: < 1 % entspannt, < 10 % spürbar, sonst hoch. */
export function pressureWord(p: HostPressure): { word: string; tone: Tone } {
  if (p.some10 < 1) return { word: t("entspannt"), tone: "ok" };
  if (p.some10 < 10) return { word: t("spürbar"), tone: "wait" };
  return { word: t("hoch"), tone: "bad" };
}

function PressureCard({ h, local }: { h: HostInfo; local: boolean }) {
  const rows: Array<[string, HostPressure | null]> = [
    ["CPU", h.pressure.cpu],
    [t("Speicher"), h.pressure.memory],
    [t("Platte"), h.pressure.io],
  ];
  if (local && rows.every(([, p]) => p === null)) return null;
  return (
    <DetailCard title={t("Engpässe (Druck)")} tone="conf" testId="host-pressure">
      <p className="text-caption leading-5 text-a-mut">{t("Wie oft Programme in den letzten 10 s warten mussten, weil CPU, Speicher oder Platte gerade voll waren.")}</p>
      <ul className="grid gap-2">
        {rows.map(([label, p]) => {
          const w = p ? pressureWord(p) : null;
          return (
            <li key={label} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-2 text-callout">
                <span className="text-a-ink">{label}</span>
                {p && w ? (
                  <span className="tabular-nums text-a-mut">
                    <span style={{ color: toneVar(w.tone) }}>{w.word}</span> · {de(p.some10)} % <span className="text-caption">({t("1 Min: {n} %", { n: de(p.some60) })})</span>
                  </span>
                ) : (
                  <Muted>{t("nicht gemeldet")}</Muted>
                )}
              </div>
              <Bar pct={p ? Math.min(100, p.some10 * 4) : null} tone={w?.tone ?? "mut"} />
            </li>
          );
        })}
      </ul>
    </DetailCard>
  );
}

function SystemCard({ h, local }: { h: HostInfo; local: boolean }) {
  const v = h.virtualization;
  const show = (x: unknown) => !local || (x !== null && x !== undefined);
  const dockerVersion = h.docker?.version ?? h.dockerVersion;
  return (
    <DetailCard title={t("System")} tone="acc" testId="host-system">
      <div className="grid gap-1">
        <Row label={t("Name")}>{h.hostname ?? <Muted>–</Muted>}</Row>
        {show(h.os) && <Row label={t("Betriebssystem")}>{h.os ?? <Muted>{t("nicht eingehängt")}</Muted>}</Row>}
        {show(h.kernel) && <Row label="Kernel">{h.kernel ?? <Muted>–</Muted>}</Row>}
        {show(v) && <Row label={t("Maschine")}>{v ? v.label : <Muted>{t("unbekannt")}</Muted>}</Row>}
        {v && (v.vendor || v.product) && <Row label={t("Hersteller / Modell")}>{[v.vendor, v.product].filter(Boolean).join(" · ")}</Row>}
        <Row label={t("Läuft seit")}>{h.uptimeSeconds !== null ? formatDuration(h.uptimeSeconds) : <Muted>–</Muted>}</Row>
        <Row label={t("Letzter Neustart")}>{h.bootedAt ? formatDateTime(h.bootedAt) : <Muted>–</Muted>}</Row>
        {show(h.openFiles) && <Row label={t("Offene Dateien")}>{h.openFiles ? int(h.openFiles.used) : <Muted>–</Muted>}</Row>}
      </div>
      {/* Docker is part of server mode; on this computer it shows only when NyxOS actually reaches it. */}
      {(!local || dockerVersion) && (
        <div className="grid gap-1 border-t border-a-line pt-2">
          <Row label="Docker">{dockerVersion ?? <Muted>{t("nicht erreichbar")}</Muted>}</Row>
          {h.docker?.images !== null && h.docker?.images !== undefined && <Row label="Images">{int(h.docker.images)}</Row>}
          {h.docker?.storageDriver && <Row label={t("Speicher-Treiber")}>{h.docker.storageDriver}</Row>}
          {h.docker?.architecture && <Row label={t("Architektur")}>{h.docker.architecture}</Row>}
        </div>
      )}
    </DetailCard>
  );
}

function PortList({ h }: { h: HostInfo }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-caption text-a-mut">{t("Veröffentlichte Ports der Container (Dienste direkt auf dem Server, z. B. SSH, stehen hier nicht):")}</span>
      <ul className="flex flex-wrap gap-1.5">
        {h.ports.map((p) => (
          <li
            key={`${p.container}-${p.proto}-${p.port}-${p.bind}`}
            className="max-w-full rounded-md border border-a-line px-2 py-0.5 font-mono text-caption tabular-nums text-a-ink [overflow-wrap:anywhere]"
            title={`${p.container}: ${p.port} → ${p.target}/${p.proto} · ${p.bind === "alle" ? t("von außen erreichbar (sofern die Firewall es zulässt)") : t("nur auf dem Server selbst")}`}
          >
            {p.port}
            <span className={p.bind === "alle" ? "text-a-wait" : "text-a-mut"}> · {p.bind === "alle" ? t("alle") : p.bind === "lokal" ? t("lokal") : p.bind}</span>
            <span className="text-a-mut"> · {p.container}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NetCard({ h, local }: { h: HostInfo; local: boolean }) {
  const mainNet = h.network.find((n) => /^(eth|en|eno|ens|enp)/.test(n.iface)) ?? h.network[0] ?? null;
  if (local) {
    // This computer: its own network, no container in between; published ports only if Docker is there.
    if (!mainNet && h.ports.length === 0) return null;
    return (
      <DetailCard title={h.ports.length > 0 ? t("Netz & Ports") : t("Netz")} tone="lime" testId="host-ports">
        {mainNet && (
          <Row label={`${t("Netz")} (${mainNet.iface})`}>
            ↓ {formatRate(mainNet.rxRate)} · ↑ {formatRate(mainNet.txRate)}
          </Row>
        )}
        {h.ports.length > 0 && <PortList h={h} />}
      </DetailCard>
    );
  }
  return (
    <DetailCard title={t("Netz & Ports")} tone="lime" testId="host-ports">
      <Row label={`${t("Netz · NyxOS-Container")}${mainNet ? ` (${mainNet.iface})` : ""}`} hint={t("Das Netz des Servers selbst ist aus dem Container nicht sichtbar")}>
        {mainNet ? `↓ ${formatRate(mainNet.rxRate)} · ↑ ${formatRate(mainNet.txRate)}` : <Muted>{t("nicht verfügbar")}</Muted>}
      </Row>
      {h.ports.length > 0 ? (
        <PortList h={h} />
      ) : (
        <p className="text-caption text-a-mut">{t("Keine veröffentlichten Ports bekannt.")}</p>
      )}
    </DetailCard>
  );
}

/** Login-/Fehler-Zustand der Host-Daten (gleich für Überblick und Detail). */
export function HostUnavailable({ error }: { error: unknown }) {
  const login = useHostLogin();
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2 text-callout text-a-mut">
      <span>{isLoginError(error) ? t("CPU, Speicher, Platten und Temperatur siehst du nach der Anmeldung.") : t("Die Server-Daten sind gerade nicht lesbar.")}</span>
      {isLoginError(error) && (
        <button type="button" onClick={login} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Anmelden")}
        </button>
      )}
    </Card>
  );
}

/** „Maschine im Detail“: gruppierte Karten, darunter ehrlich, was fehlt. */
export function HostSection({ local = false }: { local?: boolean }) {
  const { data, isLoading, error } = useHostInfo();
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <HostUnavailable error={error} />;
  return (
    <div className="grid gap-3">
      {/* Detail cards side by side differ in length – each is as tall as its content (`items-start`) instead of up to
          90 px of empty space at the bottom of the shorter card. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] items-start gap-3" data-testid="host-details">
        <CpuCard h={data} local={local} />
        <MemCard h={data} local={local} />
        <DiskCard h={data} local={local} />
        <PressureCard h={data} local={local} />
        <SystemCard h={data} local={local} />
        <NetCard h={data} local={local} />
      </div>
      {data.missing.length > 0 && (
        <details className="text-caption text-a-mut" data-testid="host-missing">
          <summary className="cursor-pointer select-none hover:text-a-ink">{t("Was NyxOS nicht sehen kann ({n})", { n: data.missing.length })}</summary>
          <ul className="mt-1 grid gap-0.5 pl-3">
            {data.missing.map((m) => (
              <li key={m}>· {m}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
