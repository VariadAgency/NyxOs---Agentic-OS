// Sperrregel feiner (der Nutzer ist Eigentümer und angemeldet):
// ORDNER wie .ssh, .config, .cache, .claude, backups dürfen geöffnet und durchsucht werden — gesperrt bleiben
// DATEIEN mit Geheimnis-Inhalt, der Inhalt von .git und /proc. Eine Funktion, eine Tabelle.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostFs, isSecretPath } from "../src/server/hostfs.js";
import { setup } from "./helpers.js";

/** [Pfad, Ordner?] — ERLAUBT */
const ALLOWED: Array<[string, boolean]> = [
  [".ssh", true], [".config", true], [".cache", true], [".local", true], [".claude", true], [".docker", true], [".npm", true], [".codex", true],
  ["backups", true], ["backups/2026-09", true], ["snapshots", true], ["Shop/backups", true],
  [".ssh/id_ed25519.pub", false], [".ssh/authorized_keys", false], [".ssh/known_hosts", false], [".ssh/config", false],
  [".config/nvim/init.lua", false], [".cache/pip/log.txt", false], [".local/share/app/state.txt", false],
  [".claude/projects", true], [".claude/agents/reviewer.md", false], [".npm/_logs/debug.log", false],
  ["secrets", true], ["Shop/backend/secrets", true], ["monkey.txt", false], ["keyboard-layout.md", false],
  ["README.md", false], ["logs/app.log", false], ["var/log/syslog", false], ["environment.md", false], ["keyboard.txt", false],
  ["Info.plist", false], ["package.json", false], [".bashrc", false], [".profile", false], [".gitignore", false], [".github/workflows/ci.yml", false],
  ["etc/ssh/ssh_host_ed25519_key.pub", false], ["keys.md", false],
];

/** [Pfad, Ordner?] — GESPERRT */
const LOCKED: Array<[string, boolean]> = [
  [".claude/projects/-home-alex/abc.jsonl", false], [".codex/sessions/2026/09/26/r.jsonl", false],
  [".env", false], [".env.local", false], ["app/.env.production", false], ["prod.env", false], [".envrc", false], ["APP/.ENV", false],
  ["certs/site.pem", false], ["x/tls.key", false], ["a.p12", false], ["AuthKey_ABC.p8", false],
  [".ssh/id_ed25519", false], [".ssh/id_rsa", false], ["etc/ssh/ssh_host_ed25519_key", false], ["deploy_key", false],
  ["credentials", false], [".aws/credentials", false], [".claude/.credentials.json", false], ["credentials.json", false],
  ["github_token.txt", false], [".vault-token", false], ["my-secret.txt", false], ["client_secret.json", false],
  [".netrc", false], [".pgpass", false], [".npmrc", false], [".git-credentials", false], [".docker/config.json", false],
  ["docker-compose.yml", false], ["compose.override.yaml", false], ["Shop/backend/docker-compose.prod.yml", false], ["Docker-Compose.YML", false],
  ["app.db", false], ["data.sqlite", false], ["data.sqlite3", false], ["dump.sql", false], ["db.dump", false], ["dump.sql.gz", false], ["old.bak", false],
  ["backups/readme.txt", false], ["backups/2026/cc.tar", false], ["Shop/backups/x.txt", false], ["snapshots/x.txt", false],
  [".git", true], ["repo/.git", true], [".git/objects", true], [".git/config", false], ["repo/.git/objects/ab/cdef", false], ["mirror.git", true], ["mirror.git/config", false],
  [".config/gh/hosts.yml", false], [".codex/auth.json", false], [".bash_history", false], [".config/rclone/rclone.conf", false],
  ["proc", true], ["proc/1/environ", false],
  [".gnupg", true], ["pgdata", true], ["postgres-data/base", true],
  // Lecks der ersten Fassung
  ["nyxos/github_deploy_key_ro", false], ["deploy.key.txt", false],
  [".ssh/github", false], [".ssh/server", false], [".ssh/nas_ed25519", false], [".ssh/deploy", false],
  ["secrets/db.txt", false], ["Shop/backend/secrets/other.txt", false], ["private/notes.txt", false], ["credentials/prod.json", false],
  ["etc/ssl/private/snakeoil", false], ["vault/data/x", false],
  ["db.pgdump", false], ["db.backup", false], ["nas-backup/a.txt", false], ["backup_2026/a.txt", false], ["dumps/prod.custom", false],
  [".config/github-copilot/hosts.json", false], [".config/hcloud/cli.toml", false], [".config/.wrangler/config/default.toml", false],
  [".config/ngrok/ngrok.yml", false], [".config/doctl/config.yaml", false], [".config/netlify/config.json", false], [".mc/config.json", false],
  [".aws/sso/cache/a.json", false], [".aws/config", false], [".config/sops/age/keys.txt", false], [".config/borg/keys/x", false],
  ["nats/user.creds", false], ["nats/seed.nk", false], ["x/kubeconfig", false], [".config/gcloud/legacy_credentials/a/adc.json", false],
  [".local/share/fish/fish_history", false], [".local/share/zsh/history", false], [".codex/history.jsonl", false],
  [".claude/settings.json", false], [".claude/settings.local.json", false], [".codex/config.toml", false],
  // Claude-Code-Dateiverlauf (Kopien bearbeiteter Dateien, auch .env/Compose), Einfüge-Speicher,
  // archivierte Codex-Mitschnitte
  [".claude/file-history/0b1c2d3e/4f5a6b7c8d9e0f1a@v2", false], [".claude/paste-cache/abc123.txt", false],
  [".codex/archived_sessions/rollout-2026-09-01.jsonl", false],
];

describe("Sperrregel isSecretPath (Tabelle)", () => {
  it.each(ALLOWED)("erlaubt: %s (Ordner: %s)", (rel, isDir) => {
    expect(isSecretPath(rel, isDir)).toBe(false);
  });
  it.each(LOCKED)("gesperrt: %s (Ordner: %s)", (rel, isDir) => {
    expect(isSecretPath(rel, isDir)).toBe(true);
  });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "r4l-"));
  mkdirSync(join(home, ".ssh"));
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  mkdirSync(join(home, "backups", "2026"), { recursive: true });
  mkdirSync(join(home, "repo", ".git"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA alex");
  writeFileSync(join(home, ".ssh", "config"), "Host shop\n");
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_x\n");
  writeFileSync(join(home, ".config", "gh", "config.yml"), "editor: vim\n");
  writeFileSync(join(home, "backups", "2026", "notiz.txt"), "Sicherung\n");
  writeFileSync(join(home, "repo", ".git", "config"), "url = https://x:ghp@github.com/a\n");
  const fs = new HostFs([{ id: "home", label: "Home", hostPath: "/home/alex", dir: home }]);
  return { home, fs };
}

describe("Herunterladen (raw?download=1): dieselben Prüfungen wie text, Größengrenze, immer als Anhang", () => {
  it("offene Datei → attachment; Geheimnis → 403; über 2 MB → 413", async () => {
    const { home } = fixture();
    writeFileSync(join(home, "gross.txt"), Buffer.alloc(2 * 1024 * 1024 + 10, 0x61));
    const { app } = await setup({ server: { env: { NYXOS_HOSTFS_ROOTS: `home:${home}:/home/alex` } } });
    const ok = await app.request("/api/server/files/raw?root=home&p=.ssh%2Fid_ed25519.pub&download=1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(ok.headers.get("content-type")).toBe("application/octet-stream");
    expect((await app.request("/api/server/files/raw?root=home&p=.ssh%2Fid_ed25519&download=1")).status).toBe(403);
    expect((await app.request("/api/server/files/raw?root=home&p=backups%2F2026%2Fnotiz.txt&download=1")).status).toBe(403);
    expect((await app.request("/api/server/files/raw?root=home&p=gross.txt&download=1")).status).toBe(413);
  });
});

describe("Sperrregel am Dateisystem", () => {
  it("Ordner .ssh / .config / backups öffnen sich; Geheimnis-Dateien darin bleiben gesperrt", async () => {
    const { fs } = fixture();
    const ssh = await fs.list("home", ".ssh");
    if (!ssh.ok) throw new Error(ssh.error);
    const byName = Object.fromEntries(ssh.value.entries.map((e) => [e.name, e]));
    expect(byName.id_ed25519).toMatchObject({ locked: true, size: 0, mtimeMs: 0 });
    expect(byName["id_ed25519.pub"]?.locked).toBe(false);
    expect((await fs.readText("home", ".ssh/id_ed25519.pub")).ok).toBe(true);
    expect((await fs.readText("home", ".ssh/config")).ok).toBe(true);
    const key = await fs.readText("home", ".ssh/id_ed25519");
    expect(key.ok ? 200 : key.status).toBe(403);
    const hosts = await fs.readRaw("home", ".config/gh/hosts.yml");
    expect(hosts.ok ? 200 : hosts.status).toBe(403);
    expect((await fs.readText("home", ".config/gh/config.yml")).ok).toBe(true);
    const backups = await fs.list("home", "backups/2026");
    if (!backups.ok) throw new Error(backups.error);
    expect(backups.value.entries[0]).toMatchObject({ name: "notiz.txt", locked: true });
    const inBackup = await fs.readText("home", "backups/2026/notiz.txt");
    expect(inBackup.ok ? 200 : inBackup.status).toBe(403);
  });

  it(".git bleibt zu (Liste 403, Datei 403), die Liste zeigt .git als gesperrten Ordner", async () => {
    const { fs } = fixture();
    const git = await fs.list("home", "repo/.git");
    expect(git.ok ? 200 : git.status).toBe(403);
    const cfg = await fs.readText("home", "repo/.git/config");
    expect(cfg.ok ? 200 : cfg.status).toBe(403);
    const repo = await fs.list("home", "repo");
    if (!repo.ok) throw new Error(repo.error);
    expect(repo.value.entries.find((e) => e.name === ".git")).toMatchObject({ isDir: true, locked: true });
  });

  it("Suche: durchsucht .ssh/.config/backups, findet nie Geheimnis-Dateien", async () => {
    const { fs } = fixture();
    const out = await fs.search("home", "", "config");
    if (!out.ok) throw new Error(out.error);
    const rels = out.value.entries.map((e) => e.rel).sort();
    expect(rels).toEqual([".config", ".config/gh/config.yml", ".ssh/config"]);
    const keys = await fs.search("home", "", "id_ed25519");
    if (!keys.ok) throw new Error(keys.error);
    expect(keys.value.entries.map((e) => e.rel)).toEqual([".ssh/id_ed25519.pub"]);
    const notes = await fs.search("home", "", "notiz");
    if (!notes.ok) throw new Error(notes.error);
    expect(notes.value.entries).toEqual([]);
  });
});
