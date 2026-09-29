// The last few server errors (for "Diagnose anhängen" in a bug report). Fed from the server's own `log()` calls:
// every event named `error` or ending in `-fehler`/`-error`. Stored raw in memory only (never in the database) and
// cleaned when the diagnostics are read (support.ts: no paths, hosts, tokens, e-mail addresses).
import { SUPPORT_LIMITS, type SupportErrorEntry } from "@nyxos/shared";

const ERROR_EVENT = /^(?:error|fehler)$|[-_](?:fehler|error|failed)$/i;
const DETAIL_KEYS = ["message", "error", "reason", "detail"] as const;

export class RecentErrors {
  private readonly entries: SupportErrorEntry[] = [];

  constructor(
    private readonly max: number = SUPPORT_LIMITS.errors,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called for every log line — must be cheap and never throw. */
  note(event: string, extra?: Record<string, unknown>): void {
    try {
      if (!ERROR_EVENT.test(event)) return;
      const detail = DETAIL_KEYS.map((k) => extra?.[k]).find((v) => typeof v === "string" && v.trim() !== "");
      const message = `${event}${typeof detail === "string" ? `: ${detail}` : ""}`.slice(0, 1000);
      this.entries.push({ source: "server", at: new Date(this.now()).toISOString(), message });
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    } catch {
      // never disturb logging
    }
  }

  list(): SupportErrorEntry[] {
    return [...this.entries];
  }
}
