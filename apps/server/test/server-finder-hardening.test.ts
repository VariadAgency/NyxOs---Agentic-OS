// Server-Finder gehärtet. Der API-Container läuft als uid 1000 (= alex auf dem Server),
// die Sperrliste ist also die einzige Hürde vor 0600-Dateien. Lieber zu viel sperren als ein Leck.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostFs, isLockedRel } from "../src/server/hostfs.js";
import { setup } from "./helpers.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "r3k-"));
  mkdirSync(join(home, "Shop", "backend", "caddy"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  mkdirSync(join(home, "Shop", ".git"), { recursive: true });
  writeFileSync(join(home, "Shop", "backend", "docker-compose.yml"), "POSTGRES_PASSWORD: inline-geheim\n");
  writeFileSync(join(home, "Shop", "backend", "caddy", "Caddyfile"), "basic_auth { alex $2a$14$hash }\n");
  writeFileSync(join(home, "Shop", ".git", "config"), "url = https://alex:ghp_x@github.com/a/b\n");
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_x\n");
  writeFileSync(join(home, "Shop", "backend", "AuthKey_ABC123.p8"), "-----BEGIN PRIVATE KEY-----\n");
  writeFileSync(join(home, "Shop", "backend", "README.md"), "# ok\n");
  writeFileSync(join(home, "notiz.txt"), "hallo\n");
  writeFileSync(join(home, "seite.html"), "<script>alert(1)</script>\n");
  writeFileSync(join(home, "bild.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>\n");
  const fs = new HostFs([{ id: "home", label: "Home", hostPath: "/home/alex", dir: home }]);
  return { home, fs };
}

describe("Sperrliste (konservativ)", () => {
  it("sperrt Compose, env-Varianten, Werkzeug-Ordner, Verläufe, Zertifikate, Apple-Schlüssel, Archive, DB-Dateien", () => {
    const locked = [
      "Shop/backend/docker-compose.yml", "docker-compose.override.yml", "compose.yaml", "docker-compose.prod.yaml",
      "env", "backend/env", "prod.env", "env.production", "app.env.local", ".envrc", "docker-env.txt",
      "Shop/.git/config", "mirror.git/config", ".config/rclone/rclone.conf", "rclone.conf", ".config/gh/hosts.yml",
      ".kube/config", "wg0.conf", "etc/wireguard/wg0.conf", ".netrc", ".pgpass", ".npmrc", ".yarnrc.yml", ".my.cnf",
      ".bash_history", ".sh_history", ".rediscli_history", ".lesshst", ".viminfo",
      "backend/caddy/Caddyfile", "Caddyfile.dev", "caddy/site.crt", "tls/fullchain.cer", "acme.json", ".htpasswd",
      "AuthKey_ABC123.p8", ".docker/config.json", "firebase-adminsdk.json", "GoogleService-Info.plist", "service-account.json",
      "github_token.txt", "api_key.txt", ".local/share/keyrings/login.keyring",
      "nas/cc-snapshot_20260822.tar.gz", "backup.zip", "app.sqlite", "data.db", "dump.rdb", "terraform.tfstate",
      "etc/ssh/ssh_host_ed25519_key", "x/.swp", "notes.txt.swp",
      "APP/.ENV", "Docker-Compose.YML",
    ];
    for (const rel of locked) expect(isLockedRel(rel), rel).toBe(true);
    const open = ["README.md", "backend/Sources/App/routes.swift", "logs/app.log", "var/log/syslog", "keyboard.txt", "environment.md", "nginx/site.conf", "Info.plist", "package.json"];
    for (const rel of open) expect(isLockedRel(rel), rel).toBe(false);
  });

  it("Datei-Zugriffe darauf enden mit 403 „gesperrt“ — auch Liste der gesperrten Ordner", async () => {
    const { fs } = fixture();
    for (const rel of ["Shop/backend/docker-compose.yml", "Shop/backend/caddy/Caddyfile", "Shop/.git/config", ".config/gh/hosts.yml", "Shop/backend/AuthKey_ABC123.p8"]) {
      const out = await fs.readRaw("home", rel);
      expect(out.ok, rel).toBe(false);
      if (!out.ok) expect(out.status, rel).toBe(403);
    }
    // Ordner wie .config öffnen sich jetzt (Geheimnis-Dateien darin bleiben zu) — .git bleibt ganz zu.
    expect((await fs.list("home", ".config")).ok).toBe(true);
    for (const rel of ["Shop/.git"]) {
      const out = await fs.list("home", rel);
      expect(out.ok, rel).toBe(false);
      if (!out.ok) expect(out.status, rel).toBe(403);
    }
  });

  it("Liste: gesperrte Einträge nur mit Namen — ohne Größe und Änderungszeit", async () => {
    const { fs } = fixture();
    const out = await fs.list("home", "Shop/backend");
    if (!out.ok) throw new Error(out.error);
    const compose = out.value.entries.find((e) => e.name === "docker-compose.yml");
    expect(compose).toMatchObject({ locked: true, size: 0, mtimeMs: 0 });
    const readme = out.value.entries.find((e) => e.name === "README.md");
    expect(readme?.locked).toBe(false);
    expect(readme?.size).toBeGreaterThan(0);
  });

  it("FIFO/Sonderdatei blockiert den Server nicht (sofort abgelehnt statt ewig warten)", async () => {
    const { home, fs } = fixture();
    execFileSync("mkfifo", [join(home, "rohr")]);
    const started = Date.now();
    const out = await fs.readRaw("home", "rohr");
    expect(out.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("Routen", () => {
  it("ohne Anmeldung: alle vier Finder-Wege und /api/server/host → 401 (HEAD nie 200)", async () => {
    const { home } = fixture();
    const { app } = await setup({ signedIn: false, server: { env: { NYXOS_HOSTFS_ROOTS: `home:${home}:/home/alex` } } });
    for (const p of ["/api/server/files/roots", "/api/server/files/list?root=home&p=", "/api/server/files/text?root=home&p=notiz.txt", "/api/server/files/raw?root=home&p=notiz.txt", "/api/server/host"]) {
      expect((await app.request(p)).status, p).toBe(401);
      // HEAD scheitert schon vorher an der Content-Type-Pflicht (415) — Hauptsache nie 200.
      expect((await app.request(p, { method: "HEAD" })).status, `HEAD ${p}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("raw: HTML/SVG/Text nie inline, immer Download in Sandbox mit nosniff", async () => {
    const { home } = fixture();
    const { app } = await setup({ server: { env: { NYXOS_HOSTFS_ROOTS: `home:${home}:/home/alex` } } });
    for (const name of ["seite.html", "bild.svg", "notiz.txt"]) {
      const res = await app.request(`/api/server/files/raw?root=home&p=${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), name).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), name).toMatch(/sandbox/);
      expect(res.headers.get("x-frame-options"), name).toBe("DENY");
    }
    const compose = await app.request("/api/server/files/text?root=home&p=Shop%2Fbackend%2Fdocker-compose.yml");
    expect(compose.status).toBe(403);
    expect(await compose.text()).not.toContain("inline-geheim");
  });
});

describe("kein /proc des Hosts", () => {
  // Als uid 1000 (= alex auf dem Server) wären über /host/proc die Umgebung (/proc/<pid>/environ) und das
  // Dateisystem (/proc/<pid>/root) jedes Host-Prozesses von alex lesbar. Darum: gar nicht einhängen.
  const repo = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

  it("Compose hängt /proc nicht ein, keine NYXOS_HOST_PROC", () => {
    const compose = repo("infra/docker-compose.yml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(compose).not.toMatch(/source:\s*\/proc\b/);
    expect(compose).not.toMatch(/\/host\/proc/);
    expect(compose).not.toMatch(/NYXOS_HOST_PROC/);
    expect(repo("infra/docker-compose.hostfs.example.yml")).not.toMatch(/source:\s*\/proc\b/);
  });

  it("hostinfo.ts liest kein fremdes /proc (kein NYXOS_HOST_PROC, kein /proc/<pid>/net)", () => {
    const src = repo("apps/server/src/server/hostinfo.ts").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/NYXOS_HOST_PROC/);
    expect(src).not.toMatch(/"1", "net"/);
  });
});
