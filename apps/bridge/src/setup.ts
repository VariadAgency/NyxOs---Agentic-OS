// Einrichtung über das Onboarding (RPC `setup.state` / `setup.apply`): Projektordner, Obsidian-Vault, Hooks und
// Shell-Anbindung lesen und ändern. Änderungen an Ordnern/Vault landen atomar in der Konfiguration; danach baut
// sich die Brücke im selben Prozess neu auf (Datei-Wächter, Git-Erfassung, Vault), s. `onChanged`.
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getLang, SetupApplySchema, setupOsOf, t, type SetupApply, type SetupBrowseResult, type SetupPackageManager, type SetupState } from "@nyxos/shared";
import { normalizeRoots, saveConfig, type BridgeConfig, type BridgePaths } from "./config.js";
import { disableShell, enableShell, hooksPresent, installHooks, shellIntegrationPresent, uninstallHooks, writeHookScript } from "./install.js";
import { EXTRA_BIN_DIRS, findOnPath, foldCase, IS_MAC } from "./platform.js";
import { browseFolder, BrowseError } from "./setup-browse.js";
import { describeRoot, detectProjectRoots, ProtectedGate, type DetectSnapshot } from "./setup-detect.js";
import { writeShellFiles } from "./terminal/shell.js";

export class SetupError extends Error {
  constructor(
    message: string,
    readonly code: "bad_request" | "missing_folder" | "denied" | "failed",
  ) {
    super(message);
  }
}

export interface SetupContext {
  /** Aktuelle Konfiguration (wird bei `apply` ersetzt). */
  cfg: BridgeConfig;
  configPath: string;
  paths: BridgePaths;
  home?: string;
  /** Nach einer Änderung an Ordnern/Vault: Brücke mit der neuen Konfiguration neu aufbauen. */
  onChanged?: () => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** node + bridge.js für das Hook-Skript, falls es noch fehlt. */
  self?: { node: string; entry: string };
}

/** Vorschläge sind teuer (Ordner lesen) — so lange gelten sie; unvollständige (macOS-Freigabe offen) kürzer. */
const SUGGEST_TTL_MS = 60_000;
const SUGGEST_TTL_INCOMPLETE_MS = 4_000;
const MAX_SUGGESTIONS = 20;
/** Diese Ordner im Home-Verzeichnis nie durchsuchen (groß, System, Cache). */
const SKIP = new Set(["Library", "node_modules", "Applications", "Movies", "Music", "Pictures", "Public", ".Trash", "snap"]);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Echter Pfad samt der Schreibweise auf der Platte (macOS: ~/projects und ~/Projects sind derselbe Ordner). */
function real(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Ordner mit `.obsidian` in ~/Documents, ~/Obsidian, ~ (bis zwei Ebenen tief) und in iCloud (macOS).
 * `canRead` = false: Ordner auslassen (macOS-Freigabe steht noch aus — Lesen dort würde hängen).
 */
export function suggestVaults(home = homedir(), canRead: (dir: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const check = (dir: string) => {
    if (out.length >= MAX_SUGGESTIONS || !existsSync(join(dir, ".obsidian"))) return false;
    const r = real(dir);
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(dir);
    }
    return true;
  };
  const bases = [join(home, "Documents"), join(home, "Obsidian"), home];
  if (IS_MAC) bases.push(join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"));
  for (const base of bases) {
    if (!canRead(base) || !isDir(base) || check(base)) continue;
    for (const d1 of subdirs(base)) {
      if (!canRead(d1) || check(d1)) continue;
      for (const d2 of subdirs(d1)) check(d2);
    }
  }
  return out;
}

/** Neuen Vault anlegen: Ordner, `.obsidian/` (damit Obsidian ihn als Vault erkennt) und eine Willkommens-Notiz. */
export function createVault(dir: string): void {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  const appJson = join(dir, ".obsidian", "app.json");
  if (!existsSync(appJson)) writeFileSync(appJson, "{}\n");
  const name = getLang() === "en" ? "Welcome.md" : "Willkommen.md";
  const note = join(dir, name);
  if (!existsSync(note)) {
    writeFileSync(
      note,
      `# ${t("Willkommen")}\n\n${t("Diesen Vault liest NyxOS mit: Notizen, Links und Tags erscheinen im Gehirn. NyxOS ändert hier nichts, außer du legst eine Notiz ausdrücklich hier ab.")}\n`,
    );
  }
}

/** Paketverwaltung des Rechners, passend zum Installationsbefehl für tmux. */
export function detectPackageManager(platform: NodeJS.Platform = process.platform, has: (bin: string) => boolean = (b) => findOnPath(b, process.env.PATH ?? "", EXTRA_BIN_DIRS) !== null): SetupPackageManager {
  if (platform === "darwin") return has("brew") ? "brew" : has("port") || existsSync("/opt/local/bin/port") ? "port" : "none";
  if (platform !== "linux") return "none";
  const order: [string, SetupPackageManager][] = [
    ["apt-get", "apt"],
    ["dnf", "dnf"],
    ["yum", "yum"],
    ["pacman", "pacman"],
    ["zypper", "zypper"],
    ["apk", "apk"],
    ["brew", "brew"],
  ];
  return order.find(([bin]) => has(bin))?.[1] ?? "none";
}

type Detection = { at: number; snapshot: DetectSnapshot; vaults: string[] };

export class SetupService {
  private detection: Detection | null = null;
  private detecting: Promise<Detection> | null = null;
  private readonly gate: ProtectedGate;

  constructor(private readonly ctx: SetupContext) {
    this.gate = new ProtectedGate({ home: this.home });
  }

  private get home(): string {
    return this.ctx.home ?? homedir();
  }

  /** Erkennung (Sessions + Home-Suche + Vaults), zwischengespeichert; gleichzeitige Aufrufe teilen sich einen Lauf. */
  private async detect(): Promise<Detection> {
    const now = Date.now();
    const d = this.detection;
    if (d && now - d.at < (d.snapshot.complete ? SUGGEST_TTL_MS : SUGGEST_TTL_INCOMPLETE_MS)) return d;
    this.detecting ??= (async () => {
      try {
        const snapshot = await detectProjectRoots({ home: this.home, claudeDir: this.ctx.cfg.claudeDir, codexDir: this.ctx.cfg.codexDir, gate: this.gate });
        // iCloud-Vaults (Obsidian) liegen in einem geschützten Ordner: erst fragen, dann (ohne Hängen) suchen.
        if (IS_MAC) await this.gate.allow(join(this.home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"));
        const vaults = suggestVaults(this.home, (dir) => this.gate.open(dir));
        this.detection = { at: Date.now(), snapshot, vaults };
        return this.detection;
      } finally {
        this.detecting = null;
      }
    })();
    return this.detecting;
  }

  private async suggestions(): Promise<SetupState["suggestions"]> {
    const { snapshot, vaults } = await this.detect();
    const configured = this.ctx.cfg.projectRoots;
    const key = (p: string) => foldCase(real(p) ?? p);
    const taken = new Set(configured.map(key));
    const open = snapshot.suggestions.filter((s) => !taken.has(key(s.path)));
    const mine = await Promise.all(configured.map((path) => describeRoot(path, snapshot, { home: this.home, gate: this.gate })));
    return {
      projectRoots: open.map((s) => s.path),
      vaults: vaults.filter((v) => v !== this.ctx.cfg.vaultDir),
      projectRootDetails: [...mine, ...open],
      complete: snapshot.complete,
    };
  }

  /** Ordner-Auswahl im Onboarding (RPC `setup.browse`). */
  async browse(params: unknown): Promise<SetupBrowseResult> {
    try {
      return await browseFolder(params, { home: this.home, gate: this.gate });
    } catch (e) {
      if (e instanceof BrowseError) throw new SetupError(e.message, e.code);
      throw e;
    }
  }

  private tools(): SetupState["tools"] {
    const path = this.ctx.cfg.terminal?.path ?? process.env.PATH ?? "";
    const extra = [...EXTRA_BIN_DIRS, join(this.home, ".local", "bin"), join(this.home, ".claude", "local"), join(this.home, ".npm-global", "bin"), join(this.home, ".bun", "bin")];
    const has = (name: string) => findOnPath(name, path, extra) !== null;
    const tmuxBin = this.ctx.cfg.terminal?.tmuxBin;
    return {
      tmux: (tmuxBin ? existsSync(tmuxBin) : false) || has("tmux"),
      git: has("git"),
      claude: has("claude"),
      codex: has("codex"),
      node: process.version || null,
      packageManager: detectPackageManager(process.platform, has),
      root: process.getuid?.() === 0,
    };
  }

  async state(): Promise<SetupState> {
    const { cfg, paths: p } = this.ctx;
    const vaultDir = cfg.vaultDir ?? null;
    return {
      bridgeOnline: true,
      os: setupOsOf(process.platform),
      home: this.home,
      projectRoots: [...cfg.projectRoots],
      vaultDir,
      vaultExists: vaultDir !== null && isDir(vaultDir),
      hooks: { claude: hooksPresent(p.claudeSettings), codex: hooksPresent(p.codexHooks) },
      shellIntegration: shellIntegrationPresent(p),
      tools: this.tools(),
      suggestions: await this.suggestions(),
    };
  }

  async apply(params: unknown): Promise<SetupState> {
    const parsed = SetupApplySchema.safeParse(params);
    if (!parsed.success) throw new SetupError(t("Ungültige Einstellungen: {error}", { error: parsed.error.issues.map((i) => i.message).join("; ") }), "bad_request");
    const req: SetupApply = parsed.data;
    const { paths: p } = this.ctx;
    const log = this.ctx.log ?? (() => {});
    const expand = (v: string) => resolve(v.replace(/^~(?=\/|$)/, this.home));

    // Erst alles prüfen, dann schreiben — eine halb übernommene Einstellung gibt es nicht.
    // Nur volle Pfade (oder ~/…): ein relativer Pfad hinge vom Arbeitsordner des Dienstes ab (launchd: `/`).
    const relative = [...(req.projectRoots ?? []), ...(req.vaultDir ? [req.vaultDir] : [])].filter((v) => !/^(\/|~(\/|$))/.test(v.trim()));
    if (relative.length > 0) throw new SetupError(t("Ungültige Einstellungen: {error}", { error: relative.join(", ") }), "bad_request");
    let projectRoots = this.ctx.cfg.projectRoots;
    if (req.projectRoots) {
      projectRoots = normalizeRoots(req.projectRoots, this.home);
      if (projectRoots.includes("/")) throw new SetupError(t("Das ganze Dateisystem kann kein Projektordner sein"), "bad_request");
      const missing = projectRoots.filter((r) => !isDir(r));
      if (missing.length > 0) throw new SetupError(t("Diese Ordner gibt es nicht: {dirs}", { dirs: missing.join(", ") }), "missing_folder");
    }
    let vaultDir = this.ctx.cfg.vaultDir ?? null;
    if (req.vaultDir !== undefined) vaultDir = req.vaultDir === null ? null : expand(req.vaultDir);
    if (vaultDir === "/") throw new SetupError(t("Ungültige Einstellungen: {error}", { error: "/" }), "bad_request");
    if (req.createVault && !vaultDir) throw new SetupError(t("Zum Anlegen fehlt der Vault-Ordner"), "bad_request");
    if (vaultDir && req.vaultDir !== undefined && !req.createVault && !isDir(vaultDir)) throw new SetupError(t("Diese Ordner gibt es nicht: {dirs}", { dirs: vaultDir }), "missing_folder");
    if (req.installHooks === true && !existsSync(p.hook) && !this.ctx.self) throw new SetupError(t("Hook-Skript fehlt – bitte NyxOS neu installieren"), "failed");

    if (req.createVault && vaultDir) {
      createVault(vaultDir);
      log("setup-vault-angelegt", { vaultDir });
    }

    const rootsChanged = JSON.stringify(projectRoots) !== JSON.stringify(this.ctx.cfg.projectRoots);
    const vaultChanged = vaultDir !== (this.ctx.cfg.vaultDir ?? null);
    if (rootsChanged || vaultChanged) {
      const next: BridgeConfig = { ...this.ctx.cfg, projectRoots, vaultDir };
      saveConfig(next, this.ctx.configPath);
      this.ctx.cfg = next;
      log("setup-konfiguration", { projectRoots: projectRoots.length, vault: vaultDir !== null });
    }

    // Ist die Konfiguration schon geschrieben, baut sich die Brücke auch dann neu auf, wenn ein späterer Schritt scheitert.
    try {
      if (req.installHooks === true) {
        if (!existsSync(p.hook) && this.ctx.self) writeHookScript(p, this.ctx.self.node, this.ctx.self.entry);
        mkdirSync(p.spool, { recursive: true });
        installHooks(p);
        log("setup-hooks", { an: true });
      } else if (req.installHooks === false) {
        uninstallHooks(p);
        log("setup-hooks", { an: false });
      }

      const tmuxBin = this.ctx.cfg.terminal?.tmuxBin;
      if (req.shellIntegration === true) {
        enableShell(p, projectRoots, tmuxBin);
        log("setup-shell", { an: true });
      } else if (req.shellIntegration === false) {
        disableShell(p);
        log("setup-shell", { an: false });
      } else if (rootsChanged && shellIntegrationPresent(p)) {
        // Die Shell-Funktionen kennen die Projektordner: neu schreiben, die Startdateien bleiben, wie sie sind.
        writeShellFiles({ supportDir: p.support, tmuxBin: tmuxBin ?? "tmux", projectRoots });
      }

      return await this.state();
    } finally {
      // Erst antworten, dann neu aufbauen (der Kanal, über den die Antwort geht, gehört zur Brücke).
      if ((rootsChanged || vaultChanged) && this.ctx.onChanged) setTimeout(this.ctx.onChanged, 200);
    }
  }
}
