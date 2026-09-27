// Demo from the onboarding: the local instance starts a demo instance (`POST /api/demo/start`), the demo is
// look-only (writes → 403 demo_readonly, except browsing and Nyx), Nyx answers there with prepared texts when no
// AI is available, and `/api/app/info` tells the web app about the demo.
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLang, type HaikuStreamEvent } from "@nyxos/shared";
import { count } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { Updater } from "../src/app-info/updates.js";
import { entries } from "../src/db/schema.js";
import { demoSessionId } from "../src/demo/build-sessions.js";
import { DemoLauncher, selfCommand, type DemoProcess, type DemoSpawn } from "../src/demo/launcher.js";
import { demoQuestions, detectDemoEngine, enableDemoNyx, scriptedAnswer } from "../src/demo/nyx.js";
import { demoWriteAllowed } from "../src/demo/readonly.js";
import { seedDemoIfEmpty } from "../src/demo/seed.js";
import type { ToolContext } from "../src/haiku/tools.js";
import { setup } from "./helpers.js";

const appInfo = (demo: boolean, mode: "local" | "server" = "local") => ({ version: "1.0.0", mode, demo, dataDir: null, updater: new Updater({ version: "1.0.0", cli: null }) });
const json = { "content-type": "application/json" };
const CONTEXT = { path: "/overview", tab: null, filters: {}, openSessionId: null, openEntryId: null };

afterEach(() => setLang("de"));

describe("demo: look only", () => {
  it("rejects writes with 403 demo_readonly, lets browsing and Nyx through", async () => {
    const { app } = await setup({ appInfo: appInfo(true), demo: { engine: "scripted", homeUrl: null } });
    for (const [method, path] of [
      ["POST", "/api/entries"],
      ["PATCH", "/api/haiku/settings"],
      ["DELETE", "/api/nyx/memory/1"],
      ["PUT", "/api/app/settings"],
      ["POST", "/api/terminal/start"],
      ["POST", "/terminal/abc"],
      ["POST", "/api/nyx/files"],
    ] as const) {
      const res = await app.request(path, { method, headers: json, body: "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("demo_readonly");
      expect(body.error).toBe("In der Demo kannst du dich nur umsehen. Richte NyxOS ein, um loszulegen.");
    }
    expect((await app.request("/api/overview")).status).toBe(200);
    expect((await app.request("/api/away/heartbeat", { method: "POST", headers: json, body: "{}" })).status).toBe(200);
    expect((await app.request("/api/sessions/claude:x/opened", { method: "POST", headers: json, body: JSON.stringify({ openedAt: new Date().toISOString() }) })).status).not.toBe(403);
    expect((await app.request("/api/auth/logout", { method: "POST", headers: json, body: "{}" })).status).not.toBe(403);
  });

  it("the allow-list: GET always, browsing and Nyx writes, nothing else", () => {
    expect(demoWriteAllowed("GET", "/api/entries")).toBe(true);
    expect(demoWriteAllowed("POST", "/api/haiku/chat")).toBe(true);
    expect(demoWriteAllowed("POST", "/api/haiku/threads/7/interrupted")).toBe(true);
    expect(demoWriteAllowed("POST", "/api/nyx/ui/reply")).toBe(true);
    expect(demoWriteAllowed("POST", "/api/auth/login/verify")).toBe(true);
    expect(demoWriteAllowed("POST", "/ingest/events")).toBe(true);
    expect(demoWriteAllowed("PATCH", "/api/haiku/threads/7")).toBe(false);
    expect(demoWriteAllowed("DELETE", "/api/haiku/threads/7")).toBe(false);
    expect(demoWriteAllowed("POST", "/api/haiku/threads/7/summary")).toBe(false);
    expect(demoWriteAllowed("POST", "/api/nyx/ui/command")).toBe(false);
    expect(demoWriteAllowed("POST", "/api/sessions/opened")).toBe(false);
  });

  it("a normal instance is not affected", async () => {
    const { app } = await setup();
    const res = await app.request("/api/entries", { method: "POST", headers: json, body: JSON.stringify({ kind: "idee", title: "Echte Idee" }) });
    expect(res.status).not.toBe(403);
  });

  it("Nyx only has reading tools, and its app_api cannot write", async () => {
    const t = await setup({ appInfo: appInfo(true), demo: { engine: "ai", homeUrl: null } });
    const names = t.haiku.tools.namesFor("full");
    expect(names).toContain("lage");
    expect(names).toContain("app_api");
    for (const writer of ["idee_anlegen", "frage_stellen", "freigabe_anfragen", "plan_vorschlagen", "memory", "todo", "schedule", "auftrag_starten", "memory_suggest"]) expect(names).not.toContain(writer);
    expect(t.haiku.tools.namesFor("review")).toEqual([]);
    await expect(t.haiku.tools.call("full", "idee_anlegen", { titel: "x", beschreibung: "y" }, { db: t.db, scope: "full", ideaLink: null, ideas: null })).rejects.toThrow();

    const ctx: ToolContext = { db: t.db, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web", threadId: null };
    const created = await t.haiku.tools.call("full", "app_api", { method: "POST", path: "/api/entries", body: { kind: "idee", title: "Von Nyx" } }, ctx);
    expect(JSON.stringify(created)).toContain("demo_readonly");
    // even a path the browser may write to stays closed for Nyx
    const beat = await t.haiku.tools.call("full", "app_api", { method: "POST", path: "/api/sessions/claude:x/opened", body: { openedAt: new Date().toISOString() } }, ctx);
    expect(JSON.stringify(beat)).toContain("demo_readonly");
    expect((await t.db.select({ n: count() }).from(entries))[0]?.n).toBe(0);
    // reading works
    const read = await t.haiku.tools.call("full", "app_api", { method: "GET", path: "/api/overview" }, ctx);
    expect(JSON.stringify(read)).not.toContain("demo_readonly");
  });
});

describe("demo: Nyx with prepared answers", () => {
  it("answers a chat message through the normal chat stream, with sources and a demo mark", async () => {
    const t = await setup({ appInfo: appInfo(true), demo: { engine: "scripted", homeUrl: null } });
    await seedDemoIfEmpty(t.db, { archiveDir: t.archiveDir, now: Date.now(), lang: "de" });
    await enableDemoNyx(t.db);
    const status = (await (await t.app.request("/api/haiku/status")).json()) as { engine: { state: string } };
    expect(status.engine.state).toBe("ready");

    const res = await t.app.request("/api/haiku/chat", { method: "POST", headers: json, body: JSON.stringify({ message: "Welche Session ist abgestürzt und warum?", context: CONTEXT, channel: "web" }) });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as HaikuStreamEvent);
    expect(events.some((e) => e.type === "thread")).toBe(true);
    expect(events.some((e) => e.type === "delta")).toBe(true);
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error(`no answer: ${JSON.stringify(events.slice(-2))}`);
    expect(done.text).toMatch(/Kartenstart auf Android/);
    expect(done.text).toMatch(/Demo-Antwort/);
    expect(done.text).not.toContain("[[");
    expect(done.sources.some((s) => s.kind === "session" && s.href?.includes(demoSessionId("android-map-crash")))).toBe(true);
    // the thread was created (chat is allowed) and nothing ran in the background with the stand-in
    const threads = (await (await t.app.request("/api/haiku/threads")).json()) as { threads: { title: string }[] };
    expect(threads.threads.some((th) => th.title.startsWith("Welche Session"))).toBe(true);
  }, 60_000);

  it("matches questions in German and English, and has a friendly default", async () => {
    const t = await setup();
    const de = await scriptedAnswer(t.db, "Welche Session ist abgestürzt und warum?", "de");
    expect(de).toContain(`[[session:${demoSessionId("android-map-crash")}]]`);
    expect(de).toContain("Vorbereitete Demo-Antwort");
    const en = await scriptedAnswer(t.db, "Which session crashed and why?", "de");
    expect(en).toContain("Fix crash when the map starts on Android");
    expect(en).toContain("Prepared demo answer");
    // loose wording finds the topic by keywords
    expect(await scriptedAnswer(t.db, "gibt es gerade irgendwo Konflikte zwischen den Sessions", "de")).toContain("src/lib/images.ts");
    expect(await scriptedAnswer(t.db, "how much money are we spending", "en")).toMatch(/\$\d/);
    expect(await scriptedAnswer(t.db, "was hat das team so geschafft", "de")).toContain("Webhooks");
    // unknown → the list of questions
    const other = await scriptedAnswer(t.db, "Wie wird das Wetter morgen in Lissabon?", "de");
    for (const q of demoQuestions("de")) expect(other).toContain(q);
  });

  it("offers 6–8 questions in the app language", async () => {
    const de = demoQuestions("de");
    const en = demoQuestions("en");
    expect(de.length).toBeGreaterThanOrEqual(6);
    expect(de.length).toBeLessThanOrEqual(8);
    expect(de).toContain("Was wartet heute auf mich?");
    expect(en).toContain("What is waiting for me today?");
    setLang("en");
    const { app } = await setup({ appInfo: appInfo(true), demo: { engine: "scripted", homeUrl: null } });
    setLang("en");
    const body = (await (await app.request("/api/demo/questions")).json()) as { questions: string[] };
    expect(body.questions).toEqual(en);
  });
});

describe("demo: which engine", () => {
  it("the signed-in Claude program → ai, otherwise scripted; NYXOS_DEMO_NYX forces it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-claude-"));
    const fakeClaude = (loggedIn: boolean) => {
      const bin = join(dir, `claude-${loggedIn}`);
      writeFileSync(bin, `#!/bin/sh\necho '{"loggedIn": ${loggedIn}, "authMethod": "claude.ai"}'\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    expect(await detectDemoEngine({ env: { PATH: process.env.PATH, CLAUDE_BIN: fakeClaude(true) } })).toBe("ai");
    expect(await detectDemoEngine({ env: { PATH: process.env.PATH, CLAUDE_BIN: fakeClaude(false) } })).toBe("scripted");
    expect(await detectDemoEngine({ env: { PATH: process.env.PATH, CLAUDE_BIN: join(dir, "missing") } })).toBe("scripted");
    expect(await detectDemoEngine({ env: { CLAUDE_BIN: fakeClaude(true), NYXOS_DEMO_NYX: "scripted" } })).toBe("scripted");
    expect(await detectDemoEngine({ env: { CLAUDE_BIN: join(dir, "missing"), NYXOS_DEMO_NYX: "ai" } })).toBe("ai");
  });
});

describe("demo: app info", () => {
  it("names the way home and how Nyx answers, only in the demo", async () => {
    const demo = await setup({ appInfo: appInfo(true), demo: { engine: "ai", homeUrl: "http://127.0.0.1:47800/" } });
    const info = (await (await demo.app.request("/api/app/info")).json()) as { demo: boolean; demoHomeUrl: string | null; demoEngine: string | null };
    expect(info).toMatchObject({ demo: true, demoHomeUrl: "http://127.0.0.1:47800/", demoEngine: "ai" });

    const standalone = await setup({ appInfo: appInfo(true) });
    expect(await (await standalone.app.request("/api/app/info")).json()).toMatchObject({ demo: true, demoHomeUrl: null, demoEngine: "scripted" });

    const normal = await setup({ appInfo: appInfo(false) });
    expect(await (await normal.app.request("/api/app/info")).json()).toMatchObject({ demo: false, demoHomeUrl: null, demoEngine: null });
  });
});

class FakeChild extends EventEmitter implements DemoProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit"));
    return true;
  }
  crash(): void {
    this.exitCode = 1;
    this.emit("exit");
  }
}

/** A fake demo program: "starts" by writing its machine token, answers /health and /local/login-code. */
function fakeDemo(opts: { healthy?: boolean; dies?: boolean } = {}) {
  const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  const spawn: DemoSpawn = (command, args, o) => {
    const child = new FakeChild();
    writeFileSync(join(o.env.NYXOS_DATA_DIR ?? "", "bridge-token"), `token-${spawned.length}\n`);
    spawned.push({ command, args, env: o.env, child });
    if (opts.dies) queueMicrotask(() => child.crash());
    return child;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      if (opts.healthy === false) throw new Error("connection refused");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/local/login-code")) {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === `Bearer token-${spawned.length - 1}` ? new Response(JSON.stringify({ code: `code-${spawned.length}` }), { status: 200 }) : new Response("{}", { status: 401 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { spawned, spawn, fetch: fetchImpl };
}

describe("POST /api/demo/start", () => {
  it("starts one demo child with fresh data and answers with its sign-in link; reuses it while it runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "nyxos-demo-home-"));
    const fake = fakeDemo();
    const launcher = new DemoLauncher({ home, port: 47999, command: "/usr/bin/node", args: ["--import", "loader", "/x/dist/local.js"], env: { PATH: "/usr/bin", NYXOS_SECRETS_KEY: "main-key", PORT: "47800" }, spawn: fake.spawn, fetch: fake.fetch, pollMs: 5 });
    const { app } = await setup({ appInfo: appInfo(false), demoLauncher: launcher });

    const res = await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "http://127.0.0.1:47999/auth/local?code=code-1&next=/overview" });
    expect(fake.spawned).toHaveLength(1);
    const first = fake.spawned[0];
    expect(first?.command).toBe("/usr/bin/node");
    expect(first?.args).toEqual(["--import", "loader", "/x/dist/local.js"]);
    expect(first?.env).toMatchObject({ NYXOS_DEMO: "1", NYXOS_DATA_DIR: join(home, "demo"), PORT: "47999", NYXOS_DEMO_LANG: "de", NYXOS_DEMO_HOME_URL: "http://localhost/", PATH: "/usr/bin" });
    expect(first?.env.NYXOS_SECRETS_KEY).toBeUndefined();
    expect(existsSync(join(home, "logs", "demo.log"))).toBe(true);

    // running and healthy → same child, new one-time code
    writeFileSync(join(home, "demo", "marker"), "x");
    const again = (await (await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).json()) as { url: string };
    expect(fake.spawned).toHaveLength(1);
    expect(again.url).toContain("code=code-1");
    expect(existsSync(join(home, "demo", "marker"))).toBe(true);

    // the child died → a fresh start with fresh data
    first?.child.crash();
    const third = await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" });
    expect(third.status).toBe(200);
    expect(fake.spawned).toHaveLength(2);
    expect(existsSync(join(home, "demo", "marker"))).toBe(false);
    expect(readFileSync(join(home, "demo", "bridge-token"), "utf8").trim()).toBe("token-1");

    await launcher.stop();
    expect(fake.spawned[1]?.child.signalCode).toBe("SIGTERM");
  });

  it("moves the demo to a free port when another program holds the preferred one", async () => {
    const home = mkdtempSync(join(tmpdir(), "nyxos-demo-home-"));
    const fake = fakeDemo();
    const launcher = new DemoLauncher({ home, port: 47999, command: "node", args: ["x.js"], spawn: fake.spawn, fetch: fake.fetch, pollMs: 5, portFree: async (port) => port !== 47999 });
    const { app } = await setup({ appInfo: appInfo(false), demoLauncher: launcher });

    const { url } = (await (await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).json()) as { url: string };
    expect(launcher.port).not.toBe(47999);
    expect(launcher.port).toBeGreaterThan(0);
    expect(url.startsWith(`http://127.0.0.1:${launcher.port}/auth/local?code=`)).toBe(true);
    expect(fake.spawned[0]?.env.PORT).toBe(String(launcher.port));
    await launcher.stop();
  });

  it("503 with a sentence when the demo does not come up, 409 outside a local instance", async () => {
    const home = mkdtempSync(join(tmpdir(), "nyxos-demo-home-"));
    const dead = fakeDemo({ healthy: false, dies: true });
    const { app } = await setup({ appInfo: appInfo(false), demoLauncher: new DemoLauncher({ home, port: 47998, command: "node", args: ["x.js"], spawn: dead.spawn, fetch: dead.fetch, pollMs: 5 }) });
    const res = await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Die Demo startet gerade nicht. Versuch es gleich noch einmal.");

    const slow = fakeDemo({ healthy: false });
    const timed = new DemoLauncher({ home, port: 47997, command: "node", args: ["x.js"], spawn: slow.spawn, fetch: slow.fetch, pollMs: 5, startTimeoutMs: 60 });
    const t2 = await setup({ appInfo: appInfo(false), demoLauncher: timed });
    expect((await t2.app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).status).toBe(503);
    expect(slow.spawned[0]?.child.signalCode).toBe("SIGTERM");

    const inDemo = await setup({ appInfo: appInfo(true) });
    expect((await inDemo.app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).status).toBe(409);
    const inServer = await setup({ appInfo: appInfo(false, "server") });
    expect((await inServer.app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).status).toBe(409);
  });

  it("needs the sign-in like every write", async () => {
    const { app } = await setup({ signedIn: false, appInfo: appInfo(false) });
    expect((await app.request("/api/demo/start", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
  });

  it("runs the same program again: loader flags from source, without the debugger", () => {
    expect(selfCommand({ execPath: "/n/node", execArgv: ["--require", "/t/preflight.cjs", "--import", "file:///t/loader.mjs", "--inspect=9229"], argv: ["/n/node", "/r/apps/server/src/local.ts"] })).toEqual({
      command: "/n/node",
      args: ["--require", "/t/preflight.cjs", "--import", "file:///t/loader.mjs", "/r/apps/server/src/local.ts"],
      fromSource: true,
    });
    expect(selfCommand({ execPath: "/n/node", execArgv: [], argv: ["/n/node", "/a/server/dist/local.js"] })).toEqual({ command: "/n/node", args: ["/a/server/dist/local.js"], fromSource: false });
  });
});
