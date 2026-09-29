// Umfangreiche Server-Daten — Parser für /proc (je Kern, Platten-IO, vmstat, Druck) und der Verlauf.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostInfoReader } from "../src/server/hostinfo.js";
import { cpuUsageBetween, diskIoBetween, HostHistory, parseCpuStat, parseDiskstats, parseDockerInfo, parseFileNr, parseMemDetail, parsePressure, parseVirtualization, parseVmstat } from "../src/server/hoststats.js";

const STAT_A = `cpu  1000 0 500 8000 100 0 0 50 0 0
cpu0 500 0 250 4000 50 0 0 25 0 0
cpu1 500 0 250 4000 50 0 0 25 0 0
intr 12345 0 0
ctxt 100000
btime 1758870000
processes 5000
procs_running 3
procs_blocked 1
`;
const STAT_B = `cpu  1600 0 700 8400 200 0 0 100 0 0
cpu0 1000 0 400 4050 50 0 0 50 0 0
cpu1 600 0 300 4350 150 0 0 50 0 0
intr 22345 0 0
ctxt 150000
btime 1758870000
processes 5100
procs_running 2
procs_blocked 0
`;

describe("Parser", () => {
  it("/proc/stat: Summe, je Kern, Kontextwechsel, Prozesse", () => {
    const s = parseCpuStat(STAT_A);
    expect(s.total?.idle).toBe(8100);
    expect(s.cores).toHaveLength(2);
    expect(s.ctxt).toBe(100000);
    expect(s.processes).toBe(5000);
    expect(s.procsRunning).toBe(3);
    expect(s.procsBlocked).toBe(1);
    expect(s.intr).toBe(12345);
  });

  it("CPU-Auslastung zwischen zwei Messungen: gesamt, je Kern, Aufteilung (Nutzer/System/Warten/gestohlen)", () => {
    const a = parseCpuStat(STAT_A);
    const b = parseCpuStat(STAT_B);
    const u = cpuUsageBetween(a, b);
    // Δ gesamt = 600 + 200 + 400 + 100 + 50 = 1350; idle+iowait Δ = 400 + 100 = 500 → 63 %
    expect(u.percent).toBeCloseTo(63, 0);
    expect(u.split).toEqual({ user: expect.closeTo(44.4, 1), system: expect.closeTo(14.8, 1), iowait: expect.closeTo(7.4, 1), steal: expect.closeTo(3.7, 1) });
    // Kern 0: Δ = 500+150+50+25 = 725, idle Δ 50 → 93 %; Kern 1: Δ = 100+50+350+100+25 = 625, idle Δ 450 → 28 %
    expect(u.cores.map((c) => Math.round(c ?? -1))).toEqual([93, 28]);
  });

  it("/proc/diskstats: nur ganze Platten, Durchsatz, IOPS und Auslastung aus der Differenz", () => {
    const A = `   7       0 loop0 10 0 20 0 0 0 0 0 0 0 0
   8       0 sda 1000 0 20000 500 2000 0 40000 800 0 1000 1300
   8       1 sda1 900 0 18000 400 1900 0 38000 700 0 900 1100
 253       0 dm-0 5 0 10 0 0 0 0 0 0 0 0
 259       0 nvme0n1 100 0 800 10 50 0 400 5 0 20 15
 259       1 nvme0n1p1 100 0 800 10 50 0 400 5 0 20 15
`;
    const B = `   7       0 loop0 10 0 20 0 0 0 0 0 0 0 0
   8       0 sda 1100 0 22048 500 2300 0 50240 800 0 3000 1300
   8       1 sda1 900 0 18000 400 1900 0 38000 700 0 900 1100
 253       0 dm-0 5 0 10 0 0 0 0 0 0 0 0
 259       0 nvme0n1 100 0 800 10 50 0 400 5 0 20 15
 259       1 nvme0n1p1 100 0 800 10 50 0 400 5 0 20 15
`;
    const a = parseDiskstats(A);
    expect(a.map((d) => d.device)).toEqual(["sda", "nvme0n1"]);
    const io = diskIoBetween(a, parseDiskstats(B), 10);
    const sda = io.find((d) => d.device === "sda");
    // 2048 Sektoren × 512 B / 10 s = 104857,6 B/s; 10240 × 512 / 10 = 524288 B/s
    expect(sda).toMatchObject({ readRate: 104858, writeRate: 524288, readIops: 10, writeIops: 30, busyPercent: 20 });
    expect(io.find((d) => d.device === "nvme0n1")).toMatchObject({ readRate: 0, writeRate: 0, busyPercent: 0 });
  });

  it("/proc/vmstat: Swap rein/raus, OOM-Kills, schwere Seitenfehler", () => {
    const v = parseVmstat("nr_free_pages 100\npswpin 12\npswpout 34\npgmajfault 56\noom_kill 2\n");
    expect(v).toEqual({ pswpin: 12, pswpout: 34, pgmajfault: 56, oomKill: 2 });
    expect(parseVmstat("pswpin 1\n").oomKill).toBeNull();
  });

  it("/proc/pressure/*: some/full avg10 und avg60", () => {
    const p = parsePressure("some avg10=1.50 avg60=0.75 avg300=0.10 total=123\nfull avg10=0.20 avg60=0.10 avg300=0.00 total=9\n");
    expect(p).toEqual({ some10: 1.5, some60: 0.75, full10: 0.2 });
    expect(parsePressure("some avg10=3.00 avg60=2.00 avg300=1.00 total=1\n")).toEqual({ some10: 3, some60: 2, full10: null });
    expect(parsePressure("kaputt")).toBeNull();
  });

  it("meminfo im Detail, offene Dateien, Virtualisierung, Docker-Info", () => {
    const m = parseMemDetail("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 40 kB\nShmem: 20 kB\nDirty: 8 kB\nMemAvailable: 500 kB\n");
    expect(m).toEqual({ free: 100 * 1024, buffers: 50 * 1024, cached: 300 * 1024, reclaimable: 40 * 1024, shmem: 20 * 1024, dirty: 8 * 1024 });
    expect(parseFileNr("2048\t0\t1048576\n")).toEqual({ used: 2048, max: 1048576 });
    expect(parseVirtualization("flags\t\t: fpu vme hypervisor sse\n", "QEMU", "Standard PC (Q35 + ICH9, 2009)")).toMatchObject({ isVirtual: true, label: "virtuelle Maschine (KVM/QEMU)" });
    expect(parseVirtualization("flags\t\t: fpu vme sse\n", "Server", "AX41").isVirtual).toBe(false);
    expect(parseDockerInfo({ ServerVersion: "27.3.1", Images: 42, Driver: "overlay2", DockerRootDir: "/var/lib/docker", Architecture: "x86_64", ContainersRunning: 20, ContainersStopped: 2 })).toEqual({
      version: "27.3.1",
      images: 42,
      storageDriver: "overlay2",
      rootDir: "/var/lib/docker",
      architecture: "x86_64",
    });
  });

  it("Verlauf: Ringpuffer hält höchstens N Punkte, der jüngste zuletzt", () => {
    const h = new HostHistory(3);
    for (let i = 0; i < 5; i++) h.push({ at: new Date(i * 10_000).toISOString(), cpu: i, memUsed: i, load1: i, diskRead: i, diskWrite: i });
    expect(h.points().map((p) => p.cpu)).toEqual([2, 3, 4]);
  });
});

describe("HostInfoReader mit zwei Messungen", () => {
  it("liefert Kerne, Platten-IO, Druck, Swap-Aktivität, Prozesse, Verlauf — und nichts Erfundenes", async () => {
    const proc = mkdtempSync(join(tmpdir(), "r3j-proc-"));
    const sys = mkdtempSync(join(tmpdir(), "r3j-sys-"));
    mkdirSync(join(proc, "pressure"));
    mkdirSync(join(proc, "sys", "fs"), { recursive: true });
    mkdirSync(join(sys, "class", "dmi", "id"), { recursive: true });
    writeFileSync(join(sys, "class", "dmi", "id", "sys_vendor"), "QEMU\n");
    writeFileSync(join(sys, "class", "dmi", "id", "product_name"), "Standard PC\n");
    writeFileSync(join(proc, "loadavg"), "0.50 0.40 0.30 2/345 999\n");
    writeFileSync(join(proc, "uptime"), "3600.00 7000.00\n");
    writeFileSync(join(proc, "meminfo"), "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 500 kB\nBuffers: 50 kB\nCached: 300 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
    writeFileSync(join(proc, "stat"), STAT_A);
    writeFileSync(join(proc, "cpuinfo"), "processor\t: 0\nmodel name\t: AMD EPYC\ncpu MHz\t\t: 2445.406\nflags\t\t: fpu hypervisor\nprocessor\t: 1\nmodel name\t: AMD EPYC\n");
    writeFileSync(join(proc, "diskstats"), "   8       0 sda 1000 0 20000 500 2000 0 40000 800 0 1000 1300\n");
    writeFileSync(join(proc, "vmstat"), "pswpin 0\npswpout 0\npgmajfault 10\noom_kill 0\n");
    writeFileSync(join(proc, "pressure", "cpu"), "some avg10=2.00 avg60=1.00 avg300=0.50 total=1\n");
    writeFileSync(join(proc, "sys", "fs", "file-nr"), "1500\t0\t100000\n");
    let t = Date.parse("2026-09-26T10:00:00Z");
    const reader = new HostInfoReader({ procDir: proc, sysDir: sys, osReleasePath: join(proc, "nope"), disks: [], now: () => t });
    const first = await reader.read();
    expect(first.cpuPercent).toBeNull();
    expect(first.cpuCores).toEqual([]);
    expect(first.history).toEqual([]);
    expect(first.processes).toMatchObject({ running: 3, blocked: 1, threads: 345 });
    expect(first.openFiles).toEqual({ used: 1500, max: 100000 });
    expect(first.virtualization).toMatchObject({ isVirtual: true });
    expect(first.cpuMHz).toBe(2445);
    expect(first.pressure.cpu).toEqual({ some10: 2, some60: 1, full10: null });
    expect(first.pressure.io).toBeNull();
    expect(first.memDetail?.cached).toBe(300 * 1024);

    t += 10_000;
    writeFileSync(join(proc, "stat"), STAT_B);
    writeFileSync(join(proc, "diskstats"), "   8       0 sda 1100 0 22048 500 2300 0 50240 800 0 3000 1300\n");
    writeFileSync(join(proc, "vmstat"), "pswpin 0\npswpout 0\npgmajfault 30\noom_kill 1\n");
    const second = await reader.read();
    expect(second.cpuPercent).toBeCloseTo(63, 0);
    expect(second.cpuCores.map((c) => Math.round(c.percent ?? -1))).toEqual([93, 28]);
    expect(second.contextSwitchRate).toBe(5000);
    expect(second.processes.forkRate).toBe(10);
    expect(second.diskIo[0]).toMatchObject({ device: "sda", writeRate: 524288, busyPercent: 20 });
    expect(second.oomKills).toBe(1);
    expect(second.swapInRate).toBe(0);
    expect(second.history).toHaveLength(1);
    expect(second.history[0]).toMatchObject({ cpu: expect.closeTo(63, 0), load1: 0.5, memUsed: 500 * 1024 });
    expect(second.missing.join(" ")).toMatch(/Druck/);
  });
});
