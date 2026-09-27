/**
 * Work the server starts without waiting for it ("fire and forget"): the context guard and the delivery
 * queue after an ingest, the Telegram reply, the digest of a new archive, the price seed at start.
 *
 * The request answers right away, but the database work keeps running. `idle()` waits until all of it is
 * done, so whoever closes the database (tests after each file, a clean shutdown) never closes it under a
 * running query. That matters for PGlite (the in-memory Postgres of the tests): closing it mid-query does
 * not throw, it spins forever and blocks the whole process.
 */
export class BackgroundTasks {
  private readonly running = new Set<Promise<unknown>>();

  /** Tracks `task`. Errors must be handled by the caller (`.catch(...)`); here they are only swallowed so
   * an unhandled rejection never escapes from the bookkeeping. */
  run(task: Promise<unknown>): void {
    const tracked = task.catch(() => {}).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /** Number of tasks still running. */
  get size(): number {
    return this.running.size;
  }

  /** Resolves once no task is running any more — including tasks that were started while waiting. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}
