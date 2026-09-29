// Skill-Bibliothek: die Brücke liest Skills (nur unter festen Wurzeln), sichert einen Skill-Ordner vor
// jedem Überschreiben und schreibt auf Wunsch einen früheren Stand der SKILL.md zurück.
//
// Quellen (Aufruf-Name wie in Claude Code):
//   user        ~/.claude/skills/<name>/SKILL.md                      → `<name>`
//   synced      ~/.claude/skills/synced/<id>/<name>/SKILL.md          → `anthropic-skills:<name>` (Claude.ai, nur lesen)
//   project     <projekt>/.claude/skills/<name>  (Projektordner und ihre direkten Unterordner) → `<name>`
//   nyxos       <NyxOS-Repo>/.claude/skills/<name>, falls es in einem Projektordner liegt → `<name>`
//   plugin      installPath aus ~/.claude/plugins/installed_plugins.json + /skills/<name> → `<plugin>:<name>` (nur lesen)
//
// Sicherheit: jeder Pfad wird per realpath aufgelöst und gegen die (ebenfalls aufgelösten) Wurzeln geprüft –
// ein Symlink aus einem Skill-Ordner nach ~/.ssh liest also nichts. Geschrieben wird nur in eigene Skills
// (Persönlich, Projekt), nie in Plugins oder Claude.ai-Skills. Muster „Sicherung vor jeder Änderung,
// Rückgängig mit Hash-Prüfung“ nach Hermes Agent `tools/skill_ledger.py` (MIT, s. NOTICE).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseSkillFrontmatter, t, type BridgeSkill, type SkillBackupResult, type SkillCreateTarget, type SkillFileInfo, type SkillReadResult, type SkillRestoreResult, type SkillSource, type SkillsListResult } from "@nyxos/shared";
import { underRoot } from "./config.js";

export class SkillLibraryError extends Error {
  constructor(
    message: string,
    readonly code: "denied" | "conflict" | "missing" | "too_big",
  ) {
    super(message);
  }
}

export interface SkillLibraryOptions {
  claudeDir: string;
  projectRoots: readonly string[];
  /** Sicherungen: `~/.nyxos/bridge/skill-backups` (Probe: im Datenordner). */
  backupsDir: string;
}

/** Höchstens so viele Projekt-Ordner mit Skills. */
const MAX_PROJECT_DIRS = 200;

function isNyxosRepo(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === "nyxos";
  } catch {
    return false;
  }
}

/** Projekt-Ordner, die Skills haben können: jeder Projektordner und seine direkten Unterordner (Repos). */
export function projectDirs(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!out.includes(root)) out.push(root);
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_PROJECT_DIRS) return out;
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const dir = join(root, e.name);
      if (existsSync(join(dir, ".claude")) && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/** Ordner, die nie in eine Sicherung oder Dateiliste gehören (wie Hermes `TRANSIENT_DIRS`). */
const SKIP_DIRS = new Set([".venv", "venv", "env", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".git"]);
const SKIP_FILES = new Set([".DS_Store"]);
const MAX_FILES = 200;
const MAX_DEPTH = 5;
const MAX_READ_BYTES = 512 * 1024;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

interface Root {
  source: Exclude<SkillSource, "plugin" | "synced" | "builtin">;
  dir: string;
}

export class SkillLibrary {
  constructor(private readonly o: SkillLibraryOptions) {}

  private get userDir(): string {
    return join(this.o.claudeDir, "skills");
  }
  private get syncedDir(): string {
    return join(this.userDir, "synced");
  }
  private get pluginsDir(): string {
    return join(this.o.claudeDir, "plugins");
  }

  /** Eigene Skill-Wurzeln (beschreibbar). */
  private ownRoots(): Root[] {
    const roots: Root[] = [{ source: "user", dir: this.userDir }];
    for (const dir of projectDirs(this.o.projectRoots)) {
      const skills = join(dir, ".claude", "skills");
      if (skills === this.userDir) continue;
      roots.push({ source: isNyxosRepo(dir) ? "nyxos" : "project", dir: skills });
    }
    return roots;
  }

  /** Ziel-Ordner für „Neuer Skill“ (ohne Projektordner: die persönlichen Skills). */
  targets(): Record<SkillCreateTarget, string> {
    const first = this.o.projectRoots[0];
    const project = first ? join(first, ".claude", "skills") : this.userDir;
    const nyxos = this.ownRoots().find((r) => r.source === "nyxos")?.dir ?? project;
    return { user: this.userDir, project, nyxos };
  }

  // ── Lesen ───────────────────────────────────────────────────────────────────────────────────

  async list(): Promise<SkillsListResult> {
    const out: BridgeSkill[] = [];
    const seen = new Set<string>();
    const push = (s: BridgeSkill | null) => {
      if (!s || seen.has(s.key)) return;
      seen.add(s.key);
      out.push(s);
    };
    for (const root of this.ownRoots()) {
      for (const name of await this.skillDirs(root.dir)) {
        if (root.source === "user" && name === "synced") continue;
        push(await this.describe(join(root.dir, name), name, root.source, null, true));
      }
    }
    // Claude.ai-Skills: mehrere synced-Ordner können denselben Skill enthalten → der jüngste gewinnt.
    const synced = new Map<string, BridgeSkill>();
    for (const bucket of await this.skillDirs(this.syncedDir, true)) {
      for (const name of await this.skillDirs(join(this.syncedDir, bucket))) {
        const s = await this.describe(join(this.syncedDir, bucket, name), `anthropic-skills:${name}`, "synced", null, false);
        if (s && (!synced.has(s.key) || (synced.get(s.key)?.mtimeMs ?? 0) < s.mtimeMs)) synced.set(s.key, s);
      }
    }
    for (const s of synced.values()) push(s);
    for (const plugin of await this.installedPlugins()) {
      for (const name of await this.skillDirs(join(plugin.path, "skills"))) {
        push(await this.describe(join(plugin.path, "skills", name), `${plugin.name}:${name}`, "plugin", plugin.name, false));
      }
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return { skills: out, projectRoot: this.o.projectRoots[0] ?? "", targets: this.targets() };
  }

  /** Unterordner, die eine SKILL.md haben (bzw. alle Unterordner bei `any`). */
  private async skillDirs(dir: string, any = false): Promise<string[]> {
    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (any) {
        out.push(e.name);
        continue;
      }
      try {
        if ((await stat(join(dir, e.name, "SKILL.md"))).isFile()) out.push(e.name);
      } catch {
        // kein Skill-Ordner
      }
    }
    return out;
  }

  private async installedPlugins(): Promise<{ name: string; path: string }[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.pluginsDir, "installed_plugins.json"), "utf8"));
    } catch {
      return [];
    }
    const plugins = (raw as { plugins?: Record<string, { installPath?: unknown }[]> }).plugins ?? {};
    const realPlugins = realOrNull(this.pluginsDir);
    const out: { name: string; path: string }[] = [];
    for (const [id, installs] of Object.entries(plugins)) {
      const path = installs.at(-1)?.installPath;
      if (typeof path !== "string" || !realPlugins) continue;
      const real = realOrNull(path);
      // Nur Plugins, die wirklich unter ~/.claude/plugins liegen.
      if (!real || !underRoot(real, realPlugins)) continue;
      out.push({ name: id.split("@")[0] ?? id, path: real });
    }
    return out;
  }

  private async describe(dir: string, key: string, source: SkillSource, plugin: string | null, writable: boolean): Promise<BridgeSkill | null> {
    const skillPath = join(dir, "SKILL.md");
    let text: string;
    let mtimeMs: number;
    try {
      const st = await stat(skillPath);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
      mtimeMs = st.mtimeMs;
      text = await readFile(skillPath, "utf8");
    } catch {
      return null;
    }
    const fm = parseSkillFrontmatter(text);
    // Verlinkte Skills (z. B. `~/.claude/skills/x -> ~/.agents/skills/x`, von `npx skills` verwaltet)
    // liegen außerhalb der Schreib-Wurzeln → nur lesen, sonst schlüge die Sicherung vor „Verbessern“ fehl.
    const real = realOrNull(dir);
    return {
      key,
      name: fm.name ?? basename(dir),
      description: fm.description,
      source,
      plugin,
      dir,
      skillPath,
      writable: writable && real !== null && this.inWritable(real),
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      mtimeMs,
      files: await this.fileList(dir),
    };
  }

  private async fileList(dir: string): Promise<SkillFileInfo[]> {
    const out: SkillFileInfo[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
      let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_FILES) return;
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
        } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
          const st = await lstat(p).catch(() => null);
          out.push({ rel: relative(dir, p), bytes: st?.size ?? 0 });
        }
      }
    };
    await walk(dir, 0);
    return out;
  }

  /** Wurzeln, unter denen gelesen werden darf (aufgelöst). */
  private readRoots(): string[] {
    return [...this.ownRoots().map((r) => r.dir), this.pluginsDir].map(realOrNull).filter((r): r is string => r !== null);
  }

  /** Wurzeln, unter denen geschrieben werden darf (aufgelöst) – ohne den synced-Ordner. */
  private writeRoots(): string[] {
    return this.ownRoots()
      .map((r) => realOrNull(r.dir))
      .filter((r): r is string => r !== null);
  }

  private inWritable(real: string): boolean {
    const synced = realOrNull(this.syncedDir);
    if (synced && underRoot(real, synced)) return false;
    // Der Wurzel-Ordner selbst ist kein Skill.
    return this.writeRoots().some((root) => underRoot(real, root) && real.toLowerCase() !== root.toLowerCase());
  }

  /** Aufgelöste Ziele verlinkter Skill-Ordner (Eintrag direkt in einer eigenen Wurzel ist ein Symlink
   * nach draußen). Nur genau dieser Ordner wird lesbar – nicht sein Nachbar, und Symlinks DARIN prüft `read` erneut. */
  private async linkedSkillDirs(): Promise<string[]> {
    const out: string[] = [];
    for (const root of this.ownRoots()) {
      for (const name of await this.skillDirs(root.dir)) {
        const real = realOrNull(join(root.dir, name));
        if (real) out.push(real);
      }
    }
    return out;
  }

  async read(paths: string[]): Promise<SkillReadResult> {
    const roots = [...this.readRoots(), ...(await this.linkedSkillDirs())];
    const files: SkillReadResult["files"] = [];
    for (const path of paths) {
      const real = realOrNull(path);
      if (!real || !roots.some((r) => underRoot(real, r))) {
        files.push({ path, content: null, sha256: null, truncated: false });
        continue;
      }
      try {
        const st = await stat(real);
        if (!st.isFile()) throw new Error("kein Datei");
        const buf = await readFile(real);
        const truncated = buf.length > MAX_READ_BYTES;
        const content = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
        files.push({ path, content, sha256: truncated ? null : sha256(content), truncated });
      } catch {
        files.push({ path, content: null, sha256: null, truncated: false });
      }
    }
    return { files };
  }

  // ── Schreiben (nur eigene Skills) ────────────────────────────────────────────────────────────

  /** Ganzen Skill-Ordner sichern: `<backupsDir>/<skill>/<Zeit>-<label>/`. */
  async backup(dir: string, label: string): Promise<SkillBackupResult> {
    const real = realOrNull(dir);
    if (!real || !this.inWritable(real)) throw new SkillLibraryError(t("Diesen Skill-Ordner darf NyxOS nicht sichern."), "denied");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(this.o.backupsDir, basename(real), `${stamp}-${label}`);
    let total = 0;
    const copy = async (from: string, to: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      await mkdir(to, { recursive: true });
      for (const e of await readdir(from, { withFileTypes: true })) {
        const src = join(from, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await copy(src, join(to, e.name), depth + 1);
        } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
          total += (await stat(src)).size;
          if (total > MAX_BACKUP_BYTES) throw new SkillLibraryError(t("Der Skill-Ordner ist zu groß für eine Sicherung."), "too_big");
          await copyFile(src, join(to, e.name));
        }
      }
    };
    await copy(real, target, 0);
    // Eine SKILL.md, die per Symlink aus dem Ordner zeigt, wird nicht gelesen (sonst landete ihr Inhalt im Verlauf).
    const skillMd = realOrNull(join(real, "SKILL.md"));
    const text = skillMd && underRoot(skillMd, real) ? await readFile(skillMd, "utf8").catch(() => null) : null;
    return { backupDir: target, sha256: text === null ? null : sha256(text), content: text };
  }

  /** Früheren Stand zurückschreiben – nur, wenn die Datei noch den erwarteten Stand hat. Vorher Sicherung. */
  async restore(skillPath: string, content: string, expectSha256: string): Promise<SkillRestoreResult> {
    const real = realOrNull(skillPath);
    if (!real || basename(real) !== "SKILL.md" || !this.inWritable(real)) throw new SkillLibraryError(t("Diesen Skill darf NyxOS nicht ändern."), "denied");
    const current = await readFile(real, "utf8");
    if (sha256(current) !== expectSha256) throw new SkillLibraryError(t("Der Skill wurde inzwischen geändert. Bitte neu laden und dann noch einmal."), "conflict");
    const { backupDir } = await this.backup(dirname(real), "vor-zuruecksetzen");
    const tmp = `${real}.nyxos-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, real);
    return { sha256: sha256(content), backupDir };
  }

  /** `claude --add-dir` für Skill-Aufträge: nur ~/.claude/skills (ohne synced). Liefert den aufgelösten Pfad. */
  checkAddDir(dir: string): string {
    const real = realOrNull(dir);
    const root = realOrNull(this.userDir);
    const synced = realOrNull(this.syncedDir);
    if (!real || !root || !underRoot(real, root) || (synced && underRoot(real, synced))) {
      throw new SkillLibraryError(t("Dieser Ordner ist für Skill-Aufträge nicht freigegeben."), "denied");
    }
    return real;
  }
}
