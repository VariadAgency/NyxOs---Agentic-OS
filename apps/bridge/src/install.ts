// Einrichten und Entfernen der Brücke: Konfiguration, Hook-Skript, Hooks in Claude/Codex, Shell-Anbindung
// und Dienst. Jeder Eingriff in fremde Dateien (Claude-/Codex-Einstellungen, Shell-Startdateien) ergänzt nur
// eigene, markierte Einträge und legt vorher eine Sicherungskopie an.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { t } from "@nyxos/shared";
import { defaults, loadConfig, normalizeRoots, paths, saveConfig, terminalDefaults, findTmux, type BridgeConfig, type BridgePaths } from "./config.js";
import { hasBlock, installShell, shellPaths, shellTargets, uninstallShell, writeShellFiles } from "./terminal/shell.js";
import { hookScript } from "./spool.js";
import { service, type ServiceDeps, type ServiceMode } from "./service.js";

/** Woran unsere Hook-Einträge erkennbar sind (zum Aktualisieren und Entfernen): der Name des Hook-Skripts. */
export const MARKER = "nyxos-hook";
/** Einträge älterer Installationen, die beim Aktualisieren ebenfalls ersetzt werden. */
const LEGACY_MARKERS = ["NyxOS/bin/nyxos-bridge"];

/** Nie SENKEN — der Nutzer kann `cleanupPeriodDays` bewusst höher gesetzt haben; ein erneuter Install-Lauf
 * darf das nie rückgängig machen. Nur anheben, falls der bisherige Wert (fehlt/kaputt → 0) niedriger ist. */
export function nextCleanupPeriodDays(existing: unknown): number {
  const current = typeof existing === "number" && Number.isFinite(existing) ? existing : 0;
  return Math.max(current, 3650);
}

// `Notification` (Claude-Hook bei einer Freigabe-Frage mitten in der Runde, z. B. Berechtigung für ein
// Werkzeug) ist nur für Claude dokumentiert; für Codex bleibt die Erkennung bei Stop/`task_complete`.
export const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "Stop", "SessionEnd", "Notification"] as const;
export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "Stop", "SessionEnd"] as const;
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

type HookHandler = { type: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookHandler[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const isOurs = (h: HookHandler) => typeof h.command === "string" && [MARKER, ...LEGACY_MARKERS].some((m) => (h.command as string).includes(m));

/** Entfernt nur unsere Einträge; fremde Hooks bleiben unverändert. */
export function removeHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks?.length ?? 0) > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length === 0 ? rest : { ...rest, hooks };
}

/** Ergänzt unsere Hooks (idempotent). */
export function addHooks(settings: Settings, hookFile: string, tool: "claude" | "codex"): Settings {
  const clean = removeHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };
  for (const event of tool === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS) {
    const handler: HookHandler = { type: "command", command: `${q(hookFile)} hook ${event} ${tool}`, timeout: event === "SessionEnd" ? 3 : 5 };
    if (tool === "codex" && event !== "SessionEnd") handler.async = true;
    const group: HookGroup = MATCHER_EVENTS.has(event) ? { matcher: "*", hooks: [handler] } : { hooks: [handler] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return { ...clean, hooks };
}

/** Stehen unsere Hooks in dieser Einstellungs-Datei? */
export function hooksPresent(file: string): boolean {
  try {
    const s = readJson(file);
    return Object.values(s.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}

function readJson(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  return text ? (JSON.parse(text) as Settings) : {};
}

/**
 * Schreibt JSON atomar und legt vorher eine Sicherungskopie an.
 *
 * `file` kann ein Symlink sein (z. B. auf ein Dotfiles-Repo) — `renameSync(tmp, file)` würde dann den Symlink
 * selbst durch eine normale Datei ersetzen. Darum das Ziel auflösen und DORT atomar schreiben; der Symlink
 * bleibt unangetastet.
 */
export function writeJsonWithBackup(file: string, data: Settings): string | null {
  let target = file;
  try {
    if (lstatSync(file).isSymbolicLink()) target = realpathSync(file);
  } catch {
    // Datei/Symlink existiert noch nicht — normal an `file` schreiben
  }
  let backup: string | null = null;
  // Keep the file's mode: settings.json can hold API keys (`env`), a 0600 file must not come back as 0644.
  let mode = 0o600;
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777;
    backup = `${target}.vor-nyxos-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
    chmodSync(backup, mode);
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-nyxos`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
  return backup;
}

/** Hooks für Claude und Codex eintragen (bestehende fremde Einträge bleiben). */
export function installHooks(p: BridgePaths): string[] {
  const report: string[] = [];
  const claude = addHooks(readJson(p.claudeSettings), p.hook, "claude");
  rememberCleanupPeriod(p, claude.cleanupPeriodDays);
  claude.cleanupPeriodDays = nextCleanupPeriodDays(claude.cleanupPeriodDays);
  const b1 = writeJsonWithBackup(p.claudeSettings, claude);
  report.push(
    b1
      ? t("Claude-Hooks ergänzt (Sicherung: {backup}), cleanupPeriodDays = {days}", { backup: b1, days: claude.cleanupPeriodDays as number })
      : t("Claude-Hooks ergänzt (Datei war neu), cleanupPeriodDays = {days}", { days: claude.cleanupPeriodDays as number }),
  );
  const b2 = writeJsonWithBackup(p.codexHooks, addHooks(readJson(p.codexHooks), p.hook, "codex"));
  report.push(b2 ? t("Codex-Hooks ergänzt (Sicherung: {backup}); Codex verlangt einmalig eine Freigabe über /hooks", { backup: b2 }) : t("Codex-Hooks ergänzt (Datei war neu); Codex verlangt einmalig eine Freigabe über /hooks"));
  return report;
}

/** Original `cleanupPeriodDays` of the user, stored once before NyxOS raised it (restored by uninstall). */
function cleanupFile(p: BridgePaths): string {
  return join(p.support, "claude-cleanup-period.json");
}

function rememberCleanupPeriod(p: BridgePaths, existing: unknown): void {
  const file = cleanupFile(p);
  if (existsSync(file)) return; // only the value from before the very first install counts
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ original: typeof existing === "number" && Number.isFinite(existing) ? existing : null }) + "\n", { mode: 0o600 });
}

/**
 * Restores the user's `cleanupPeriodDays` — but only if it still has the value NyxOS set (a value the user changed
 * afterwards stays). Returns the restored value, `undefined` = nothing changed.
 */
export function restoreCleanupPeriod(settings: Record<string, unknown>, original: number | null): { settings: Record<string, unknown>; changed: boolean } {
  if (settings.cleanupPeriodDays !== nextCleanupPeriodDays(original)) return { settings, changed: false };
  const next = { ...settings };
  if (original === null) delete next.cleanupPeriodDays;
  else next.cleanupPeriodDays = original;
  return { settings: next, changed: true };
}

/** Nur unsere Hooks entfernen und `cleanupPeriodDays` auf den Wert von vor NyxOS zurücksetzen. */
export function uninstallHooks(p: BridgePaths): string[] {
  const report: string[] = [];
  const stored = (() => {
    try {
      return JSON.parse(readFileSync(cleanupFile(p), "utf8")) as { original: number | null };
    } catch {
      return null;
    }
  })();
  if (hooksPresent(p.claudeSettings)) {
    let settings = removeHooks(readJson(p.claudeSettings)) as Record<string, unknown>;
    if (stored) settings = restoreCleanupPeriod(settings, stored.original).settings;
    writeJsonWithBackup(p.claudeSettings, settings as Settings);
    report.push(t("Claude-Hooks entfernt"));
  }
  rmSync(cleanupFile(p), { force: true });
  if (hooksPresent(p.codexHooks)) {
    writeJsonWithBackup(p.codexHooks, removeHooks(readJson(p.codexHooks)));
    report.push(t("Codex-Hooks entfernt"));
  }
  return report;
}

/** Hook-Skript (schneller sh-Pfad) für diese node-/bridge.js-Kombination schreiben. */
export function writeHookScript(p: BridgePaths, node: string, entry: string): void {
  mkdirSync(p.support, { recursive: true });
  const tmp = `${p.hook}.tmp-${process.pid}`;
  writeFileSync(tmp, hookScript(p.spool, node, entry));
  chmodSync(tmp, 0o755);
  renameSync(tmp, p.hook);
}

export function shellIntegrationPresent(p: BridgePaths): boolean {
  return hasBlock(p.zshrc) || hasBlock(p.bashrc);
}

/** Shell-Anbindung einschalten (Startdateien nach `$SHELL` und vorhandenen Dateien). */
export function enableShell(p: BridgePaths, projectRoots: readonly string[], tmuxBin = findTmux()): string[] {
  return installShell({ supportDir: p.support, tmuxBin, projectRoots, targets: shellTargets({ zshrc: p.zshrc, bashrc: p.bashrc }) });
}

export function disableShell(p: BridgePaths): string[] {
  return uninstallShell({ rcFiles: [p.zshrc, p.bashrc] });
}

export interface InstallOptions {
  serverUrl: string;
  token: string;
  tunnel: BridgeConfig["tunnel"];
  /** node-Programm, mit dem Dienst und Hooks laufen. */
  node: string;
  /** Pfad zu `bridge.js`. */
  entry: string;
  /** Leer = bisherige Ordner behalten (bei einer Neuinstallation). */
  projectRoots: string[];
  /** `undefined` = bisherigen Vault behalten. */
  vaultDir?: string | null;
  hooks: boolean;
  shell: boolean;
  /** Tests: andere Wurzel, Dienst nachbauen. */
  paths?: BridgePaths;
  service?: Omit<ServiceDeps, "paths">;
}

function previousConfig(file: string): BridgeConfig | null {
  try {
    return loadConfig(file);
  } catch {
    return null;
  }
}

export async function install(o: InstallOptions): Promise<{ mode: ServiceMode; report: string[] }> {
  const p = o.paths ?? paths();
  const report: string[] = [];
  for (const d of [p.support, p.spool, p.logs]) mkdirSync(d, { recursive: true });

  const svc = service({ ...o.service, paths: p });
  // Laufende Brücke zuerst anhalten: sie hielte sonst die alte Konfiguration und den Puffer offen.
  await svc.stop();

  writeHookScript(p, o.node, o.entry);
  report.push(t("Hook-Skript → {file}", { file: p.hook }));

  // Eine Neuinstallation (z. B. Update) übernimmt, was das Onboarding schon eingestellt hat.
  const prev = previousConfig(p.config);
  const projectRoots = o.projectRoots.length > 0 ? normalizeRoots(o.projectRoots) : (prev?.projectRoots ?? []);
  const vaultDir = o.vaultDir !== undefined ? o.vaultDir : (prev?.vaultDir ?? null);
  const tmuxBin = findTmux();
  // tmux.conf braucht der Terminal-Dienst immer, die Startdateien nur mit Shell-Anbindung.
  report.push(...writeShellFiles({ supportDir: p.support, tmuxBin, projectRoots }));
  if (o.shell) report.push(...enableShell(p, projectRoots, tmuxBin));

  // PATH aus der Shell, in der installiert wird: der Dienst hat sonst keinen Zugriff auf claude/codex/node.
  const terminal = { ...terminalDefaults(), ...(prev?.terminal ?? {}), tmuxBin, conf: shellPaths(p.support).conf, path: process.env.PATH ?? null };
  const cfg: BridgeConfig = {
    ...defaults(),
    ...(prev ?? {}),
    serverUrl: o.serverUrl,
    token: o.token,
    tunnel: o.tunnel,
    projectRoots,
    vaultDir,
    terminal,
  };
  saveConfig(cfg, p.config);
  report.push(t("Konfiguration → {file}", { file: p.config }));

  if (o.hooks) report.push(...installHooks(p));

  const r = await svc.install({ node: o.node, entry: o.entry });
  report.push(...r.report);
  return { mode: r.mode, report };
}

export async function uninstall(purge: boolean, opts: { paths?: BridgePaths; service?: Omit<ServiceDeps, "paths"> } = {}): Promise<string[]> {
  const p = opts.paths ?? paths();
  const report = await service({ ...opts.service, paths: p }).uninstall();
  report.push(...uninstallHooks(p));
  report.push(...disableShell(p));
  rmSync(p.hook, { force: true });
  if (purge) {
    rmSync(p.support, { recursive: true, force: true });
    try {
      for (const f of readdirSync(p.logs)) if (f.startsWith(basename(p.log))) rmSync(join(p.logs, f), { force: true });
    } catch {
      // kein Log-Ordner
    }
    report.push(t("{dir} gelöscht (inkl. Puffer und Log)", { dir: p.support }));
  } else {
    report.push(t("Puffer und Konfiguration bleiben in {dir}", { dir: p.support }));
  }
  return report;
}
