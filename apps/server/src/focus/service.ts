// Focus button: the stored focus ("auto" / "away" / "dnd") with an end. The notification pipeline and the away service
// ask synchronously for every notification (`mode()`), hence a cache that is refreshed at start, on every change and in
// the minute tick (`tick`). Expired → back to auto (stored and announced live to all open windows).
import { DEFAULT_FOCUS_STATE, effectiveFocus, FocusModeSchema, FocusSetBySchema, focusUntilFor, t, type FocusLiveMessage, type FocusMode, type FocusPut, type FocusSetBy, type FocusState } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { focusState } from "../db/schema.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface FocusServiceDeps {
  db: Db;
  now?: () => number;
  broadcast?: (msg: FocusLiveMessage) => void;
  log?: Log;
}

export class FocusError extends Error {}

function iso(v: string | null): string | null {
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export class FocusService {
  private state: FocusState = DEFAULT_FOCUS_STATE;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly d: FocusServiceDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
  }

  /** Last known state with expiry applied (synchronous – for the pipeline and the away service). */
  current(): FocusState {
    return effectiveFocus(this.state, new Date(this.now()));
  }

  mode(): FocusMode {
    return this.current().mode;
  }

  async load(): Promise<FocusState> {
    const [row] = await this.d.db.select().from(focusState).where(eq(focusState.id, 1)).limit(1);
    const mode = FocusModeSchema.safeParse(row?.mode);
    const setBy = FocusSetBySchema.safeParse(row?.setBy);
    this.state = row && mode.success ? { mode: mode.data, until: iso(row.until), since: iso(row.since), setBy: setBy.success ? setBy.data : null } : DEFAULT_FOCUS_STATE;
    return this.current();
  }

  /** Sets the focus (menu, settings or Nyx). Throws `FocusError` when the end is not in the future. */
  async set(put: FocusPut, setBy: FocusSetBy): Promise<FocusState> {
    const now = new Date(this.now());
    let until: string | null = null;
    if (put.mode !== "auto") {
      if (put.until) {
        const end = Date.parse(put.until);
        if (Number.isNaN(end) || end <= now.getTime()) throw new FocusError(t("Das Ende muss in der Zukunft liegen."));
        until = new Date(end).toISOString();
      } else {
        // Without an explicit end (Nyx, API): the duration in the user's time zone (`timeZone()` – settings or system).
        until = focusUntilFor(put.duration ?? "manual", now);
      }
    }
    const next: FocusState = put.mode === "auto" ? { mode: "auto", until: null, since: now.toISOString(), setBy } : { mode: put.mode, until, since: now.toISOString(), setBy };
    await this.save(next);
    this.log("fokus-gesetzt", { modus: next.mode, bis: next.until, von: setBy });
    return this.current();
  }

  /** Minute tick: expired focus → store auto and announce it. `true` = reset. */
  async tick(): Promise<boolean> {
    await this.load();
    if (this.state.mode === "auto" || this.current().mode !== "auto") return false;
    const ended = this.state.mode;
    await this.save({ mode: "auto", until: null, since: new Date(this.now()).toISOString(), setBy: "expiry" });
    this.log("fokus-abgelaufen", { modus: ended });
    return true;
  }

  private async save(next: FocusState): Promise<void> {
    const row = { mode: next.mode, until: next.until, since: next.since, setBy: next.setBy };
    await this.d.db
      .insert(focusState)
      .values({ id: 1, ...row })
      .onConflictDoUpdate({ target: focusState.id, set: { ...row, updatedAt: sql`now()` } });
    this.state = next;
    this.d.broadcast?.({ type: "focus", state: next });
  }
}
