// Quelle für den Aufgaben-/Audit-Import auf dem Server. Die Brücke liest (NUR lesen) die GOAL.md-Aufträge
// (samt `BERICHT.md` daneben) und die Audit-Maßnahmenpläne in den Projektordnern und schickt die volle Liste
// an `POST /ingest/entry-sources`; der Server importiert daraus (s. apps/server/src/entries/importService.ts).
// Warum die Brücke und kein Checkout auf dem Server: nur der Rechner des Nutzers hat den aktuellen Stand —
// die Dateien liegen teils ohne Git in den Projektordnern.
//
// Ablauf: Datei-Wächter (chokidar, gebündelt) + Sicherheits-Takt. Geschickt wird nur, wenn sich etwas
// geändert hat, spätestens aber stündlich (damit der Server „zuletzt geliefert“ ehrlich zeigt).
// Eigenes Modul, im Daemon nur eingehängt (ein paar Zeilen) — wirft nie, blockiert nie.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";
import {
  ENTRY_SOURCE_AUDIT_DIR,
  ENTRY_SOURCE_AUDIT_FILE,
  ENTRY_SOURCE_GOAL_DIRS,
  ENTRY_SOURCE_MAX_CHARS,
  ENTRY_SOURCE_REPORT_FILE,
  ENTRY_SOURCE_SKIP_DIRS,
  ENTRY_SOURCES_MAX_FILES,
  entrySourceKind,
  t,
  type EntrySourcesIngest,
} from "@nyxos/shared";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { Log } from "./tracker.js";

/** Ordner, die durchsucht werden (Vereinigung aus GOAL- und Audit-Ordnern, ohne Doppel). */
const SOURCE_DIRS = [...new Set<string>([...ENTRY_SOURCE_GOAL_DIRS, ENTRY_SOURCE_AUDIT_DIR])];
/** Nie betreten: die gemeinsamen Ausnahmen, Build-Ausgaben und alle versteckten Ordner. */
const SKIP_DIRS = new Set([...ENTRY_SOURCE_SKIP_DIRS, "dist", "build", "target", "vendor", "Pods", ".venv"]);
const skipDir = (name: string) => SKIP_DIRS.has(name) || name.startsWith(".");
/** So tief sucht die Brücke unter einem Projektordner (Schutz vor riesigen Bäumen). */
const MAX_DEPTH = 8;
const SOURCE_NAMES = new Set(["GOAL.md", ENTRY_SOURCE_AUDIT_FILE, ENTRY_SOURCE_REPORT_FILE]);

export interface EntrySourcesScan {
  files: { path: string; content: string }[];
  complete: boolean;
  errors: string[];
  /** Wie viele der Quell-Ordner es gibt (0 = falscher Projekt-Ordner). */
  dirsFound: number;
}

/**
 * Liest alle Quelldateien (relativ zum jeweiligen Projektordner, `/` als Trenner; bei gleichem Pfad in zwei
 * Projektordnern gilt der erste). `complete` = alle Ordner da, kein Lesefehler.
 */
export async function scanEntrySources(projectRoots: readonly string[]): Promise<EntrySourcesScan> {
  const files = new Map<string, string>();
  const errors: string[] = [];
  let dirsFound = 0;
  const walk = async (root: string, abs: string, depth: number): Promise<void> => {
    let items;
    try {
      items = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      errors.push(t("{path}: nicht lesbar ({code})", { path: relative(root, abs) || ".", code: (e as NodeJS.ErrnoException).code ?? t("Fehler") }));
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (!skipDir(it.name) && depth < MAX_DEPTH) await walk(root, join(abs, it.name), depth + 1);
        continue;
      }
      if (!it.isFile() || !SOURCE_NAMES.has(it.name)) continue;
      const rel = relative(root, join(abs, it.name)).split(sep).join("/");
      if (!entrySourceKind(rel) || files.has(rel)) continue;
      try {
        const content = await readFile(join(abs, it.name), "utf8");
        if (content.length > ENTRY_SOURCE_MAX_CHARS) errors.push(t("{path}: zu groß", { path: rel }));
        else files.set(rel, content);
      } catch (e) {
        errors.push(t("{path}: nicht lesbar ({code})", { path: rel, code: (e as NodeJS.ErrnoException).code ?? t("Fehler") }));
      }
    }
  };
  for (const root of projectRoots) {
    for (const dir of SOURCE_DIRS) {
      const abs = join(root, dir);
      try {
        if (!(await stat(abs)).isDirectory()) throw new Error("not a directory");
      } catch {
        errors.push(t("{path}: Ordner fehlt", { path: abs }));
        continue;
      }
      dirsFound++;
      await walk(root, abs, 0);
    }
  }
  // Ein Bericht zählt nur direkt neben einer GOAL.md (dann ist dieser Auftrag fertig). Lose
  // Berichte (Teilberichte in Unterordnern, Notizen) gehen gar nicht erst raus.
  for (const rel of [...files.keys()]) {
    if (entrySourceKind(rel) === "report" && !files.has(posix.join(posix.dirname(rel), "GOAL.md"))) files.delete(rel);
  }
  const list = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
  if (list.length > ENTRY_SOURCES_MAX_FILES) errors.push(t("mehr als {n} Quelldateien", { n: ENTRY_SOURCES_MAX_FILES }));
  return { files: list.slice(0, ENTRY_SOURCES_MAX_FILES), complete: errors.length === 0, errors: errors.slice(0, 50), dirsFound };
}

export interface EntrySourcesConfig {
  projectRoots: readonly string[];
  serverUrl: string;
  token: string;
}

export interface EntrySourcesOptions {
  /** Änderungen so lange bündeln, bevor gescannt und geschickt wird. */
  debounceMs?: number;
  /** Sicherheits-Takt (voller Scan); 0 = aus (Tests). */
  intervalMs?: number;
  /** Auch ohne Änderung spätestens nach dieser Zeit erneut schicken. */
  resendMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** false = kein Datei-Wächter (Tests). */
  watch?: boolean;
}

export interface EntrySourcesStatus {
  files: number;
  lastOkAt: number | null;
  lastError: string | null;
}

/** Lehnt der Server die Lieferung wegen eines `BERICHT.md` ab (älterer Server)? Antwort-Text
 * `{"error":"Pfad nicht erlaubt: <pfad>"}` aus `IngestPathError`. */
export function rejectedReportPath(body: string): boolean {
  let msg: unknown;
  try {
    msg = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return false;
  }
  if (typeof msg !== "string") return false;
  const m = /^Pfad nicht erlaubt: (.+)$/.exec(msg);
  return m?.[1] !== undefined && basename(m[1]) === ENTRY_SOURCE_REPORT_FILE;
}

export class EntrySourcesSync {
  private readonly fetchImpl: typeof fetch;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly resendMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly useWatcher: boolean;
  private backoff: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private lastSentHash: string | null = null;
  private lastSentAt = 0;
  /** Bis wann Berichte weggelassen werden, weil der Server sie (noch) nicht kennt. */
  private reportsRejectedUntil = 0;

  readonly status: EntrySourcesStatus = { files: 0, lastOkAt: null, lastError: null };

  constructor(
    private readonly cfg: EntrySourcesConfig,
    private readonly log: Log,
    fetchImpl?: typeof fetch,
    opts: EntrySourcesOptions = {},
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.intervalMs = opts.intervalMs ?? 10 * 60_000;
    this.resendMs = opts.resendMs ?? 60 * 60_000;
    this.minBackoffMs = opts.minBackoffMs ?? 5000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.useWatcher = opts.watch ?? true;
    this.backoff = this.minBackoffMs;
  }

  /** Wächter + erster Abgleich; kehrt nach dem ersten Versuch zurück. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.useWatcher) {
      try {
        const dirs = this.cfg.projectRoots.flatMap((root) => SOURCE_DIRS.map((d) => join(root, d)));
        const w = chokidarWatch(dirs, {
          ignoreInitial: true,
          followSymlinks: false,
          depth: MAX_DEPTH,
          ignored: (path: string, stats?: { isFile(): boolean; isDirectory(): boolean }) => {
            const name = basename(path);
            if (stats?.isDirectory() && !dirs.includes(path) && skipDir(name)) return true;
            return stats?.isFile() === true && !SOURCE_NAMES.has(name);
          },
        });
        this.watcher = w;
        const onChange = (path: string) => {
          if (SOURCE_NAMES.has(basename(path))) this.schedule();
        };
        w.on("add", onChange).on("change", onChange).on("unlink", onChange);
        w.on("unlinkDir", () => this.schedule());
        w.on("error", (e: unknown) => this.log("aufgaben-quelle-fehler", { error: String(e) }));
        await new Promise<void>((r) => w.once("ready", () => r()));
      } catch (e) {
        this.log("aufgaben-quelle-fehler", { error: `watcher: ${String(e)}` });
      }
    }
    if (this.stopped) return;
    if (this.intervalMs > 0) {
      this.tickTimer = setInterval(() => void this.kick(), this.intervalMs);
      this.tickTimer.unref?.();
    }
    await this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.debounceTimer, this.retryTimer]) if (t) clearTimeout(t);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.debounceTimer = this.retryTimer = this.tickTimer = null;
    const w = this.watcher;
    this.watcher = null;
    await w?.close().catch(() => {});
    await this.running?.catch(() => {});
  }

  /** Sofort scannen und (falls geändert) schicken — für Tests und ein Aufwachen nach Schlaf. */
  syncNow(): Promise<void> {
    return this.kick();
  }

  private schedule(): void {
    if (this.stopped || this.debounceTimer || this.retryTimer) return; // ein geplanter Versuch holt alles mit ab
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.kick();
    }, this.debounceMs);
  }

  /** Genau ein Lauf zur Zeit; Anstöße währenddessen werden danach nachgeholt. */
  private kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          if (!(await this.once())) break;
        } while (this.again && !this.stopped);
      } catch (e) {
        this.fail(String(e));
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  /** true = erledigt (geschickt oder nichts zu tun), false = Fehler, erneuter Versuch geplant. */
  private async once(): Promise<boolean> {
    // Ohne Projektordner gibt es keine Quelle — nichts schicken (eine leere Liste sähe aus wie „alles gelöscht“).
    if (this.cfg.projectRoots.length === 0) return true;
    const scan = await scanEntrySources(this.cfg.projectRoots);
    if (this.stopped) return false;
    // Ein älterer Server lehnt die GANZE Lieferung ab, sobald ein BERICHT.md
    // drin ist („Pfad nicht erlaubt“, 400). Dann gehen die Berichte eine Weile nicht mit — die Aufträge
    // selbst kommen weiter an, statt dass die Brücke dieselbe Lieferung endlos erneut schickt.
    const withoutReports = Date.now() < this.reportsRejectedUntil;
    if (withoutReports) scan.files = scan.files.filter((f) => entrySourceKind(f.path) !== "report");
    if (scan.dirsFound === 0) {
      // Falscher Projekt-Ordner: nichts schicken (eine leere Liste sähe aus wie „alles gelöscht“).
      this.status.lastError = t("Keiner der Projektordner ist vorhanden: {dirs}", { dirs: this.cfg.projectRoots.join(", ") });
      this.log("aufgaben-quelle-fehler", { reason: this.status.lastError });
      return true;
    }
    const hash = createHash("sha256");
    for (const f of scan.files) hash.update(f.path).update("\0").update(f.content).update("\0");
    hash.update(scan.complete ? "1" : "0");
    const digest = hash.digest("hex");
    if (digest === this.lastSentHash && Date.now() - this.lastSentAt < this.resendMs) return true;
    const body: EntrySourcesIngest = { complete: scan.complete, scannedAt: new Date().toISOString(), files: scan.files, errors: scan.errors };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.serverUrl}/ingest/entry-sources`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      this.fail(`Netz: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (!withoutReports && res.status === 400 && rejectedReportPath(text)) {
        this.reportsRejectedUntil = Date.now() + Math.max(this.resendMs, this.maxBackoffMs);
        this.log("aufgaben-quelle-ohne-berichte", { grund: "Server kennt BERICHT.md noch nicht", bis: new Date(this.reportsRejectedUntil).toISOString() });
        return this.once(); // sofort ohne Berichte (kein zweites Mal: `withoutReports` ist dann gesetzt)
      }
      this.fail(`HTTP ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    await res.body?.cancel().catch(() => {});
    this.lastSentHash = digest;
    this.lastSentAt = Date.now();
    this.backoff = this.minBackoffMs;
    this.status.files = scan.files.length;
    this.status.lastOkAt = Date.now();
    this.status.lastError = !scan.complete
      ? t("unvollständig: {errors}", { errors: scan.errors.slice(0, 3).join("; ") })
      : withoutReports
        ? t("Berichte (BERICHT.md) ausgelassen: der Server kennt sie noch nicht")
        : null;
    this.log("aufgaben-quelle-geschickt", { dateien: scan.files.length, vollstaendig: scan.complete });
    return true;
  }

  private fail(reason: string): void {
    this.status.lastError = reason;
    this.log("aufgaben-quelle-fehler", { reason, retryMs: this.backoff });
    if (this.stopped || this.retryTimer) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.kick();
    }, this.backoff);
    this.retryTimer.unref?.();
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }
}
