// Leitplanken Ende-zu-Ende: der echte Hook (`nyxos-bridge guard`, per tsx als Kindprozess)
// bekommt eine echte Claude-Code-PreToolUse-JSON auf stdin und spricht mit dem echten Server (PGlite).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { approvals } from "../../server/src/db/schema.js";
import { TOKEN, setup } from "../../server/test/helpers.js";
import { GUARD_DEADLINE_MS, guardSessionEnv, guardSettingsJson, runGuard } from "../src/guard/hook.js";
import { hookScript } from "../src/spool.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const MAIN = join(REPO, "apps", "bridge", "src", "main.ts");

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0).reverse()) s();
});

const timings: Record<string, number[]> = {};
const time = (k: string, ms: number) => (timings[k] ??= []).push(ms);
afterAll(() => {
  const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { n: v.length, median: Math.round([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0), max: Math.round(Math.max(...v)) }]));
  console.log("Leitplanken-Hook Laufzeiten (ms):", JSON.stringify(summary));
});

/** Eine Auftrags-Worktree wie von `git worktree add`: `.git` ist eine Datei mit `gitdir:`. */
function fakeWorktree(branch: string) {
  const base = mkdtempSync(join(tmpdir(), "nyxos-guard-"));
  const gitdir = join(base, "main-repo", ".git", "worktrees", "t01");
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
  const wt = join(base, "wt-t01");
  mkdirSync(join(wt, "apps"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
  return { base, wt };
}

async function world(opts: { serverDown?: boolean } = {}) {
  const srv = await setup();
  const net = { guardCalls: 0 };
  const server = serve({
    fetch: (req) => {
      if (new URL(req.url).pathname === "/guard/check") net.guardCalls++;
      return srv.app.fetch(req);
    },
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  if (opts.serverDown) server.close();
  else stops.push(() => void server.close());

  const { base, wt } = fakeWorktree("auftrag/t-01");
  const cfgPath = join(base, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: TOKEN }));
  // Texte hier auf Deutsch prüfen (die Sprache folgt sonst dem System).
  const nyxosEnv = { NYXOS_AUFTRAG: "T-01", NYXOS_BRIDGE_CONFIG: cfgPath, NYXOS_LANG: "de" };

  const payload = (command: string, sessionId = "sess-guard-1") =>
    JSON.stringify({
      session_id: sessionId,
      transcript_path: `/Users/x/.claude/projects/p/${sessionId}.jsonl`,
      cwd: wt,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Test" },
    });

  const runHook = (stdin: string, env: Record<string, string>) =>
    new Promise<{ stdout: string; code: number | null; ms: number }>((resolve, reject) => {
      const t0 = performance.now();
      const child = spawn(TSX, [MAIN, "guard"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, code, ms: performance.now() - t0 }));
      child.stdin.end(stdin);
    });

  const decide = (id: number, decision: "approve" | "deny") =>
    srv.app.request(`/api/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }), headers: { "content-type": "application/json" } });

  return { srv, net, wt, base, nyxosEnv, payload, runHook, decide };
}

function parseDeny(stdout: string): { reason: string; id: number | null } {
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  const m = /#(\d+)/.exec(out.hookSpecificOutput.permissionDecisionReason);
  return { reason: out.hookSpecificOutput.permissionDecisionReason, id: m ? Number(m[1]) : null };
}

describe("Leitplanken-Hook (Kindprozess gegen echten Server)", () => {
  it("ohne NYXOS_AUFTRAG (eigene Session des Nutzers): keine Ausgabe, keine Anfrage", async () => {
    const w = await world();
    const r = await w.runHook(w.payload("git push --force origin main"), {});
    time("node-ohne-auftrag", r.ms);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(w.net.guardCalls).toBe(0);
    expect(await w.srv.db.select().from(approvals)).toHaveLength(0);
  });

  it("git push → deny-JSON + Anfrage; nach Freigabe genau EIN Durchlauf, danach wieder deny", async () => {
    const w = await world();
    const first = await w.runHook(w.payload("git push origin HEAD"), w.nyxosEnv);
    time("node-gefaehrlich", first.ms);
    expect(first.code).toBe(0);
    const deny = parseDeny(first.stdout);
    expect(deny.reason).toContain("git push");
    expect(deny.reason).toContain("beim Nutzer");
    expect(deny.id).toBeTypeOf("number");
    const rows = await w.srv.db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: deny.id, status: "pending", rule: "git_push", sessionKey: "claude:sess-guard-1", auftrag: "T-01", worktree: w.wt, cwd: w.wt });

    expect((await w.decide(deny.id as number, "approve")).status).toBe(200);
    const allowed = await w.runHook(w.payload("git push origin HEAD"), w.nyxosEnv);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe("");

    const again = await w.runHook(w.payload("git push origin HEAD"), w.nyxosEnv);
    const deny2 = parseDeny(again.stdout);
    expect(deny2.id).not.toBe(deny.id);
    expect(w.net.guardCalls).toBe(3);
  });

  it("Merge auf main (checkout main && merge) → deny", async () => {
    const w = await world();
    const r = await w.runHook(w.payload("git checkout main && git merge --no-ff auftrag/t-01"), w.nyxosEnv);
    expect(parseDeny(r.stdout).reason).toContain("main");
    const rows = await w.srv.db.select().from(approvals);
    expect(rows[0]?.rule).toBe("merge_main");
  });

  it("harmloser Befehl → keine Ausgabe und keine Netzwerk-Anfrage", async () => {
    const w = await world();
    for (const cmd of ["ls -la", "git merge main", "rm -rf apps", 'echo "git push"', "git push --dry-run"]) {
      const r = await w.runHook(w.payload(cmd), w.nyxosEnv);
      time("node-harmlos", r.ms);
      expect(r.code).toBe(0);
      expect(r.stdout, cmd).toBe("");
    }
    expect(w.net.guardCalls).toBe(0);
  });

  it("andere Werkzeuge und kaputte Eingaben → nie blockieren", async () => {
    const w = await world();
    const write = JSON.stringify({ session_id: "s", cwd: w.wt, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/etc/x", content: "git push" } });
    for (const input of [write, "kein json", ""]) {
      const r = await w.runHook(input, w.nyxosEnv);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(w.net.guardCalls).toBe(0);
  });

  it("Server nicht erreichbar → trotzdem deny (fail closed), mit Hinweis", async () => {
    const w = await world({ serverDown: true });
    const r = await w.runHook(w.payload("git push"), w.nyxosEnv);
    expect(r.code).toBe(0);
    const deny = parseDeny(r.stdout);
    expect(deny.reason).toContain("nicht erreichbar");
    expect(deny.id).toBeNull();
    // harmlos bleibt harmlos, auch ohne Server
    expect((await w.runHook(w.payload("ls"), w.nyxosEnv)).stdout).toBe("");
  });

  it("Shell-Schnellpfad: ohne NYXOS_AUFTRAG endet das installierte Hook-Skript ohne Programmstart (< 50 ms)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-guard-sh-"));
    const script = join(dir, "nyxos-hook");
    // node-Pfad existiert absichtlich nicht: würde der Schnellpfad ihn starten, gäbe es einen Fehler.
    writeFileSync(script, hookScript(join(dir, "spool"), "/nicht/vorhanden/node", "/nicht/vorhanden/bridge.js"));
    chmodSync(script, 0o755);
    const input = JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "git push" } });
    const env = { PATH: "/usr/bin:/bin" };
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = spawnSync(script, ["guard"], { input, env });
      time("shell-ohne-auftrag", performance.now() - t0);
      expect(r.status).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    }
    const sorted = [...(timings["shell-ohne-auftrag"] ?? [])].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(50);
    // Mit Auftrag geht das Skript an das Programm weiter (hier: nicht vorhanden → Fehlercode).
    expect(spawnSync(script, ["guard"], { input, env: { ...env, NYXOS_AUFTRAG: "T-01" } }).status).not.toBe(0);
  });

  it("guardSettingsJson erzeugt einen PreToolUse-Eintrag nur für Bash, guardSessionEnv die Umgebung", () => {
    const s = JSON.parse(guardSettingsJson("/Users/x/Library/Application Support/NyxOS/bin/nyxos-bridge")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
    };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]?.matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0]?.hooks[0]).toEqual({ type: "command", command: "'/Users/x/Library/Application Support/NyxOS/bin/nyxos-bridge' guard", timeout: 5 });
    expect(guardSessionEnv("A02", "/wt/a02")).toEqual({ NYXOS_AUFTRAG: "A02", NYXOS_WORKTREE: "/wt/a02" });
  });

  it("hängt die Prüfung (Server antwortet nie, ignoriert Abbruch) → nach dem internen Limit verweigern statt durchlassen", async () => {
    // Claude Code lässt einen Hook, der länger als sein timeout (5 s) läuft, DURCH (fail-open) – deshalb
    // entscheidet der Hook selbst spätestens nach GUARD_DEADLINE_MS und verweigert.
    expect(GUARD_DEADLINE_MS).toBeLessThanOrEqual(2000);
    const { wt } = fakeWorktree("auftrag/t-01");
    const input = JSON.stringify({ session_id: "s", cwd: wt, tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
    const t0 = performance.now();
    const out = await runGuard(input, { NYXOS_AUFTRAG: "T-01", NYXOS_WORKTREE: wt }, {
      server: () => ({ serverUrl: "http://127.0.0.1:9", token: "x" }),
      fetchImpl: () => new Promise<Response>(() => {}),
      timeoutMs: 60_000,
      deadlineMs: 150,
    });
    expect(performance.now() - t0).toBeLessThan(1500);
    const parsed = JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/zu lange/);
  });

  it("harmlose Befehle kommen nie in die Zeitgrenze", async () => {
    const { wt } = fakeWorktree("auftrag/t-01");
    const input = JSON.stringify({ session_id: "s", cwd: wt, tool_name: "Bash", tool_input: { command: "pnpm test" } });
    const out = await runGuard(input, { NYXOS_AUFTRAG: "T-01", NYXOS_WORKTREE: wt }, { fetchImpl: () => new Promise<Response>(() => {}), deadlineMs: 150 });
    expect(out).toMatchObject({ stdout: "", asked: false });
  });
});
