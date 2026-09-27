// Umfangreichere Host-Daten — reine Parser für /proc und /sys (getestet in test/host-stats.test.ts)
// plus ein kleiner Verlauf (Ringpuffer). Nur LESEN, nie ein Befehl auf dem Host. /proc/{stat,diskstats,vmstat,
// pressure/*} und /sys sind im Container die des Hosts (nicht namespaced); /proc/<pid> des Hosts bleibt bewusst
// unsichtbar (s. hostinfo.ts).
import type { HostCpuSplit, HostDiskIo, HostDockerInfo, HostHistoryPoint, HostMemDetail, HostPressure, HostProbe, HostVirtualization } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { connect } from "node:tls";

// ─────────────────────────────── /proc/stat ───────────────────────────────

/** Zeiten einer CPU-Zeile (Einheit: Ticks). `idle` enthält iowait, `total` die ersten 8 Felder. */
export interface CpuTimes {
  user: number;
  system: number;
  idle: number;
  iowait: number;
  steal: number;
  total: number;
}

export interface CpuStat {
  total: CpuTimes | null;
  cores: CpuTimes[];
  ctxt: number | null;
  intr: number | null;
  processes: number | null;
  procsRunning: number | null;
  procsBlocked: number | null;
}

function cpuTimes(fields: string[]): CpuTimes {
  const n = fields.map(Number).map((x) => (Number.isFinite(x) ? x : 0));
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
  return { user: user + nice, system: system + irq + softirq, idle: idle + iowait, iowait, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function parseCpuStat(text: string): CpuStat {
  const out: CpuStat = { total: null, cores: [], ctxt: null, intr: null, processes: null, procsRunning: null, procsBlocked: null };
  const num = (v: string | undefined): number | null => {
    const x = Number(v);
    return v !== undefined && Number.isFinite(x) ? x : null;
  };
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const key = parts[0];
    if (!key) continue;
    if (key === "cpu") out.total = cpuTimes(parts.slice(1));
    else if (/^cpu\d+$/.test(key)) out.cores.push(cpuTimes(parts.slice(1)));
    else if (key === "ctxt") out.ctxt = num(parts[1]);
    else if (key === "intr") out.intr = num(parts[1]);
    else if (key === "processes") out.processes = num(parts[1]);
    else if (key === "procs_running") out.procsRunning = num(parts[1]);
    else if (key === "procs_blocked") out.procsBlocked = num(parts[1]);
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function busyBetween(a: CpuTimes, b: CpuTimes): number | null {
  const dt = b.total - a.total;
  if (dt <= 0) return null;
  return round1(Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dt) * 100)));
}

/** Auslastung zwischen zwei Messungen: gesamt, Aufteilung und je Kern. */
export function cpuUsageBetween(a: CpuStat, b: CpuStat): { percent: number | null; split: HostCpuSplit | null; cores: Array<number | null> } {
  let percent: number | null = null;
  let split: HostCpuSplit | null = null;
  if (a.total && b.total) {
    percent = busyBetween(a.total, b.total);
    const dt = b.total.total - a.total.total;
    if (dt > 0) {
      const p = (k: keyof CpuTimes) => round1(Math.max(0, ((b.total?.[k] ?? 0) - (a.total?.[k] ?? 0)) / dt) * 100);
      split = { user: p("user"), system: p("system"), iowait: p("iowait"), steal: p("steal") };
    }
  }
  const cores = b.cores.map((c, i) => {
    const prev = a.cores[i];
    return prev ? busyBetween(prev, c) : null;
  });
  return { percent, split, cores };
}

// ─────────────────────────────── /proc/diskstats ───────────────────────────────

export interface DiskCounters {
  device: string;
  reads: number;
  sectorsRead: number;
  writes: number;
  sectorsWritten: number;
  ioMs: number;
}

/** Nur ganze Platten (keine Partitionen, loop, ram, dm/md — die würden doppelt zählen). */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const SECTOR_BYTES = 512;

export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    const device = f[2];
    if (!device || !WHOLE_DISK.test(device) || f.length < 13) continue;
    const n = (i: number) => Number(f[i]) || 0;
    out.push({ device, reads: n(3), sectorsRead: n(5), writes: n(7), sectorsWritten: n(9), ioMs: n(12) });
  }
  return out;
}

export function diskIoBetween(a: DiskCounters[], b: DiskCounters[], dtSec: number): HostDiskIo[] {
  return b.map((d) => {
    const p = a.find((x) => x.device === d.device);
    const ok = p && dtSec > 0 && d.reads >= p.reads && d.writes >= p.writes;
    if (!ok || !p) return { device: d.device, readRate: null, writeRate: null, readIops: null, writeIops: null, busyPercent: null };
    return {
      device: d.device,
      readRate: Math.round(((d.sectorsRead - p.sectorsRead) * SECTOR_BYTES) / dtSec),
      writeRate: Math.round(((d.sectorsWritten - p.sectorsWritten) * SECTOR_BYTES) / dtSec),
      readIops: round1((d.reads - p.reads) / dtSec),
      writeIops: round1((d.writes - p.writes) / dtSec),
      busyPercent: round1(Math.max(0, Math.min(100, ((d.ioMs - p.ioMs) / (dtSec * 1000)) * 100))),
    };
  });
}

// ─────────────────────────────── /proc/vmstat, pressure, file-nr, meminfo ───────────────────────────────

export interface VmstatCounters {
  pswpin: number | null;
  pswpout: number | null;
  pgmajfault: number | null;
  oomKill: number | null;
}

export function parseVmstat(text: string): VmstatCounters {
  const get = (key: string): number | null => {
    const m = new RegExp(`^${key}\\s+(\\d+)`, "m").exec(text);
    return m?.[1] ? Number(m[1]) : null;
  };
  return { pswpin: get("pswpin"), pswpout: get("pswpout"), pgmajfault: get("pgmajfault"), oomKill: get("oom_kill") };
}

export function parsePressure(text: string): HostPressure | null {
  const line = (kind: string) => new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)`, "m").exec(text);
  const some = line("some");
  if (!some?.[1] || !some[2]) return null;
  const full = line("full");
  return { some10: Number(some[1]), some60: Number(some[2]), full10: full?.[1] ? Number(full[1]) : null };
}

export function parseFileNr(text: string): { used: number; max: number } | null {
  const [alloc, unused, max] = text.trim().split(/\s+/).map(Number);
  if (alloc === undefined || max === undefined || !Number.isFinite(alloc) || !Number.isFinite(max)) return null;
  return { used: alloc - (Number.isFinite(unused) ? (unused ?? 0) : 0), max };
}

export function parseMemDetail(text: string): HostMemDetail | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m?.[1] ? Number(m[1]) * 1024 : null;
  };
  const free = kb("MemFree");
  const cached = kb("Cached");
  if (free === null || cached === null) return null;
  return { free, buffers: kb("Buffers") ?? 0, cached, reclaimable: kb("SReclaimable") ?? 0, shmem: kb("Shmem") ?? 0, dirty: kb("Dirty") ?? 0 };
}

// ─────────────────────────────── Maschine ───────────────────────────────

/** VM oder eigene Hardware: cpuinfo-Flag „hypervisor“ + DMI-Hersteller (/sys/class/dmi/id). */
export function parseVirtualization(cpuinfo: string | null, vendor: string | null, product: string | null): HostVirtualization {
  const flagged = !!cpuinfo && /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo);
  const v = `${vendor ?? ""} ${product ?? ""}`;
  const kind = /qemu|kvm/i.test(v) ? "KVM/QEMU" : /vmware/i.test(v) ? "VMware" : /xen/i.test(v) ? "Xen" : /microsoft|hyper-v/i.test(v) ? "Hyper-V" : /virtualbox|innotek/i.test(v) ? "VirtualBox" : null;
  const isVirtual = flagged || kind !== null;
  return {
    isVirtual,
    label: isVirtual ? `${t("virtuelle Maschine")}${kind ? ` (${kind})` : ""}` : t("eigene Hardware"),
    vendor: vendor || null,
    product: product || null,
  };
}

export function parseCpuMHz(cpuinfo: string): number | null {
  const m = /^cpu MHz\s*:\s*([\d.]+)/m.exec(cpuinfo);
  return m?.[1] ? Math.round(Number(m[1])) : null;
}

/** Aus `/info` des Docker-Lese-Proxys nur die Anzeige-Felder. */
export function parseDockerInfo(info: Record<string, unknown> | null): HostDockerInfo | null {
  if (!info) return null;
  const str = (k: string) => (typeof info[k] === "string" && info[k] ? (info[k] as string) : null);
  const num = (k: string) => (typeof info[k] === "number" ? (info[k] as number) : null);
  return { version: str("ServerVersion"), images: num("Images"), storageDriver: str("Driver"), rootDir: str("DockerRootDir"), architecture: str("Architecture") };
}

// ─────────────────────────────── Verlauf ───────────────────────────────

export class HostHistory {
  private readonly buf: HostHistoryPoint[] = [];
  constructor(private readonly max: number) {}
  push(p: HostHistoryPoint): void {
    this.buf.push(p);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }
  points(): HostHistoryPoint[] {
    return [...this.buf];
  }
}

// ─────────────────────────────── Erreichbarkeit (nur TLS-Handshake) ───────────────────────────────

/** Baut eine TLS-Verbindung auf, liest das Zertifikat und schließt sofort — es wird nichts gesendet. */
export function probeTls(host: string, timeoutMs = 4000, now: () => number = Date.now): Promise<HostProbe> {
  const start = now();
  const checkedAt = new Date(start).toISOString();
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: Omit<HostProbe, "host" | "checkedAt">) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ host, checkedAt, ...p });
    };
    const socket = connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      const valid = validTo && Number.isFinite(validTo.getTime()) ? validTo : null;
      const issuer = cert?.issuer ? (typeof cert.issuer.O === "string" ? cert.issuer.O : typeof cert.issuer.CN === "string" ? cert.issuer.CN : null) : null;
      finish({
        ok: socket.authorized,
        ms: now() - start,
        certValidTo: valid ? valid.toISOString() : null,
        certDaysLeft: valid ? Math.floor((valid.getTime() - now()) / 86_400_000) : null,
        issuer,
        error: socket.authorized ? null : t("Zertifikat nicht gültig ({reason})", { reason: String(socket.authorizationError ?? t("unbekannt")) }),
      });
    });
    socket.on("timeout", () => finish({ ok: false, ms: null, certValidTo: null, certDaysLeft: null, issuer: null, error: t("keine Antwort in {n} s", { n: Math.round(timeoutMs / 1000) }) }));
    socket.on("error", (e) => finish({ ok: false, ms: null, certValidTo: null, certDaysLeft: null, issuer: null, error: e.message }));
  });
}
