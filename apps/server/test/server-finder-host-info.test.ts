// Server-Finder (nur lesen) + Host-Daten. Pfad-Ausbruch, Symlink-Ausbruch und Sperrliste müssen halten.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostFs, isLockedRel, parseHostFsRoots } from "../src/server/hostfs.js";
import { publishedPorts } from "../src/server/docker.js";
import { HostInfoReader, parseMeminfo, parseNetDev, readTemperatures } from "../src/server/hostinfo.js";
import { needsAuth } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "r3h-"));
  const home = join(base, "home");
  const outside = join(base, "outside");
  mkdirSync(join(home, "Shop", "backend"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "Shop", "backend", "README.md"), "# Hallo Server\n");
  writeFileSync(join(home, "Shop", ".env"), "DB_PASSWORD=geheim\n");
  writeFileSync(join(home, "Shop", "server.key"), "KEY");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, "bild.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(outside, "passwd.txt"), "root:x:0:0");
  symlinkSync(outside, join(home, "ausbruch"));
  symlinkSync(join(outside, "passwd.txt"), join(home, "ausbruch.txt"));
  symlinkSync(join(home, ".ssh"), join(home, "schluessel"));
  symlinkSync(join(home, "Shop", "backend", "README.md"), join(home, "readme-link.md"));
  const fs = new HostFs([{ id: "home", label: "Home", hostPath: "/home/alex", dir: home }]);
  return { base, home, fs };
}

describe("Server-Finder", () => {
  it("liest Wurzeln aus NYXOS_HOSTFS_ROOTS (id:Container-Pfad:Host-Pfad)", () => {
    const roots = parseHostFsRoots("home:/hostfs/home:/home/alex, log:/hostfs/log:/var/log, kaputt, ../x:/a:/b");
    expect(roots.map((r) => r.id)).toEqual(["home", "log"]);
    expect(roots[0]).toMatchObject({ dir: "/hostfs/home", hostPath: "/home/alex" });
  });

  it("listet einen Ordner und markiert Geheimes als gesperrt", async () => {
    const { fs } = fixture();
    const out = await fs.list("home", "Shop");
    if (!out.ok) throw new Error(out.error);
    const byName = Object.fromEntries(out.value.entries.map((e) => [e.name, e]));
    expect(byName.backend?.isDir).toBe(true);
    expect(byName[".env"]?.locked).toBe(true);
    expect(byName["server.key"]?.locked).toBe(true);
  });

  it("lehnt Pfad-Ausbruch mit .. / absoluten Pfaden / NUL ab (400)", async () => {
    const { fs } = fixture();
    for (const rel of ["..", "../outside", "Shop/../../outside", "/etc/passwd", "a\0b", "./Shop", "Shop//backend"]) {
      const out = await fs.list("home", rel);
      expect(out.ok, rel).toBe(false);
      if (!out.ok) expect(out.status, rel).toBe(400);
    }
    const unknown = await fs.list("etc", "");
    expect(unknown.ok).toBe(false);
  });

  it("folgt keinem Symlink aus der Wurzel hinaus (403), wohl aber einem nach innen", async () => {
    const { fs } = fixture();
    const dir = await fs.list("home", "ausbruch");
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.status).toBe(403);
    const file = await fs.readText("home", "ausbruch.txt");
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.status).toBe(403);
    const inside = await fs.readText("home", "readme-link.md");
    expect(inside.ok && inside.value.content).toBe("# Hallo Server\n");
    // Ausbrechende Links tauchen in der Liste gar nicht erst auf.
    const root = await fs.list("home", "");
    if (!root.ok) throw new Error(root.error);
    expect(root.value.entries.map((e) => e.name)).not.toContain("ausbruch");
  });

  it("Sperrliste: .env, Schlüssel (auch über einen Symlink) → 403 „gesperrt“; der Ordner .ssh selbst öffnet sich", async () => {
    const { fs } = fixture();
    expect((await fs.list("home", ".ssh")).ok).toBe(true);
    expect((await fs.list("home", "schluessel")).ok).toBe(true);
    for (const rel of ["Shop/.env", "Shop/server.key", ".ssh/id_ed25519", "schluessel/id_ed25519"]) {
      const out = await fs.readText("home", rel);
      expect(out.ok, rel).toBe(false);
      if (!out.ok) {
        expect(out.status, rel).toBe(403);
        expect(out.error, rel).toMatch(/gesperrt/i);
      }
    }
  });

  it("isLockedRel erkennt typische Geheimnisse", () => {
    for (const rel of [".env", "app/.env.production", "certs/site.pem", "x/tls.key", "id_rsa", "my-secret.txt", "backups/snapshots/a.tar", "postgres-data/base", "shadow", ".git-credentials", "dump.sql", ".bash_history", ".config/gh/hosts.yml", ".codex/auth.json", ".claude/.credentials.json"]) {
      expect(isLockedRel(rel), rel).toBe(true);
    }
    // Compose-Dateien sind jetzt gesperrt (Passwörter stehen auf dem Server oft inline).
    for (const rel of ["README.md", "logs/app.log", "keyboard.txt", "backend/Sources/App/routes.swift", "App/Info.plist", "var/log/syslog"]) {
      expect(isLockedRel(rel), rel).toBe(false);
    }
  });

  it("liest Text, erkennt Binärdateien und liefert Bilder roh", async () => {
    const { fs } = fixture();
    const text = await fs.readText("home", "Shop/backend/README.md");
    expect(text.ok && text.value.content).toBe("# Hallo Server\n");
    const bin = await fs.readText("home", "bild.png");
    expect(bin.ok).toBe(false);
    if (!bin.ok) expect(bin.status).toBe(415);
    const raw = await fs.readRaw("home", "bild.png");
    expect(raw.ok && raw.value.bytes.length).toBe(8);
  });
});

describe("Host-Daten", () => {
  it("parst /proc/meminfo, /proc/net/dev und veröffentlichte Ports aus der Container-Liste", () => {
    const mem = parseMeminfo("MemTotal:       16000 kB\nMemAvailable:    8000 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n");
    expect(mem).toEqual({ memTotal: 16000 * 1024, memAvailable: 8000 * 1024, swapTotal: 2048 * 1024, swapFree: 1024 * 1024 });
    const dev = parseNetDev("Inter-|   Receive\n face |bytes\n    lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n  eth0: 5000 10 0 0 0 0 0 0 7000 12 0 0 0 0 0 0\n");
    expect(dev).toEqual([{ iface: "eth0", rxBytes: 5000, txBytes: 7000 }]);
    // Ports kommen aus Docker (veröffentlichte Ports laufender Container), nicht aus /proc des Hosts.
    const ports = publishedPorts([
      { name: "shop-caddy", state: "running", ports: [
        { IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
        { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
        { PrivatePort: 2019, Type: "tcp" },
      ] },
      { name: "nyxos-api", state: "running", ports: [{ IP: "127.0.0.1", PrivatePort: 8080, PublicPort: 47800, Type: "tcp" }] },
      { name: "alt", state: "exited", ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }] },
    ]);
    expect(ports).toEqual([
      { port: 443, bind: "alle", proto: "tcp", target: 443, container: "shop-caddy" },
      { port: 47800, bind: "lokal", proto: "tcp", target: 8080, container: "nyxos-api" },
    ]);
  });

  it("liest Temperaturen aus hwmon/thermal und ist auf einer VM ohne Sensoren still leer", async () => {
    const base = mkdtempSync(join(tmpdir(), "r3h-sys-"));
    mkdirSync(join(base, "class", "hwmon", "hwmon0"), { recursive: true });
    writeFileSync(join(base, "class", "hwmon", "hwmon0", "name"), "coretemp\n");
    writeFileSync(join(base, "class", "hwmon", "hwmon0", "temp1_input"), "45000\n");
    writeFileSync(join(base, "class", "hwmon", "hwmon0", "temp1_label"), "Package id 0\n");
    mkdirSync(join(base, "class", "thermal", "thermal_zone0"), { recursive: true });
    writeFileSync(join(base, "class", "thermal", "thermal_zone0", "type"), "x86_pkg_temp\n");
    writeFileSync(join(base, "class", "thermal", "thermal_zone0", "temp"), "47500\n");
    const temps = await readTemperatures(base);
    expect(temps).toEqual([
      { label: "coretemp · Package id 0", celsius: 45 },
      { label: "x86_pkg_temp", celsius: 47.5 },
    ]);
    expect(await readTemperatures(join(base, "gibt-es-nicht"))).toEqual([]);
  });

  it("HostInfoReader sammelt alles und nennt Fehlendes in einfachen Worten", async () => {
    const proc = mkdtempSync(join(tmpdir(), "r3h-proc-"));
    writeFileSync(join(proc, "loadavg"), "0.50 0.40 0.30 1/200 999\n");
    writeFileSync(join(proc, "uptime"), "3600.00 7000.00\n");
    writeFileSync(join(proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
    writeFileSync(join(proc, "stat"), "cpu  100 0 100 800 0 0 0 0 0 0\n");
    writeFileSync(join(proc, "cpuinfo"), "processor\t: 0\nmodel name\t: AMD Ryzen 7 3700X\nprocessor\t: 1\nmodel name\t: AMD Ryzen 7 3700X\n");
    const reader = new HostInfoReader({ procDir: proc, sysDir: join(proc, "nosys"), osReleasePath: join(proc, "nope"), disks: [], now: () => Date.parse("2026-09-26T10:00:00Z") });
    const info = await reader.read();
    expect(info.load).toEqual([0.5, 0.4, 0.3]);
    expect(info.uptimeSeconds).toBe(3600);
    expect(info.bootedAt).toBe("2026-09-26T09:00:00.000Z");
    expect(info.cpuModel).toBe("AMD Ryzen 7 3700X");
    expect(info.cores).toBe(2);
    expect(info.memTotal).toBe(1000 * 1024);
    expect(info.temperatures).toEqual([]);
    expect(info.missing.join(" ")).toMatch(/Temperatur/);
    expect(info.missing.join(" ")).toMatch(/Netz: nur der NyxOS-Container/);
    expect(info.ports).toEqual([]);
    expect(info.tailscale).toBeNull();
    const withDocker = await reader.read({ running: 1, total: 1, version: "27", published: [{ port: 443, bind: "alle", proto: "tcp", target: 443, container: "caddy" }] });
    expect(withDocker.ports).toHaveLength(1);
    expect(withDocker.containersRunning).toBe(1);
  });
});

describe("Anmeldung", () => {
  it("Server-Dateien und Host-Daten nur mit Anmeldung — auch wenn Lesen sonst frei ist", async () => {
    for (const p of ["/api/server/files/roots", "/api/server/files/list", "/api/server/files/raw", "/api/server/host"]) {
      expect(needsAuth("GET", p, false), p).toBe(true);
    }
    expect(needsAuth("GET", "/api/server", false)).toBe(false);
  });
});

describe("Routen", () => {
  it("GET /api/server/files/* über die App: Liste, Text, Sperre, Bild inline in der Sandbox; /api/server/host antwortet", async () => {
    const { home } = fixture();
    const { app } = await setup({ server: { env: { NYXOS_HOSTFS_ROOTS: `home:${home}:/home/alex` } } });
    const roots = (await (await app.request("/api/server/files/roots")).json()) as { roots: Array<{ id: string; exists: boolean }> };
    expect(roots.roots).toEqual([expect.objectContaining({ id: "home", exists: true })]);
    const list = await app.request("/api/server/files/list?root=home&p=Shop");
    expect(list.status).toBe(200);
    const text = await app.request("/api/server/files/text?root=home&p=Shop%2Fbackend%2FREADME.md");
    expect(((await text.json()) as { content: string }).content).toBe("# Hallo Server\n");
    const env = await app.request("/api/server/files/text?root=home&p=Shop%2F.env");
    expect(env.status).toBe(403);
    const up = await app.request("/api/server/files/list?root=home&p=..");
    expect(up.status).toBe(400);
    const img = await app.request("/api/server/files/raw?root=home&p=bild.png");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toMatch(/sandbox/);
    const host = await app.request("/api/server/host");
    expect(host.status).toBe(200);
    const info = (await host.json()) as { missing: string[]; checkedAt: string };
    expect(typeof info.checkedAt).toBe("string");
  });
});
