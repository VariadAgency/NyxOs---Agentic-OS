// @nyxos/shared darf kein `node:` importieren (der Barrel läuft im Browser; Vite-Dev blieb weiß).
// Die reinen POSIX-Helfer im Codex-Parser verhalten sich wie `node:path` (posix).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { posixBasename, posixJoin } from "../src/parse/codex.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("shared ohne Node-Module", () => {
  it("kein Import aus `node:*` in packages/shared/src", () => {
    const offenders = files(SRC).filter((f) => /from\s+["']node:|require\(["']node:/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("posixBasename/posixJoin verhalten sich wie path.posix", () => {
    for (const p of ["/a/b/rollout-x.jsonl", "rollout.jsonl", "/a/b/", "/", "", "a//b"]) expect(posixBasename(p)).toBe(posix.basename(p));
    const cases: [string, string][] = [
      ["/Users/c/repo", "src/a.ts"],
      ["/Users/c/repo/", "./src/a.ts"],
      ["/Users/c/repo", "../other/b.ts"],
      ["/a", "../../../x"],
      ["rel/dir", "../../.."],
      ["/a", "b/"],
      ["/a", "."],
    ];
    for (const [a, b] of cases) expect(posixJoin(a, b)).toBe(posix.join(a, b));
  });
});
