// Build-Prüfung auf dem Rechner des Nutzers (RPC `run_build` vom Server). Hier liegen die Arbeitsordner
// und Werkzeuge (pnpm, swift, Xcode) — auf dem Server nicht. Der Befehl kommt vom Server, darum eng begrenzt:
// - nur GENAU die Prüfungen, die der Server plant (`server/builds/detect.ts`): `pnpm -r typecheck`,
//   `pnpm test`, `swift test`, `xcodebuild build -project … -scheme … -destination … -derivedDataPath …`
//   — keine freien Argumente (`pnpm exec …`, `swift run`, `xcodebuild -…` wären beliebige Befehle);
// - Werkzeug als blanker Name, über den PATH der Brücke gesucht; nur Ordner unter den Projektordnern;
// - keine Umgebungsvariablen vom Server;
// - DerivedData legt die Brücke selbst fest (eigener Ordner je Projekt) — ein Server-Pfad existiert hier nicht;
// - xcodebuild nur auf macOS.
// Fehlt etwas, gibt es „nicht eingerichtet“ (mit Grund) statt eines roten Laufs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { BUILD_ALLOWED_TOOLS, BUILD_TIMEOUT_MS, t, type BuildUnavailableReason, type RunBuildRequest, type RunBuildResult } from "@nyxos/shared";
import { accessRoots, underRoot } from "../config.js";

export interface RunBuildDeps {
  /** PATH der Brücke (ein Dienst hat sonst nur /usr/bin:/bin — s. `config.terminal.path`). */
  path: string;
  /** Projektordner; ohne eingetragene Ordner gilt das Home-Verzeichnis. */
  projectRoots: readonly string[];
  /** Wohin Xcode baut (eigener Ordner je Projekt) — nie das echte `~/Library/Developer/Xcode/DerivedData`. */
  derivedDataRoot?: string;
  /** Tests: Betriebssystem vorgeben. */
  platform?: NodeJS.Platform;
}

export const DEFAULT_DERIVED_DATA_ROOT = join(homedir(), "Library", "Caches", "NyxOS", "derived-data");

/** Nur das Ende des Logs zählt (Einzeiler/Details); mehr als das behält die Brücke nicht im Speicher. */
const MAX_LOG_CHARS = 64 * 1024;
const KILL_GRACE_MS = 5000;

/** Erlaubte Argumente je Werkzeug (xcodebuild wird eigens geprüft). */
const FIXED_ARGS: Record<string, string[][]> = {
  pnpm: [["-r", "typecheck"], ["test"]],
  swift: [["test"]],
};
const IOS_DESTINATION = "generic/platform=iOS Simulator";

const unavailable = (reason: BuildUnavailableReason, log: string, tool?: string): RunBuildResult => ({ outcome: "unavailable", reason, log, ...(tool ? { tool } : {}) });

type Checked = { ok: true; args: string[]; cwd: string } | { ok: false; result: RunBuildResult };

function findOnPath(tool: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, tool);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Nächster Ordner mit `Package.swift` (vom Arbeitsordner aufwärts, höchstens bis zum Projektordner). */
function swiftPackageDir(cwd: string, root: string): string | null {
  for (let dir = cwd; underRoot(dir, root); dir = dirname(dir)) {
    if (existsSync(join(dir, "Package.swift"))) return dir;
    if (dirname(dir) === dir) break;
  }
  return null;
}

function checkCommand(tool: string, args: string[], cwd: string, root: string, derivedDataRoot: string): Checked {
  const denied = (log: string): Checked => ({ ok: false, result: unavailable("not_allowed", log) });
  if (tool === "xcodebuild") {
    // Genau: build -project <P> -scheme <S> -destination <iOS Simulator> -derivedDataPath <egal, s. u.>
    const [verb, fProject, project, fScheme, scheme, fDest, dest, fDerived, derived, ...rest] = args;
    if (
      verb !== "build" ||
      fProject !== "-project" ||
      fScheme !== "-scheme" ||
      fDest !== "-destination" ||
      dest !== IOS_DESTINATION ||
      fDerived !== "-derivedDataPath" ||
      !derived ||
      rest.length > 0 ||
      !project ||
      !scheme ||
      scheme.startsWith("-") ||
      !project.endsWith(".xcodeproj")
    ) {
      return denied(t("Nicht erlaubte xcodebuild-Argumente: {args}", { args: args.join(" ") }));
    }
    const abs = resolve(cwd, project);
    if (!underRoot(abs, cwd)) return denied(t("Projekt liegt nicht im Arbeitsordner: {path}", { path: abs }));
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return { ok: false, result: unavailable("no_project", t("Xcode-Projekt fehlt: {path}", { path: abs })) };
    }
    if (!underRoot(real, cwd)) return denied(t("Projekt liegt nicht im Arbeitsordner: {path}", { path: real }));
    const dd = join(derivedDataRoot, createHash("sha256").update(cwd).digest("hex").slice(0, 16));
    try {
      mkdirSync(dd, { recursive: true });
    } catch (e) {
      return { ok: false, result: unavailable("folder_missing", t("DerivedData-Ordner nicht anlegbar: {path} ({error})", { path: dd, error: String(e) })) };
    }
    return { ok: true, cwd, args: ["build", "-project", real, "-scheme", scheme, "-destination", IOS_DESTINATION, "-derivedDataPath", dd] };
  }
  const allowed = FIXED_ARGS[tool] ?? [];
  if (!allowed.some((a) => sameArgs(a, args))) return denied(t("Nicht erlaubt: {cmd}", { cmd: [tool, ...args].join(" ") }));
  if (tool === "swift") {
    const pkg = swiftPackageDir(cwd, root);
    if (!pkg) return { ok: false, result: unavailable("no_project", t("Kein Package.swift in {path} oder darüber", { path: cwd })) };
    return { ok: true, cwd: pkg, args };
  }
  if (tool === "pnpm" && !existsSync(join(cwd, "node_modules"))) return { ok: false, result: unavailable("deps_missing", t("node_modules fehlt in {path}", { path: cwd })) };
  return { ok: true, cwd, args };
}

/** Laufende Prüfungen (Prozessgruppen) — beim Beenden der Brücke mit beendet, damit nichts verwaist. */
const active = new Set<number>();
let exitHook = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // schon beendet
  }
}

export async function runBuild(req: RunBuildRequest, deps: RunBuildDeps): Promise<RunBuildResult> {
  const [tool, ...rawArgs] = req.command;
  if (!tool || !(BUILD_ALLOWED_TOOLS as readonly string[]).includes(tool)) return unavailable("not_allowed", t("Nicht erlaubt: {cmd}", { cmd: tool ?? t("(leer)") }));
  if (tool === "xcodebuild" && (deps.platform ?? process.platform) !== "darwin") return unavailable("tool_missing", t("xcodebuild gibt es nur auf macOS"), tool);

  let cwd: string;
  try {
    cwd = realpathSync(req.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    return unavailable("folder_missing", t("Ordner fehlt: {path}", { path: req.cwd }));
  }
  const roots = accessRoots(deps.projectRoots).map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  const root = roots.find((r) => underRoot(cwd, r));
  if (!root) return unavailable("not_allowed", t("Ordner liegt nicht in einem Projektordner: {path}", { path: cwd }));

  const checked = checkCommand(tool, rawArgs, cwd, root, deps.derivedDataRoot ?? DEFAULT_DERIVED_DATA_ROOT);
  if (!checked.ok) return checked.result;

  const bin = findOnPath(tool, deps.path);
  if (!bin) return unavailable("tool_missing", t("{tool} nicht im Suchpfad der Brücke (PATH={path})", { tool, path: deps.path }), tool);

  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const pid of active) killGroup(pid, "SIGKILL");
    });
  }

  const timeoutMs = req.timeoutMs ?? BUILD_TIMEOUT_MS;
  return new Promise((resolveRun) => {
    let log = "";
    const append = (d: Buffer) => {
      log += d.toString("utf8");
      if (log.length > MAX_LOG_CHARS * 2) log = log.slice(-MAX_LOG_CHARS);
    };
    let timedOut = false;
    // Eigene Prozessgruppe (`detached`), damit der Abbruch auch Kind-Prozesse trifft (tsc, swift-build,
    // clang): sonst halten sie die Ausgabe offen und die Antwort an den Server hängt.
    const proc = spawn(bin, checked.args, {
      cwd: checked.cwd,
      detached: true,
      env: { ...process.env, PATH: deps.path, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = proc.pid;
    if (pid) active.add(pid);
    const timer = setTimeout(() => {
      timedOut = true;
      if (!pid) return;
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    const finish = (r: RunBuildResult) => {
      clearTimeout(timer);
      if (pid) active.delete(pid);
      resolveRun(r);
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") finish(unavailable("tool_missing", err.message, tool));
      else finish({ outcome: "done", exitCode: -1, log: `${log}\n${t("Fehler beim Starten: {error}", { error: err.message })}` });
    });
    // `exit` statt `close`: nach dem Abbruch nicht darauf warten, dass jeder Enkel seine Ausgabe schließt.
    proc.on("exit", (code) => {
      if (timedOut && pid) killGroup(pid, "SIGKILL");
      const tail = log.slice(-MAX_LOG_CHARS);
      if (timedOut) finish({ outcome: "done", exitCode: -1, log: `${tail}\n${t("Prüfung abgebrochen nach {s} s", { s: Math.round(timeoutMs / 1000) })}` });
      else {
        // Restausgabe kurz abwarten (die Pipes schließen normalerweise direkt nach dem Ende).
        const done = () => finish({ outcome: "done", exitCode: code ?? -1, log: log.slice(-MAX_LOG_CHARS) });
        if (proc.stdout.readableEnded && proc.stderr.readableEnded) done();
        else {
          const wait = setTimeout(done, 2000);
          proc.once("close", () => {
            clearTimeout(wait);
            done();
          });
        }
      }
    });
  });
}
