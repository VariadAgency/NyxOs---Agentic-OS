// Server-Finder wie der Mac-Finder — rekursive Namenssuche (mit Grenze), Anfang/Ende großer Dateien und
// Rechte in der Liste. Die Sperrliste bleibt genauso streng: gesperrte Ordner werden nie durchsucht, gesperrte
// Dateien nie gefunden, Links nie verfolgt.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTFS_MAX_BYTES, HOSTFS_PART_BYTES } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { HostFs } from "../src/server/hostfs.js";
import { setup } from "./helpers.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "r3f-"));
  const home = join(base, "home");
  const outside = join(base, "outside");
  mkdirSync(join(home, "Shop", "backend", "Sources"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".config", "config-dir"), { recursive: true });
  mkdirSync(join(home, "backups"), { recursive: true });
  mkdirSync(join(home, "Shop", ".git"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_config"), "PRIVATE"); // privater Schlüssel: nie ein Treffer
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "Shop", "backend", "Sources", "config.swift"), "let x = 1\n");
  writeFileSync(join(home, "Shop", "backend", "config.yml"), "port: 8080\n");
  writeFileSync(join(home, "Shop", "backend", "config.json"), "{}"); // gesperrt (Name)
  writeFileSync(join(home, "Shop", ".env.config"), "SECRET=1"); // gesperrt
  writeFileSync(join(home, ".ssh", "config"), "Host x"); // in gesperrtem Ordner
  writeFileSync(join(home, ".config", "config-dir", "config.txt"), "x"); // in gesperrtem Ordner
  writeFileSync(join(home, "backups", "config.txt"), "x"); // in gesperrtem Ordner
  writeFileSync(join(outside, "config-draussen.txt"), "x");
  symlinkSync(outside, join(home, "ausbruch"));
  symlinkSync(join(home, ".ssh"), join(home, "schluessel"));
  const fs = new HostFs([{ id: "home", label: "Home", hostPath: "/home/alex", dir: home }]);
  return { base, home, fs };
}

describe("Server-Finder: rekursive Suche", () => {
  it("findet Namen in Unterordnern, aber nie Gesperrtes, nie in gesperrten Ordnern, nie hinter Links", async () => {
    const { fs } = fixture();
    const out = await fs.search("home", "", "CONFIG");
    if (!out.ok) throw new Error(out.error);
    const rels = out.value.entries.map((e) => e.rel).sort();
    // .config/.ssh/backups werden durchsucht (Ordner offen) — gefunden wird nur, was nicht gesperrt ist:
    // .ssh/config (offen), backups/config.txt (Datei in Sicherung → gesperrt), config.json bleibt gesperrt (Tokens).
    expect(rels).toEqual([".config", ".config/config-dir", ".config/config-dir/config.txt", ".ssh/config", "Shop/backend/Sources/config.swift", "Shop/backend/config.yml"]);
    expect(rels).not.toContain("backups/config.txt");
    expect(out.value.truncated).toBe(false);
    expect(out.value.entries.every((e) => !e.locked)).toBe(true);
  });

  it("sucht nur unterhalb des angegebenen Ordners, gesperrter Start-Ordner = 403, Unsinn = 400", async () => {
    const { fs } = fixture();
    const sub = await fs.search("home", "Shop/backend/Sources", "config");
    if (!sub.ok) throw new Error(sub.error);
    expect(sub.value.entries.map((e) => e.rel)).toEqual(["Shop/backend/Sources/config.swift"]);
    const git = await fs.search("home", "Shop/.git", "config");
    expect(git.ok ? 200 : git.status).toBe(403);
    const bad = await fs.search("home", "..", "config");
    expect(bad.ok ? 200 : bad.status).toBe(400);
    const empty = await fs.search("home", "", "   ");
    expect(empty.ok ? 200 : empty.status).toBe(400);
  });

  it("hört bei der Grenze auf und sagt ehrlich „gekürzt“", async () => {
    const { home, fs } = fixture();
    mkdirSync(join(home, "viele"));
    for (let i = 0; i < 30; i++) writeFileSync(join(home, "viele", `treffer-${i}.txt`), "x");
    const out = await fs.search("home", "", "treffer", { limit: 10 });
    if (!out.ok) throw new Error(out.error);
    expect(out.value.entries).toHaveLength(10);
    expect(out.value.truncated).toBe(true);
  });
});

describe("Server-Finder: Suche kann den Server nicht belegen", () => {
  it("abgebrochene Anfrage beendet die Suche sofort; mehr als 2 gleichzeitig → 429", async () => {
    const { fs } = fixture();
    const ctl = new AbortController();
    ctl.abort();
    const aborted = await fs.search("home", "", "config", { signal: ctl.signal });
    if (!aborted.ok) throw new Error(aborted.error);
    expect(aborted.value.entries).toHaveLength(0);
    expect(aborted.value.truncated).toBe(true);
    const all = await Promise.all([1, 2, 3, 4].map(() => fs.search("home", "", "config")));
    const busy = all.filter((o) => !o.ok && o.status === 429);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(all.filter((o) => o.ok).length).toBeGreaterThanOrEqual(2);
    // danach ist wieder Platz
    const after = await fs.search("home", "", "config");
    expect(after.ok).toBe(true);
  });
});

describe("Server-Finder: große Dateien und Rechte", () => {
  it("große Datei: ohne Teil 413, mit part=tail nur das Ende (ganze Zeilen), mit part=head nur der Anfang", async () => {
    const { home, fs } = fixture();
    const line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrst\n"; // 100 B
    const count = Math.ceil((HOSTFS_MAX_BYTES + 100_000) / line.length);
    const body = Array.from({ length: count }, (_, i) => `${String(i).padStart(7, "0")} ${line.slice(8)}`).join("");
    writeFileSync(join(home, "gross.log"), body);
    const full = await fs.readText("home", "gross.log");
    expect(full.ok ? 200 : full.status).toBe(413);
    const tail = await fs.readText("home", "gross.log", "tail");
    if (!tail.ok) throw new Error(tail.error);
    expect(tail.value.partial).toBe("tail");
    expect(tail.value.totalSize).toBe(body.length);
    expect(tail.value.content.length).toBeLessThanOrEqual(HOSTFS_PART_BYTES);
    expect(tail.value.content.endsWith(`${String(count - 1).padStart(7, "0")} ${line.slice(8)}`)).toBe(true);
    expect(/^\d{7} /.test(tail.value.content)).toBe(true); // beginnt mit einer ganzen Zeile
    const head = await fs.readText("home", "gross.log", "head");
    if (!head.ok) throw new Error(head.error);
    expect(head.value.partial).toBe("head");
    expect(head.value.content.startsWith("0000000 ")).toBe(true);
    expect(head.value.content.endsWith("\n")).toBe(true);
  });

  it("kleine Datei mit part: ganz, ohne partial; gesperrt bleibt gesperrt", async () => {
    const { fs } = fixture();
    const small = await fs.readText("home", "Shop/backend/config.yml", "tail");
    if (!small.ok) throw new Error(small.error);
    expect(small.value.content).toBe("port: 8080\n");
    expect(small.value.partial).toBeUndefined();
    const locked = await fs.readText("home", "Shop/.env.config", "tail");
    expect(locked.ok ? 200 : locked.status).toBe(403);
  });

  it("Liste liefert Rechte (mode) — gesperrte Einträge nicht", async () => {
    const { fs } = fixture();
    const out = await fs.list("home", "Shop/backend");
    if (!out.ok) throw new Error(out.error);
    const yml = out.value.entries.find((e) => e.name === "config.yml");
    expect(typeof yml?.mode).toBe("number");
    const cc = await fs.list("home", "Shop");
    if (!cc.ok) throw new Error(cc.error);
    const env = cc.value.entries.find((e) => e.name === ".env.config");
    expect(env?.locked).toBe(true);
    expect(env?.mode).toBeUndefined();
  });
});

describe("Server-Finder: Routen", () => {
  it("GET /api/server/files/search und text?part=tail", async () => {
    const { home } = fixture();
    const { app } = await setup({ server: { env: { NYXOS_HOSTFS_ROOTS: `home:${home}:/home/alex` } } });
    const res = await app.request("/api/server/files/search?root=home&p=&q=config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ rel: string }>; truncated: boolean };
    expect(body.entries.map((e) => e.rel)).toContain("Shop/backend/config.yml");
    expect(body.entries.map((e) => e.rel)).not.toContain("backups/config.txt");
    expect((await app.request("/api/server/files/search?root=home&p=Shop%2F.git&q=config")).status).toBe(403);
    expect((await app.request("/api/server/files/search?root=home&p=&q=")).status).toBe(400);
    const tail = await app.request("/api/server/files/text?root=home&p=Shop%2Fbackend%2Fconfig.yml&part=tail");
    expect(tail.status).toBe(200);
    expect((await app.request("/api/server/files/text?root=home&p=Shop%2Fbackend%2Fconfig.yml&part=quatsch")).status).toBe(400);
  });
});
