#!/usr/bin/env node
// Builds the release package `dist/nyxos-<version>.tar.gz` plus `dist/SHA256SUMS`.
// The package runs on macOS and Linux (x64 and arm64): it only contains JavaScript, the web app and
// PGlite (WebAssembly); the installer brings its own Node.js. The optional voice pack ships as Python source
// (voice/); `nyxos voice install` fetches Python and the pinned packages for the computer it runs on.
//
//   node scripts/package.mjs            build everything, then package
//   node scripts/package.mjs --no-build package the existing build output
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const name = `nyxos-${version}`;
const out = join(root, "dist");
const stage = join(out, name);

const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (!process.argv.includes("--no-build")) {
  sh("pnpm", ["--filter", "@nyxos/server", "run", "build"]);
  sh("pnpm", ["--filter", "@nyxos/web", "run", "build"]);
  sh("pnpm", ["--filter", "@nyxos/bridge", "run", "build"]);
}

const need = (p) => {
  if (!existsSync(p)) throw new Error(`missing build output: ${p}`);
  return p;
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// package.json of the release: name, version and the GitHub repository for updates.
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "nyxos", version, license: pkg.license, type: "module", nyxos: pkg.nyxos ?? {} }, null, 2) + "\n");
for (const f of ["README.md", "LICENSE", "NOTICE", "CHANGELOG.md"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));

// `nyxos` command
cpSync(need(join(root, "apps/cli/bin/nyxos")), join(stage, "bin/nyxos"));
cpSync(need(join(root, "apps/cli/nyxos.mjs")), join(stage, "cli/nyxos.mjs"));
cpSync(need(join(root, "apps/cli/voice.mjs")), join(stage, "cli/voice.mjs"));

// voice service (Python source + pinned requirements), run by `nyxos voice install` / the local server
const voiceSrc = join(root, "infra/nyx-voice");
cpSync(need(join(voiceSrc, "nyx_voice")), join(stage, "voice/nyx_voice"), { recursive: true, filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc") });
cpSync(need(join(voiceSrc, "requirements-local.txt")), join(stage, "voice/requirements-local.txt"));

// server + web app + migrations
cpSync(need(join(root, "apps/server/dist")), join(stage, "server/dist"), { recursive: true });
cpSync(need(join(root, "apps/server/drizzle")), join(stage, "server/drizzle"), { recursive: true });
cpSync(need(join(root, "apps/web/dist")), join(stage, "server/web"), { recursive: true });
writeFileSync(join(stage, "server/package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
// PGlite is loaded at runtime (WebAssembly files next to its JavaScript), not bundled.
const pglite = realpathSync(join(root, "apps/server/node_modules/@electric-sql/pglite"));
cpSync(pglite, join(stage, "server/node_modules/@electric-sql/pglite"), { recursive: true, dereference: true });

// bridge
cpSync(need(join(root, "apps/bridge/dist/bridge.js")), join(stage, "bridge/bridge.js"));
writeFileSync(join(stage, "bridge/package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");

const tarball = join(out, `${name}.tar.gz`);
rmSync(tarball, { force: true });
execFileSync("tar", ["--no-xattrs", "-czf", tarball, "-C", out, name], { cwd: root, stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${name}.tar.gz\n`);
console.log(`\n${tarball}\nsha256 ${sum}`);
