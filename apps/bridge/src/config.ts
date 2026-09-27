import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { t } from "@nyxos/shared";
import { findBin, foldCase } from "./platform.js";

export interface BridgeConfig {
  /** Basis-URL des Servers, z. B. http://127.0.0.1:47800 (lokaler Server) oder die Adresse eines SSH-Tunnels. */
  serverUrl: string;
  token: string;
  /** Optionaler SSH-Tunnel zu einem entfernten Server. `null` = kein Tunnel (Standard). */
  tunnel: { host: string; localPort: number; remotePort: number } | null;
  /**
   * Projektordner, deren Sessions NyxOS erfasst. Leer = alle Sessions (bis das Onboarding Ordner einträgt).
   * Gleichzeitig die Grenze, in der der Server Sessions starten, bauen und Dateien zeigen darf.
   */
  projectRoots: string[];
  claudeDir: string;
  codexDir: string;
  /** Terminal-Dienst (tmux). `null` = aus. Fehlt das Feld, gelten die Standardwerte. */
  terminal?: TerminalConfig | null;
  /** Obsidian-Vault, der nur lesend eingelesen wird (Metadaten + Links). `null`/fehlt = aus. */
  vaultDir?: string | null;
  /** Weitere lokale Modell-Ports für den Server (Ollama 11434 + LM Studio 1234 sind immer erlaubt). */
  localModelPorts?: number[] | null;
  /**
   * Produktionsserver für die Leitplanken (Host-Alias, Hostname, IP oder `*.domain`): ssh/scp/rsync dorthin
   * aus einer Auftrags-Session braucht eine Freigabe. Zusätzlich zu `NYXOS_PROD_HOSTS`.
   */
  prodHosts?: string[] | null;
}

export interface TerminalConfig {
  /** tmux-Socket (`tmux -L <name>`), Standard `nyxos`; die Probe nutzt einen eigenen. */
  socket: string;
  tmuxBin: string;
  /** tmux-Konfiguration für neu gestartete tmux-Server (vom Installer geschrieben). */
  conf: string | null;
  /** PATH für neu gestartete Sessions (Dienste haben einen kargen PATH); Standard: PATH beim Installieren. */
  path: string | null;
}

export function findTmux(): string {
  return findBin("tmux") ?? "tmux";
}

export function terminalDefaults(home = homedir(), env: NodeJS.ProcessEnv = process.env): TerminalConfig {
  const conf = paths(home, env).tmuxConf;
  return { socket: "nyxos", tmuxBin: findTmux(), conf: existsSync(conf) ? conf : null, path: null };
}

/** launchd-Label (macOS). */
export const LABEL = "app.nyxos.bridge";
/** systemd-Benutzer-Unit (Linux). */
export const SYSTEMD_UNIT = "nyxos-bridge.service";

/** Wurzel aller NyxOS-Daten: `$NYXOS_HOME`, sonst `~/.nyxos`. */
export function nyxosHome(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const v = env.NYXOS_HOME?.trim();
  return v ? resolve(v.replace(/^~(?=\/|$)/, home)) : join(home, ".nyxos");
}

export function paths(home = homedir(), env: NodeJS.ProcessEnv = process.env) {
  const root = nyxosHome(home, env);
  const support = join(root, "bridge");
  const logs = join(root, "logs");
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return {
    root,
    /** Brücken-Daten: Konfiguration, Puffer, Spool, tmux.conf, Hook-Skript. */
    support,
    /** Hook-Skript für Claude/Codex (schneller Shell-Pfad, startet node nur bei Bedarf). */
    hook: join(support, "nyxos-hook"),
    config: join(support, "config.json"),
    db: join(support, "buffer.sqlite"),
    spool: join(support, "spool"),
    uploads: join(support, "uploads"),
    skillBackups: join(support, "skill-backups"),
    tmuxConf: join(support, "tmux.conf"),
    logs,
    log: join(logs, "bridge.log"),
    /** Whisper-Modelle für die Spracheingabe. */
    whisperModels: join(root, "models", "whisper"),
    launchAgent: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    systemdUnit: join(configHome, "systemd", "user", SYSTEMD_UNIT),
    claudeSettings: join(home, ".claude", "settings.json"),
    codexHooks: join(home, ".codex", "hooks.json"),
    zshrc: join(env.ZDOTDIR?.trim() || home, ".zshrc"),
    bashrc: join(home, ".bashrc"),
  };
}

export type BridgePaths = ReturnType<typeof paths>;

export function defaults(home = homedir()): Omit<BridgeConfig, "serverUrl" | "token"> {
  return {
    tunnel: null,
    projectRoots: [],
    claudeDir: join(home, ".claude"),
    codexDir: join(home, ".codex"),
    vaultDir: null,
  };
}

/** Ordnerliste säubern: nur absolute Pfade, ohne Schrägstrich am Ende, ohne Doppelte. */
export function normalizeRoots(list: unknown, home = homedir()): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || !v.trim()) continue;
    const abs = resolve(v.trim().replace(/^~(?=\/|$)/, home));
    const clean = abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
    if (!out.some((o) => foldCase(o) === foldCase(clean))) out.push(clean);
  }
  return out;
}

export function loadConfig(file = paths().config): BridgeConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeConfig> & { projectRoot?: unknown };
  if (!raw.serverUrl || !raw.token) throw new Error(t("serverUrl/token fehlen in {file}", { file }));
  // Ältere Konfigurationen kannten genau einen Projektordner.
  const legacy = typeof raw.projectRoot === "string" ? [raw.projectRoot] : [];
  const { projectRoot: _legacy, ...rest } = raw;
  return { ...defaults(), ...rest, projectRoots: normalizeRoots(raw.projectRoots ?? legacy) } as BridgeConfig;
}

/** Schreibt die Konfiguration atomar (Zwischendatei + rename), nur für den Nutzer lesbar. */
export function saveConfig(cfg: BridgeConfig, file = paths().config): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Liegt `path` in `root` (oder ist es)? Auf macOS ohne Rücksicht auf Groß-/Kleinschreibung, auf Linux genau. */
export function underRoot(path: string | null | undefined, root: string): boolean {
  if (!path) return false;
  const p = foldCase(path).replace(/\/+$/, "");
  const r = foldCase(root).replace(/\/+$/, "");
  if (r === "") return true; // Wurzel „/“
  return p === r || p.startsWith(r + "/");
}

/** Gehört ein Arbeitsordner zu einem der Projektordner? Ohne eingetragene Ordner gehört alles dazu. */
export function inProjects(path: string | null | undefined, roots: readonly string[]): boolean {
  if (!path) return false;
  return roots.length === 0 || roots.some((r) => underRoot(path, r));
}

/**
 * Wo der Server Ordner öffnen, Sessions starten und bauen darf: die Projektordner, ohne eingetragene
 * Ordner das Home-Verzeichnis (nie das ganze Dateisystem).
 */
export function accessRoots(roots: readonly string[], home = homedir()): string[] {
  return roots.length > 0 ? [...roots] : [home];
}

/** Claude kodiert Projektpfade als Ordnernamen: jedes Nicht-Alphanumerische wird zu „-". */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Gehört ein Ordner unter `~/.claude/projects` zu einem der Projektordner? Ohne eingetragene Ordner: ja.
 * Grob über den Namen; die genaue Prüfung macht der Tracker später über den Arbeitsordner der Session.
 */
export function claudeDirInProjects(dirName: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const d = foldCase(dirName);
  return roots.some((r) => {
    const prefix = foldCase(claudeProjectDirName(r));
    return d === prefix || d.startsWith(prefix + "-");
  });
}
