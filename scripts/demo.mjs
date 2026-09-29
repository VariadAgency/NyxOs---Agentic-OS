#!/usr/bin/env node
// Starts the NyxOS demo straight from the repository (no installation): invented data, own data folder
// `.demo/` in the repository, port 47802. Builds the web app first if it has not been built yet.
//   pnpm demo            start with freshly generated demo data
//   pnpm demo --keep     keep the demo data of the last run
//   pnpm demo --lang en  start in English
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(root, ".demo");
const port = Number(process.env.NYXOS_DEMO_PORT ?? 47802);
const args = process.argv.slice(2);
const lang = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : null;

// Fresh invented data on every start (timestamps are relative to "now"); --keep keeps the last state.
if (!args.includes("--keep")) rmSync(home, { recursive: true, force: true });
if (!existsSync(join(root, "apps/web/dist/index.html"))) execFileSync("pnpm", ["--filter", "@nyxos/web", "run", "build"], { cwd: root, stdio: "inherit" });

const server = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "apps/server/src/local.ts")], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    NYXOS_HOME: home,
    NYXOS_DATA_DIR: join(home, "demo"),
    NYXOS_DEMO: "1",
    PORT: String(port),
    WEB_DIR: join(root, "apps/web/dist"),
    NYXOS_MIGRATIONS_DIR: join(root, "apps/server/drizzle"),
    ...(lang ? { NYXOS_DEMO_LANG: lang } : {}),
  },
});
const stop = () => server.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
const token = readFileSync(join(home, "demo", "bridge-token"), "utf8").trim();
const { code } = await (await fetch(`${base}/local/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json();
const url = `${base}/auth/local?code=${code}`;
console.log(`\nNyxOS demo: ${url}\n(link valid for 2 minutes · stop with Ctrl+C)\n`);
if (process.env.NYXOS_NO_BROWSER !== "1") try {
  execFileSync(platform() === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
} catch {
  // no browser available: the link above is enough
}
await new Promise((r) => server.on("exit", r));
