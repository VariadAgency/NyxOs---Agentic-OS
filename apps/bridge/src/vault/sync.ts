import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import { t, VAULT_INGEST_MAX_NOTES, type VaultIngest, type VaultNote } from "@nyxos/shared";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { Log } from "../tracker.js";
import { isIgnoredRel, isNoteFile, VaultScanner } from "./scan.js";

export interface VaultSyncConfig {
  vaultDir: string;
  serverUrl: string;
  token: string;
}

export interface VaultSyncOptions {
  /** Änderungen so lange sammeln, bevor ein Delta geschickt wird. */
  debounceMs?: number;
  /** Zur Sicherheit regelmäßig alles abgleichen (0 = aus). */
  fullResyncMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Notizen je Anfrage (Obergrenze laut Vertrag `VAULT_INGEST_MAX_NOTES`). */
  chunkSize?: number;
  /** false = kein Datei-Wächter (Tests). */
  watch?: boolean;
}

export interface VaultSyncStatus {
  notes: number;
  lastOkAt: number | null;
  lastError: string | null;
}

/**
 * PG „Gehirn": schickt die Metadaten des Obsidian-Vaults an den Server (`POST /ingest/vault`).
 * Ablauf: Vollabgleich (in Teilen, gemeinsame `syncId`, `done` nur beim letzten), danach Deltas
 * aus dem Datei-Wächter. Alles strikt nacheinander — nie zwei Anfragen gleichzeitig. Jeder Fehler
 * → Backoff und danach IMMER ein neuer Vollabgleich (einfach und robust, der Server löscht beim
 * `done` Notizen früherer Läufe). Liest nur, schreibt nie in den Vault, wirft nie.
 */
export class VaultSync {
  private readonly scanner: VaultScanner;
  private readonly fetchImpl: typeof fetch;
  private readonly debounceMs: number;
  private readonly fullResyncMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly chunkSize: number;
  private readonly useWatcher: boolean;

  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  private stopped = false;
  private running: Promise<void> | null = null;
  private again = false;

  private needFull = true;
  /** Notizen im letzten bestätigten Vollabgleich (Schutz gegen plötzliches Schrumpfen, W2). */
  private confirmedCount = 0;
  private shrinkCandidate: number | null = null;
  private lastSyncId: string | null = null;
  private readonly pending = new Set<string>();

  readonly status: VaultSyncStatus = { notes: 0, lastOkAt: null, lastError: null };

  constructor(
    private readonly cfg: VaultSyncConfig,
    private readonly log: Log,
    fetchImpl?: typeof fetch,
    opts: VaultSyncOptions = {},
  ) {
    this.scanner = new VaultScanner(cfg.vaultDir);
    this.fetchImpl = fetchImpl ?? fetch;
    this.debounceMs = opts.debounceMs ?? 1500;
    this.fullResyncMs = opts.fullResyncMs ?? 15 * 60_000;
    this.minBackoffMs = opts.minBackoffMs ?? 2000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.chunkSize = Math.max(1, Math.min(opts.chunkSize ?? VAULT_INGEST_MAX_NOTES, VAULT_INGEST_MAX_NOTES));
    this.useWatcher = opts.watch ?? true;
    this.backoff = this.minBackoffMs;
  }

  /** Startet Wächter und den ersten Vollabgleich; kehrt nach dem ersten Versuch zurück. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.useWatcher) {
      try {
        const root = this.cfg.vaultDir;
        const w = chokidarWatch(root, {
          ignoreInitial: true,
          followSymlinks: false,
          ignored: (path: string, stats?: { isFile(): boolean }) => {
            const rel = relative(root, path);
            if (!rel || rel.startsWith("..")) return false;
            if (isIgnoredRel(rel)) return true;
            return stats?.isFile() === true && !isNoteFile(path);
          },
        });
        this.watcher = w;
        const onFile = (path: string) => this.onChange(path);
        w.on("add", onFile).on("change", onFile).on("unlink", onFile);
        w.on("unlinkDir", () => this.requestFull());
        w.on("error", (e: unknown) => this.log("vault-fehler", { error: String(e) }));
        await new Promise<void>((r) => w.once("ready", () => r()));
      } catch (e) {
        this.log("vault-fehler", { error: `Wächter: ${String(e)}` });
      }
    }
    if (this.stopped) return;
    if (this.fullResyncMs > 0) {
      this.resyncTimer = setInterval(() => this.requestFull(), this.fullResyncMs);
      this.resyncTimer.unref?.();
    }
    await this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.debounceTimer, this.retryTimer]) if (t) clearTimeout(t);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.debounceTimer = this.retryTimer = this.resyncTimer = null;
    const w = this.watcher;
    this.watcher = null;
    await w?.close().catch(() => {});
    await this.running?.catch(() => {});
  }

  private onChange(absPath: string): void {
    if (this.stopped) return;
    const rel = relative(this.cfg.vaultDir, absPath).split(sep).join("/");
    if (!rel || rel.startsWith("..") || !isNoteFile(rel) || isIgnoredRel(rel)) return;
    this.pending.add(rel);
    this.scheduleDebounced();
  }

  /** Vollabgleich anstoßen (z. B. nach Aufwachen), gebündelt wie Änderungen. */
  resync(): void {
    this.requestFull();
  }

  private requestFull(): void {
    if (this.stopped) return;
    this.needFull = true;
    this.scheduleDebounced();
  }

  private scheduleDebounced(): void {
    if (this.debounceTimer || this.retryTimer) return; // ein laufender Backoff holt alles mit ab
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.kick();
    }, this.debounceMs);
  }

  /** Genau ein Abgleich-Lauf zur Zeit; Anstöße während eines Laufs werden danach nachgeholt. */
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
          const ok = await this.processOnce();
          if (!ok) break;
        } while ((this.again || this.needFull || this.pending.size > 0) && !this.stopped);
      } catch (e) {
        this.fail(String(e)); // darf nie passieren — trotzdem nie werfen
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  /** true = erfolgreich (oder nichts zu tun), false = Fehler, Backoff ist geplant. */
  private async processOnce(): Promise<boolean> {
    if (this.needFull || !this.lastSyncId) return this.fullSync();
    if (this.pending.size === 0) return true;
    return this.deltaSync();
  }

  private async fullSync(): Promise<boolean> {
    this.needFull = false;
    this.pending.clear(); // der Scan liest ohnehin den aktuellen Stand; spätere Änderungen sammeln sich neu
    const syncId = randomUUID();
    const notes = await this.scanner.scanAll();
    // Nur ein vollständiger, plausibler Scan darf am Ende `done` schicken (= Server
    // löscht, was fehlt). Lesefehler → hochladen ja, löschen nein, später neu versuchen. Schrumpft
    // der Vault um mehr als die Hälfte, muss ein zweiter Scan dieselbe Zahl bestätigen.
    const incomplete = this.scanner.lastScanErrors > 0;
    const shrunk = this.confirmedCount > 20 && notes.length < this.confirmedCount / 2;
    const shrinkConfirmed = shrunk && this.shrinkCandidate === notes.length;
    const mayDelete = !incomplete && (!shrunk || shrinkConfirmed);
    const parts: VaultNote[][] = [];
    for (let i = 0; i < notes.length; i += this.chunkSize) parts.push(notes.slice(i, i + this.chunkSize));
    if (parts.length === 0) parts.push([]);
    for (let i = 0; i < parts.length; i++) {
      if (this.stopped) return false;
      const ok = await this.send({ root: this.cfg.vaultDir, syncId, mode: "full", notes: parts[i] ?? [], deleted: [], done: mayDelete && i === parts.length - 1 });
      if (!ok) return false;
    }
    if (!mayDelete) {
      this.shrinkCandidate = shrunk ? notes.length : null;
      this.fail(
        incomplete
          ? t("Vault-Scan unvollständig ({n} Lesefehler) — nichts gelöscht", { n: this.scanner.lastScanErrors })
          : t("Vault von {from} auf {to} Notizen geschrumpft — zweiter Scan bestätigt", { from: this.confirmedCount, to: notes.length }),
      );
      return false;
    }
    this.shrinkCandidate = null;
    this.confirmedCount = notes.length;
    this.lastSyncId = syncId;
    this.status.notes = notes.length;
    this.log("vault-abgleich", { notizen: notes.length, teile: parts.length });
    return true;
  }

  private async deltaSync(): Promise<boolean> {
    const paths = [...this.pending];
    this.pending.clear();
    const upserts: VaultNote[] = [];
    const deleted: string[] = [];
    let readErrors = 0;
    for (const rel of paths) {
      const r = await this.scanner.read(rel);
      if (r.kind === "note") upserts.push(r.note);
      else if (r.kind === "gone") deleted.push(rel);
      else readErrors++; // Lesefehler: nicht als gelöscht melden (W2) — unten Backoff + Vollabgleich
    }
    const syncId = this.lastSyncId ?? randomUUID();
    for (let i = 0; i < Math.max(1, Math.ceil(upserts.length / this.chunkSize)); i++) {
      if (this.stopped) return false;
      const ok = await this.send({
        root: this.cfg.vaultDir,
        syncId,
        mode: "delta",
        notes: upserts.slice(i * this.chunkSize, (i + 1) * this.chunkSize),
        deleted: i === 0 ? deleted : [],
        done: true,
      });
      if (!ok) return false;
    }
    if (readErrors > 0) {
      this.fail(t("{n} Notiz(en) nicht lesbar — nichts gelöscht, später Vollabgleich", { n: readErrors }));
      return false;
    }
    this.status.notes = this.scanner.size;
    return true;
  }

  private async send(body: VaultIngest): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.serverUrl}/ingest/vault`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      this.fail(t("Netz: {error}", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.fail(`HTTP ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    await res.body?.cancel().catch(() => {});
    this.status.lastOkAt = Date.now();
    this.status.lastError = null;
    this.backoff = this.minBackoffMs;
    return true;
  }

  private fail(reason: string): void {
    this.status.lastError = reason;
    this.needFull = true; // nach jedem Fehler: kompletter Neuabgleich
    this.log("vault-fehler", { reason, retryMs: this.backoff });
    if (this.stopped) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.kick();
      }, this.backoff);
      this.retryTimer.unref?.();
    }
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }
}
