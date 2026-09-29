// Version of this NyxOS build: NYXOS_VERSION, else the `version` of the nearest package.json named "nyxos"
// (release package: <app>/server/dist → <app>/package.json; source tree: apps/server/src → repo root).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function findVersion(start: string = import.meta.dirname): string {
  if (process.env.NYXOS_VERSION) return process.env.NYXOS_VERSION;
  for (let dir = start, i = 0; i < 5; i++, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "nyxos" && pkg.version) return pkg.version;
    } catch {
      // keep looking one folder up
    }
  }
  return "0.0.0-dev";
}
