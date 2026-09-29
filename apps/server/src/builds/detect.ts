// Build-Wächter — welche Prüfung zu einem Arbeitsordner passt, und wie sie aufgerufen wird.
// Reine Funktionen mit austauschbarem Dateizugriff (wie `categorize.ts`), damit `watcher.ts`, die Route
// und Tests dieselbe Ableitung benutzen.
//
// Erkannt wird am Arbeitsordner der Session:
// - NyxOS selbst (ein Ordner `nyxos` im Pfad, auch dessen Worktrees) → `pnpm -r typecheck`;
// - ein Xcode-Projekt (`<Name>.xcodeproj`) im Arbeitsordner, direkt darunter oder in einem der Ordner
//   darüber → `xcodebuild build` mit dem gleichnamigen Standard-Schema;
// - ein Swift-Paket (`Package.swift`) im Arbeitsordner oder darüber → `swift test`.
// Läuft der Server nicht auf dem Rechner der Brücke (Server-Modus), sieht er die Ordner nicht; dann
// greifen nur die Pfad-Regeln (NyxOS, Ordner `backend`). Gebaut wird immer auf dem Rechner der Brücke.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WORKTREE_DIR, type BuildKind } from "@nyxos/shared";

/** Dateizugriff für die Erkennung (Tests setzen einen Fake). */
export interface BuildFs {
  isDir(path: string): boolean;
  /** Namen der Einträge eines Ordners, `[]` wenn nicht lesbar. */
  list(path: string): string[];
  exists(path: string): boolean;
}

export const nodeBuildFs: BuildFs = {
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  exists: (p) => existsSync(p),
};

export interface BuildPlan {
  kind: BuildKind;
  command: string[];
  cwd: string;
  /** Nur bei `kind === "ios"` gesetzt — eigener Pfad je Arbeitsordner, NIE der echte
   * `~/Library/Developer/Xcode/DerivedData` des Nutzers. */
  derivedDataPath: string | null;
}

/** Wie weit die Suche vom Arbeitsordner aus nach oben geht. */
const MAX_UP = 4;
const SKIP_CHILDREN = new Set(["node_modules", "Pods", "DerivedData", "build", ".build"]);

/** Eigener, deterministischer DerivedData-Pfad je Arbeitsordner (Hash des Pfades) unter dem
 * Build-Volume (`buildsDir`, s. `routes/builds.ts`/`main.ts`) — zwei Worktrees kollidieren nie,
 * derselbe Worktree bekommt bei jedem Lauf denselben Pfad (inkrementeller Build). */
export function derivedDataPathFor(worktreePath: string, buildsDir: string): string {
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(buildsDir, "derived-data", hash);
}

/** Hauptordner eines NyxOS-Checkouts: ein Worktree darin (`…/nyxos/.worktrees/<slug>` bzw.
 * `…/nyxos/.claude/worktrees/<slug>`) oder das Repo selbst (das ERSTE `/nyxos` im Pfad, ohne
 * Groß-/Kleinschreibung — ein Unterordner gleichen Namens zählt nicht). `null` = kein NyxOS-Ordner. */
export function nyxosRoot(cwd: string): string | null {
  const main = /^(.*?\/nyxos)(?:\/|$)/i.exec(cwd);
  if (!main?.[1]) return null;
  const rest = cwd.slice(main[1].length);
  const wt = new RegExp(`^/(?:${WORKTREE_DIR.replace(/\./g, "\\.")}|\\.claude/worktrees)/[^/]+`).exec(rest);
  return wt ? main[1] + wt[0] : main[1];
}

const xcodeProjectsIn = (dir: string, fs: BuildFs) => fs.list(dir).filter((n) => n.endsWith(".xcodeproj")).sort();

/** Das Xcode-Projekt eines Ordners: bei mehreren das gleichnamige (`<Ordner>.xcodeproj`), sonst das erste. */
function pickProject(dir: string, names: string[]): string | null {
  if (names.length === 0) return null;
  const own = names.find((n) => n === `${basename(dir)}.xcodeproj`);
  return own ?? names[0] ?? null;
}

/** Ordner und Projekt eines Xcode-Projekts: im Arbeitsordner, direkt darunter (z. B. `ios/`), sonst darüber. */
export function findXcodeProject(cwd: string, fs: BuildFs = nodeBuildFs): { dir: string; project: string } | null {
  const here = pickProject(cwd, xcodeProjectsIn(cwd, fs));
  if (here) return { dir: cwd, project: here };
  for (const child of fs.list(cwd).sort()) {
    if (child.startsWith(".") || SKIP_CHILDREN.has(child) || child.endsWith(".xcodeproj")) continue;
    const dir = join(cwd, child);
    if (!fs.isDir(dir)) continue;
    const found = pickProject(dir, xcodeProjectsIn(dir, fs));
    if (found) return { dir, project: found };
  }
  let dir = cwd;
  for (let i = 0; i < MAX_UP; i++) {
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
    const found = pickProject(dir, xcodeProjectsIn(dir, fs));
    if (found) return { dir, project: found };
  }
  return null;
}

/** Nächster Ordner mit `Package.swift` (Arbeitsordner oder darüber). */
export function findSwiftPackage(cwd: string, fs: BuildFs = nodeBuildFs): string | null {
  let dir = cwd;
  for (let i = 0; i <= MAX_UP; i++) {
    if (fs.exists(join(dir, "Package.swift"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Welche Prüfung passt zum Arbeitsordner? `null` = keine (z. B. Planungs-/Doku-Ordner). */
export function detectBuild(cwd: string | null, buildsDir: string, fs: BuildFs = nodeBuildFs): BuildPlan | null {
  if (!cwd || !cwd.startsWith("/")) return null;
  const nyxos = nyxosRoot(cwd);
  // Typen-Check statt voller Test-Suite — läuft nach JEDER Stop-Runde (oft mehrere Agenten parallel):
  // `pnpm test` bräuchte je Lauf über 80 s volle CPU, der Typen-Check ~7 s. Immer im Hauptordner.
  if (nyxos) return { kind: "nyxos", cwd: nyxos, derivedDataPath: null, command: ["pnpm", "-r", "typecheck"] };
  if (fs.isDir(cwd)) {
    const xcode = findXcodeProject(cwd, fs);
    if (xcode) {
      const derivedDataPath = derivedDataPathFor(xcode.dir, buildsDir);
      const scheme = xcode.project.slice(0, -".xcodeproj".length);
      return {
        kind: "ios",
        cwd: xcode.dir,
        derivedDataPath,
        command: ["xcodebuild", "build", "-project", xcode.project, "-scheme", scheme, "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derivedDataPath],
      };
    }
    const pkg = findSwiftPackage(cwd, fs);
    if (pkg) return { kind: "backend", cwd: pkg, derivedDataPath: null, command: ["swift", "test"] };
    return null;
  }
  // Server-Modus: Ordner nicht sichtbar — nur die Pfad-Regel für ein Swift-Backend (`swift test` sucht
  // das Paket auf dem Rechner der Brücke selbst, ohne Paket meldet die Brücke „nicht eingerichtet“).
  if (cwd.includes("/backend/") || cwd.endsWith("/backend")) return { kind: "backend", cwd, derivedDataPath: null, command: ["swift", "test"] };
  return null;
}
