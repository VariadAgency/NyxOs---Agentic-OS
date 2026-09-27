// Dünne Schicht über `node:sqlite` (synchrone prepare/run/get/all-API); nur Positions-Parameter (?) verwenden.

export type SqlParam = string | number | bigint | null;

export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): { changes: number };
  get<T>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T>(sql: string, ...params: SqlParam[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface Stmt {
  run(...p: SqlParam[]): { changes: number | bigint };
  get(...p: SqlParam[]): unknown;
  all(...p: SqlParam[]): unknown[];
}
interface RawDb {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

type DatabaseSyncCtor = new (path: string) => RawDb;
let ctor: Promise<DatabaseSyncCtor> | null = null;

/**
 * `node:sqlite` meldet beim Laden einmal „ExperimentalWarning: SQLite is an experimental feature“. Die Brücke
 * nutzt nur die stabile Grundfunktion; genau diese eine Warnung wird beim Laden unterdrückt, alle anderen bleiben.
 */
function loadSqlite(): Promise<DatabaseSyncCtor> {
  ctor ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
      const text = typeof warning === "string" ? warning : warning.message;
      if (/SQLite is an experimental feature/i.test(text)) return;
      return (original as (...a: unknown[]) => void).call(this, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      const mod = await import("node:sqlite");
      return mod.DatabaseSync as unknown as DatabaseSyncCtor;
    } finally {
      process.emitWarning = original;
    }
  })();
  return ctor;
}

export async function openDb(path: string): Promise<SqlDb> {
  const DatabaseSync = await loadSqlite();
  const raw = new DatabaseSync(path);
  const cache = new Map<string, Stmt>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  const db: SqlDb = {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...p) => ({ changes: Number(stmt(sql).run(...p).changes) }),
    get: <T>(sql: string, ...p: SqlParam[]) => (stmt(sql).get(...p) ?? undefined) as T | undefined,
    all: <T>(sql: string, ...p: SqlParam[]) => stmt(sql).all(...p) as T[],
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
