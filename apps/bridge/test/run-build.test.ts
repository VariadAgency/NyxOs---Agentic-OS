// Build-Prüfung auf dem Rechner (RPC `run_build`): nur erlaubte Werkzeuge, nur unter dem
// Projektordner; fehlt Werkzeug/Ordner/Pakete → „nicht eingerichtet“ statt rot.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBuild } from "../src/build/runBuild.js";
import { TerminalManager } from "../src/terminal/manager.js";
import { Tmux } from "../src/terminal/tmux.js";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-build-")));
  const wt = join(root, "werkzeug", "nyxos");
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tool = (name: string, script: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
  };
  return { root, wt, bin, tool, path: `${bin}:/usr/bin:/bin` };
}

describe("runBuild (Brücke)", () => {
  it("führt das erlaubte Werkzeug im Arbeitsordner aus und liefert Exit-Code + Ausgabe", async () => {
    const p = project();
    p.tool("pnpm", 'echo "läuft in $(pwd) mit $*"; echo "error TS2322: kaputt" >&2; exit 2');
    const r = await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: p.wt }, { path: p.path, projectRoots: [p.root] });
    expect(r).toMatchObject({ outcome: "done", exitCode: 2 });
    expect(r.log).toContain(`läuft in ${p.wt} mit -r typecheck`);
    expect(r.log).toContain("error TS2322");
  });

  it("Werkzeug fehlt im Suchpfad → „nicht eingerichtet“ (tool_missing), kein roter Lauf", async () => {
    const p = project();
    const r = await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: p.wt }, { path: p.path, projectRoots: [p.root] });
    expect(r).toMatchObject({ outcome: "unavailable", reason: "tool_missing", tool: "pnpm" });
  });

  it("Arbeitsordner fehlt → folder_missing; Ordner außerhalb des Projekts → not_allowed", async () => {
    const p = project();
    p.tool("pnpm", "exit 0");
    expect(await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: join(p.root, "weg") }, { path: p.path, projectRoots: [p.root] })).toMatchObject({ outcome: "unavailable", reason: "folder_missing" });
    expect(await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: tmpdir() }, { path: p.path, projectRoots: [p.root] })).toMatchObject({ outcome: "unavailable", reason: "not_allowed" });
  });

  it("nur pnpm/xcodebuild/swift — alles andere wird nicht gestartet", async () => {
    const p = project();
    p.tool("rm", "echo SOLLTE-NIE-LAUFEN");
    const r = await runBuild({ command: ["rm", "-rf", "x"], cwd: p.wt }, { path: p.path, projectRoots: [p.root] });
    expect(r).toMatchObject({ outcome: "unavailable", reason: "not_allowed" });
    expect(r.log).not.toContain("SOLLTE-NIE-LAUFEN");
    expect(await runBuild({ command: [`${p.bin}/pnpm`], cwd: p.wt }, { path: p.path, projectRoots: [p.root] })).toMatchObject({ outcome: "unavailable", reason: "not_allowed" });
  });

  it("pnpm ohne installierte Pakete → deps_missing", async () => {
    const p = project();
    p.tool("pnpm", "exit 0");
    const bare = join(p.root, "werkzeug", "leer");
    mkdirSync(bare, { recursive: true });
    expect(await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: bare }, { path: p.path, projectRoots: [p.root] })).toMatchObject({ outcome: "unavailable", reason: "deps_missing" });
  });

  it("bricht nach der Zeitgrenze ab (rot mit Hinweis)", async () => {
    const p = project();
    p.tool("pnpm", "sleep 5");
    const r = await runBuild({ command: ["pnpm", "test"], cwd: p.wt, timeoutMs: 200 }, { path: p.path, projectRoots: [p.root] });
    expect(r).toMatchObject({ outcome: "done", exitCode: -1 });
    expect(r.log).toContain("abgebrochen");
  });

  // ── Befehle kommen vom Server — die Brücke lässt nur genau die geplanten Prüfungen zu ──

  it("keine Argument-Einschleusung: nur die geplanten Prüfungen, nicht `pnpm exec …`/`swift run`/`xcodebuild -…`", async () => {
    const p = project();
    p.tool("pnpm", "echo SOLLTE-NIE-LAUFEN $*");
    p.tool("swift", "echo SOLLTE-NIE-LAUFEN $*");
    p.tool("xcodebuild", "echo SOLLTE-NIE-LAUFEN $*");
    for (const command of [
      ["pnpm", "exec", "rm", "-rf", "x"],
      ["pnpm", "dlx", "boese"],
      ["pnpm", "-r", "typecheck", "--", "x"],
      ["swift", "run"],
      ["xcodebuild", "-runFirstLaunch"],
      ["xcodebuild", "build", "-project", "/etc/x.xcodeproj", "-scheme", "S", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "/tmp/dd"],
    ]) {
      // `platform: "darwin"`: die xcodebuild-Regeln gelten auf dem Mac – so prüft sie auch ein Linux-Rechner.
      const r = await runBuild({ command, cwd: p.wt }, { path: p.path, projectRoots: [p.root], platform: "darwin" });
      expect(r, command.join(" ")).toMatchObject({ outcome: "unavailable", reason: "not_allowed" });
      expect(r.log).not.toContain("SOLLTE-NIE-LAUFEN");
    }
  });

  it("Umgebungsvariablen vom Server werden nicht übernommen (kein NODE_OPTIONS/DYLD_* von außen)", async () => {
    const p = project();
    p.tool("pnpm", 'echo "X=[$NYXOS_BOESE] N=[$NODE_OPTIONS]"');
    const req = { command: ["pnpm", "-r", "typecheck"], cwd: p.wt, env: { NYXOS_BOESE: "ja", NODE_OPTIONS: "--require /tmp/boese.js" } };
    const r = await runBuild(req as Parameters<typeof runBuild>[0], { path: p.path, projectRoots: [p.root] });
    expect(r.log).toContain("X=[] N=[]");
  });

  it("iOS: DerivedData liegt in einem Mac-Ordner der Brücke, nie im Server-Pfad (/builds/… gibt es auf dem Rechner nicht)", async () => {
    const p = project();
    const app = join(p.root, "App");
    const proj = join(app, "Xcode", "Shop App", "Shop App.xcodeproj");
    mkdirSync(proj, { recursive: true });
    p.tool("xcodebuild", 'echo "ARGS $*"');
    const dd = join(p.root, "cache");
    const r = await runBuild(
      { command: ["xcodebuild", "build", "-project", proj, "-scheme", "Shop App", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "/builds/derived-data/abc"], cwd: app },
      { path: p.path, projectRoots: [p.root], derivedDataRoot: dd, platform: "darwin" },
    );
    expect(r).toMatchObject({ outcome: "done", exitCode: 0 });
    expect(r.log).not.toContain("/builds/derived-data");
    expect(r.log).toMatch(new RegExp(`-derivedDataPath ${dd}/[0-9a-f]{16}`));
  });

  it("iOS-Projekt fehlt → „kein Projekt“ (nicht eingerichtet), kein roter Lauf", async () => {
    const p = project();
    p.tool("xcodebuild", "exit 65");
    const app = join(p.root, "App");
    mkdirSync(app, { recursive: true });
    const r = await runBuild(
      { command: ["xcodebuild", "build", "-project", join(app, "Xcode", "X.xcodeproj"), "-scheme", "S", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "/builds/x"], cwd: app },
      { path: p.path, projectRoots: [p.root], derivedDataRoot: join(p.root, "cache"), platform: "darwin" },
    );
    expect(r).toMatchObject({ outcome: "unavailable", reason: "no_project" });
  });

  it("Backend: `swift test` läuft im nächsten Ordner mit Package.swift; ohne Paket → „kein Projekt“", async () => {
    const p = project();
    p.tool("swift", 'echo "in $(pwd)"');
    const svc = join(p.root, "App", "backend", "services", "user-service");
    mkdirSync(join(svc, "Sources", "App"), { recursive: true });
    writeFileSync(join(svc, "Package.swift"), "// swift-tools-version:5.9\n");
    const r = await runBuild({ command: ["swift", "test"], cwd: join(svc, "Sources", "App") }, { path: p.path, projectRoots: [p.root] });
    expect(r).toMatchObject({ outcome: "done", exitCode: 0 });
    expect(r.log).toContain(`in ${svc}`);
    const bare = join(p.root, "App", "backend");
    expect(await runBuild({ command: ["swift", "test"], cwd: bare }, { path: p.path, projectRoots: [p.root] })).toMatchObject({ outcome: "unavailable", reason: "no_project" });
  });

  it("Zeitgrenze beendet auch Kind-Prozesse (sonst hält z. B. tsc die Ausgabe offen und die Antwort hängt)", async () => {
    const p = project();
    p.tool("pnpm", "sleep 30; echo fertig");
    const t0 = Date.now();
    const r = await runBuild({ command: ["pnpm", "-r", "typecheck"], cwd: p.wt, timeoutMs: 200 }, { path: p.path, projectRoots: [p.root] });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toMatchObject({ outcome: "done", exitCode: -1 });
  });

  it("TerminalManager beantwortet den RPC `run_build`", async () => {
    const p = project();
    p.tool("pnpm", "echo gruen; exit 0");
    const m = new TerminalManager({
      tmux: new Tmux({ bin: "/usr/bin/false", socket: "nyxos-test-unbenutzt", conf: null }),
      projectRoots: [p.root],
      path: p.path,
      log: () => {},
      processAttached: async () => false,
      claudePids: async () => new Map(),
    });
    expect(await m.rpc("run_build", { command: ["pnpm", "-r", "typecheck"], cwd: p.wt })).toMatchObject({ outcome: "done", exitCode: 0, log: "gruen\n" });
  });
});
