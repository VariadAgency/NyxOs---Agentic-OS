// Security hardening found in the pre-release audit: framing protection for the web app, no unauthenticated
// writes, no personal details for visitors who are not signed in.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setup, TOKEN } from "./helpers.js";

describe("framing protection (clickjacking)", () => {
  it("the web app and the API may only be framed by NyxOS itself", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "nyxos-web-"));
    writeFileSync(join(webDir, "index.html"), '<!doctype html><div id="root"></div>');
    const { app } = await setup({ webDir });
    for (const path of ["/", "/sessions/some/page", "/api/app/info"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(res.headers.get("content-security-policy") ?? "", path).toContain("frame-ancestors 'self'");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });
});

describe("GET /api/app/info without sign-in", () => {
  it("does not reveal the data folder (home path) or the user's name to visitors who are not signed in", async () => {
    const before = process.env.NYXOS_AUTH_READS;
    process.env.NYXOS_AUTH_READS = "1";
    try {
      const { Updater } = await import("../src/app-info/updates.js");
      const appInfo = { version: "1.0.0", mode: "local" as const, demo: false, dataDir: "/home/alex/.nyxos/data", updater: new Updater({ version: "1.0.0", cli: null }) };
      const { app, authHeaders } = await setup({ signedIn: false, appInfo });
      const put = await app.request("/api/app/settings", { method: "PUT", headers: { ...authHeaders, "content-type": "application/json" }, body: JSON.stringify({ userName: "Alex" }) });
      expect(put.status).toBe(200);

      const anon = (await (await app.request("/api/app/info")).json()) as { dataDir: string | null; version: string; settings: { userName: string; onboardingDone: boolean } };
      expect(anon.version).toBe("1.0.0");
      expect(anon.dataDir).toBeNull();
      expect(anon.settings.userName).toBe("");

      const own = (await (await app.request("/api/app/info", { headers: authHeaders })).json()) as { dataDir: string | null; settings: { userName: string } };
      expect(own.dataDir).toBe("/home/alex/.nyxos/data");
      expect(own.settings.userName).toBe("Alex");
    } finally {
      if (before === undefined) delete process.env.NYXOS_AUTH_READS;
      else process.env.NYXOS_AUTH_READS = before;
    }
  });
});

describe("POST /api/server/deploys", () => {
  it("needs the machine token or a signed-in session (no anonymous writes)", async () => {
    const { app } = await setup({ signedIn: false });
    const body = JSON.stringify({ gitRev: "abc1234" });
    const anon = await app.request("/api/server/deploys", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(anon.status).toBe(401);
    const machine = await app.request("/api/server/deploys", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body });
    expect(machine.status).toBe(200);
  });
});

describe("Nyx app_api: actions that run code on their own need the user's click", () => {
  it("autonomous agents, project-file writes and setup changes need a confirmation", async () => {
    const { classifyApiRequest } = await import("../src/nyx/appApi/rules.js");
    expect(classifyApiRequest("POST", "/api/entries/12/start").access).toBe("bestaetigung");
    expect(classifyApiRequest("POST", "/api/finder/write").access).toBe("bestaetigung");
    expect(classifyApiRequest("POST", "/api/setup").access).toBe("bestaetigung");
    // an autonomous session (--permission-mode auto) via the terminal route, too
    expect(classifyApiRequest("POST", "/api/terminal/start", { tool: "claude", cwd: "/p", auftrag: { id: "a1", worktree: "/p/wt" } }).access).toBe("bestaetigung");
    // a normal session (Claude asks for every risky step itself) stays direct
    expect(classifyApiRequest("POST", "/api/terminal/start", { tool: "claude", cwd: "/p", prompt: "x" }).access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/terminal/start", { tool: "claude", cwd: "/p", auftrag: null }).access).toBe("direkt");
  });
});
