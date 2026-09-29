// Onboarding: project folder detection and folder picker in a throw-away home folder (never the real one).
// Sessions (Claude/Codex transcripts with a `cwd`) are the strongest signal, then a shallow scan for Git repos.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_CAP_SETUP_BROWSE, SETUP_RPC_BROWSE, ServerToBridgeSchema, SetupBrowseResultSchema, SetupStateSchema } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { saveConfig, paths, type BridgeConfig } from "../src/config.js";
import { BrowseError, browseFolder } from "../src/setup-browse.js";
import { cwdFromHead, detectProjectRoots, ProtectedGate, rootForProject, visiblePart } from "../src/setup-detect.js";
import { detectPackageManager, SetupService } from "../src/setup.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

let n = 0;
/** A Claude transcript whose first line has no cwd (like the real `mode`/`queue-operation` lines). */
function claudeSession(home: string, cwd: string, ageMin = 0) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `s${++n}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "mode", mode: "normal" })}\n${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  const t = new Date(Date.now() - ageMin * 60_000);
  utimesSync(dir, t, t);
}

function codexSession(home: string, cwd: string, day = "20", ageMin = 0) {
  const dir = join(home, ".codex", "sessions", "2026", "09", day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-${day}T10-00-00-${++n}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ timestamp: "2026-09-20T10:00:00Z", type: "session_meta", payload: { id: "x", cwd, instructions: "…" } })}\n`);
  const t = new Date(Date.now() - ageMin * 60_000);
  utimesSync(file, t, t);
}

function repo(...parts: string[]) {
  mkdirSync(join(...parts, ".git"), { recursive: true });
}

/** Home folder with sessions in ~/code (Claude, three sessions, one from a hidden worktree), ~/work/api (Codex),
 * a repo directly in home (~/myapp), sessions in home itself and in a temp folder, plus repos only the scan finds. */
function world() {
  const home = tempDir("nyxos-detect-");
  const elsewhere = tempDir("nyxos-tmp-");
  repo(home, "code", "shop");
  repo(home, "code", "blog");
  mkdirSync(join(home, "code", "shop", "src"), { recursive: true });
  mkdirSync(join(home, "code", "shop", ".claude", "worktrees", "agent-1"), { recursive: true });
  writeFileSync(join(home, "code", "shop", ".claude", "worktrees", "agent-1", ".git"), "gitdir: ../../../.git/worktrees/agent-1\n");
  repo(home, "work", "api");
  repo(home, "myapp");
  repo(home, "Sites", "portfolio");
  repo(home, "Documents", "GitHub", "tool");
  repo(home, "node_modules", "pkg");
  mkdirSync(join(home, "Music", "band", ".git"), { recursive: true });
  claudeSession(home, join(home, "code", "shop", "src"));
  claudeSession(home, join(home, "code", "blog"), 5);
  // Arbeitsordner, den es nicht mehr gibt: zählt für den Ordner drumherum.
  claudeSession(home, join(home, "code", "shop", "gelöscht"), 7);
  claudeSession(home, join(home, "code", "shop", ".claude", "worktrees", "agent-1"), 10);
  claudeSession(home, home, 1);
  claudeSession(home, join(elsewhere, "scratch"), 1);
  mkdirSync(join(elsewhere, "scratch"), { recursive: true });
  codexSession(home, join(home, "work", "api"));
  codexSession(home, join(home, "myapp"), "19", 60);
  return { home, elsewhere, opts: { home, claudeDir: join(home, ".claude"), codexDir: join(home, ".codex"), platform: "linux" as const, tmpDirs: [elsewhere] } };
}

describe("Projektordner erkennen", () => {
  it("liest den cwd aus Claude- und Codex-Zeilen (auch mit Escapes), sonst nichts", () => {
    expect(cwdFromHead('{"type":"user","cwd":"/home/alex/my \\"app\\""}')).toBe('/home/alex/my "app"');
    expect(cwdFromHead('{"payload":{"cwd":"/srv/www/site"}}')).toBe("/srv/www/site");
    expect(cwdFromHead('{"cwd":"relative/path"}')).toBeNull();
    expect(cwdFromHead('{"type":"mode"}')).toBeNull();
  });

  it("Pfad-Regeln: versteckte Ordner gehören zum Projekt drumherum, nie Home oder /", () => {
    const r = { home: "/home/alex", platform: "linux" as const, tmpDirs: [] };
    expect(visiblePart("/home/alex/code/app/.claude/worktrees/x", r)).toBe("/home/alex/code/app");
    expect(visiblePart("/home/alex/.config/nvim", r)).toBe("/home/alex");
    expect(rootForProject("/home/alex/code/app", r)).toBe("/home/alex/code");
    expect(rootForProject("/home/alex/myapp", r)).toBe("/home/alex/myapp");
    expect(rootForProject("/srv/www/site", r)).toBe("/srv/www");
    expect(rootForProject("/workspace", r)).toBe("/workspace");
  });

  it("Sessions zuerst (nach Anzahl), dann Ordner mit Repos; nie Home, /, Temp, node_modules oder Musik", async () => {
    const w = world();
    const snap = await detectProjectRoots(w.opts);
    const paths = snap.suggestions.map((s) => s.path);
    expect(paths.slice(0, 3)).toEqual([join(w.home, "code"), join(w.home, "work"), join(w.home, "myapp")]);
    expect(paths).toEqual(expect.arrayContaining([join(w.home, "Sites"), join(w.home, "Documents", "GitHub")]));
    for (const bad of [w.home, "/", join(w.elsewhere, "scratch"), w.elsewhere, join(w.home, "node_modules"), join(w.home, "Music")]) expect(paths).not.toContain(bad);
    const code = snap.suggestions[0];
    // vier Claude-Sessions (eine aus der versteckten Worktree, eine aus einem gelöschten Unterordner), zwei Repos
    expect(code).toMatchObject({ sessions: 4, repos: 2, tools: ["claude"], recommended: true });
    expect(code?.lastUsedAt).not.toBeNull();
    expect(snap.suggestions.find((s) => s.path === join(w.home, "work"))).toMatchObject({ sessions: 1, repos: 1, tools: ["codex"], recommended: true });
    expect(snap.suggestions.find((s) => s.path === join(w.home, "Sites"))).toMatchObject({ sessions: 0, repos: 1, recommended: false, lastUsedAt: null });
    expect(snap.complete).toBe(true);
  });

  it("gleicher Ordner über einen Symlink erscheint nur einmal; höchstens acht Vorschläge", async () => {
    const w = world();
    symlinkSync(join(w.home, "code"), join(w.home, "projects"));
    claudeSession(w.home, join(w.home, "projects", "shop"));
    for (let i = 0; i < 12; i++) repo(w.home, `extra${i}`, "r");
    const snap = await detectProjectRoots(w.opts);
    const reals = snap.suggestions.map((s) => realpathSync(s.path));
    expect(new Set(reals).size).toBe(reals.length);
    expect(snap.suggestions.length).toBeLessThanOrEqual(8);
    expect(snap.suggestions[0]).toMatchObject({ path: join(w.home, "code"), sessions: 5 });
  });

  it("ohne Verläufe und ohne Repos: keine Vorschläge, kein Fehler", async () => {
    const home = tempDir("nyxos-empty-");
    const snap = await detectProjectRoots({ home, claudeDir: join(home, ".claude"), codexDir: join(home, ".codex"), platform: "linux", tmpDirs: [] });
    expect(snap.suggestions).toEqual([]);
    expect(snap.complete).toBe(true);
  });

  it("macOS: solange die Freigabe für ~/Documents aussteht, hängt nichts – der Ordner wird ausgelassen", async () => {
    const w = world();
    const gate = new ProtectedGate({ home: w.home, platform: "darwin", timeoutMs: 50, probe: () => new Promise(() => undefined) });
    const started = Date.now();
    const snap = await detectProjectRoots({ ...w.opts, platform: "darwin", gate });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(snap.suggestions.map((s) => s.path)).not.toContain(join(w.home, "Documents", "GitHub"));
    expect(snap.suggestions[0]?.path).toBe(join(w.home, "code"));
    expect(snap.complete).toBe(false);
    // Nach „Erlauben“ ist der Ordner beim nächsten Lauf dabei.
    const allowed = new ProtectedGate({ home: w.home, platform: "darwin", probe: async () => undefined });
    const again = await detectProjectRoots({ ...w.opts, platform: "darwin", gate: allowed });
    expect(again.suggestions.map((s) => s.path)).toContain(join(w.home, "Documents", "GitHub"));
    expect(again.complete).toBe(true);
  });

  it("Paketverwaltung passend zum System", () => {
    const only = (...bins: string[]) => (b: string) => bins.includes(b);
    expect(detectPackageManager("darwin", only("brew"))).toBe("brew");
    expect(detectPackageManager("darwin", only())).toBe("none");
    expect(detectPackageManager("linux", only("apt-get", "brew"))).toBe("apt");
    expect(detectPackageManager("linux", only("dnf", "yum"))).toBe("dnf");
    expect(detectPackageManager("linux", only("pacman"))).toBe("pacman");
    expect(detectPackageManager("linux", only("zypper"))).toBe("zypper");
    expect(detectPackageManager("linux", only("apk"))).toBe("apk");
    expect(detectPackageManager("linux", only())).toBe("none");
  });
});

describe("Ordner-Auswahl (setup.browse)", () => {
  it("startet im Home-Ordner: nur sichtbare Ordner, sortiert, Repos markiert und gezählt, Symlinks auf Ordner dabei", async () => {
    const w = world();
    writeFileSync(join(w.home, "notiz.txt"), "x");
    symlinkSync(join(w.home, "code"), join(w.home, "Link-zu-code"));
    symlinkSync(join(w.home, "gibt-es-nicht"), join(w.home, "kaputt"));
    const r = await browseFolder({}, { home: w.home });
    expect(SetupBrowseResultSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ path: w.home, home: w.home, isRepo: false, truncated: false });
    const names = r.entries.map((e) => e.name);
    expect(names).toEqual(["code", "Documents", "Link-zu-code", "Music", "myapp", "node_modules", "Sites", "work"]);
    expect(r.entries.find((e) => e.name === "myapp")).toMatchObject({ isRepo: true });
    expect(r.entries.find((e) => e.name === "code")).toMatchObject({ isRepo: false, repoCount: 2, path: join(w.home, "code") });
    // Symlink bleibt als Pfad, wie man ihn gewählt hat
    expect(r.entries.find((e) => e.name === "Link-zu-code")?.path).toBe(join(w.home, "Link-zu-code"));
  });

  it("Unterordner, ~ und Elternordner; / hat keinen Elternordner", async () => {
    const w = world();
    const code = await browseFolder({ path: "~/code" }, { home: w.home });
    expect(code).toMatchObject({ path: join(w.home, "code"), parent: w.home });
    expect(code.entries.map((e) => e.name)).toEqual(["blog", "shop"]);
    const shop = await browseFolder({ path: join(w.home, "code", "shop") }, { home: w.home });
    expect(shop.isRepo).toBe(true);
    expect((await browseFolder({ path: "/" }, { home: w.home })).parent).toBeNull();
  });

  it("Fehler als klare Sätze: fehlt, ist eine Datei, relativer Pfad, unbekanntes Feld", async () => {
    const w = world();
    writeFileSync(join(w.home, "datei"), "x");
    await expect(browseFolder({ path: join(w.home, "fehlt") }, { home: w.home })).rejects.toMatchObject({ code: "missing_folder" });
    await expect(browseFolder({ path: join(w.home, "datei") }, { home: w.home })).rejects.toMatchObject({ code: "bad_request" });
    await expect(browseFolder({ path: "code" }, { home: w.home })).rejects.toMatchObject({ code: "bad_request" });
    await expect(browseFolder({ path: "/", extra: 1 }, { home: w.home })).rejects.toBeInstanceOf(BrowseError);
  });

  it("macOS: ausstehende Freigabe → sofort ein Satz statt hängen; Home listet ~/Documents ohne es zu öffnen", async () => {
    const w = world();
    let probes = 0;
    const gate = new ProtectedGate({
      home: w.home,
      platform: "darwin",
      timeoutMs: 50,
      probe: () => {
        probes++;
        return new Promise(() => undefined);
      },
    });
    const home = await browseFolder({}, { home: w.home, gate });
    expect(home.entries.find((e) => e.name === "Documents")).toEqual({ name: "Documents", path: join(w.home, "Documents"), isRepo: false });
    expect(probes).toBe(0);
    await expect(browseFolder({ path: "~/Documents" }, { home: w.home, gate })).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Erlauben") });
    expect(probes).toBe(1);
  });
});

describe("Kanal", () => {
  it("die Brücke nimmt den Befehl setup.browse an (sonst verwirft sie ihn schon beim Lesen)", () => {
    expect(SETUP_RPC_BROWSE).toBe("setup.browse");
    expect(BRIDGE_CAP_SETUP_BROWSE).toBe("setup_browse");
    expect(ServerToBridgeSchema.safeParse({ op: "rpc", id: 1, method: SETUP_RPC_BROWSE, params: { path: "~" } }).success).toBe(true);
  });
});

describe("setup.state mit Details", () => {
  it("liefert Vorschläge samt Details; eingetragene Ordner mit Zählern, nicht doppelt als Vorschlag", async () => {
    const w = world();
    const p = paths(w.home, { NYXOS_HOME: join(w.home, ".nyxos") } as NodeJS.ProcessEnv);
    const cfg: BridgeConfig = { serverUrl: "http://127.0.0.1:47800", token: "t", tunnel: null, projectRoots: [join(w.home, "work")], claudeDir: join(w.home, ".claude"), codexDir: join(w.home, ".codex"), vaultDir: null };
    saveConfig(cfg, p.config);
    const svc = new SetupService({ cfg, configPath: p.config, paths: p, home: w.home });
    const state = await svc.state();
    expect(SetupStateSchema.parse(state)).toEqual(state);
    expect(state.suggestions.projectRoots).not.toContain(join(w.home, "work"));
    expect(state.suggestions.projectRoots[0]).toBe(join(w.home, "code"));
    expect(state.suggestions.projectRootDetails?.[0]).toMatchObject({ path: join(w.home, "work"), sessions: 1, repos: 1 });
    expect(state.tools.packageManager).toBeDefined();
    expect(typeof state.tools.root).toBe("boolean");
    const browse = await svc.browse({ path: "~/code" });
    expect(browse.entries.map((e) => e.name)).toEqual(["blog", "shop"]);
    await expect(svc.browse({ path: "~/fehlt" })).rejects.toMatchObject({ code: "missing_folder" });
  });
});
