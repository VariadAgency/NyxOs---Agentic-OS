// NUR LESENDER Vergleich für die Konflikte-Seite — `git log` + `git diff` für eine Datei
// (oder einen Ordner) unter dem Projektordner. Nutzt `runGit` (immer `--no-optional-locks`, also
// kein Index-Auffrischen nebenbei). Kein `checkout`, kein `show > datei`, keine Optionen vom Server:
// Stände sind per Schema geprüft (nie mit `-` am Anfang) und werden vorher mit `rev-parse --verify`
// bestätigt; der Pfad steht immer hinter `--`.
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { t, type GitCompareRawResult, type GitCompareRequest } from "@nyxos/shared";
import { underRoot } from "../config.js";
import { runGit } from "./exec.js";

/** Größte Diff-Ausgabe, die an den Server geht (mehr wäre in der Ansicht ohnehin nicht lesbar). */
export const MAX_DIFF_BYTES = 1024 * 1024;

export class GitCompareError extends Error {
  constructor(
    message: string,
    readonly code: "bad_folder" | "not_in_repo" | "bad_ref" | "failed",
  ) {
    super(message);
  }
}

/** Der Pfad ist immer ein wörtlicher Dateiname, nie ein Git-Pfadmuster (`*`, `:(glob)`, `:/`). */
const LITERAL = "--literal-pathspecs";

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `roots`: erlaubte Wurzeln (Projektordner, ohne eingetragene Ordner das Home-Verzeichnis). */
export async function gitCompare(roots: readonly string[], req: GitCompareRequest): Promise<GitCompareRawResult> {
  // Die Datei kann gelöscht sein — dann der nächste vorhandene Ordner darüber.
  let dir = isDir(req.path) ? req.path : dirname(req.path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    throw new GitCompareError(t("Ordner gibt es nicht"), "bad_folder");
  }
  const realRoot = roots.map(realOrNull).find((r) => r !== null && underRoot(realDir, r));
  if (!realRoot) throw new GitCompareError(t("liegt nicht unter dem Projektordner"), "bad_folder");
  const target = join(realDir, relative(dir, req.path));
  // Auch das zusammengesetzte Ziel prüfen (nicht nur den vorhandenen Ordner darüber).
  if (!underRoot(target, realRoot)) throw new GitCompareError(t("liegt nicht unter dem Projektordner"), "bad_folder");
  // Nie Git-Interna (`.git/config` kann Tokens enthalten) und nie einem Symlink folgen.
  if (target.split(sep).includes(".git")) throw new GitCompareError(t("Git-Interna"), "bad_folder");
  if (isSymlink(target)) throw new GitCompareError(t("Verknüpfung"), "bad_folder");

  const top = await runGit(realDir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new GitCompareError(t("kein Git-Ordner"), "not_in_repo");
  const repoRoot = realpathSync(top.stdout.trim());
  const rel = relative(repoRoot, target) || ".";
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new GitCompareError(t("liegt nicht im Repo"), "bad_folder");

  for (const ref of [req.from, req.to]) {
    if (ref === undefined) continue;
    const ok = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!ok.ok) throw new GitCompareError(t("Stand {ref} gibt es nicht", { ref }), "bad_ref");
  }

  // Von Git ausgeblendete Dateien (`.env`, Schlüssel …) nie anfassen.
  // (`check-ignore` kennt `--literal-pathspecs` nicht und nimmt Pfade ohnehin wörtlich. Exit 0 = ausgeblendet,
  // 1 = nicht ausgeblendet, 128 = Fehler → im Zweifel ablehnen.)
  if (rel !== ".") {
    const ign = await runGit(repoRoot, ["check-ignore", "-q", "--", rel]);
    if (ign.code !== 1) throw new GitCompareError(t("ausgeblendete Datei"), "bad_folder");
  }

  const log = await runGit(repoRoot, [LITERAL, "log", `-n${req.limit}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", "--", rel]);
  const commits = log.ok
    ? log.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha = "", short = "", author = "", at = "", subject = ""] = l.split("\u001f");
          return { sha, short, author, at, subject };
        })
    : [];

  // Noch nie committete Datei: `git diff HEAD` sähe sie gar nicht („keine Unterschiede“ wäre falsch).
  let untracked = false;
  if (commits.length === 0 && !isDir(target) && existsSync(target)) {
    untracked = !(await runGit(repoRoot, [LITERAL, "ls-files", "--error-unmatch", "--", rel])).ok;
  }

  let diff: string | null = null;
  let truncated = false;
  if (req.from) {
    if (untracked && !req.to) {
      // Nur lesend: vergleicht „nichts“ mit der Datei (kein `add`, kein Index). Rückgabe 1 = Unterschiede.
      const r = await runGit(repoRoot, [LITERAL, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", rel]);
      if (!r.stdout && r.stderr.trim()) throw new GitCompareError(t("git diff fehlgeschlagen"), "failed");
      diff = r.stdout;
    } else {
      const r = await runGit(repoRoot, [LITERAL, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", req.from, ...(req.to ? [req.to] : []), "--", rel]);
      if (!r.ok) throw new GitCompareError(t("git diff fehlgeschlagen"), "failed");
      diff = r.stdout;
    }
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
      diff = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8");
      diff = diff.slice(0, diff.lastIndexOf("\n") + 1);
      truncated = true;
    }
  }
  return { repoRoot, relPath: rel, commits, diff, truncated, untracked };
}
