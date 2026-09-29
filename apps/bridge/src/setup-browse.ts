// Onboarding folder picker (RPC `setup.browse`): the subfolders of one folder, so nobody has to type a path.
// Directories only, hidden ones left out, sorted, capped. Symlinks to folders are shown (their target is checked
// with `stat`, broken links and loops are skipped). Paths stay as the user navigated them (no symlink
// resolution), because the bridge matches sessions to project folders by that path. Read only.
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SetupBrowseRequestSchema, t, type SetupBrowseEntry, type SetupBrowseResult } from "@nyxos/shared";
import { mapLimit, ProtectedGate } from "./setup-detect.js";

/** At most this many subfolders are listed. */
export const BROWSE_MAX_ENTRIES = 500;
/** Repo counts per subfolder only for folders up to this size, and only within this time. */
const COUNT_MAX_ENTRIES = 150;
const COUNT_BUDGET_MS = 400;
const CONCURRENCY = 8;

export class BrowseError extends Error {
  constructor(
    message: string,
    readonly code: "bad_request" | "missing_folder" | "denied" | "failed",
  ) {
    super(message);
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Git repos directly inside `dir` (one level). */
async function reposInside(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const subs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."));
  const flags = await mapLimit(subs, CONCURRENCY, (e) => hasGit(join(dir, e.name)));
  return flags.filter(Boolean).length;
}

/** `.git` folder (repo) or file (worktree). */
async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function browseFolder(params: unknown, o: { home: string; gate?: ProtectedGate; now?: () => number }): Promise<SetupBrowseResult> {
  const parsed = SetupBrowseRequestSchema.safeParse(params ?? {});
  if (!parsed.success) throw new BrowseError(t("Ungültige Einstellungen: {error}", { error: parsed.error.issues.map((i) => i.message).join("; ") }), "bad_request");
  const home = resolve(o.home);
  const raw = parsed.data.path?.trim() || home;
  const expanded = raw.replace(/^~(?=\/|$)/, home);
  if (!isAbsolute(expanded)) throw new BrowseError(t("Bitte einen vollständigen Pfad angeben, z. B. ~/code"), "bad_request");
  const path = resolve(expanded);
  const gate = o.gate ?? new ProtectedGate({ home });
  const now = o.now ?? Date.now;

  if (!(await gate.allow(path))) {
    throw new BrowseError(
      gate.pending(path)
        ? t("Dein Rechner fragt gerade, ob NyxOS diesen Ordner lesen darf. Bitte im Dialog „Erlauben“ wählen und den Ordner dann noch einmal öffnen.")
        : t("NyxOS darf diesen Ordner nicht lesen. Du kannst das in den Systemeinstellungen unter „Datenschutz & Sicherheit“ erlauben."),
      "denied",
    );
  }

  let entries: Dirent[];
  try {
    const st = await stat(path);
    if (!st.isDirectory()) throw new BrowseError(t("Das ist kein Ordner: {path}", { path }), "bad_request");
    entries = await readdir(path, { withFileTypes: true });
  } catch (e) {
    if (e instanceof BrowseError) throw e;
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") throw new BrowseError(t("Diese Ordner gibt es nicht: {dirs}", { dirs: path }), "missing_folder");
    if (code === "EACCES" || code === "EPERM") throw new BrowseError(t("NyxOS darf diesen Ordner nicht lesen."), "denied");
    throw new BrowseError(t("Der Ordner lässt sich gerade nicht öffnen."), "failed");
  }

  const isRepo = entries.some((e) => e.name === ".git");
  const visible = entries.filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()));
  // Symlinks only when they point to a folder that exists (stat follows the link; loops fail with ELOOP).
  const dirs = (await mapLimit(visible, CONCURRENCY, async (e) => (e.isDirectory() || (await isDir(join(path, e.name))) ? e.name : null))).filter((n): n is string => n !== null);
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const truncated = dirs.length > BROWSE_MAX_ENTRIES;
  const shown = dirs.slice(0, BROWSE_MAX_ENTRIES);

  const deadline = now() + COUNT_BUDGET_MS;
  const countRepos = shown.length <= COUNT_MAX_ENTRIES;
  const list: SetupBrowseEntry[] = await mapLimit(shown, CONCURRENCY, async (name) => {
    const child = join(path, name);
    // Listing a folder must never trigger the macOS permission dialog for a protected subfolder.
    if (!gate.open(child)) return { name, path: child, isRepo: false };
    const repo = await hasGit(child);
    const entry: SetupBrowseEntry = { name, path: child, isRepo: repo };
    if (!repo && countRepos && now() < deadline) entry.repoCount = await reposInside(child);
    return entry;
  });

  return { path, parent: path === "/" ? null : dirname(path), home, isRepo, entries: list, truncated };
}
