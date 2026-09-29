import type { Outbox } from "./outbox.js";
import type { Log } from "./tracker.js";

export const BATCH = 500;
/** Zwischen zwei vollen Paketen (Rückstand nach Neustart/Offline) kurz Luft lassen — für Pong,
 * Tunnel-Prüfung und Terminal, und damit der Rückstand die SSH-Verbindung nicht am Stück belegt. */
export const BACKLOG_PAUSE_MS = 50;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export interface SenderOptions {
  outbox: Outbox;
  serverUrl: string;
  token: string;
  log: Log;
  fetchImpl?: typeof fetch;
  /** Für Tests: Backoff-Grenzen verkürzen. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Leert den Puffer der Reihe nach. Ein Eintrag wird erst gelöscht, wenn der
 * Server ihn bestätigt hat. Netzwerkfehler → Wiederholung mit wachsendem Abstand.
 */
export class Sender {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private current: Promise<boolean> = Promise.resolve(true);
  private stopped = false;
  private backoff: number;
  lastOkAt: number | null = null;
  lastError: string | null = null;

  constructor(private readonly o: SenderOptions) {
    this.backoff = o.minBackoffMs ?? MIN_BACKOFF_MS;
  }

  /** Neue Einträge: bald senden (kurz sammeln, dann los). */
  nudge(delayMs = 20): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
  }

  /** Hält an und wartet, bis ein laufender Versand abgeschlossen ist. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Sendet, bis der Puffer leer ist oder ein Fehler auftritt. Liefert true, wenn leer. */
  drain(): Promise<boolean> {
    if (this.running || this.stopped) return Promise.resolve(false);
    this.running = true;
    this.current = this.drainLoop();
    return this.current;
  }

  private async drainLoop(): Promise<boolean> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    try {
      for (;;) {
        const rows = this.o.outbox.peek(BATCH);
        if (rows.length === 0) {
          this.backoff = this.o.minBackoffMs ?? MIN_BACKOFF_MS;
          return true;
        }
        let res: Response;
        try {
          res = await fetchImpl(`${this.o.serverUrl}/ingest/events`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
            body: JSON.stringify({ items: rows.map((r) => r.item) }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (e) {
          this.fail(`Netz: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
        if (res.ok) {
          if (this.stopped) return false; // Server hat es, beim nächsten Start dedupliziert er
          this.o.outbox.ack(rows.map((r) => r.seq));
          this.lastOkAt = Date.now();
          this.lastError = null;
          this.backoff = this.o.minBackoffMs ?? MIN_BACKOFF_MS;
          if (rows.length === BATCH) await new Promise((r) => setTimeout(r, BACKLOG_PAUSE_MS));
          continue;
        }
        const text = await res.text().catch(() => "");
        if (res.status === 400) {
          // Der Server lehnt den Inhalt ab: einzeln prüfen, nur die schlechten beiseitelegen.
          await this.isolate(rows, fetchImpl);
          continue;
        }
        this.fail(`HTTP ${res.status} ${text.slice(0, 200)}`);
        return false;
      }
    } finally {
      this.running = false;
    }
  }

  private async isolate(rows: ReturnType<Outbox["peek"]>, fetchImpl: typeof fetch): Promise<void> {
    for (const row of rows) {
      const res = await fetchImpl(`${this.o.serverUrl}/ingest/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify({ items: [row.item] }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (!res) return; // Netz weg: später weiter
      if (res.ok) this.o.outbox.ack([row.seq]);
      else if (res.status === 400) {
        const why = await res.text().catch(() => "");
        this.o.outbox.bury([row], why.slice(0, 500));
        this.o.log("abgelehnt", { seq: row.seq, why: why.slice(0, 200) });
      } else return;
    }
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.o.log("senden-fehlgeschlagen", { reason, retryMs: this.backoff, queued: this.o.outbox.size() });
    if (!this.stopped && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.drain();
      }, this.backoff);
    }
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? MAX_BACKOFF_MS);
  }
}
