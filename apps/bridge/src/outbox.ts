import type { IngestItem } from "@nyxos/shared";
import type { SqlDb } from "./sqlite.js";

export interface FileRow {
  path: string;
  tool: string;
  session_id: string;
  emitted_offset: number;
  ignored: number;
  archived_sha: string | null;
  archived_size: number | null;
  archived_mtime: number | null;
}

/**
 * Lokaler Puffer: alles, was zum Server soll, landet zuerst hier.
 * Events werden über ihre ID dedupliziert, Zusammenfassung und Status je
 * Session nur in der neuesten Fassung gehalten.
 */
export class Outbox {
  constructor(readonly db: SqlDb) {
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      item TEXT NOT NULL,
      created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      emitted_offset INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      archived_sha TEXT,
      archived_size INTEGER,
      archived_mtime INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS states (session_key TEXT PRIMARY KEY, running INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS dead (seq INTEGER PRIMARY KEY, item TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  }

  private keyOf(item: IngestItem): { key: string; replace: boolean } {
    if (item.type === "event") return { key: `event:${item.event.id}`, replace: false };
    if (item.type === "summary") return { key: `summary:${item.summary.tool}:${item.summary.sessionId}`, replace: true };
    if (item.type === "terminal") return { key: `terminal:${item.terminal.tool}:${item.terminal.sessionId}`, replace: true };
    return { key: `state:${item.state.tool}:${item.state.sessionId}`, replace: true };
  }

  enqueue(items: IngestItem[]): number {
    let added = 0;
    this.db.transaction(() => {
      for (const item of items) {
        const { key, replace } = this.keyOf(item);
        const verb = replace ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
        added += this.db.run(`${verb} INTO outbox (key, item, created_at) VALUES (?, ?, ?)`, key, JSON.stringify(item), Date.now()).changes;
      }
    });
    return added;
  }

  peek(limit: number): { seq: number; item: IngestItem }[] {
    return this.db
      .all<{ seq: number; item: string }>("SELECT seq, item FROM outbox ORDER BY seq LIMIT ?", limit)
      .map((r) => ({ seq: r.seq, item: JSON.parse(r.item) as IngestItem }));
  }

  ack(seqs: number[]): void {
    this.db.transaction(() => {
      for (const s of seqs) this.db.run("DELETE FROM outbox WHERE seq = ?", s);
    });
  }

  /** Vom Server abgelehnte Einträge beiseitelegen, damit sie die Warteschlange nicht blockieren. */
  bury(rows: { seq: number; item: IngestItem }[], error: string): void {
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run("INSERT OR REPLACE INTO dead (seq, item, error, at) VALUES (?, ?, ?, ?)", r.seq, JSON.stringify(r.item), error, Date.now());
        this.db.run("DELETE FROM outbox WHERE seq = ?", r.seq);
      }
    });
  }

  size(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n ?? 0;
  }

  deadCount(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM dead")?.n ?? 0;
  }

  file(path: string): FileRow | undefined {
    return this.db.get<FileRow>("SELECT * FROM files WHERE path = ?", path);
  }

  upsertFile(path: string, tool: string, sessionId: string): void {
    this.db.run("INSERT OR IGNORE INTO files (path, tool, session_id) VALUES (?, ?, ?)", path, tool, sessionId);
  }

  setEmittedOffset(path: string, offset: number): void {
    this.db.run("UPDATE files SET emitted_offset = ? WHERE path = ?", offset, path);
  }

  setIgnored(path: string): void {
    this.db.run("UPDATE files SET ignored = 1 WHERE path = ?", path);
  }

  setArchived(path: string, sha: string, size: number, mtime: number): void {
    this.db.run("UPDATE files SET archived_sha = ?, archived_size = ?, archived_mtime = ? WHERE path = ?", sha, size, mtime, path);
  }

  files(): FileRow[] {
    return this.db.all<FileRow>("SELECT * FROM files");
  }

  lastState(sessionKey: string): boolean | undefined {
    const r = this.db.get<{ running: number }>("SELECT running FROM states WHERE session_key = ?", sessionKey);
    return r === undefined ? undefined : r.running === 1;
  }

  setState(sessionKey: string, running: boolean): void {
    this.db.run("INSERT OR REPLACE INTO states (session_key, running) VALUES (?, ?)", sessionKey, running ? 1 : 0);
  }

  getMeta(k: string): string | undefined {
    return this.db.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v;
  }

  setMeta(k: string, v: string): void {
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
  }
}
