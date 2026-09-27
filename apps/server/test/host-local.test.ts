// Local mode of the "This computer" page: macOS without /proc (os.* + vm_stat/sysctl/netstat) and Linux with
// the computer's own /proc — no container, Docker or Dozzle notes. Platform and tools are injected, so these
// tests run the macOS path on any OS.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Updater } from "../src/app-info/updates.js";
import { HostInfoReader, localHostInfoOptions } from "../src/server/hostinfo.js";
import { cpuStatFromCpus, MAC_TOOLS, macMemAvailable, macOsName, parseMacVmStat, parseNetstatIb, parseSwapUsage, parseSysctl, type LocalHostOptions, type LocalSystem } from "../src/server/hostlocal.js";
import { setup } from "./helpers.js";

const VM_STAT = (swapins: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4000.
Pages active:                                 180000.
Pages inactive:                               180000.
Pages speculative:                              2000.
Pages wired down:                             100000.
Pages purgeable:                                1000.
"Translation faults":                     4329450819.
File-backed pages:                            116000.
Anonymous pages:                              201000.
Pages occupied by compressor:                  50000.
Swapins:                                     ${swapins}.
Swapouts:                                         10.
`;

const NETSTAT = (rx: number, tx: number) => `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       8055553     0 55365417045  8055553     0 55365417045     0
lo0        16384 127           127.0.0.1        8055553     - 55365417045  8055553     - 55365417045     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en5        1500  <Link#8>    aa:bb:cc:dd:ee:01        0     0          0        0     0          0     0
utun4      1380  <Link#20>                        300     0     280992      200     0      27513     0
awdl0      1500  <Link#14>   aa:bb:cc:dd:ee:03      500     0    6403943     900     0  403450751     0
en0        1500  <Link#11>   aa:bb:cc:dd:ee:02  1000000     0 ${rx}   900000     0 ${tx}     0
en0        1500  192.168.1     192.168.1.20      1000000     - ${rx}   900000     - ${tx}     -
`;

const SYSCTL = "hw.model: Mac14,9\nkern.hv_vmm_present: 0\nvm.swapusage: total = 2048,00M  used = 512,00M  free = 1536,00M  (encrypted)\nkern.num_files: 17495\nkern.maxfiles: 122880\n";

const GB = 1024 ** 3;

function fakeMac(dataDir: string) {
  const state = { idle: 1000, busy: 1000, swapins: 100, rx: 1_000_000, tx: 500_000 };
  const system: LocalSystem = {
    loadavg: () => [2.5, 2, 1.5],
    cpus: () =>
      [0, 1].map(() => ({ model: "Apple M2 Pro", speed: 2400, times: { user: state.busy, nice: 0, sys: 0, idle: state.idle, irq: 0 } })),
    totalmem: () => 16 * GB,
    uptime: () => 7200,
    hostname: () => "test-mac.local",
    release: () => "24.6.0",
  };
  const calls: string[] = [];
  const local: LocalHostOptions = {
    platform: "darwin",
    system,
    macVersionPath: join(dataDir, "missing.plist"),
    run: async (file) => {
      calls.push(file);
      if (file === MAC_TOOLS.vmStat) return VM_STAT(state.swapins);
      if (file === MAC_TOOLS.netstat) return NETSTAT(state.rx, state.tx);
      if (file === MAC_TOOLS.sysctl) return SYSCTL;
      if (file === MAC_TOOLS.swVers) return "15.6\n";
      return null;
    },
  };
  return { state, local, calls };
}

describe("macOS parsers", () => {
  it("vm_stat → pages and page size; available memory counts like Activity Monitor (not os.freemem)", () => {
    const vm = parseMacVmStat(VM_STAT(5));
    expect(vm).toMatchObject({ pageBytes: 16384, free: 4000, wired: 100000, purgeable: 1000, anonymous: 201000, compressor: 50000, swapins: 5, swapouts: 10 });
    // in use: (201000 − 1000) + 100000 + 50000 = 350000 pages
    expect(vm && macMemAvailable(16 * GB, vm)).toBe(16 * GB - 350000 * 16384);
    expect(parseMacVmStat("nonsense")).toBeNull();
  });

  it("vm.swapusage with comma or point decimals", () => {
    expect(parseSwapUsage("total = 2048,00M  used = 512,00M  free = 1536,00M  (encrypted)")).toEqual({ total: 2048 * 1024 ** 2, free: 1536 * 1024 ** 2 });
    expect(parseSwapUsage("total = 1.50G  used = 0.00M  free = 1.50G")).toEqual({ total: 1.5 * GB, free: 1.5 * GB });
    expect(parseSwapUsage("")).toBeNull();
  });

  it("netstat -ibn: one row per active interface, loopback/tunnels/idle left out", () => {
    expect(parseNetstatIb(NETSTAT(123, 456))).toEqual([{ iface: "en0", rxBytes: 123, txBytes: 456 }]);
  });

  it("sysctl lines, macOS name, os.cpus() as /proc/stat counters", () => {
    expect(parseSysctl(SYSCTL).get("hw.model")).toBe("Mac14,9");
    expect(macOsName("<dict><key>ProductVersion</key>\n\t<string>15.6</string></dict>", null)).toBe("macOS 15.6");
    expect(macOsName(null, "26.0.1\n")).toBe("macOS 26.0.1");
    expect(macOsName(null, null)).toBe("macOS");
    const stat = cpuStatFromCpus([{ times: { user: 10, nice: 5, sys: 3, idle: 80, irq: 2 } }]);
    expect(stat?.total).toEqual({ user: 15, system: 5, idle: 80, iowait: 0, steal: 0, total: 100 });
    expect(cpuStatFromCpus([])).toBeNull();
  });
});

describe("HostInfoReader in local mode on macOS (no /proc)", () => {
  it("reads macOS, CPU, load, memory, swap, disk, network — and no container or Docker notes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nyx-local-mac-"));
    const { state, local } = fakeMac(dataDir);
    let now = Date.parse("2026-09-27T10:00:00Z");
    const reader = new HostInfoReader({ ...localHostInfoOptions(dataDir, local, dataDir), procDir: join(dataDir, "no-proc"), sysDir: join(dataDir, "no-sys"), now: () => now });

    const first = await reader.read(null);
    expect(first.os).toBe("macOS 15.6");
    expect(first.kernel).toBe("Darwin 24.6.0");
    expect(first.hostname).toBe("test-mac.local");
    expect(first.cpuModel).toBe("Apple M2 Pro");
    expect(first.cores).toBe(2);
    expect(first.load).toEqual([2.5, 2, 1.5]);
    expect(first.uptimeSeconds).toBe(7200);
    expect(first.memTotal).toBe(16 * GB);
    expect(first.memAvailable).toBe(16 * GB - 350000 * 16384);
    expect(first.swapTotal).toBe(2048 * 1024 ** 2);
    expect(first.swapFree).toBe(1536 * 1024 ** 2);
    expect(first.openFiles).toEqual({ used: 17495, max: 122880 });
    expect(first.virtualization).toMatchObject({ isVirtual: false, vendor: "Apple", product: "Mac14,9" });
    expect(first.disks).toHaveLength(1);
    expect(first.disks[0]?.label).toBe("Daten (NyxOS)");
    expect(first.network).toEqual([expect.objectContaining({ iface: "en0", rxRate: null })]);
    expect(first.cpuPercent).toBeNull();
    // Nothing that belongs to server mode:
    const missing = first.missing.join(" ");
    expect(missing).not.toMatch(/Container|Docker|eingehängt|Server/);
    expect(first.pressure).toEqual({ cpu: null, memory: null, io: null });
    expect(first.processes).toEqual({ running: null, blocked: null, threads: null, forkRate: null });

    now += 10_000;
    state.busy += 300;
    state.idle += 700;
    state.swapins += 2;
    state.rx += 100_000;
    state.tx += 50_000;
    const second = await reader.read(null);
    expect(second.cpuPercent).toBeCloseTo(30, 0);
    expect(second.cpuCores.map((c) => Math.round(c.percent ?? -1))).toEqual([30, 30]);
    expect(second.network[0]).toMatchObject({ iface: "en0", rxRate: 10_000, txRate: 5_000 });
    // two 16 KiB pages in 10 s
    expect(second.swapInRate).toBe(Math.round((2 * 16384) / 10));
    expect(second.history).toHaveLength(1);
    expect(second.history[0]).toMatchObject({ load1: 2.5, memUsed: 350000 * 16384 });
  });
});

describe("HostInfoReader in local mode on Linux", () => {
  it("uses this computer's /proc; notes speak of this computer, not of a container", async () => {
    const proc = mkdtempSync(join(tmpdir(), "nyx-local-linux-"));
    mkdirSync(join(proc, "net"));
    writeFileSync(join(proc, "loadavg"), "0.50 0.40 0.30 1/200 999\n");
    writeFileSync(join(proc, "uptime"), "3600.00 7000.00\n");
    writeFileSync(join(proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
    writeFileSync(join(proc, "stat"), "cpu  100 0 100 800 0 0 0 0 0 0\n");
    writeFileSync(join(proc, "net", "dev"), "Inter-|\n face |\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n wlp2s0: 5000 10 0 0 0 0 0 0 3000 8 0 0 0 0 0 0\n");
    const osRelease = join(proc, "os-release");
    writeFileSync(osRelease, 'PRETTY_NAME="Fedora Linux 42 (Workstation Edition)"\n');
    const { local } = fakeMac(proc);
    const reader = new HostInfoReader({ ...localHostInfoOptions(proc, { ...local, platform: "linux" }, proc), procDir: proc, sysDir: join(proc, "no-sys"), osReleasePath: osRelease });
    const info = await reader.read(null);
    expect(info.os).toBe("Fedora Linux 42 (Workstation Edition)");
    expect(info.hostname).toBe("test-mac.local");
    expect(info.load).toEqual([0.5, 0.4, 0.3]);
    expect(info.network.map((n) => n.iface)).toEqual(["wlp2s0"]);
    expect(info.disks.map((d) => d.label)).toEqual(["Daten (NyxOS)"]);
    const missing = info.missing.join(" ");
    expect(missing).toMatch(/Temperatur: Dieser Rechner meldet keine Sensoren/);
    expect(missing).not.toMatch(/Container|Docker|Deploy/);
  });
});

describe("Routes in local mode", () => {
  const appInfo = (mode: "local" | "server") => ({ version: "1.0.0", mode, demo: false, dataDir: null, updater: new Updater({ version: "1.0.0", cli: null }) });

  it("local: nothing is 'still missing' without Docker/Dozzle; server mode keeps its steps", async () => {
    const localApp = await setup({ appInfo: appInfo("local") });
    const local = (await (await localApp.app.request("/api/server")).json()) as { pending: unknown[]; docker: { available: boolean } };
    expect(local.docker.available).toBe(false);
    expect(local.pending).toEqual([]);
    const host = (await (await localApp.app.request("/api/server/host")).json()) as { missing: string[]; disks: unknown[] };
    expect(host.missing.join(" ")).not.toMatch(/NyxOS-Container|Docker/);
    expect(host.disks.length).toBeGreaterThan(0);

    const serverApp = await setup({ appInfo: appInfo("server") });
    const server = (await (await serverApp.app.request("/api/server")).json()) as { pending: Array<{ id: string }> };
    expect(server.pending.map((p) => p.id)).toEqual(["socket-proxy", "dozzle"]);
  });
});
