import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER, addHooks, nextCleanupPeriodDays, removeHooks, writeJsonWithBackup } from "../src/install.js";
import { plist, systemdUnit } from "../src/service.js";
import { stateChanges } from "../src/liveness.js";
import { drainSpool, hookEvent, hookScript } from "../src/spool.js";
import { ROOT, newOutbox, noLog, sandbox } from "./helpers.js";

describe("Hook-Skript", () => {
  it("legt stdin als Spool-Datei ab, gibt nichts aus und endet mit 0", () => {
    const sb = sandbox();
    const spool = join(sb.home, "spool");
    mkdirSync(spool);
    const script = join(sb.home, "nyxos-bridge");
    writeFileSync(script, hookScript(spool, "/nicht/vorhanden/node", "/nicht/vorhanden/bridge.js"));
    chmodSync(script, 0o755);
    const payload = JSON.stringify({ session_id: "s1", cwd: ROOT, hook_event_name: "PreToolUse" });
    const r = spawnSync(script, ["hook", "PreToolUse", "claude"], { input: payload });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("");
    const files = readdirSync(spool);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d*-PreToolUse-claude\.json$/);
    expect(readFileSync(join(spool, files[0] ?? ""), "utf8")).toBe(payload);
  });

  it("endet auch ohne Spool-Ordner still mit 0 (Brücke kaputt → Claude läuft normal weiter)", () => {
    const sb = sandbox();
    const script = join(sb.home, "nyxos-bridge");
    writeFileSync(script, hookScript(join(sb.home, "gibt-es-nicht"), "/nicht/vorhanden/node", "/nicht/vorhanden/bridge.js"));
    chmodSync(script, 0o755);
    const r = spawnSync(script, ["hook", "Stop"], { input: "{}" });
    expect(r.status).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
  });

  it("verträgt Leerzeichen und Hochkommas im Pfad", () => {
    const sb = sandbox();
    const spool = join(sb.home, "Application Support", "it's here");
    mkdirSync(spool, { recursive: true });
    const script = join(sb.home, "zb");
    writeFileSync(script, hookScript(spool, "/nicht/vorhanden/node", "/x/bridge.js"));
    chmodSync(script, 0o755);
    expect(spawnSync(script, ["hook", "Stop", "codex"], { input: "{}" }).status).toBe(0);
    expect(readdirSync(spool)).toHaveLength(1);
  });
});

describe("Spool → Events", () => {
  const at = new Date("2026-09-24T10:00:00.000Z");

  it("baut ein Hook-Event mit stabiler ID und knappen Daten", () => {
    const e = hookEvent(
      "123-456-PreToolUse-claude.json",
      { session_id: "s1", cwd: `${ROOT}/App`, tool_name: "Bash", tool_input: { command: "ls -la" }, transcript_path: "/x.jsonl" },
      at,
      [ROOT],
    );
    expect(e).toEqual({
      id: "hook:claude:s1:123-456-PreToolUse",
      tool: "claude",
      sessionId: "s1",
      ts: "2026-09-24T10:00:00.000Z",
      kind: "hook",
      source: "hook",
      data: { event: "PreToolUse", cwd: `${ROOT}/App`, toolName: "Bash", target: "ls -la", transcriptPath: "/x.jsonl" },
    });
  });

  it.each([
    ["fremder Arbeitsordner", "1-2-Stop-claude.json", { session_id: "s1", cwd: "/home/alex/privat" }],
    ["ohne Arbeitsordner", "1-2-Stop-claude.json", { session_id: "s1" }],
    ["ohne Session-ID", "1-2-Stop-claude.json", { cwd: ROOT }],
    ["Session-ID mit Pfadzeichen", "1-2-Stop-claude.json", { session_id: "../x", cwd: ROOT }],
    ["falscher Dateiname", "irgendwas.json", { session_id: "s1", cwd: ROOT }],
    ["unbekanntes Werkzeug", "1-2-Stop-gemini.json", { session_id: "s1", cwd: ROOT }],
  ])("verwirft: %s", (_n, name, payload) => {
    expect(hookEvent(name, payload, at, [ROOT])).toBeNull();
  });

  it("legt Events in den Puffer und räumt den Spool-Ordner auf, auch bei kaputten Dateien", async () => {
    const sb = sandbox();
    const spool = join(sb.home, "spool");
    mkdirSync(spool);
    writeFileSync(join(spool, "1-1-SessionStart-claude.json"), JSON.stringify({ session_id: "s1", cwd: ROOT, source: "startup" }));
    writeFileSync(join(spool, "1-2-Stop-claude.json"), "{kaputt");
    writeFileSync(join(spool, "1-3-Stop-claude.json"), JSON.stringify({ session_id: "s2", cwd: "/tmp" }));
    writeFileSync(join(spool, "1-4-Stop-claude.json.tmp"), "noch nicht fertig");
    const outbox = await newOutbox(sb.home);
    const r = await drainSpool(spool, outbox, [ROOT], noLog);
    expect(r.events.map((e) => e.data.event)).toEqual(["SessionStart"]);
    expect(outbox.size()).toBe(1);
    expect(readdirSync(spool)).toEqual(["1-4-Stop-claude.json.tmp"]);
    // Zweiter Durchlauf erzeugt nichts doppelt.
    await drainSpool(spool, outbox, [ROOT], noLog);
    expect(outbox.size()).toBe(1);
  });
});

describe("Installation: Hooks in settings.json", () => {
  const gitnexus = {
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npx gitnexus hook", timeout: 10 }] }],
  };
  const wrapper = "/home/alex/.nyxos/bridge/nyxos-hook";

  it("ergänzt eigene Hooks und lässt fremde unverändert", () => {
    const out = addHooks({ model: "opus", hooks: structuredClone(gitnexus) }, wrapper, "claude");
    expect(out.model).toBe("opus");
    expect(out.hooks?.PostToolUse?.[0]).toEqual(gitnexus.PostToolUse[0]);
    expect(out.hooks?.PostToolUse).toHaveLength(2);
    expect(Object.keys(out.hooks ?? {}).sort()).toEqual([
      "Notification",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
    const cmd = out.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    expect(cmd).toBe(`'${wrapper}' hook SessionStart claude`);
    expect(cmd).toContain(MARKER);
    expect(out.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
  });

  it("ist idempotent und vollständig rückbaubar", () => {
    const orig = { hooks: structuredClone(gitnexus), x: 1 };
    const once = addHooks(orig, wrapper, "claude");
    const twice = addHooks(once, wrapper, "claude");
    expect(twice).toEqual(once);
    expect(removeHooks(twice)).toEqual(orig);
    expect(removeHooks(addHooks({}, wrapper, "codex"))).toEqual({});
  });

  it("setzt bei Codex async, außer bei SessionEnd", () => {
    const out = addHooks({}, wrapper, "codex");
    expect(out.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({ async: true, command: `'${wrapper}' hook Stop codex` });
    expect(out.hooks?.SessionEnd?.[0]?.hooks?.[0]?.async).toBeUndefined();
  });

  it("trägt Notification nur bei Claude ein, nicht bei Codex", () => {
    const claude = addHooks({}, wrapper, "claude");
    expect(claude.hooks?.Notification?.[0]?.hooks?.[0]?.command).toBe(`'${wrapper}' hook Notification claude`);
    const codex = addHooks({}, wrapper, "codex");
    expect(codex.hooks?.Notification).toBeUndefined();
  });

  it("ist auch mit Notification idempotent (genau ein Eintrag bei wiederholtem Aufruf)", () => {
    const once = addHooks({}, wrapper, "claude");
    const twice = addHooks(once, wrapper, "claude");
    expect(twice).toEqual(once);
    expect(twice.hooks?.Notification).toHaveLength(1);
    expect(removeHooks(twice)).toEqual({});
  });

  it.runIf(process.platform === "darwin")("erzeugt eine gültige launchd-plist", () => {
    const sb = sandbox();
    const f = join(sb.home, "x.plist");
    const args = ["/opt/nyx dir/node", "--disable-warning=ExperimentalWarning", "/opt/nyx dir/app/bridge/bridge.js", "run"];
    writeFileSync(f, plist(args, "/tmp/a&b.log", { PATH: "/usr/bin:/bin", NYXOS_HOME: "/tmp/<nx>" }));
    const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f]).toString()) as Record<string, unknown>;
    expect(json).toMatchObject({ Label: "app.nyxos.bridge", RunAtLoad: true, KeepAlive: true, StandardOutPath: "/tmp/a&b.log" });
    expect(json.ProgramArguments).toEqual(args);
    expect(json.EnvironmentVariables).toEqual({ PATH: "/usr/bin:/bin", NYXOS_HOME: "/tmp/<nx>" });
    // Kanal und Terminal sind interaktiv: im Hintergrund-Band (`Background`/`LowPriorityIO`) bekäme die Brücke
    // unter Last minutenlang keine Rechenzeit.
    expect(json.ProcessType).toBe("Interactive");
    expect(json).not.toHaveProperty("LowPriorityIO");
    rmSync(f);
    expect(existsSync(f)).toBe(false);
  });

  it("erzeugt eine systemd-Unit, die nur die Brücke beendet (tmux-Sessions laufen weiter)", () => {
    const unit = systemdUnit(["/opt/n x/node", "/opt/app/bridge.js", "run"], "/home/a/.nyxos/logs/bridge.log", { PATH: "/usr/bin", NYXOS_HOME: "/home/a/nx$1%" });
    expect(unit).toContain('ExecStart="/opt/n x/node" "/opt/app/bridge.js" "run"');
    expect(unit).toContain('Environment="NYXOS_HOME=/home/a/nx$$1%%"');
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StandardOutput=append:/home/a/.nyxos/logs/bridge.log");
    expect(unit).toContain("WantedBy=default.target");
  });

  // `cleanupPeriodDays` nur anheben, nie senken — der Nutzer kann einen höheren Wert bewusst über die
  // Claude-Einstellungen gesetzt haben.
  it("nextCleanupPeriodDays hebt nur an, senkt nie", () => {
    expect(nextCleanupPeriodDays(undefined)).toBe(3650); // Datei war neu/Feld fehlte
    expect(nextCleanupPeriodDays(10)).toBe(3650); // niedriger als 3650 → anheben
    expect(nextCleanupPeriodDays(3650)).toBe(3650);
    expect(nextCleanupPeriodDays(999_999)).toBe(999_999); // bewusst höher gesetzt → NIE senken
    expect(nextCleanupPeriodDays("kaputt")).toBe(3650); // kaputter Wert zählt wie "fehlt"
  });

  // `renameSync(tmp, file)` hätte einen SYMLINK selbst durch eine normale Datei ersetzt, statt an sein
  // Ziel zu schreiben.
  it("writeJsonWithBackup schreibt ans Ziel eines Symlinks, statt den Symlink selbst zu ersetzen", () => {
    const sb = sandbox();
    const real = join(sb.home, "echte-settings.json");
    writeFileSync(real, JSON.stringify({ vorher: true }));
    const link = join(sb.home, "settings.json");
    symlinkSync(real, link);

    const backup = writeJsonWithBackup(link, { nachher: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(true); // Symlink selbst unangetastet
    expect(readlinkSync(link)).toBe(real);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ nachher: true }); // ans Ziel geschrieben
    expect(backup).not.toBeNull();
    expect(JSON.parse(readFileSync(backup as string, "utf8"))).toEqual({ vorher: true }); // Sicherung vom ZIEL-Inhalt
  });

  it("writeJsonWithBackup schreibt normal, wenn die Datei (noch) kein Symlink ist", () => {
    const sb = sandbox();
    const file = join(sb.home, "neu.json");
    const backup = writeJsonWithBackup(file, { x: 1 });
    expect(backup).toBeNull(); // Datei war neu
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ x: 1 });
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
  });
});

describe("Lebenszeichen", () => {
  it("meldet nur Wechsel: neu laufend, unverändert, beendet", async () => {
    const sb = sandbox();
    const outbox = await newOutbox(sb.home);
    const now = Date.parse("2026-09-24T12:00:00Z");
    const known = [
      { tool: "claude" as const, sessionId: "c1", lastMtimeMs: now },
      { tool: "codex" as const, sessionId: "x1", lastMtimeMs: now - 60_000 },
      { tool: "codex" as const, sessionId: "x2", lastMtimeMs: now - 60 * 60_000 },
    ];
    const first = stateChanges(outbox, { known, claudeRunning: new Set(["c1"]), codexProcess: true, now });
    expect(first.map((i) => i.type === "state" && [i.state.sessionId, i.state.running])).toEqual([
      ["c1", true],
      ["x1", true],
      ["x2", false],
    ]);
    expect(stateChanges(outbox, { known, claudeRunning: new Set(["c1"]), codexProcess: true, now })).toEqual([]);
    const later = stateChanges(outbox, { known, claudeRunning: new Set(), codexProcess: false, now: now + 1000 });
    expect(later.map((i) => i.type === "state" && [i.state.sessionId, i.state.running])).toEqual([
      ["c1", false],
      ["x1", false],
    ]);
  });
});
