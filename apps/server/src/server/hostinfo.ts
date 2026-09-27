// Host-Daten für den Server-Tab — nur Lesen aus /proc und /sys, nie ein Befehl.
// Im Container sind /proc/{loadavg,meminfo,uptime,stat,cpuinfo} und /sys schon die des Hosts (ohne lxcfs kein
// eigener Namensraum dafür). Netz ist je Container getrennt: /proc/net/dev zeigt nur den NyxOS-Container.
// /proc des Hosts wird bewusst NICHT eingehängt (als uid 1000 wären /proc/<pid>/environ und
// /proc/<pid>/root der Host-Prozesse des Nutzers lesbar). Ports kommen darum aus Docker (veröffentlichte Ports
// laufender Container, s. docker.ts `publishedPorts`). Fehlt etwas, steht ein Satz in `missing` — nie eine
// erfundene Zahl.
// dazu je Kern, Platten-IO, vmstat, Druck (PSI), Prozesse, Maschine (VM?) und ein Verlauf (hoststats.ts).
// Local mode (`local` option, NyxOS on the user's own computer): Linux reads the same /proc files (they are the
// computer's own, network included); macOS has no /proc and uses os.* plus a few read-only tools (hostlocal.ts).
// Container, Docker and "network of the NyxOS container" notes are server mode only.
import { HOST_HISTORY_POINTS, t, type HostCpuSplit, type HostDisk, type HostDiskIo, type HostDockerInfo, type HostInfo, type HostListenPort, type HostNetwork, type HostProbe, type HostTemperature } from "@nyxos/shared";
import { readdir, readFile, statfs } from "node:fs/promises";
import { homedir, hostname, release } from "node:os";
import { join } from "node:path";
import { cpuStatFromCpus, localHostOptions, MAC_TOOLS, macMemAvailable, parseMacVmStat, parseNetstatIb, parseSwapUsage, parseSysctl, readMacOsName, type LocalHostOptions, type MacVmStat } from "./hostlocal.js";
import { cpuUsageBetween, diskIoBetween, HostHistory, parseCpuMHz, parseCpuStat, parseDiskstats, parseFileNr, parseMemDetail, parsePressure, parseVirtualization, parseVmstat, type CpuStat, type DiskCounters, type VmstatCounters } from "./hoststats.js";

const read = (p: string): Promise<string | null> => readFile(p, "utf8").catch(() => null);

export function parseMeminfo(text: string): { memTotal: number | null; memAvailable: number | null; swapTotal: number | null; swapFree: number | null } {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m?.[1] ? Number(m[1]) * 1024 : null;
  };
  return { memTotal: kb("MemTotal"), memAvailable: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

/** Schnittstellen aus /proc/net/dev (ohne lo und Docker-interne veth/br-). */
export function parseNetDev(text: string): Array<{ iface: string; rxBytes: number; txBytes: number }> {
  const out: Array<{ iface: string; rxBytes: number; txBytes: number }> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    const iface = m[1];
    if (iface === "lo" || iface.startsWith("veth") || iface.startsWith("br-") || iface === "docker0") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    out.push({ iface, rxBytes: f[0] ?? 0, txBytes: f[8] ?? 0 });
  }
  return out;
}

/** Temperaturen aus hwmon (mit Beschriftung) und thermal_zone. Keine Sensoren (VM) → leere Liste. */
export async function readTemperatures(sysDir: string): Promise<HostTemperature[]> {
  const out: HostTemperature[] = [];
  const hwmonDir = join(sysDir, "class", "hwmon");
  for (const h of (await readdir(hwmonDir).catch(() => [] as string[])).sort()) {
    const dir = join(hwmonDir, h);
    const name = (await read(join(dir, "name")))?.trim() ?? h;
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^temp\d+_input$/.test(f)).sort();
    for (const f of files) {
      const v = Number((await read(join(dir, f)))?.trim());
      if (!Number.isFinite(v) || v <= 0) continue;
      const label = (await read(join(dir, f.replace("_input", "_label"))))?.trim();
      out.push({ label: label ? `${name} · ${label}` : name, celsius: Math.round(v / 100) / 10 });
    }
  }
  const thermalDir = join(sysDir, "class", "thermal");
  for (const z of (await readdir(thermalDir).catch(() => [] as string[])).filter((d) => d.startsWith("thermal_zone")).sort()) {
    const v = Number((await read(join(thermalDir, z, "temp")))?.trim());
    if (!Number.isFinite(v) || v <= 0) continue;
    const type = (await read(join(thermalDir, z, "type")))?.trim() ?? z;
    out.push({ label: type, celsius: Math.round(v / 100) / 10 });
  }
  return out;
}

export interface HostInfoOptions {
  procDir: string;
  sysDir: string;
  osReleasePath: string;
  /** /etc/hostname des Hosts (im Container ist os.hostname() nur die Container-ID), null = nicht eingehängt. */
  hostnamePath?: string | null;
  /** Platten: je ein Pfad im Container, der auf der jeweiligen Host-Platte liegt. */
  disks: Array<{ label: string; path: string }>;
  now?: () => number;
  /** Local mode (the user's own Mac or Linux computer). Absent = server mode (container on a Linux server). */
  local?: LocalHostOptions;
}

/** Local mode: this computer's /proc (Linux) or os.* + system tools (macOS); disks = the NyxOS data folder and the home folder. */
export function localHostInfoOptions(dataDir: string, local: LocalHostOptions = localHostOptions(), homeDir: string = homedir()): HostInfoOptions {
  return {
    procDir: "/proc",
    sysDir: "/sys",
    osReleasePath: "/etc/os-release",
    hostnamePath: null,
    disks: [
      { label: "Daten (NyxOS)", path: dataDir },
      { label: "Benutzerordner", path: homeDir },
    ],
    local,
  };
}

export function hostInfoOptionsFromEnv(env: NodeJS.ProcessEnv, hostFsDirs: Array<{ label: string; path: string }>): HostInfoOptions {
  return {
    procDir: "/proc",
    sysDir: env.NYXOS_HOST_SYS?.trim() || "/sys",
    osReleasePath: env.NYXOS_HOST_OS_RELEASE?.trim() || "/etc/os-release",
    hostnamePath: env.NYXOS_HOST_HOSTNAME?.trim() || null,
    disks: [{ label: "Archiv (NyxOS)", path: "/archive" }, ...hostFsDirs],
  };
}

/** Zähler einer Messung (Grundlage für Raten zwischen zwei Messungen). */
interface Sample {
  at: number;
  stat: CpuStat | null;
  disks: DiskCounters[];
  vm: VmstatCounters | null;
  net: Map<string, { rx: number; tx: number }>;
  /** Swap counters count pages: 4 KiB on Linux, 16 KiB on Apple silicon. */
  pageBytes: number;
  memUsed: number | null;
  load1: number | null;
  /** macOS only: the last `vm_stat` (memory in use). */
  macVm: MacVmStat | null;
}

/** Aus zwei Messungen errechnete Raten (gelten bis zur nächsten Messung). */
interface Rates {
  cpuPercent: number | null;
  cpuSplit: HostCpuSplit | null;
  cores: Array<number | null>;
  ctxtRate: number | null;
  intrRate: number | null;
  forkRate: number | null;
  diskIo: HostDiskIo[];
  swapInRate: number | null;
  swapOutRate: number | null;
  majorFaultRate: number | null;
  net: Map<string, { rx: number; tx: number }>;
}

/** Näher beieinander liegende Messungen geben keine sinnvollen Raten (und blähen den Verlauf nicht auf). */
const MIN_SAMPLE_GAP_MS = 5000;
const PAGE_BYTES = 4096;

type HostDockerInput = { running: number; total: number; version: string | null; published: HostListenPort[]; info?: HostDockerInfo | null };

export class HostInfoReader {
  private last: Sample | null = null;
  private macOsName: Promise<string> | null = null;
  private rates: Rates | null = null;
  private sampling: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly history = new HostHistory(HOST_HISTORY_POINTS);
  private readonly now: () => number;

  constructor(private readonly opts: HostInfoOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** misst im Hintergrund alle `everyMs` (Verlauf auch ohne offene Seite). Mehrfacher Aufruf = einmal. */
  startSampling(everyMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  stopSampling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Eine Messung: Zähler lesen, Raten gegen die vorige rechnen, einen Verlaufspunkt anhängen. Gleichzeitige Aufrufe teilen sich eine. */
  sample(): Promise<void> {
    if (this.sampling) return this.sampling;
    this.sampling = this.doSample().finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }

  /** macOS in local mode: no /proc. */
  private get mac(): LocalHostOptions | null {
    return this.opts.local?.platform === "darwin" ? this.opts.local : null;
  }

  private async procCounters(at: number): Promise<Sample> {
    const { procDir, local } = this.opts;
    const [stat, diskstats, vmstat, netDev, meminfo, loadavg] = await Promise.all([
      read(join(procDir, "stat")),
      read(join(procDir, "diskstats")),
      read(join(procDir, "vmstat")),
      read(join(procDir, "net", "dev")),
      read(join(procDir, "meminfo")),
      read(join(procDir, "loadavg")),
    ]);
    const mem = meminfo ? parseMeminfo(meminfo) : null;
    const load1 = Number(loadavg?.trim().split(/\s+/)[0]);
    return {
      at,
      // Local mode without /proc/stat (unusual Linux setups): the same counters from os.cpus().
      stat: stat ? parseCpuStat(stat) : local ? cpuStatFromCpus(local.system.cpus()) : null,
      disks: diskstats ? parseDiskstats(diskstats) : [],
      vm: vmstat ? parseVmstat(vmstat) : null,
      net: new Map((netDev ? parseNetDev(netDev) : []).map((n) => [n.iface, { rx: n.rxBytes, tx: n.txBytes }])),
      pageBytes: PAGE_BYTES,
      memUsed: mem && mem.memTotal !== null && mem.memAvailable !== null ? mem.memTotal - mem.memAvailable : null,
      load1: loadavg && Number.isFinite(load1) ? load1 : null,
      macVm: null,
    };
  }

  private async macCounters(at: number, mac: LocalHostOptions): Promise<Sample> {
    const [vmText, netText] = await Promise.all([mac.run(MAC_TOOLS.vmStat, []), mac.run(MAC_TOOLS.netstat, ["-ibn"])]);
    const macVm = vmText ? parseMacVmStat(vmText) : null;
    const total = mac.system.totalmem();
    const available = macVm && total > 0 ? macMemAvailable(total, macVm) : null;
    const load1 = mac.system.loadavg()[0];
    return {
      at,
      stat: cpuStatFromCpus(mac.system.cpus()),
      disks: [],
      vm: macVm ? { pswpin: macVm.swapins, pswpout: macVm.swapouts, pgmajfault: null, oomKill: null } : null,
      net: new Map((netText ? parseNetstatIb(netText) : []).map((n) => [n.iface, { rx: n.rxBytes, tx: n.txBytes }])),
      pageBytes: macVm?.pageBytes ?? PAGE_BYTES,
      memUsed: available !== null ? total - available : null,
      load1: typeof load1 === "number" && Number.isFinite(load1) ? load1 : null,
      macVm,
    };
  }

  private async doSample(): Promise<void> {
    const at = this.now();
    if (this.last && at - this.last.at < MIN_SAMPLE_GAP_MS) return;
    const mac = this.mac;
    const cur = mac ? await this.macCounters(at, mac) : await this.procCounters(at);
    const prev = this.last;
    this.last = cur;
    if (!prev) return;
    const dt = (at - prev.at) / 1000;
    const perSec = (a: number | null | undefined, b: number | null | undefined, factor = 1): number | null =>
      typeof a === "number" && typeof b === "number" && b >= a && dt > 0 ? Math.round(((b - a) * factor) / dt) : null;
    const cpu = prev.stat && cur.stat ? cpuUsageBetween(prev.stat, cur.stat) : { percent: null, split: null, cores: [] };
    const diskIo = diskIoBetween(prev.disks, cur.disks, dt);
    const net = new Map<string, { rx: number; tx: number }>();
    for (const [iface, c] of cur.net) {
      const p = prev.net.get(iface);
      const rx = perSec(p?.rx, c.rx);
      const tx = perSec(p?.tx, c.tx);
      if (rx !== null && tx !== null) net.set(iface, { rx, tx });
    }
    this.rates = {
      cpuPercent: cpu.percent,
      cpuSplit: cpu.split,
      cores: cpu.cores,
      ctxtRate: perSec(prev.stat?.ctxt, cur.stat?.ctxt),
      intrRate: perSec(prev.stat?.intr, cur.stat?.intr),
      forkRate: perSec(prev.stat?.processes, cur.stat?.processes),
      diskIo,
      swapInRate: perSec(prev.vm?.pswpin, cur.vm?.pswpin, cur.pageBytes),
      swapOutRate: perSec(prev.vm?.pswpout, cur.vm?.pswpout, cur.pageBytes),
      majorFaultRate: perSec(prev.vm?.pgmajfault, cur.vm?.pgmajfault),
      net,
    };
    const sum = (k: "readRate" | "writeRate") => (diskIo.some((d) => d[k] !== null) ? diskIo.reduce((s, d) => s + (d[k] ?? 0), 0) : null);
    this.history.push({
      at: new Date(at).toISOString(),
      cpu: cpu.percent,
      memUsed: cur.memUsed,
      load1: cur.load1,
      diskRead: sum("readRate"),
      diskWrite: sum("writeRate"),
    });
  }

  private async disks(): Promise<HostDisk[]> {
    const out: HostDisk[] = [];
    const seen = new Set<string>();
    for (const d of this.opts.disks) {
      const s = await statfs(d.path).catch(() => null);
      if (!s || s.blocks === 0) continue;
      // Dieselbe Platte unter mehreren Ordnern nur einmal zeigen.
      const key = `${s.type}:${s.blocks}:${s.bsize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({
        label: t(d.label),
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - s.bfree * s.bsize,
        inodesTotal: s.files > 0 ? s.files : null,
        inodesUsed: s.files > 0 ? s.files - s.ffree : null,
      });
    }
    return out;
  }

  async read(docker?: HostDockerInput | null, probe?: HostProbe | null): Promise<HostInfo> {
    const { procDir, sysDir, local } = this.opts;
    // Liegt die letzte Messung ≥ 5 s zurück (oder gab es keine), jetzt messen — sonst gelten die Raten der letzten.
    await this.sample().catch(() => undefined);
    const mac = this.mac;
    if (mac) return this.readMac(mac, docker ?? null);
    const at = this.now();
    const missing: string[] = [];
    const hostName = this.opts.hostnamePath ? (await read(this.opts.hostnamePath))?.trim() : null;
    const dmi = (f: string) => read(join(sysDir, "class", "dmi", "id", f)).then((v) => v?.trim() || null);
    const [loadavg, uptime, meminfo, stat, cpuinfo, osRelease, temperatures, netDev, disks, psiCpu, psiMem, psiIo, fileNr, vendor, product] = await Promise.all([
      read(join(procDir, "loadavg")),
      read(join(procDir, "uptime")),
      read(join(procDir, "meminfo")),
      read(join(procDir, "stat")),
      read(join(procDir, "cpuinfo")),
      read(this.opts.osReleasePath),
      readTemperatures(sysDir),
      read(join(procDir, "net", "dev")),
      this.disks(),
      read(join(procDir, "pressure", "cpu")),
      read(join(procDir, "pressure", "memory")),
      read(join(procDir, "pressure", "io")),
      read(join(procDir, "sys", "fs", "file-nr")),
      dmi("sys_vendor"),
      dmi("product_name"),
    ]);

    const loadFields = loadavg?.trim().split(/\s+/) ?? [];
    const l = loadFields.slice(0, 3).map(Number);
    const load: HostInfo["load"] = l.length === 3 && l.every(Number.isFinite) ? [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0] : null;
    const threads = Number(loadFields[3]?.split("/")[1]);
    const up = uptime ? Number(uptime.trim().split(/\s+/)[0]) : NaN;
    const uptimeSeconds = Number.isFinite(up) ? Math.round(up) : null;
    const mem = meminfo ? parseMeminfo(meminfo) : { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null };
    const cpuStat = stat ? parseCpuStat(stat) : null;
    const r = this.rates;

    const models = cpuinfo ? [...cpuinfo.matchAll(/^model name\s*:\s*(.+)$/gm)].map((m) => m[1]?.trim() ?? "") : [];
    const procs = cpuinfo ? [...cpuinfo.matchAll(/^processor\s*:/gm)].length : 0;
    const os = osRelease ? (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease)?.[1] ?? null) : null;

    const nets = netDev ? parseNetDev(netDev) : [];
    const network: HostNetwork[] = nets.map((n) => ({ ...n, rxRate: r?.net.get(n.iface)?.rx ?? null, txRate: r?.net.get(n.iface)?.tx ?? null }));

    const ports = docker?.published ?? [];
    const pressure = { cpu: psiCpu ? parsePressure(psiCpu) : null, memory: psiMem ? parsePressure(psiMem) : null, io: psiIo ? parsePressure(psiIo) : null };

    if (local) {
      // This computer itself: no container, no Docker needed — only what genuinely could not be read.
      if (temperatures.length === 0) missing.push(t("Temperatur: Dieser Rechner meldet keine Sensoren."));
      if (!os) missing.push(t("Betriebssystem: /etc/os-release ist nicht lesbar."));
      if (!load) missing.push(t("Last: /proc/loadavg nicht lesbar."));
      if (disks.length === 0) missing.push(t("Platten: Der Ordner der NyxOS-Daten ist nicht lesbar."));
    } else {
      if (temperatures.length === 0) missing.push(t("Temperatur: Der Server meldet keine Sensoren (typisch für eine virtuelle Maschine)."));
      missing.push(t("Netz: nur der NyxOS-Container — das Netz des Servers selbst ist aus dem Container nicht sichtbar."));
      if (!docker) missing.push(t("Ports: Docker ist gerade nicht erreichbar, darum keine veröffentlichten Ports."));
      if (!os) missing.push(t("Betriebssystem: /etc/os-release des Hosts ist noch nicht eingehängt (nächster Deploy)."));
      if (!load) missing.push(t("Last: /proc/loadavg nicht lesbar."));
      if (disks.length === 0) missing.push(t("Platten: kein Ordner des Hosts eingehängt."));
    }
    if (!pressure.cpu || !pressure.memory || !pressure.io) missing.push(t("Druck (PSI): Der Kernel meldet ihn nicht vollständig (/proc/pressure fehlt oder ist abgeschaltet)."));

    return {
      checkedAt: new Date(at).toISOString(),
      hostname: hostName || (local ? local.system.hostname() : hostname()) || null,
      os,
      kernel: (local ? local.system.release() : release()) || null,
      cpuModel: models[0] || null,
      cores: procs > 0 ? procs : null,
      cpuPercent: r?.cpuPercent ?? null,
      load,
      uptimeSeconds,
      bootedAt: uptimeSeconds !== null ? new Date(at - uptimeSeconds * 1000).toISOString() : null,
      ...mem,
      temperatures,
      disks,
      network,
      ports,
      containersRunning: docker?.running ?? null,
      containersTotal: docker?.total ?? null,
      dockerVersion: docker?.version ?? docker?.info?.version ?? null,
      // Die Tailscale-Schnittstelle des Hosts ist aus dem Container-Netz nicht sichtbar: ehrlich „unbekannt“.
      tailscale: nets.some((n) => n.iface.startsWith("tailscale")) ? true : null,
      cpuCores: r ? r.cores.map((percent, id) => ({ id, percent })) : [],
      cpuSplit: r?.cpuSplit ?? null,
      cpuMHz: cpuinfo ? parseCpuMHz(cpuinfo) : null,
      virtualization: cpuinfo || vendor || product ? parseVirtualization(cpuinfo, vendor, product) : null,
      processes: { running: cpuStat?.procsRunning ?? null, blocked: cpuStat?.procsBlocked ?? null, threads: Number.isFinite(threads) ? threads : null, forkRate: r?.forkRate ?? null },
      contextSwitchRate: r?.ctxtRate ?? null,
      interruptRate: r?.intrRate ?? null,
      memDetail: meminfo ? parseMemDetail(meminfo) : null,
      swapInRate: r?.swapInRate ?? null,
      swapOutRate: r?.swapOutRate ?? null,
      majorFaultRate: r?.majorFaultRate ?? null,
      oomKills: this.last?.vm?.oomKill ?? null,
      diskIo: r?.diskIo ?? [],
      pressure,
      openFiles: fileNr ? parseFileNr(fileNr) : null,
      history: this.history.points(),
      docker: docker?.info ?? null,
      probe: probe ?? null,
      missing,
    };
  }
  /** macOS (local mode): os.* for CPU, load, uptime; vm_stat/sysctl/netstat for memory, swap, model, network. */
  private async readMac(mac: LocalHostOptions, docker: HostDockerInput | null): Promise<HostInfo> {
    const at = this.now();
    const sys = mac.system;
    this.macOsName ??= readMacOsName(mac);
    const [sysctlText, os, disks] = await Promise.all([mac.run(MAC_TOOLS.sysctl, ["hw.model", "kern.hv_vmm_present", "vm.swapusage", "kern.num_files", "kern.maxfiles"]), this.macOsName, this.disks()]);
    const sc = parseSysctl(sysctlText ?? "");
    const r = this.rates;
    const list = sys.cpus();
    const l = sys.loadavg();
    const load: HostInfo["load"] = l.length >= 3 && l.slice(0, 3).every(Number.isFinite) ? [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0] : null;
    const up = sys.uptime();
    const uptimeSeconds = Number.isFinite(up) && up > 0 ? Math.round(up) : null;
    const memTotal = sys.totalmem() > 0 ? sys.totalmem() : null;
    const vm = this.last?.macVm ?? null;
    const swap = parseSwapUsage(sc.get("vm.swapusage") ?? "");
    const model = sc.get("hw.model") || null;
    const isVirtual = sc.get("kern.hv_vmm_present") === "1";
    const numFiles = Number(sc.get("kern.num_files"));
    const maxFiles = Number(sc.get("kern.maxfiles"));
    const network: HostNetwork[] = [...(this.last?.net ?? new Map<string, { rx: number; tx: number }>())].map(([iface, c]) => ({ iface, rxBytes: c.rx, txBytes: c.tx, rxRate: r?.net.get(iface)?.rx ?? null, txRate: r?.net.get(iface)?.tx ?? null }));
    return {
      checkedAt: new Date(at).toISOString(),
      hostname: sys.hostname() || null,
      os,
      kernel: sys.release() ? `Darwin ${sys.release()}` : null,
      cpuModel: list[0]?.model?.trim() || null,
      cores: list.length > 0 ? list.length : null,
      cpuPercent: r?.cpuPercent ?? null,
      load,
      uptimeSeconds,
      bootedAt: uptimeSeconds !== null ? new Date(at - uptimeSeconds * 1000).toISOString() : null,
      memTotal,
      memAvailable: memTotal !== null && vm ? macMemAvailable(memTotal, vm) : null,
      swapTotal: swap?.total ?? null,
      swapFree: swap?.free ?? null,
      temperatures: [],
      disks,
      network,
      ports: docker?.published ?? [],
      containersRunning: docker?.running ?? null,
      containersTotal: docker?.total ?? null,
      dockerVersion: docker?.version ?? docker?.info?.version ?? null,
      tailscale: null,
      cpuCores: r ? r.cores.map((percent, id) => ({ id, percent })) : [],
      // Apple silicon reports no reliable clock speed; iowait and steal do not exist on macOS.
      cpuSplit: r?.cpuSplit ?? null,
      cpuMHz: null,
      virtualization: { isVirtual, label: isVirtual ? t("virtuelle Maschine") : t("eigene Hardware"), vendor: "Apple", product: model },
      processes: { running: null, blocked: null, threads: null, forkRate: null },
      contextSwitchRate: null,
      interruptRate: null,
      memDetail: null,
      swapInRate: r?.swapInRate ?? null,
      swapOutRate: r?.swapOutRate ?? null,
      majorFaultRate: null,
      oomKills: null,
      diskIo: [],
      pressure: { cpu: null, memory: null, io: null },
      openFiles: Number.isFinite(numFiles) && numFiles > 0 && Number.isFinite(maxFiles) && maxFiles > 0 ? { used: numFiles, max: maxFiles } : null,
      history: this.history.points(),
      docker: docker?.info ?? null,
      probe: null,
      missing: [t("Temperatur, Engpässe (Druck) und Platten-Durchsatz meldet macOS ohne Zusatzrechte nicht – darum fehlen sie hier.")],
    };
  }
}
