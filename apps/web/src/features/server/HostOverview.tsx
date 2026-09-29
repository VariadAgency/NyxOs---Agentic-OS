// „Auf einen Blick“ — ganz oben ein Kachel-Raster im Stil der Maschinen-Kacheln: farbiger Punkt + Wort, große farbige Zahl, Balken, kleine Unterzeile. Nur Kacheln mit echten
// Daten — die Temperatur erscheint nur, wenn der Server Sensoren meldet. Die Anzahl ist immer gerade, und ab
// 1440 px stehen genau zwei volle Reihen (Spalten = Anzahl / 2), darunter füllt sich das Raster automatisch.
import { locale, t, type HostInfo, type HostPressure, type ServerSnapshot } from "@nyxos/shared";
import type { CSSProperties, ReactNode } from "react";
import { Sparkline } from "../../components/charts/Sparkline";
import { Card } from "../../components/ui/Card";
import { formatDateTime } from "../../lib/format";
import { toneVar, type Tone } from "../../lib/tones";
import { coresWord, de, formatDuration, formatRate, levelTone, pressureWord } from "./HostTiles";
import { formatBytes, isSteadyRunning, isTroubled } from "./serverView";

/** „3 gestoppt oder nie gestartet · 1 startet ständig neu“ — die Summe passt immer zu „läuft / alle“. */
export function containersCaption(list: ServerSnapshot["containers"], short = false): string {
  const looping = list.filter((c) => c.restartLoop || c.state === "restarting").length;
  const stopped = list.length - list.filter(isSteadyRunning).length - looping;
  if (stopped === 0 && looping === 0) return t("alle laufen");
  const s = short ? t("{n} gestoppt", { n: stopped }) : t("{n} gestoppt oder nie gestartet", { n: stopped });
  return looping > 0 ? `${s} · ${short ? t("{n} Neustart-Schleife", { n: looping }) : t("{n} startet ständig neu", { n: looping })}` : s;
}

const TROUBLED_SHOWN = 3;
/** Geschütztes Leerzeichen: „21 %“ bricht nie zwischen Zahl und Einheit um. */
const NBSP = " ";

/** Gestörte Container als kurze Liste: je Name eine Zeile mit Ellipse, der volle Text im Tooltip. */
function TroubledNames({ list }: { list: ServerSnapshot["containers"] }) {
  const shown = list.slice(0, TROUBLED_SHOWN);
  return (
    <ul className="grid min-w-0 gap-0.5">
      {shown.map((c) => {
        const why = c.restartLoop || c.state === "restarting" ? t("startet ständig neu") : c.health === "unhealthy" ? t("ungesund") : c.state;
        return (
          <li key={c.id} className="truncate font-mono text-label" title={`${c.name} · ${why}`}>
            {c.name}
          </li>
        );
      })}
      {list.length > TROUBLED_SHOWN && <li className="text-label">{t("+ {n} weitere", { n: list.length - TROUBLED_SHOWN })}</li>}
    </ul>
  );
}

interface TileSpec {
  key: string;
  label: string;
  tone: Tone;
  value: ReactNode;
  caption?: ReactNode;
  bar?: number | null;
  spark?: number[];
  testId?: string;
}

/** „Ubuntu 24.04.4 LTS“ → „Ubuntu 24.04“ (die volle Bezeichnung steht in der Unterzeile). */
export function shortOs(os: string): string {
  const m = /^(.+?)\s+(\d+)(?:\.(\d+))?/.exec(os);
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : os;
}

/** Überlauf: Kopf und Wert brechen bei Platzmangel um (nie abgeschnitten, nie über den Rand); die Kacheln
 * haben darum kurze Beschriftungen („Netz“, „Swap“, „Last“) und kurze Werte. */
function Tile({ tile }: { tile: TileSpec }) {
  const color = toneVar(tile.tone);
  const spark = tile.spark && tile.spark.filter((v) => v > 0).length >= 3 ? tile.spark : null;
  return (
    <Card className="grid min-w-0 content-start gap-1.5" data-tile={tile.key} data-testid={tile.testId} data-equal-row="">
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-label uppercase tracking-wider text-a-mut">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]" data-tile-label>
          {tile.label}
        </span>
      </span>
      <span className="min-w-0 font-display text-title2 font-semibold leading-tight tabular-nums [overflow-wrap:anywhere]" style={{ color }} data-tile-value>
        {tile.value}
      </span>
      {tile.bar !== undefined && (
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-a-p3" aria-hidden>
          <span className="block h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(100, tile.bar ?? 0))}%`, background: color }} />
        </span>
      )}
      {spark && <Sparkline values={spark} height={18} color={color} />}
      <div className="min-h-[1.25rem] min-w-0 text-caption leading-5 text-pretty text-a-mut [overflow-wrap:anywhere]">{tile.caption}</div>
    </Card>
  );
}

const na = () => <span className="text-a-mut">{t("nicht verfügbar")}</span>;

function worstPressure(h: HostInfo): { label: string; p: HostPressure } | null {
  const all: Array<[string, HostPressure | null]> = [
    ["CPU", h.pressure.cpu],
    [t("Speicher"), h.pressure.memory],
    [t("Platte"), h.pressure.io],
  ];
  let worst: { label: string; p: HostPressure } | null = null;
  for (const [label, p] of all) if (p && (!worst || p.some10 > worst.p.some10)) worst = { label, p };
  return worst;
}

/** Baut die Kacheln aus echten Daten. Ungerade Anzahl → eine Zusatz-Kachel (Docker, offene Dateien) oder die unwichtigste fällt weg.
 * Local mode (this computer): container tiles only when a Docker read access is actually there. */
export function buildTiles(h: HostInfo | undefined, snap: ServerSnapshot, local = false): TileSpec[] {
  const tiles: TileSpec[] = [];
  const steady = snap.containers.filter(isSteadyRunning);
  const troubled = snap.containers.filter(isTroubled);
  const containerTiles: TileSpec[] = [
    { key: "containers", label: t("Container"), tone: "lime", value: `${steady.length} / ${snap.containers.length}`, caption: containersCaption(snap.containers, true) },
    {
      key: "troubled",
      label: t("Gestört"),
      tone: troubled.length > 0 ? "bad" : "ok",
      value: String(troubled.length),
      caption: troubled.length === 0 ? t("alles gesund") : <TroubledNames list={troubled} />,
    },
  ];
  const shownContainerTiles = local && !snap.docker.available ? [] : containerTiles;
  if (!h) return shownContainerTiles;

  const hist = (k: "cpu" | "memUsed" | "load1") => h.history.map((p) => p[k] ?? 0);
  const memUsed = h.memTotal !== null && h.memAvailable !== null ? h.memTotal - h.memAvailable : null;
  const memPct = memUsed !== null && h.memTotal ? (memUsed / h.memTotal) * 100 : null;
  const swapUsed = h.swapTotal !== null && h.swapFree !== null ? h.swapTotal - h.swapFree : null;
  const fullest = h.disks.reduce<HostInfo["disks"][number] | null>((m, d) => (!m || d.usedBytes / d.totalBytes > m.usedBytes / m.totalBytes ? d : m), null);
  const diskPct = fullest && fullest.totalBytes > 0 ? (fullest.usedBytes / fullest.totalBytes) * 100 : null;
  const io = h.diskIo;
  const ioRead = io.some((d) => d.readRate !== null) ? io.reduce((s, d) => s + (d.readRate ?? 0), 0) : null;
  const ioWrite = io.some((d) => d.writeRate !== null) ? io.reduce((s, d) => s + (d.writeRate ?? 0), 0) : null;
  const ioBusy = io.reduce<number | null>((m, d) => (d.busyPercent !== null && (m === null || d.busyPercent > m) ? d.busyPercent : m), null);
  const mainNet = h.network.find((n) => /^(eth|en|eno|ens|enp)/.test(n.iface)) ?? h.network[0] ?? null;
  const worst = worstPressure(h);
  const hottest = h.temperatures.reduce<number | null>((m, t) => (m === null || t.celsius > m ? t.celsius : m), null);
  const loadPct = h.load && h.cores ? (h.load[0] / h.cores) * 100 : null;

  tiles.push({
    key: "cpu",
    label: "CPU",
    tone: "claude",
    value: h.cpuPercent !== null ? `${de(h.cpuPercent)} %` : t("misst …"),
    bar: h.cpuPercent,
    spark: hist("cpu"),
    caption: [h.cores ? coresWord(h.cores) : null, h.cpuSplit && h.cpuSplit.steal >= 1 ? t("{n} % gestohlen", { n: de(h.cpuSplit.steal) }) : h.cpuModel].filter(Boolean).join(" · "),
  });
  if (h.load)
    tiles.push({ key: "load", label: t("Last"), tone: "violet", value: de(h.load[0], 2), bar: loadPct, spark: hist("load1"), caption: `${t("5 Min {n}", { n: de(h.load[1], 2) })} · ${t("15 Min {n}", { n: de(h.load[2], 2) })}${h.cores ? ` · ${t("voll bei {n}", { n: h.cores })}` : ""}` });
  if (h.memTotal !== null) tiles.push({ key: "mem", label: "RAM", tone: "indigo", value: memUsed !== null ? formatBytes(memUsed) : na(), bar: memPct, spark: hist("memUsed"), caption: `${t("von {total} belegt", { total: formatBytes(h.memTotal) })}${memPct !== null ? ` · ${Math.round(memPct)} %` : ""}` });
  tiles.push({
    key: "swap",
    label: "Swap",
    tone: "gold",
    value: h.swapTotal ? formatBytes(swapUsed) : t("keine"),
    bar: h.swapTotal && swapUsed !== null ? (swapUsed / h.swapTotal) * 100 : undefined,
    caption: h.swapTotal ? `${t("von {total}", { total: formatBytes(h.swapTotal) })}${h.swapInRate !== null ? ` · ${t("rein {rate}", { rate: formatRate(h.swapInRate) })}` : ""}` : t("kein Swap eingerichtet"),
  });
  if (h.uptimeSeconds !== null) tiles.push({ key: "uptime", label: t("Läuft seit"), tone: "ok", value: formatDuration(h.uptimeSeconds), caption: h.bootedAt ? t("letzter Neustart {time}", { time: formatDateTime(h.bootedAt) }) : undefined });
  if (fullest && diskPct !== null) tiles.push({ key: "disk", label: t("Platte"), tone: levelTone(diskPct), value: `${Math.round(diskPct)} %`, bar: diskPct, caption: `${t("{size} frei", { size: formatBytes(fullest.freeBytes) })} · ${fullest.label}` });
  if (io.length > 0)
    tiles.push({
      key: "diskio",
      label: t("Platten-IO"),
      tone: "done",
      value: ioRead !== null ? `↓ ${formatRate(ioRead)}` : t("misst …"),
      bar: ioBusy,
      caption: ioWrite !== null ? `↑ ${t("{rate} schreiben", { rate: formatRate(ioWrite) })}${ioBusy !== null ? ` · ${t("{n} beschäftigt", { n: `${Math.round(ioBusy)}${NBSP}%` })}` : ""}` : t("zweiter Messpunkt folgt in 10 s"),
    });
  if (mainNet) tiles.push({ key: "net", label: t("Netz"), tone: "teal", value: `↓ ${formatRate(mainNet.rxRate)}`, caption: `↑ ${formatRate(mainNet.txRate)} · ${local ? mainNet.iface : t("nur NyxOS-Container ({iface})", { iface: mainNet.iface })}` });
  if (h.processes.running !== null)
    tiles.push({
      key: "procs",
      label: t("Prozesse"),
      tone: "acc",
      value: t("{n} laufen", { n: h.processes.running }),
      caption: [
        h.processes.threads !== null ? t("{n} Threads", { n: h.processes.threads.toLocaleString(locale()) }) : null,
        t("{n} warten", { n: h.processes.blocked ?? 0 }),
        h.contextSwitchRate !== null ? t("{n} Wechsel/s", { n: Math.round(h.contextSwitchRate).toLocaleString(locale()) }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  if (worst) {
    const w = pressureWord(worst.p);
    tiles.push({
      key: "pressure",
      label: t("Engpässe"),
      tone: w.tone,
      value: w.word,
      bar: Math.min(100, worst.p.some10 * 4),
      caption: [["CPU", h.pressure.cpu], [t("Speicher"), h.pressure.memory], [t("Platte"), h.pressure.io]]
        .filter((x): x is [string, HostPressure] => x[1] !== null)
        .map(([l, p]) => `${l}${NBSP}${de(p.some10)}${NBSP}%`)
        .join(" · "),
    });
  }
  tiles.push(...shownContainerTiles);
  tiles.push({
    key: "system",
    label: t("System"),
    tone: "acc",
    value: h.os ? shortOs(h.os) : local ? (h.hostname ?? "–") : "Linux",
    caption: [h.kernel ? `Kernel ${h.kernel}` : null, h.virtualization?.isVirtual ? "VM" : null].filter(Boolean).join(" · "),
  });
  if (hottest !== null)
    tiles.push({
      key: "temp",
      label: t("Temperatur"),
      tone: hottest >= 85 ? "bad" : hottest >= 70 ? "wait" : "temp",
      value: `${de(hottest)} °C`,
      caption: h.temperatures.slice(0, 3).map((x) => `${x.label} ${de(x.celsius)} °C`).join(" · "),
      testId: "host-temp",
    });

  // Gerade Anzahl → zwei volle Reihen.
  const fillers: TileSpec[] = [];
  if (h.docker?.version) fillers.push({ key: "docker", label: "Docker", tone: "conf", value: h.docker.version, caption: [h.docker.images !== null ? t("{n} Images", { n: h.docker.images }) : null, h.docker.storageDriver, h.docker.architecture].filter(Boolean).join(" · ") });
  if (h.openFiles) fillers.push({ key: "files", label: t("Offene Dateien"), tone: "mut", value: h.openFiles.used.toLocaleString(locale()), caption: local ? t("auf diesem Rechner") : t("vom ganzen Server") });
  if (tiles.length % 2 === 1) {
    const extra = fillers[0];
    if (extra) tiles.push(extra);
    else {
      const i = tiles.findIndex((t) => t.key === "swap" && !h.swapTotal);
      tiles.splice(i >= 0 ? i : tiles.length - 1, 1);
    }
  }
  return tiles;
}

export function HostOverview({ host, snapshot, local = false }: { host: HostInfo | undefined; snapshot: ServerSnapshot; local?: boolean }) {
  const tiles = buildTiles(host, snapshot, local);
  const cols = Math.max(1, Math.ceil(tiles.length / 2));
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3 min-[1440px]:grid-cols-[repeat(var(--cols),minmax(0,1fr))]"
      style={{ "--cols": String(cols) } as CSSProperties}
      data-testid="host-tiles"
    >
      {tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} />
      ))}
    </div>
  );
}
