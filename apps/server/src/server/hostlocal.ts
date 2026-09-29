// Host data in LOCAL mode (NyxOS on the user's own Mac or Linux computer, one Node process, no container).
// Linux still reads /proc and /sys (hostinfo.ts). macOS has no /proc: CPU comes from os.cpus()/os.loadavg(),
// memory and swap activity from `vm_stat`, swap size, model and open files from `sysctl`, network counters from
// `netstat -ibn`, the version from SystemVersion.plist (fallback `sw_vers`). Only these read-only system tools,
// with absolute paths, a short timeout and the C locale — never a shell. What macOS does not report without
// extra rights (temperature, pressure, per-disk throughput) stays null, and the page hides it.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, hostname, loadavg, release, totalmem, uptime, type CpuInfo } from "node:os";
import type { CpuStat, CpuTimes } from "./hoststats.js";

/** The parts of `node:os` the reader needs — injectable so tests run the macOS path on any OS. */
export interface LocalSystem {
  loadavg(): number[];
  cpus(): Array<Pick<CpuInfo, "model" | "speed" | "times">>;
  totalmem(): number;
  uptime(): number;
  hostname(): string;
  release(): string;
}

/** Runs a read-only system tool; null when it is missing or fails (stdout of a partial failure is kept). */
export type RunCommand = (file: string, args: string[]) => Promise<string | null>;

export interface LocalHostOptions {
  platform: NodeJS.Platform;
  system: LocalSystem;
  run: RunCommand;
  /** macOS version file (plain XML plist). */
  macVersionPath: string;
}

export const MAC_TOOLS = { vmStat: "/usr/bin/vm_stat", sysctl: "/usr/sbin/sysctl", netstat: "/usr/sbin/netstat", swVers: "/usr/bin/sw_vers" } as const;

const RUN_TIMEOUT_MS = 2000;

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } }, (err, stdout) => {
      // sysctl exits 1 when a single key is unknown but still prints the others.
      const out = typeof stdout === "string" ? stdout : "";
      resolve(err && !out ? null : out);
    });
  });

export function localHostOptions(platform: NodeJS.Platform = process.platform): LocalHostOptions {
  return {
    platform,
    system: { loadavg, cpus, totalmem, uptime, hostname, release },
    run: runCommand,
    macVersionPath: "/System/Library/CoreServices/SystemVersion.plist",
  };
}

/** os.cpus() times (ms) in the same shape as a /proc/stat line, so cpuUsageBetween works unchanged. */
export function cpuStatFromCpus(list: Array<Pick<CpuInfo, "times">>): CpuStat | null {
  if (list.length === 0) return null;
  const toTimes = (t: CpuInfo["times"]): CpuTimes => ({ user: t.user + t.nice, system: t.sys + t.irq, idle: t.idle, iowait: 0, steal: 0, total: t.user + t.nice + t.sys + t.irq + t.idle });
  const cores = list.map((c) => toTimes(c.times));
  const total = cores.reduce<CpuTimes>((s, c) => ({ user: s.user + c.user, system: s.system + c.system, idle: s.idle + c.idle, iowait: 0, steal: 0, total: s.total + c.total }), { user: 0, system: 0, idle: 0, iowait: 0, steal: 0, total: 0 });
  return { total, cores, ctxt: null, intr: null, processes: null, procsRunning: null, procsBlocked: null };
}

export interface MacVmStat {
  pageBytes: number;
  free: number | null;
  wired: number | null;
  purgeable: number | null;
  anonymous: number | null;
  compressor: number | null;
  swapins: number | null;
  swapouts: number | null;
}

/** `vm_stat` (counts in pages; the page size is in the first line). */
export function parseMacVmStat(text: string): MacVmStat | null {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!size) return null;
  const get = (label: string): number | null => {
    const m = new RegExp(`^"?${label}"?:\\s+(\\d+)`, "m").exec(text);
    return m?.[1] ? Number(m[1]) : null;
  };
  return {
    pageBytes: Number(size),
    free: get("Pages free"),
    wired: get("Pages wired down"),
    purgeable: get("Pages purgeable"),
    anonymous: get("Anonymous pages"),
    compressor: get("Pages occupied by compressor"),
    swapins: get("Swapins"),
    swapouts: get("Swapouts"),
  };
}

/** Memory in use the way Activity Monitor counts it: app memory (anonymous − purgeable) + wired + compressed.
 * Everything else (file cache, purgeable, free) macOS hands back at once — that is "available". os.freemem()
 * alone would be misleadingly small, because macOS keeps free memory low on purpose. */
export function macMemAvailable(total: number, vm: MacVmStat): number | null {
  if (vm.anonymous === null || vm.wired === null || vm.compressor === null) return null;
  const used = (Math.max(0, vm.anonymous - (vm.purgeable ?? 0)) + vm.wired + vm.compressor) * vm.pageBytes;
  return Math.max(0, total - used);
}

/** `sysctl a.b c.d` → key/value map ("key: value" per line). */
export function parseSysctl(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([\w.]+):\s*(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out.set(m[1], m[2].trim());
  }
  return out;
}

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)" (comma decimals too). */
export function parseSwapUsage(value: string): { total: number; free: number } | null {
  const size = (key: string): number | null => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.,]+)([BKMGT])?`).exec(value);
    if (!m?.[1]) return null;
    const n = Number(m[1].replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * (UNIT[m[2] ?? "B"] ?? 1)) : null;
  };
  const total = size("total");
  const free = size("free");
  return total !== null && free !== null ? { total, free } : null;
}

/** `netstat -ibn`: byte counters per interface from the `<Link#n>` rows. Loopback, tunnels (utun: VPNs, iCloud
 * relay), AirDrop/peer-to-peer links (awdl, llw, anpi, ap) and idle interfaces are left out. */
export function parseNetstatIb(text: string): Array<{ iface: string; rxBytes: number; txBytes: number }> {
  const out: Array<{ iface: string; rxBytes: number; txBytes: number }> = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes("<Link#")) continue;
    const f = line.trim().split(/\s+/);
    const iface = f[0];
    // From the end: … Ibytes Opkts Oerrs Obytes Coll (the address column is empty for some interfaces).
    const rx = Number(f[f.length - 5]);
    const tx = Number(f[f.length - 2]);
    if (!iface || iface.endsWith("*") || /^(lo|gif|stf|utun|awdl|llw|anpi|ap)\d/.test(iface) || seen.has(iface)) continue;
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx + tx === 0) continue;
    seen.add(iface);
    out.push({ iface, rxBytes: rx, txBytes: tx });
  }
  return out;
}

/** "macOS 15.6" from SystemVersion.plist (or the `sw_vers -productVersion` output). */
export function macOsName(plist: string | null, swVers: string | null): string {
  const fromPlist = plist ? /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() : null;
  const version = fromPlist || swVers?.trim() || null;
  return version && /^[\d.]+$/.test(version) ? `macOS ${version}` : "macOS";
}

export async function readMacOsName(opts: Pick<LocalHostOptions, "run" | "macVersionPath">): Promise<string> {
  const plist = await readFile(opts.macVersionPath, "utf8").catch(() => null);
  if (plist && /ProductVersion/.test(plist)) return macOsName(plist, null);
  return macOsName(null, await opts.run(MAC_TOOLS.swVers, ["-productVersion"]));
}
