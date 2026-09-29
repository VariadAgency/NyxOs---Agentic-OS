import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, paths, type BridgeConfig } from "./config.js";
import type { DaemonOptions } from "./daemon.js";
import { IS_MAC } from "./platform.js";

/**
 * Löst die Konfiguration/Daemon-Optionen für `bridge.js run` auf. Mit `--data-dir <ordner>`: eigene
 * Brücken-Instanz mit eigenem Puffer/Spool in einem selbst gewählten Ordner, KEIN Einfluss auf die
 * installierte Brücke (`paths()`, `~/.nyxos/bridge/…`) — kein Hook-Eintrag, kein Dienst, kein Log-Rotieren
 * dort. `config.json` liegt dann unter `<data-dir>/config.json` (vom Aufrufer angelegt, z. B. dem
 * Probe-Skript). `defaultConfigFile` ist nur für Tests da, damit sie nie die echte installierte Datei
 * lesen müssen. Eigene Datei (statt Teil von `main.ts`), weil `main.ts` beim Import sofort `main()`
 * ausführt — ein Test dürfte diese Funktion sonst nicht gefahrlos importieren.
 */
export function resolveRunOptions(
  rest: string[],
  defaultConfigFile = paths().config,
): { cfg: BridgeConfig; daemonOpts: DaemonOptions; dataDir: string | null } {
  const { values } = parseArgs({ args: rest, options: { "data-dir": { type: "string" } } });
  const dataDir = values["data-dir"] ?? null;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    const cfg = loadConfig(join(dataDir, "config.json"));
    return {
      cfg,
      daemonOpts: {
        spoolDir: join(dataDir, "spool"),
        dbPath: join(dataDir, "buffer.sqlite"),
        // Chat-Anhänge und Skill-Sicherungen der Probe nie in die Ordner der installierten Brücke.
        uploadsDir: join(dataDir, "uploads"),
        skillBackupsDir: join(dataDir, "skill-backups"),
        // Hooks, die das Onboarding dieser Brücke einträgt, landen in IHREM Spool.
        setupPaths: { ...paths(), support: dataDir, config: join(dataDir, "config.json"), hook: join(dataDir, "nyxos-hook"), spool: join(dataDir, "spool"), tmuxConf: join(dataDir, "tmux.conf") },
        git: gitOptions(),
      },
      dataDir,
    };
  }
  const cfg = loadConfig(defaultConfigFile);
  // Nur die installierte Brücke auf macOS liest die Claude-Limits aus CodexBar (nur lesen, nur wenn vorhanden).
  return { cfg, daemonOpts: { git: gitOptions(), ...(IS_MAC ? { codexbar: {} } : {}) }, dataDir: null };
}

/** Git-Erfassung für jede Brücke. Sicherheits-Standard: `applyCatchups` NUR bei ausdrücklich gesetztem
 * `NYXOS_GIT_CATCHUP_APPLY=1` — ohne das bleibt automatisches Nachziehen ein Vorschlag (s. catchup.ts). */
function gitOptions(): NonNullable<DaemonOptions["git"]> {
  return { applyCatchups: process.env.NYXOS_GIT_CATCHUP_APPLY === "1" };
}
