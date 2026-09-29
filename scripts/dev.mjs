#!/usr/bin/env node
// Local development stack without Docker: starts (a) the dev server (apps/server/src/dev.ts, PGlite instead
// of Postgres, port 47890) and (b) a SECOND bridge instance, completely separate from an installed bridge,
// that reads the real transcripts from ~/.claude/projects and ~/.codex/sessions and sends them to the dev
// server (token "dev-token"). Never touches an installed bridge (no hook entry, no tunnel, own data folder via
// `run --data-dir`, see apps/bridge/src/run-options.ts). Development only — Ctrl+C stops both processes.
//
//   pnpm dev                                   all sessions
//   NYXOS_DEV_PROJECT_ROOTS=~/code/app pnpm dev only sessions below these folders (comma separated)
//   PROBE_PORT=47891 pnpm dev                  own port (parallel worktrees)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT ?? 47890); // parallele Worktrees: eigener Port per PROBE_PORT
const TOKEN = "dev-token";
const PROBE_DIR = join(ROOT, ".probe");
const PGLITE_DIR = join(PROBE_DIR, "pglite");
const ARCHIVE_DIR = join(PROBE_DIR, "archive");
const BRIDGE_DATA_DIR = join(PROBE_DIR, "bridge-data");
const WEB_DIR = join(ROOT, "apps/web/dist");

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`Befehl fehlgeschlagen: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

for (const d of [PGLITE_DIR, ARCHIVE_DIR, BRIDGE_DATA_DIR]) mkdirSync(d, { recursive: true });

log("probe", "baue Web-App (apps/web/dist) …");
run("pnpm", ["--filter", "@nyxos/web", "run", "build"]);

// Own minimal bridge configuration in the data folder — never the config of an installed bridge.
// claudeDir/codexDir are the real folders so real transcripts are read; serverUrl/token point to the dev server.
// eigener tmux-Socket + eigene tmux.conf für die Probe (nie `-L nyxos`).
const TMUX_SOCKET = process.env.PROBE_TMUX_SOCKET ?? "nyxos-probe";
const TMUX_CONF = join(PROBE_DIR, "tmux.conf");
run("node", ["--import", "tsx", "-e", `import { tmuxConf } from "./apps/bridge/src/terminal/shell.ts"; import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(TMUX_CONF)}, tmuxConf());`]);
const tmuxBin = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p)) ?? "tmux";
const bridgeConfig = {
  serverUrl: `http://127.0.0.1:${PORT}`,
  token: TOKEN,
  tunnel: null,
  terminal: { socket: TMUX_SOCKET, tmuxBin, conf: TMUX_CONF, path: process.env.PATH ?? null },
  projectRoots: (process.env.NYXOS_DEV_PROJECT_ROOTS ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^~(?=\/|$)/, homedir()))
    .filter((p) => p.startsWith("/")),
  claudeDir: join(homedir(), ".claude"),
  codexDir: join(homedir(), ".codex"),
};
writeFileSync(join(BRIDGE_DATA_DIR, "config.json"), JSON.stringify(bridgeConfig, null, 2) + "\n", { mode: 0o600 });
log("probe", `Brücken-Konfiguration → ${join(BRIDGE_DATA_DIR, "config.json")} (nie die installierte Brücke)`);

// Direkt das tsx-Binary aufrufen, nicht über "pnpm exec tsx" — pnpm spawnt dafür noch einmal einen
// eigenen Zwischenprozess, der SIGTERM/SIGINT nicht zuverlässig weiterreicht (beobachtet: verwaiste
// tsx-Prozesse blieben nach "pnpm exec tsx …" + SIGTERM am Elternprozess laufen). `detached: true` +
// Kill der ganzen Prozessgruppe (negative PID) beim Beenden räumt zuverlässig auf.
const TSX_BIN = join(ROOT, "node_modules/.bin/tsx");
const children = [];
function spawnTsx(tag, scriptArgs, env) {
  const child = spawn(TSX_BIN, scriptArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .forEach((l) => console.log(`[${tag}] ${l}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  children.push({ tag, child });
  return child;
}

log("probe", `starte Probe-Server auf http://127.0.0.1:${PORT} …`);
spawnTsx("server", ["apps/server/src/dev.ts"], {
  PORT: String(PORT),
  ARCHIVE_DIR,
  PGLITE_DIR,
  WEB_DIR,
});

async function waitForHealth(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      // noch nicht oben
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const healthy = await waitForHealth();
if (!healthy) {
  log("probe", "Probe-Server nach 30 s nicht grün — breche ab.");
  for (const { child } of children) child.kill("SIGTERM");
  process.exit(1);
}
log("probe", "Probe-Server ist grün.");

// Tasks/audits arrive as in real operation through the bridge (it delivers GOAL.md files and audit plans
// from the project folders to `POST /ingest/entry-sources`, read only) — no import call of its own here.
log("probe", "starte zweite, getrennte Brücken-Instanz (--data-dir, liest echte Verläufe) …");
spawnTsx("bridge", ["apps/bridge/src/main.ts", "run", "--data-dir", BRIDGE_DATA_DIR], {});

// Logs how many sessions were read until the number is stable (initial import finished).
async function measureImport() {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  const STABLE_MS = 5_000;
  const TIMEOUT_MS = 120_000;
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions?limit=2000`);
      const body = await res.json();
      const n = Array.isArray(body.sessions) ? body.sessions.length : -1;
      if (n !== last) {
        log("probe", `eingelesene Sessions: ${n}`);
        last = n;
        stableSince = Date.now();
      } else if (n > 0 && Date.now() - stableSince > STABLE_MS) {
        log("probe", `Nachimport stabil bei ${n} Sessions nach ${((Date.now() - started) / 1000).toFixed(1)} s.`);
        return;
      }
    } catch {
      // Server kurz nicht erreichbar — weiter versuchen.
    }
  }
  log("probe", `Nachimport nach ${TIMEOUT_MS / 1000} s nicht stabil — letzter Stand: ${last} Sessions.`);
}
void measureImport();

log("probe", `bereit — Web-App: http://127.0.0.1:${PORT}/sessions . Strg+C beendet beide Prozesse.`);

let stopping = false;
function stop(sig) {
  if (stopping) return;
  stopping = true;
  log("probe", `${sig} empfangen, beende Probe-Server und Brücke …`);
  for (const { tag, child } of children) {
    log("probe", `stoppe ${tag} (Prozessgruppe ${child.pid}) …`);
    try {
      process.kill(-child.pid, "SIGTERM"); // ganze Prozessgruppe (detached: true), nicht nur tsx selbst
    } catch {
      child.kill("SIGTERM"); // Fallback, falls die Gruppe schon weg ist
    }
  }
  // Nachfassen: eine harte Frist, falls SIGTERM allein nicht reicht (z. B. während eines
  // laufenden Archiv-Uploads) — dann SIGKILL der ganzen Gruppe statt verwaister Prozesse.
  setTimeout(() => {
    for (const { child } of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // schon beendet
      }
    }
    process.exit(0);
  }, 2_000);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
