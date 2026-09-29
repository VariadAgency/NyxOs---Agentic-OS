// Local sign-in link (`nyxos open`): machine token → one-time code → `/auth/local` sets the session cookie.
// Only in local mode; the redirect target afterwards must stay on this server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Updater, updateCommand } from "../src/app-info/updates.js";
import { safeLocalNext } from "../src/terminal/auth.js";
import { setup, TOKEN } from "./helpers.js";

const bearer = { authorization: `Bearer ${TOKEN}` };

async function code(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }): Promise<string> {
  const res = await app.request("/local/login-code", { method: "POST", headers: bearer });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

describe("local sign-in link", () => {
  it("signs in once, the code cannot be used twice", async () => {
    const { app } = await setup({ signedIn: false });
    const c = await code(app);
    const first = await app.request(`/auth/local?code=${c}&next=%2Fsessions`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/sessions");
    expect(first.headers.getSetCookie().some((l) => /HttpOnly/i.test(l) && /SameSite=Strict/i.test(l))).toBe(true);
    const again = await app.request(`/auth/local?code=${c}`);
    expect(again.headers.get("location")).toBe("/?login=expired");
    expect(again.headers.getSetCookie()).toHaveLength(0);
  });

  it("needs the machine token for a code", async () => {
    const { app } = await setup({ signedIn: false });
    expect((await app.request("/local/login-code", { method: "POST" })).status).toBe(401);
    expect((await app.request("/local/login-code", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("never redirects to another site", async () => {
    const { app } = await setup({ signedIn: false });
    for (const next of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "/%0d%0aSet-Cookie:x=1"]) {
      const res = await app.request(`/auth/local?code=${await code(app)}&next=${encodeURIComponent(next)}`);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("/")).toBe(true);
      expect(location.startsWith("//")).toBe(false);
      expect(location).not.toContain("\\");
      expect(location).not.toMatch(/[\r\n\t]/);
    }
  });

  it("safeLocalNext keeps plain paths with query and hash", () => {
    expect(safeLocalNext("/tasks?id=3#top")).toBe("/tasks?id=3#top");
    expect(safeLocalNext(undefined)).toBe("/");
    expect(safeLocalNext("/\\evil.example")).toBe("/");
    expect(safeLocalNext("/\u0009/evil.example")).toBe("/");
    expect(safeLocalNext("relative")).toBe("/");
  });

  it("server mode has neither the link nor the code endpoint", async () => {
    const { db } = await setup({ signedIn: false });
    const { app } = createApp({
      db,
      archiveDir: mkdtempSync(join(tmpdir(), "nyxos-archiv-")),
      appInfo: { version: "1.0.0", mode: "server", demo: false, dataDir: null, updater: new Updater({ version: "1.0.0", cli: null }) },
    });
    expect((await app.request("/local/login-code", { method: "POST", headers: bearer })).status).toBe(404);
    const res = await app.request("/auth/local?code=x");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get("location")).not.toBe("/?login=expired");
  });
});

describe("update process", () => {
  it("under systemd it gets a unit of its own, so the service restart does not kill it", () => {
    const env = { INVOCATION_ID: "abc", NYXOS_HOME: "/home/a/my nyxos", PATH: "/usr/bin" };
    const r = updateCommand("/home/a/.nyxos/bin/nyxos", env, "linux");
    expect(r.cmd).toBe("systemd-run");
    expect(r.args).toContain("--user");
    expect(r.args).toContain("--setenv=NYXOS_HOME=/home/a/my nyxos");
    expect(r.args.slice(-3)).toEqual(["/home/a/.nyxos/bin/nyxos", "update", "--yes"]);
  });

  it("elsewhere it is a plain detached process", () => {
    expect(updateCommand("/x/nyxos", { INVOCATION_ID: "abc" }, "darwin")).toEqual({ cmd: "/x/nyxos", args: ["update", "--yes"] });
    expect(updateCommand("/x/nyxos", {}, "linux")).toEqual({ cmd: "/x/nyxos", args: ["update", "--yes"] });
  });
});
