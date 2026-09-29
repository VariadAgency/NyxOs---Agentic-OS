import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { ARCHIVE_HEADERS, type Tool } from "@nyxos/shared";
import type { BridgeConfig } from "./config.js";
import type { Outbox } from "./outbox.js";
import { archiveRelPath, type Log } from "./tracker.js";
import { yieldNow } from "./yield.js";

const gz = promisify(gzip);
const QUIET_MS = 3000;
const MAX_WAIT_MS = 30_000;
/**
 * Drosselung. Gemessen: Die Haupt-Verlaufsdatei (16 MB, gzip 6,7 MB) ging bei laufender
 * Session alle 30 s komplett hoch, dazu 3–9 MB je Subagent — alles über dieselbe Verbindung wie der
 * Brücken-Kanal. Große Dateien jetzt höchstens alle 2 min, und nach jedem Upload eine Pause gemäß Größe
 * (im Schnitt höchstens `UPLOAD_BYTES_PER_S`).
 */
export const BIG_FILE_BYTES = 4 * 1024 * 1024;
export const BIG_FILE_MAX_WAIT_MS = 120_000;
export const UPLOAD_BYTES_PER_S = 2 * 1024 * 1024;
const MAX_PACE_MS = 10_000;
/** Solange der Kanal auf ein Lebenszeichen wartet, haben Pings Vorrang: Upload so lange zurückstellen. */
const HOLD_STEP_MS = 500;
const HOLD_MAX_MS = 30_000;
/** Prüfsumme in Stücken, dazwischen darf die Ereignisschleife kurz dran. */
const HASH_CHUNK = 1024 * 1024;

export interface ArchiverOptions {
  /** true = gerade nicht hochladen (z. B. Brücken-Kanal wartet auf ein Lebenszeichen). */
  holdWhile?: () => boolean;
  bytesPerSecond?: number;
}

async function sha256Sliced(buf: Buffer): Promise<string> {
  const h = createHash("sha256");
  for (let i = 0; i < buf.length; i += HASH_CHUNK) {
    h.update(buf.subarray(i, i + HASH_CHUNK));
    if (i + HASH_CHUNK < buf.length) await yieldNow();
  }
  return h.digest("hex");
}

interface Job {
  tool: Tool;
  sessionId: string;
  timer: NodeJS.Timeout | null;
  firstAt: number;
}

/**
 * Lädt jede Verlaufsdatei nach Änderung (entprellt) als gzip samt SHA-256 hoch.
 * Was fehlschlägt, bleibt als „nicht archiviert" in der Dateitabelle stehen und
 * wird beim nächsten Durchlauf erneut versucht – offline geht nichts verloren.
 */
export class Archiver {
  private readonly jobs = new Map<string, Job>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Zuletzt gelesene Größe je Datei — entscheidet über die längere Wartezeit großer Dateien. */
  private readonly sizes = new Map<string, number>();
  private pace: { timer: NodeJS.Timeout; done: () => void } | null = null;
  lastError: string | null = null;
  uploads = 0;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly outbox: Outbox,
    private readonly isAllowed: (tool: Tool, sessionId: string) => boolean | null,
    private readonly log: Log,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly quietMs = QUIET_MS,
    private readonly opts: ArchiverOptions = {},
  ) {}

  schedule(path: string, tool: Tool, sessionId: string): void {
    if (this.stopped) return;
    const now = Date.now();
    const job = this.jobs.get(path) ?? { tool, sessionId, timer: null, firstAt: now };
    if (job.timer) clearTimeout(job.timer);
    // Große Dateien: erst nach 30 s Ruhe, bei Dauerschreiben spätestens nach 2 min (statt 3 s / 30 s).
    const big = (this.sizes.get(path) ?? 0) >= BIG_FILE_BYTES;
    const maxWait = big ? BIG_FILE_MAX_WAIT_MS : MAX_WAIT_MS;
    const quiet = big ? MAX_WAIT_MS : this.quietMs;
    const wait = Math.max(0, Math.min(quiet, job.firstAt + maxWait - now));
    job.timer = setTimeout(() => {
      this.jobs.delete(path);
      this.chain = this.chain.then(() => this.upload(path, tool, sessionId)).catch(() => {});
    }, wait);
    this.jobs.set(path, job);
  }

  /** Plant alle Dateien ein, deren Stand vom zuletzt archivierten abweicht. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const f of this.outbox.files()) {
      if (f.ignored || this.jobs.has(f.path)) continue;
      const st = await stat(f.path).catch(() => null);
      if (!st) continue;
      if (f.archived_size === st.size && f.archived_mtime === Math.floor(st.mtimeMs)) continue;
      this.schedule(f.path, f.tool as Tool, f.session_id);
      n++;
    }
    return n;
  }

  /** Wartet, bis alle eingeplanten Uploads gelaufen sind (für Nachimport und Tests). */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await new Promise((r) => setTimeout(r, 100));
    await this.chain;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const j of this.jobs.values()) if (j.timer) clearTimeout(j.timer);
    this.jobs.clear();
    if (this.pace) {
      clearTimeout(this.pace.timer);
      this.pace.done();
    }
    await this.chain;
  }

  /** Pause, die `stop()` sofort beenden kann. */
  private sleep(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.pace = null;
        resolve();
      };
      this.pace = { timer: setTimeout(done, ms), done };
    });
  }

  private async upload(path: string, tool: Tool, sessionId: string): Promise<void> {
    if (this.stopped) return;
    const allowed = this.isAllowed(tool, sessionId);
    if (allowed === false) return;
    if (allowed === null) {
      this.schedule(path, tool, sessionId);
      return;
    }
    // Pings haben Vorrang: wartet der Brücken-Kanal gerade auf ein Lebenszeichen, erst einmal nicht senden.
    for (let held = 0; this.opts.holdWhile?.() && held < HOLD_MAX_MS && !this.stopped; held += HOLD_STEP_MS) await this.sleep(HOLD_STEP_MS);
    if (this.stopped) return;
    const before = await stat(path).catch(() => null);
    if (!before) return;
    const raw = await readFile(path);
    this.sizes.set(path, raw.length);
    const sha = await sha256Sliced(raw);
    const row = this.outbox.file(path);
    const mtime = Math.floor(before.mtimeMs);
    if (row?.archived_sha === sha) {
      this.outbox.setArchived(path, sha, raw.length, mtime);
      return;
    }
    const body = await gz(raw);
    const rel = archiveRelPath(path, tool, this.cfg);
    try {
      const res = await this.fetchImpl(`${this.cfg.serverUrl}/ingest/archive`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/gzip",
          [ARCHIVE_HEADERS.tool]: tool,
          [ARCHIVE_HEADERS.sessionId]: sessionId,
          [ARCHIVE_HEADERS.path]: encodeURIComponent(rel),
          [ARCHIVE_HEADERS.sha256]: sha,
          [ARCHIVE_HEADERS.size]: String(raw.length),
        },
        body,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      if (this.stopped) return;
      // Nur als archiviert markieren, was wirklich hochgeladen wurde (Größe der gelesenen Fassung).
      this.outbox.setArchived(path, sha, raw.length, raw.length === before.size ? mtime : 0);
      this.uploads++;
      this.lastError = null;
      // Drosselung: im Schnitt höchstens `bytesPerSecond` für Archiv-Uploads.
      await this.sleep(Math.min(MAX_PACE_MS, (body.length / (this.opts.bytesPerSecond ?? UPLOAD_BYTES_PER_S)) * 1000));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log("archiv-fehlgeschlagen", { rel, error: this.lastError });
    }
  }
}
