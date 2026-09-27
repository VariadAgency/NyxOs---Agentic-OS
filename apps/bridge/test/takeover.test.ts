// „In der NyxOS übernehmen“: eine außerhalb gestartete Session sauber per `--resume` in die
// NyxOS holen. Gegen ein ECHTES tmux auf einem eigenen Wegwerf-Socket je Test (nie `-L nyxos`).
// Das „alte Fenster“ ist ein echter, harmloser Prozess (`sleep`), den dieser Test selbst startet.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { codexPidsFor, parseLsofPidsForPath, recordedStart, sameStart, type RecordedStart } from "../src/liveness.js";
import { appOf, looksLikeTool, parseProcessTable, TerminalManager } from "../src/terminal/manager.js";
import { tmuxConf } from "../src/terminal/shell.js";
import { disposeTmux, isolatedTmux, until } from "./tmuxSockets.js";

const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-d2-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());

const sockets: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) disposeTmux(s);
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wegwerf-Projekt mit falschem `claude`/`codex`, das Arbeitsordner + Argumente protokolliert und dann wartet. */
function fakeProject() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-d2-")));
  const root = join(base, "projekte");
  const bin = join(base, "bin");
  const worktree = join(root, "app", ".worktrees", "feature-d2");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const tool of ["claude", "codex"]) {
    const f = join(bin, tool);
    // Erst in eine Zwischendatei, dann umbenennen: der Test sieht die Datei nie halb geschrieben.
    writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "cwd=$PWD" "$@" > "${base}/${tool}.tmp"\nmv "${base}/${tool}.tmp" "${base}/${tool}.log"\nexec sleep 60\n`);
    chmodSync(f, 0o755);
  }
  const log = (tool: string) => {
    try {
      return readFileSync(join(base, `${tool}.log`), "utf8").split("\n");
    } catch {
      return [];
    }
  };
  const clear = (tool: string) => rmSync(join(base, `${tool}.log`), { force: true });
  return { base, root, bin, worktree, log, clear };
}

type Table = Map<number, { ppid: number; comm: string; startMs: number | null }>;

function setup(
  tag: string,
  opts: {
    pids?: (tool: Tool, sessionId: string) => Promise<number[]>;
    endWaitMs?: number;
    processTable?: () => Promise<Table>;
    claudePids?: () => Promise<Map<number, string>>;
    sessionStart?: (tool: Tool, sessionId: string, pid: number) => Promise<RecordedStart | null>;
  } = {},
) {
  const p = fakeProject();
  const { tmux, socket } = isolatedTmux(tag, CONF);
  sockets.push(socket);
  const m = new TerminalManager({
    tmux,
    projectRoots: [p.root],
    path: `${p.bin}:/usr/bin:/bin`,
    log: () => {},
    processAttached: async (tool, sid) => ((await opts.pids?.(tool, sid)) ?? []).length > 0,
    claudePids: opts.claudePids ?? (async () => new Map()),
    sessionPids: opts.pids ?? (async () => []),
    ...(opts.sessionStart ? { sessionStart: opts.sessionStart } : {}),
    endWaitMs: opts.endWaitMs ?? 5000,
    ...(opts.processTable ? { processTable: opts.processTable } : {}),
  });
  return { p, m, tmux };
}

/** Das „alte Fenster“: ein echter Prozess außerhalb der NyxOS, der für `ps` wie `claude` heißt (argv0). */
function oldWindow(ignoreTerm = false, name = "claude"): ChildProcess {
  const c = ignoreTerm
    ? spawn("/bin/bash", ["-c", `trap '' TERM; exec -a ${name} /bin/sleep 60`], { stdio: "ignore" })
    : spawn("/bin/sleep", ["60"], { stdio: "ignore", argv0: name });
  children.push(c);
  return c;
}

/** Ein unbeteiligtes Programm (heißt `sleep`), z. B. eines, das die PID eines längst beendeten Claude geerbt hat. */
function foreignProgram(): ChildProcess {
  const c = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  children.push(c);
  return c;
}

/** Bis `ps` den neuen Namen (argv0/exec -a) zeigt, vergehen ein paar Millisekunden. */
async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

const SID = "5fd26341-0781-438b-a79f-b103a34c1902";
const req = (cwd: string | null, endPids: number[] = [], tool: Tool = "claude", sessionId = SID) => ({ tool, sessionId, cwd, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null, endPids });

describe("Übernehmen ohne laufendes Programm", () => {
  it("setzt Claude per --resume in tmux fort, im Arbeitsordner der Session", async () => {
    const { p, m, tmux } = setup("resume-cwd");
    const r = await m.takeover(req(p.worktree));
    expect(r.tmuxName).toMatch(/^zc-claude-[a-z0-9]{8}$/);
    expect(await tmux.hasSession(r.tmuxName)).toBe(true);
    expect(await until(() => p.log("claude").length > 1)).toBe(true);
    expect(p.log("claude").slice(0, 3)).toEqual([`cwd=${p.worktree}`, "--resume", SID]);
  });

  it("Codex: `codex resume <id>` im Arbeitsordner", async () => {
    const { p, m } = setup("resume-codex");
    const cid = "01a0c424-0000-7000-8000-00000000c0de";
    await m.takeover(req(p.worktree, [], "codex", cid));
    expect(await until(() => p.log("codex").length > 1)).toBe(true);
    expect(p.log("codex").slice(0, 3)).toEqual([`cwd=${p.worktree}`, "resume", cid]);
  });

  it("Arbeitsordner außerhalb des Projektordners → abgelehnt statt still woanders fortgesetzt", async () => {
    const { p, m } = setup("bad-cwd");
    await expect(m.takeover(req(p.base))).rejects.toMatchObject({ code: "bad_folder" });
    expect(p.log("claude")).toEqual([]);
  });
});

describe("Übernehmen, während das alte Fenster noch läuft", () => {
  it("Info für den Dialog: welches Programm (PID) hängt an der Session", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const { m } = setup("info", { pids: async (_t, sid) => (sid === SID ? [pid] : []) });
    await settled();
    const info = await m.takeoverInfo({ tool: "claude", sessionId: SID });
    expect(info.processes.map((x) => x.pid)).toEqual([pid]);
    expect(info.inNyxOS).toBeNull();
  });

  it("ohne Freigabe (keine PID bestätigt) wird nichts beendet und nichts gestartet", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const { p, m } = setup("no-confirm", { pids: async () => (alive(pid) ? [pid] : []) });
    await settled();
    await expect(m.takeover(req(p.worktree))).rejects.toMatchObject({ code: "process_running" });
    expect(alive(pid)).toBe(true);
    expect(p.log("claude")).toEqual([]);
  });

  it("bestätigte PID: GENAU dieses Programm wird sauber beendet (SIGTERM), danach --resume in tmux", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const other = oldWindow(); // ein unbeteiligtes Programm — darf nie getroffen werden
    const { p, m } = setup("end-old", { pids: async () => (alive(pid) ? [pid] : []) });
    let signal: string | null = null;
    old.once("exit", (_c, s) => (signal = s));
    await settled();
    expect((await m.takeoverInfo({ tool: "claude", sessionId: SID })).processes.map((x) => x.pid)).toEqual([pid]);
    const r = await m.takeover(req(p.worktree, [pid]));
    expect(alive(pid)).toBe(false);
    expect(signal).toBe("SIGTERM");
    expect(alive(other.pid ?? -1)).toBe(true);
    expect(r.tmuxName).toMatch(/^zc-claude-/);
    expect(await until(() => p.log("claude").length > 1)).toBe(true);
    expect(p.log("claude").slice(0, 3)).toEqual([`cwd=${p.worktree}`, "--resume", SID]);
  });

  it("hängt inzwischen ein ANDERES Programm an der Session → process_changed, nichts beendet", async () => {
    const confirmed = oldWindow();
    const now = oldWindow();
    const { p, m } = setup("changed", { pids: async () => [now.pid ?? -1] });
    await settled();
    await m.takeoverInfo({ tool: "claude", sessionId: SID });
    await expect(m.takeover(req(p.worktree, [confirmed.pid ?? -1]))).rejects.toMatchObject({ code: "process_changed" });
    expect(alive(confirmed.pid ?? -1)).toBe(true);
    expect(alive(now.pid ?? -1)).toBe(true);
    expect(p.log("claude")).toEqual([]);
  });

  it("eine PID, die gar nicht zur Session gehört, wird nie beendet", async () => {
    const stranger = oldWindow();
    const { p, m } = setup("stranger", { pids: async () => [] });
    // Session läuft nirgends → einfach fortsetzen; die fremde PID bleibt unberührt.
    await m.takeover(req(p.worktree, [stranger.pid ?? -1]));
    expect(alive(stranger.pid ?? -1)).toBe(true);
  });

  it("reagiert das alte Programm nicht auf SIGTERM → ehrlicher Fehler, kein hartes Beenden, kein Start", async () => {
    const stubborn = oldWindow(true);
    const pid = stubborn.pid ?? -1;
    await new Promise((r) => setTimeout(r, 250)); // `trap` muss stehen, bevor das Signal kommt
    const { p, m } = setup("stubborn", { pids: async () => (alive(pid) ? [pid] : []), endWaitMs: 600 });
    expect((await m.takeoverInfo({ tool: "claude", sessionId: SID })).processes.map((x) => x.pid)).toEqual([pid]);
    // Eigener Code: „ließ sich nicht beenden“ ist etwas anderes als „noch nicht freigegeben“ (sonst rät der
    // Dialog, genau den Knopf noch einmal zu drücken, der gerade nicht gewirkt hat).
    await expect(m.takeover(req(p.worktree, [pid]))).rejects.toMatchObject({ code: "process_stuck" });
    expect(alive(pid)).toBe(true);
    expect(p.log("claude")).toEqual([]);
  });
});

describe("nie ein falsches Programm beenden", () => {
  it("PID gehört inzwischen einem fremden Programm (alte Registrier-Datei, PID neu vergeben) → nicht gezeigt, nicht beendet", async () => {
    const stranger = foreignProgram();
    const pid = stranger.pid ?? -1;
    const { p, m } = setup("reused", { pids: async () => [pid] });
    await settled();
    const info = await m.takeoverInfo({ tool: "claude", sessionId: SID });
    expect(info.processes).toEqual([]);
    await m.takeover(req(p.worktree, [pid])).catch(() => null);
    expect(alive(pid)).toBe(true);
  });

  it("ein Codex-Fenster wird nicht als Claude beendet (Programm muss zum Werkzeug passen)", async () => {
    const codex = oldWindow(false, "codex");
    const pid = codex.pid ?? -1;
    const { p, m } = setup("wrong-tool", { pids: async () => [pid] });
    await settled();
    expect((await m.takeoverInfo({ tool: "claude", sessionId: SID })).processes).toEqual([]);
    await m.takeover(req(p.worktree, [pid])).catch(() => null);
    expect(alive(pid)).toBe(true);
  });

  it("PID zwischen Vorschau und Klick neu vergeben (andere Startzeit) → process_changed, nichts beendet", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    let start = 1_000_000;
    const table: () => Promise<Table> = async () => new Map([[pid, { ppid: 1, comm: "claude", startMs: start }]]);
    const { p, m } = setup("pid-reuse", { pids: async () => [pid], processTable: table });
    expect((await m.takeoverInfo({ tool: "claude", sessionId: SID })).processes.map((x) => x.pid)).toEqual([pid]);
    start += 5_000; // dieselbe Nummer, aber ein anderer Prozess
    await expect(m.takeover(req(p.worktree, [pid]))).rejects.toMatchObject({ code: "process_changed" });
    expect(alive(pid)).toBe(true);
    expect(p.log("claude")).toEqual([]);
  });

  it("ohne vorherige Vorschau wird nichts beendet (die Freigabe gilt nur für das, was der Dialog gezeigt hat)", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const { p, m } = setup("no-preview", { pids: async () => [pid] });
    await settled();
    await expect(m.takeover(req(p.worktree, [pid]))).rejects.toMatchObject({ code: "process_changed" });
    expect(alive(pid)).toBe(true);
  });

  it("PIDs ≤ 1 und die eigene PID der Brücke werden nie angefasst", async () => {
    const { m } = setup("bad-pids", { pids: async () => [0, 1, -1, process.pid, 1.5] });
    expect((await m.takeoverInfo({ tool: "claude", sessionId: SID })).processes).toEqual([]);
  });
});

describe("keine Einschleusung über Session-ID oder Ordner", () => {
  it("Session-ID, die wie eine Option aussieht (`--…`), wird abgelehnt", async () => {
    const { p, m } = setup("dash-id");
    for (const sessionId of ["--dangerously-skip-permissions", "-c"]) {
      await expect(m.rpc("takeover", req(p.worktree, [], "claude", sessionId))).rejects.toThrow();
      await expect(m.rpc("resume", req(p.worktree, [], "claude", sessionId))).rejects.toThrow();
    }
    expect(p.log("claude")).toEqual([]);
  });

  it("Ordner mit `#{…}` im Namen: tmux wertet das nicht aus, Start genau in diesem Ordner", async () => {
    const { p, m } = setup("hash-cwd");
    const odd = join(p.root, "app", ".worktrees", "feat#{session_name}#(true)");
    mkdirSync(odd, { recursive: true });
    await m.takeover(req(odd));
    expect(await until(() => p.log("claude").length > 1)).toBe(true);
    expect(p.log("claude")[0]).toBe(`cwd=${odd}`);
  });
});

describe("läuft schon in der NyxOS", () => {
  it("Info meldet den Namen; Übernehmen startet nichts doppelt, sondern liefert die laufende Sitzung", async () => {
    const { p, m, tmux } = setup("already");
    const started = await m.start({ tool: "claude", model: null, cwd: p.root, prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
    const sid = started.sessionId ?? "";
    const panes = await tmux.listPanes();
    const panePid = panes.find((x) => x.name === started.tmuxName)?.panePid ?? -1;
    const m2 = new TerminalManager({
      tmux,
      projectRoots: [p.root],
      path: `${p.bin}:/usr/bin:/bin`,
      log: () => {},
      processAttached: async () => true,
      claudePids: async () => new Map([[panePid, sid]]),
      sessionPids: async () => [panePid],
    });
    const info = await m2.takeoverInfo({ tool: "claude", sessionId: sid });
    expect(info).toEqual({ processes: [], inNyxOS: started.tmuxName });
    p.clear("claude");
    const r = await m2.takeover(req(p.root, [], "claude", sid));
    expect(r.tmuxName).toBe(started.tmuxName);
    expect((await tmux.listPanes()).length).toBe(1);
  });
});

describe("Wo läuft das alte Fenster? (für den Dialog)", () => {
  const table = new Map<number, { ppid: number; comm: string }>([
    [1, { ppid: 0, comm: "/sbin/launchd" }],
    [100, { ppid: 1, comm: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" }],
    [101, { ppid: 100, comm: "/usr/bin/login" }],
    [102, { ppid: 101, comm: "-zsh" }],
    [103, { ppid: 102, comm: "claude" }],
    [200, { ppid: 1, comm: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" }],
    [201, { ppid: 200, comm: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" }],
    [202, { ppid: 201, comm: "/bin/zsh" }],
    [203, { ppid: 202, comm: "codex" }],
    [300, { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
    [301, { ppid: 300, comm: "claude" }],
    [400, { ppid: 1, comm: "claude" }],
  ]);
  it("erkennt Terminal, VS Code, iTerm; sonst null", () => {
    expect(appOf(table, 103)).toBe("Terminal");
    expect(appOf(table, 203)).toBe("VS Code");
    expect(appOf(table, 301)).toBe("iTerm");
    expect(appOf(table, 400)).toBeNull();
    expect(appOf(table, 999)).toBeNull();
  });
});

describe("ist das wirklich Claude/Codex? (ps)", () => {
  it("erkennt das Werkzeug am Programmnamen, unter node nur an der Befehlszeile", () => {
    expect(looksLikeTool("claude", "claude", null)).toBe(true);
    expect(looksLikeTool("codex", "/opt/homebrew/bin/codex", null)).toBe(true);
    expect(looksLikeTool("claude", "codex", null)).toBe(false);
    expect(looksLikeTool("claude", "/usr/bin/tail", "tail -f /Users/c/.claude/projects/x.jsonl")).toBe(false);
    expect(looksLikeTool("codex", "/Applications/CodexBar.app/Contents/MacOS/CodexBar", null)).toBe(false);
    expect(looksLikeTool("claude", "node", "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
    expect(looksLikeTool("codex", "node", "node /Users/c/.npm/bin/codex resume x")).toBe(true);
    expect(looksLikeTool("claude", "node", "node /Users/c/code/nyxos/apps/bridge/dist/cli.js")).toBe(false);
    expect(looksLikeTool("claude", "node", null)).toBe(false);
  });

  it("liest PID, Eltern, Startzeit und Programm aus `ps` (auch einstellige Tage)", () => {
    const t = parseProcessTable(["  103   102 Fri Sep  5 13:37:12 2026     claude", "  203   202 Thu Sep 24 08:00:01 2026     /Applications/Visual Studio Code.app/x", "kaputt"].join("\n"));
    expect(t.get(103)).toEqual({ ppid: 102, comm: "claude", startMs: new Date(2026, 8, 5, 13, 37, 12).getTime() });
    expect(t.get(203)?.comm).toBe("/Applications/Visual Studio Code.app/x");
    expect(t.size).toBe(2);
  });
});

describe("Codex: wer hält die Rollout-Datei offen? (lsof)", () => {
  const out = ["p501", "fcwd", "n/Users/c", "n/Users/c/.codex/sessions/2026/09/25/rollout-a.jsonl", "p777", "n/Users/c/.codex/sessions/2026/09/25/rollout-b.jsonl", "p778", "n/Users/c/.codex/sessions/2026/09/25/rollout-a.jsonl"].join("\n");
  it("liefert genau die PIDs zu dieser Datei", () => {
    expect(parseLsofPidsForPath(out, "/Users/c/.codex/sessions/2026/09/25/rollout-a.jsonl")).toEqual([501, 778]);
    expect(parseLsofPidsForPath(out, "/Users/c/.codex/sessions/x.jsonl")).toEqual([]);
  });
  it("lsof ohne Treffer (Exit 1) → leer, ein einziger Aufruf", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      throw Object.assign(new Error("exit 1"), { stdout: "" });
    }) as unknown as Parameters<typeof codexPidsFor>[1];
    expect(await codexPidsFor("/x", fake)).toEqual([]);
    expect(calls).toBe(1);
  });
});

// „Prozess beenden" ohne tmux lief über `~/.claude/sessions/<pid>.json` und schickte
// SIGTERM an diese PID — ohne zu prüfen, ob sie noch Claude ist. Eine liegen gebliebene Datei eines
// abgestürzten Claude zeigt auf eine PID, die macOS längst neu vergeben hat. Jetzt: dieselbe Prüfung wie beim
// Übernehmen (ps-Programm claude + Startzeit wie im Register), und direkt vor dem Signal noch einmal.
describe("Prozess beenden ohne tmux: nur echte Claude-Prozesse mit passender Startzeit", () => {
  const psStart = (pid: number): number =>
    Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }).toString().trim());
  const register = (pid: number) => async () => new Map([[pid, SID]]);

  it("fremdes Programm unter der PID aus dem Register (PID neu vergeben) → nie beendet", async () => {
    const foreign = foreignProgram();
    const pid = foreign.pid ?? -1;
    const { m } = setup("kill-foreign", { claudePids: register(pid), pids: async () => [pid], sessionStart: async () => ({ procStartMs: psStart(pid), startedAtMs: null }) });
    await settled();
    await expect(m.kill({ tool: "claude", sessionId: SID, tmuxName: null })).rejects.toMatchObject({ code: "not_found" });
    expect(alive(pid)).toBe(true);
  });

  it("Claude-Prozess, aber mit anderer Startzeit als im Register → nie beendet", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const { m } = setup("kill-other-start", { claudePids: register(pid), pids: async () => [pid], sessionStart: async () => ({ procStartMs: Date.now() - 3_600_000, startedAtMs: null }) });
    await settled();
    await expect(m.kill({ tool: "claude", sessionId: SID, tmuxName: null })).rejects.toMatchObject({ code: "not_found" });
    expect(alive(pid)).toBe(true);
  });

  it("Register ohne Startzeit → nicht beendet (lieber nichts als das Falsche)", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const { m } = setup("kill-no-start", { claudePids: register(pid), pids: async () => [pid], sessionStart: async () => null });
    await settled();
    await expect(m.kill({ tool: "claude", sessionId: SID, tmuxName: null })).rejects.toMatchObject({ code: "not_found" });
    expect(alive(pid)).toBe(true);
  });

  it("echter Claude-Prozess mit Startzeit wie im Register → sauber beendet (SIGTERM), sonst niemand", async () => {
    const old = oldWindow();
    const pid = old.pid ?? -1;
    const other = oldWindow();
    let signal: string | null = null;
    old.once("exit", (_c, sig) => (signal = sig));
    const { m } = setup("kill-ok", { claudePids: register(pid), pids: async () => [pid], sessionStart: async (_t, _s, p) => (p === pid ? { procStartMs: psStart(pid), startedAtMs: null } : null) });
    await settled();
    expect(await m.kill({ tool: "claude", sessionId: SID, tmuxName: null })).toEqual({ killed: true, via: "signal" });
    expect(await until(() => !alive(pid))).toBe(true);
    expect(signal).toBe("SIGTERM");
    expect(alive(other.pid ?? -1)).toBe(true);
  });
});

describe("Register-Startzeit lesen und vergleichen", () => {
  it("`procStart` ist UTC im lstart-Format; ±1 s gilt als gleich", () => {
    const rec = recordedStart({ procStart: "Fri Sep 25 08:49:41 2026", startedAt: 1790326182749 });
    expect(rec.procStartMs).toBe(Date.UTC(2026, 8, 25, 8, 49, 41));
    expect(sameStart(Date.UTC(2026, 8, 25, 8, 49, 41), rec)).toBe(true);
    expect(sameStart(Date.UTC(2026, 8, 25, 8, 49, 43), rec)).toBe(false);
    expect(recordedStart({ procStart: "Fri Sep  5 08:49:41 2026" }).procStartMs).toBe(Date.UTC(2026, 8, 5, 8, 49, 41));
  });
  it("ohne `procStart`: `startedAt` muss kurz nach dem Prozessstart liegen; ohne beides nie", () => {
    const ps = Date.UTC(2026, 8, 25, 8, 49, 41);
    expect(sameStart(ps, recordedStart({ startedAt: ps + 1700 }))).toBe(true);
    expect(sameStart(ps, recordedStart({ startedAt: ps - 3_600_000 }))).toBe(false);
    expect(sameStart(ps, recordedStart({ procStart: "kaputt" }))).toBe(false);
    expect(sameStart(ps, null)).toBe(false);
  });
});
