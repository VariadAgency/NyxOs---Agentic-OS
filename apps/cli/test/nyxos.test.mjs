import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { activate, activeRelease, addToShellPath, isValidVersion, launchdPlist, layout, pickPort, portInUse, releaseVersion, safeToRemove, stripRcBlock, systemdUnit, unpackRelease, updateDecision, checkRepo, serverEnv } from "../nyxos.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "nyxos-cli-"));
}

function fakeRelease(dir, version, folder = `nyxos-${version}`) {
  const src = join(dir, "src");
  const inner = join(src, folder);
  mkdirSync(join(inner, "bin"), { recursive: true });
  mkdirSync(join(inner, "cli"), { recursive: true });
  writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "nyxos", version }));
  writeFileSync(join(inner, "bin", "nyxos"), "#!/bin/sh\n");
  writeFileSync(join(inner, "cli", "nyxos.mjs"), "");
  const tarball = join(dir, `${folder}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", src, folder]);
  return tarball;
}

describe("nyxos command", () => {
  it("puts everything under NYXOS_HOME", () => {
    const p = layout({ NYXOS_HOME: "/tmp/x" }, "/home/alex");
    expect(p.data).toBe("/tmp/x/data");
    expect(p.current).toBe("/tmp/x/app/current");
    expect(p.node).toBe("/tmp/x/runtime/node/bin/node");
    expect(p.port).toBe(47800);
    expect(p.unit).toBe("/home/alex/.config/systemd/user/nyxos-server.service");
  });

  it("writes a launchd agent and a systemd unit that start the local server", () => {
    const p = layout({ NYXOS_HOME: "/home/alex/.nyxos" }, "/home/alex");
    const env = { NYXOS_HOME: p.root, PATH: "/usr/bin:/bin", PORT: "47800" };
    const plist = launchdPlist(p, env);
    expect(plist).toContain("<string>app.nyxos.server</string>");
    expect(plist).toContain("/home/alex/.nyxos/app/current/server/dist/local.js");
    expect(plist).toContain("<key>PATH</key><string>/usr/bin:/bin</string>");
    const unit = systemdUnit(p, env);
    expect(unit).toContain('ExecStart="/home/alex/.nyxos/runtime/node/bin/node" --enable-source-maps "/home/alex/.nyxos/app/current/server/dist/local.js"');
    expect(unit).toContain('Environment="PORT=47800"');
    expect(unit).toContain("WantedBy=default.target");
  });

  it("adds ~/.nyxos/bin to PATH once and removes the block again", () => {
    const home = tempHome();
    writeFileSync(join(home, ".zshrc"), "alias ll='ls -l'\n");
    const p = { ...layout({ NYXOS_HOME: join(home, ".nyxos") }, home), os: "darwin" };
    addToShellPath(p);
    addToShellPath(p);
    const text = readFileSync(join(home, ".zshrc"), "utf8");
    expect(text.match(/>>> nyxos >>>/g)).toHaveLength(1);
    expect(text).toContain(`export PATH="${join(home, ".nyxos", "bin")}:$PATH"`);
    expect(stripRcBlock(text).trim()).toBe("alias ll='ls -l'");
  });

  it("unpacks a release into versions/<version> and switches `current` to it", () => {
    const home = tempHome();
    const p = layout({ NYXOS_HOME: join(home, ".nyxos") }, home);
    const v1 = unpackRelease(p, fakeRelease(home, "0.1.0"));
    activate(p, v1);
    expect(releaseVersion(p.current)).toBe("0.1.0");
    const v2 = unpackRelease(p, fakeRelease(home, "0.2.0"));
    activate(p, v2);
    expect(readlinkSync(p.current)).toBe(v2);
    expect(existsSync(join(p.versions, "0.1.0"))).toBe(true);
    expect(readlinkSync(p.cli)).toBe(join(p.current, "bin", "nyxos"));
  });

  it("refuses release archives whose version would leave versions/", () => {
    const home = tempHome();
    const p = layout({ NYXOS_HOME: join(home, ".nyxos") }, home);
    const victim = join(home, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "x");
    expect(() => unpackRelease(p, fakeRelease(home, "../../../victim", "nyxos-evil"))).toThrow(/invalid version/);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    // no half-unpacked leftovers either
    expect(readdirSync(p.versions)).toEqual([]);
    expect(isValidVersion("0.2.0")).toBe(true);
    expect(isValidVersion("1.0.0-rc.1")).toBe(true);
    for (const bad of ["..", "1.0", "1.0.0/../x", "v1.0.0", "", null]) expect(isValidVersion(bad)).toBe(false);
  });

  it("knows the active release for a rollback", () => {
    const home = tempHome();
    const p = layout({ NYXOS_HOME: join(home, ".nyxos") }, home);
    expect(activeRelease(p)).toBe(null);
    const v1 = unpackRelease(p, fakeRelease(home, "0.1.0"));
    activate(p, v1);
    expect(activeRelease(p)).toBe(realpathSync(v1));
  });

  it("escapes systemd specifiers and $ in paths", () => {
    const p = layout({ NYXOS_HOME: "/home/alex/100%/$HOME/.nyxos" }, "/home/alex");
    const unit = systemdUnit(p, { NYXOS_HOME: p.root });
    expect(unit).toContain("WorkingDirectory=/home/alex/100%%/$HOME/.nyxos");
    expect(unit).toContain('Environment="NYXOS_HOME=/home/alex/100%%/$HOME/.nyxos"');
    expect(unit).toContain('ExecStart="/home/alex/100%%/$$HOME/.nyxos/runtime/node/bin/node"');
  });

  it("quotes an unusual NYXOS_HOME in the PATH block", () => {
    const home = tempHome();
    const p = { ...layout({ NYXOS_HOME: join(home, 'my "x" $(id)') }, home), os: "darwin" };
    addToShellPath(p);
    const line = readFileSync(join(home, ".zshrc"), "utf8").split("\n").find((l) => l.startsWith("export PATH="));
    const out = execFileSync("sh", ["-c", `${line}; printf %s "$PATH"`], { encoding: "utf8" });
    expect(out.split(":")[0]).toBe(join(home, 'my "x" $(id)', "bin"));
  });

  it("uninstall only removes a folder that is a NyxOS installation", () => {
    const home = tempHome();
    expect(safeToRemove(layout({ NYXOS_HOME: home }, home))).toBe(false);
    expect(safeToRemove(layout({ NYXOS_HOME: "/" }, home))).toBe(false);
    expect(safeToRemove(layout({ NYXOS_HOME: dirname(home) }, home))).toBe(false);
    const root = join(home, ".nyxos");
    expect(safeToRemove(layout({ NYXOS_HOME: root }, home))).toBe(false);
    // a generic data/ folder alone is no proof (NYXOS_HOME pointed at some project folder by mistake)
    const project = join(home, "projects");
    mkdirSync(join(project, "data"), { recursive: true });
    expect(safeToRemove(layout({ NYXOS_HOME: project }, home))).toBe(false);
    mkdirSync(root);
    writeFileSync(join(root, "nyxos.json"), "{}");
    expect(safeToRemove(layout({ NYXOS_HOME: root }, home))).toBe(true);
  });

  it("an update never goes back to an older release unless that version was asked for", () => {
    expect(updateDecision("0.2.0", "0.3.0", false)).toBe("install");
    expect(updateDecision("0.2.0", "0.2.0", false)).toBe("current");
    expect(updateDecision("0.2.0", "0.1.9", false)).toBe("older");
    expect(updateDecision("0.10.0", "0.9.0", false)).toBe("older");
    expect(updateDecision("0.2.0", "0.1.9", true)).toBe("install");
    expect(updateDecision(null, "0.1.0", false)).toBe("install");
  });

  it("the service PATH keeps only absolute folders (a relative entry would run programs from a cloned repo)", () => {
    const home = tempHome();
    const env = serverEnv(layout({ NYXOS_HOME: join(home, ".nyxos") }, home), ".:node_modules/.bin::/usr/bin:/opt/homebrew/bin");
    expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin");
  });

  it("refuses to download from the placeholder repository", () => {
    expect(() => checkRepo("OWNER/nyxos")).toThrow();
    expect(() => checkRepo("owner/nyxos; rm")).toThrow();
    expect(checkRepo("some-org/nyxos")).toBe("some-org/nyxos");
  });

  it("keeps the default port when it is free and moves on in steps of ten when it is taken", async () => {
    const busy = new Set([47800, 47812]);
    const inUse = async (port) => busy.has(port);
    const isNyxos = async () => false;
    expect(await pickPort(47800, { inUse, isNyxos })).toBe(47820);
    expect(await pickPort(47900, { inUse, isNyxos })).toBe(47900);
    // a NyxOS already running on the default keeps it
    expect(await pickPort(47800, { inUse, isNyxos: async (port) => port === 47800 })).toBe(47800);
  });

  it("remembers whether a port was chosen", () => {
    const home = tempHome();
    expect(layout({ NYXOS_HOME: home }, home).portChosen).toBe(false);
    expect(layout({ NYXOS_HOME: home, NYXOS_PORT: "47900" }, home)).toMatchObject({ port: 47900, portChosen: true });
    writeFileSync(join(home, "nyxos.json"), JSON.stringify({ port: 47810 }));
    expect(layout({ NYXOS_HOME: home }, home)).toMatchObject({ port: 47810, portChosen: true });
  });

  it("sees a port that another program listens on", async () => {
    const server = createServer();
    await new Promise((r) => server.listen({ port: 0, host: "127.0.0.1" }, r));
    const port = server.address().port;
    expect(await portInUse(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await portInUse(port)).toBe(false);
  });

  it("gives the demo instance the port next to the server", () => {
    const p = layout({ NYXOS_HOME: "/tmp/x", NYXOS_PORT: "47810" }, "/home/alex");
    expect(launchdPlist(p)).toContain("<key>NYXOS_DEMO_PORT</key><string>47812</string>");
  });
});
