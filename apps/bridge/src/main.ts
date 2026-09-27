// bridge.js: run | install | uninstall | status | restart | stop | verify | mcp | hook | guard
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setLang, t } from "@nyxos/shared";
import { loadConfig, paths, type BridgeConfig } from "./config.js";
import { startDaemon, defaultLog } from "./daemon.js";
import { deadlineText, denyJson, GUARD_DEADLINE_MS, runGuard } from "./guard/hook.js";
import { hooksPresent, install, shellIntegrationPresent, uninstall } from "./install.js";
import { runMcpServer } from "./mcp.js";
import { Outbox } from "./outbox.js";
import { resolveRunOptions } from "./run-options.js";
import { readServiceRecord, service } from "./service.js";
import { openDb } from "./sqlite.js";
import { archiveRelPath } from "./tracker.js";

const [cmd, ...rest] = process.argv.slice(2);

/** Sprache der Ausgaben: `NYXOS_LANG`, sonst die Systemsprache (Deutsch nur, wenn das System Deutsch spricht). */
function detectLang(): void {
  const v = (process.env.NYXOS_LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "").toLowerCase();
  setLang(v.startsWith("de") ? "de" : "en");
}

/** Pfad dieses Programms (bridge.js) und des node, das es ausführt — für Dienst und Hook-Skript. */
function self(nodeOverride?: string): { node: string; entry: string } {
  const script = process.argv[1] ?? "";
  let entry = script;
  try {
    entry = realpathSync(script);
  } catch {
    // Pfad bleibt, wie er ist
  }
  return { node: nodeOverride ?? process.execPath, entry };
}

/**
 * Log klein halten: Der Dienst-Manager hält die Logdatei offen (Anhängen). Umbenennen hieße, er schriebe in die
 * alte Datei weiter — darum kopieren und die offene Datei leeren.
 */
function rotateLog(): void {
  const log = paths().log;
  try {
    if (statSync(log).size > 10 * 1024 * 1024) {
      copyFileSync(log, `${log}.1`);
      truncateSync(log, 0);
    }
  } catch {
    // keine Logdatei
  }
}

function tryLoadConfig(): BridgeConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

async function runDaemon(): Promise<void> {
  const { cfg, daemonOpts, dataDir } = resolveRunOptions(rest);
  if (!dataDir) rotateLog(); // Log-Rotation gilt nur für die installierte Brücke.
  // Erste Zeile, sobald JavaScript läuft (`prozessMs` = Zeit seit Prozessstart, zeigt einen langsamen Start).
  defaultLog("startet", { pid: process.pid, prozessMs: Math.round(process.uptime() * 1000), node: process.version, os: process.platform });
  const configPath = dataDir ? join(dataDir, "config.json") : paths().config;
  let current = cfg;
  let d = await startDaemon(current, { ...daemonOpts, configPath, onConfigChanged: () => void reload() });
  // Tunnel und Kanal laufen jetzt; Nachimport und Versand folgen im Hintergrund (`start-phase`).
  defaultLog("gestartet", { pid: process.pid, prozessMs: Math.round(process.uptime() * 1000), ...(dataDir ? { dataDir } : {}) });
  void d.ready.then(() => defaultLog("bereit", { prozessMs: Math.round(process.uptime() * 1000) }));

  // Das Onboarding hat Projektordner/Vault geändert: Brücke im selben Prozess mit der neuen Konfiguration neu
  // aufbauen (Datei-Wächter, Git-Erfassung, Vault) — ohne den Dienst-Manager zu bemühen.
  let reloading: Promise<void> | null = null;
  const reload = (): Promise<void> => {
    reloading ??= (async () => {
      try {
        const next = resolveRunOptions(rest).cfg;
        defaultLog("konfiguration-neu", { projectRoots: next.projectRoots.length, vault: next.vaultDir ? true : false });
        await d.stop();
        current = next;
        d = await startDaemon(current, { ...daemonOpts, configPath, onConfigChanged: () => void reload() });
      } catch (e) {
        defaultLog("konfiguration-neu-fehler", { error: String(e) });
        process.exit(1); // der Dienst-Manager startet neu
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  };

  const stop = async (sig: string) => {
    defaultLog("beende", { sig });
    await reloading;
    await d.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

async function status(): Promise<void> {
  const p = paths();
  const cfg = tryLoadConfig();
  const rec = readServiceRecord(p);
  const svc = service({ paths: p });
  const running = svc.running();
  const out: Record<string, unknown> = {
    installed: cfg !== null && rec !== null,
    service: rec?.mode ?? null,
    running,
    home: p.root,
    config: p.config,
    log: p.log,
    hooks: { claude: hooksPresent(p.claudeSettings), codex: hooksPresent(p.codexHooks) },
    shellIntegration: shellIntegrationPresent(p),
    projectRoots: cfg?.projectRoots ?? [],
    vaultDir: cfg?.vaultDir ?? null,
    server: cfg?.serverUrl ?? null,
  };
  if (cfg) {
    try {
      const res = await fetch(`${cfg.serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
      out.health = `${res.status}`;
    } catch (e) {
      out.health = t("nicht erreichbar ({error})", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (existsSync(p.db)) {
    const outbox = new Outbox(await openDb(p.db));
    const files = outbox.files();
    out.buffer = {
      queued: outbox.size(),
      rejected: outbox.deadCount(),
      files: files.length,
      ignored: files.filter((f) => f.ignored).length,
      archived: files.filter((f) => !f.ignored && f.archived_sha).length,
    };
    out.daemon = JSON.parse(outbox.getMeta("status") ?? "{}") as Record<string, unknown>;
    outbox.db.close();
  }
  console.log(JSON.stringify(out, null, 2));
  if (!out.installed) process.exitCode = 1;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "run":
      return runDaemon();
    case "install": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "server-url": { type: "string" },
          "token-file": { type: "string" },
          node: { type: "string" },
          "project-root": { type: "string", multiple: true },
          "vault-dir": { type: "string" },
          "no-hooks": { type: "boolean", default: false },
          "no-shell": { type: "boolean", default: false },
          "tunnel-host": { type: "string" },
          "local-port": { type: "string", default: "47801" },
          "remote-port": { type: "string", default: "47800" },
        },
      });
      const serverUrl = values["server-url"];
      const tokenFile = values["token-file"];
      if (!serverUrl || !tokenFile) throw new Error(t("--server-url und --token-file sind Pflicht"));
      const token = readFileSync(tokenFile, "utf8").trim();
      if (!token) throw new Error(t("Die Token-Datei {file} ist leer", { file: tokenFile }));
      const host = values["tunnel-host"];
      const tunnel = host ? { host, localPort: Number(values["local-port"]), remotePort: Number(values["remote-port"]) } : null;
      const { node, entry } = self(values.node);
      const r = await install({
        serverUrl,
        token,
        tunnel,
        node,
        entry,
        projectRoots: values["project-root"] ?? [],
        ...(values["vault-dir"] !== undefined ? { vaultDir: values["vault-dir"] || null } : {}),
        hooks: !values["no-hooks"],
        shell: !values["no-shell"],
      });
      for (const line of r.report) console.log(`✓ ${line}`);
      return;
    }
    case "uninstall": {
      for (const line of await uninstall(rest.includes("--purge"))) console.log(`✓ ${line}`);
      return;
    }
    case "status":
      return status();
    case "restart": {
      const p = paths();
      if (!readServiceRecord(p) || !tryLoadConfig()) throw new Error(t("Die Brücke ist nicht installiert ({dir})", { dir: p.support }));
      for (const line of await service({ paths: p }).restart(self())) console.log(`✓ ${line}`);
      return;
    }
    case "stop": {
      const report = await service({ paths: paths() }).stop();
      for (const line of report.length > 0 ? report : [t("Brücke lief nicht")]) console.log(`✓ ${line}`);
      return;
    }
    case "verify": {
      // Vergleicht die SHA-256 jeder lokalen Verlaufsdatei mit dem Archiv auf dem Server.
      const cfg = loadConfig();
      const outbox = new Outbox(await openDb(paths().db));
      const res = await fetch(`${cfg.serverUrl}/archive`, { signal: AbortSignal.timeout(30_000) });
      const remote = new Map<string, string>();
      for (const f of ((await res.json()) as { files: { tool: string; path: string; sha256: string }[] }).files) remote.set(`${f.tool}:${f.path}`, f.sha256);
      let ok = 0;
      const bad: string[] = [];
      for (const f of outbox.files().filter((x) => !x.ignored)) {
        if (!existsSync(f.path)) continue;
        const sha = createHash("sha256").update(readFileSync(f.path)).digest("hex");
        const rel = archiveRelPath(f.path, f.tool as "claude" | "codex", cfg);
        if (remote.get(`${f.tool}:${rel}`) === sha) ok++;
        else bad.push(`${f.tool}:${rel} (${remote.has(`${f.tool}:${rel}`) ? t("Prüfsumme weicht ab") : t("fehlt auf dem Server")})`);
      }
      console.log(JSON.stringify({ checked: ok + bad.length, equal: ok, different: bad.length, list: bad.slice(0, 50) }, null, 2));
      if (bad.length > 0) process.exitCode = 1;
      return;
    }
    case "mcp": {
      // stdio-MCP-Server "nyxos" — bleibt am Leben, bis stdin schließt.
      runMcpServer();
      await new Promise<void>((resolve) => process.stdin.on("close", resolve));
      return;
    }
    case "hook": {
      // Ersatzweg, falls das Shell-Skript fehlt: stdin in den Spool-Ordner, niemals Fehler nach außen.
      try {
        const [event = "Unbekannt", tool = "claude"] = rest;
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const spool = paths().spool;
        mkdirSync(spool, { recursive: true });
        const f = join(spool, `${process.pid}-${Math.floor(Math.random() * 1e9)}-${event}-${tool}`);
        writeFileSync(`${f}.tmp`, Buffer.concat(chunks));
        renameSync(`${f}.tmp`, `${f}.json`);
      } catch {
        // Hooks dürfen Claude nie stören.
      }
      return;
    }
    case "guard": {
      // Leitplanken (PreToolUse). Nur Auftrags-Sessions (NYXOS_AUFTRAG), s. guard/hook.ts.
      // Endet immer mit 0; eine Verweigerung steht als Hook-JSON auf stdout.
      if (!process.env.NYXOS_AUFTRAG) return;
      // Auch ein hängendes stdin darf nicht in Claude Codes „nach 5 s durchlassen“ laufen: nach 2 s verweigern.
      const deadline = setTimeout(() => {
        process.stdout.write(denyJson(deadlineText()) + "\n", () => process.exit(0));
      }, GUARD_DEADLINE_MS);
      try {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const out = await runGuard(Buffer.concat(chunks).toString("utf8"), process.env);
        if (out.stdout) process.stdout.write(out.stdout + "\n");
      } catch {
        // Hooks dürfen Claude nie stören.
      } finally {
        clearTimeout(deadline);
      }
      return;
    }
    default:
      console.error(
        t("Aufruf: bridge.js run [--data-dir <ordner>] | install --server-url <url> --token-file <datei> [--node <node>] [--project-root <ordner>]… [--vault-dir <ordner>] [--no-hooks] [--no-shell] | uninstall [--purge] | status | restart | stop | verify | mcp | hook <Event> [claude|codex] | guard"),
      );
      process.exitCode = 2;
  }
}

detectLang();
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(cmd === "hook" || cmd === "guard" ? 0 : 1);
});
