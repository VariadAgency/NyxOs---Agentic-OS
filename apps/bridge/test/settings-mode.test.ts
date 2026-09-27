// Rewriting ~/.claude/settings.json (it can hold API keys in `env`) must not make it readable for others.
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonWithBackup } from "../src/install.js";

describe("writeJsonWithBackup", () => {
  it.skipIf(process.platform === "win32")("keeps the file mode of an existing settings file (0600 stays 0600)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-settings-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"env":{"ANTHROPIC_API_KEY":"fake"}}\n');
    chmodSync(file, 0o600);
    const backup = writeJsonWithBackup(file, { env: { ANTHROPIC_API_KEY: "fake" }, hooks: {} });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backup).not.toBeNull();
    expect(statSync(backup as string).mode & 0o777).toBe(0o600);
  });
});

describe("service PATH", () => {
  it("drops relative PATH entries (., node_modules/.bin): git runs inside cloned repositories", async () => {
    const { servicePath } = await import("../src/service.js");
    const dirs = servicePath("/opt/node/bin/node", ".:node_modules/.bin::/usr/local/bin:bin").split(":");
    expect(dirs).toContain("/usr/local/bin");
    for (const d of dirs) expect(d.startsWith("/"), d).toBe(true);
  });
});
