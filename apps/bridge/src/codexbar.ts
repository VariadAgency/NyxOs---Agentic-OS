// Echte Claude-Limits aus CodexBar (Mac-App, MIT, steipete). Der OAuth-Weg aus dem Agent-Container scheitert
// live mit 403 (das `setup-token` darf die Nutzung nicht lesen); CodexBar liest die echten Werte und schreibt sie
// bei jeder Aktualisierung (≈ jede Minute) neu nach `history/claude.json`.
//
// Nur LESEN, nur diese eine Datei: keine anderen CodexBar-Dateien (nie `codex-account-snapshots.json`), keine
// Cookies, keine Keychain, keine Rechte-Dialoge. Weitergegeben werden nur Zahlen (Prozent, Reset, Messzeitpunkt),
// nie Konto-Schlüssel. Datei fehlt → still. Unlesbar → EIN Log ohne Inhalt je Dateistand.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { USAGE_READINGS_MAX_POINTS, type UsageReadingWindow, type UsageReadingsMsg } from "@nyxos/shared";

export const CODEXBAR_CLAUDE_HISTORY = join(homedir(), "Library", "Application Support", "com.steipete.codexbar", "history", "claude.json");
/** Prüftakt; gelesen wird nur, wenn sich die Schreibzeit geändert hat. */
export const CODEXBAR_POLL_MS = 60_000;
/** Das bevorzugte Konto gilt als „aktuell“, solange sein jüngster Punkt höchstens so weit hinter dem jüngsten aller Konten liegt. */
const PREFERRED_MAX_LAG_MS = 60 * 60_000;
/** Größere Dateien sind sicher keine CodexBar-Historie (echt ≈ 240 KB). */
const MAX_BYTES = 8 * 1024 * 1024;

type Log = (msg: string, extra?: Record<string, unknown>) => void;

interface Entry {
  at: number;
  pct: number;
  resetsAt: string | null;
}

const WINDOW_OF: Record<string, "fiveHour" | "sevenDay" | "sevenDayOpus" | "sevenDaySonnet"> = {
  session: "fiveHour",
  weekly: "sevenDay",
  opus: "sevenDayOpus",
  sonnet: "sevenDaySonnet",
};

function isoMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Nur vollständige Einträge (gültige Zeit, Prozent als Zahl); ältester zuerst. */
function entriesOf(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as { capturedAt?: unknown; resetsAt?: unknown; usedPercent?: unknown };
    const at = isoMs(r.capturedAt);
    if (at === null || typeof r.usedPercent !== "number" || !Number.isFinite(r.usedPercent)) continue;
    const reset = isoMs(r.resetsAt);
    out.push({ at, pct: r.usedPercent, resetsAt: reset === null ? null : new Date(reset).toISOString() });
  }
  return out.sort((a, b) => a.at - b.at);
}

const toWindow = (e: Entry): UsageReadingWindow => ({ utilization: e.pct, resets_at: e.resetsAt, fetchedAt: new Date(e.at).toISOString() });

type Account = Map<string, Entry[]>;

function accountOf(raw: unknown): Account | null {
  if (!Array.isArray(raw)) return null;
  const acct: Account = new Map();
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const { name, entries } = w as { name?: unknown; entries?: unknown };
    if (typeof name !== "string" || !(name in WINDOW_OF)) continue;
    const list = entriesOf(entries);
    if (list.length > 0) acct.set(name, list);
  }
  return acct.size > 0 ? acct : null;
}

const newestOf = (a: Account): number => Math.max(...[...a.values()].map((l) => l[l.length - 1]?.at ?? 0));

/**
 * Rein: Inhalt von `history/claude.json` → Bericht für den Server. `null`, wenn die Datei unlesbar ist oder kein
 * Konto einen Sitzungs- oder Wochenwert hat. Konto: `preferredAccountKey`, wenn vorhanden und aktuell, sonst das
 * mit dem jüngsten Messpunkt.
 */
export function parseCodexBarHistory(text: string): UsageReadingsMsg | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { accounts, preferredAccountKey } = data as { accounts?: unknown; preferredAccountKey?: unknown };
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  const all: { key: string; acct: Account; newest: number }[] = [];
  for (const [key, raw] of Object.entries(accounts as Record<string, unknown>)) {
    const acct = accountOf(raw);
    if (acct && (acct.has("session") || acct.has("weekly"))) all.push({ key, acct, newest: newestOf(acct) });
  }
  if (all.length === 0) return null;
  const newest = all.reduce((a, b) => (b.newest > a.newest ? b : a));
  const preferred = typeof preferredAccountKey === "string" ? all.find((a) => a.key === preferredAccountKey) : undefined;
  const pick = preferred && newest.newest - preferred.newest <= PREFERRED_MAX_LAG_MS ? preferred : newest;
  const latest = (name: string): UsageReadingWindow | null => {
    const list = pick.acct.get(name);
    const last = list?.[list.length - 1];
    return last ? toWindow(last) : null;
  };
  return {
    op: "usage_readings",
    source: "codexbar",
    tool: "claude",
    fiveHour: latest("session"),
    sevenDay: latest("weekly"),
    sevenDayOpus: latest("opus"),
    sevenDaySonnet: latest("sonnet"),
    sessionHistory: (pick.acct.get("session") ?? []).slice(-USAGE_READINGS_MAX_POINTS).map(toWindow),
  };
}

export type CodexBarTick = "missing" | "unchanged" | "error" | "sent" | "pending";

/**
 * Takt-Leser: prüft die Schreibzeit, liest nur bei Änderung, schickt den Bericht über `send` (liefert `false`,
 * wenn der Kanal gerade zu ist → der Bericht bleibt liegen und geht beim nächsten Takt raus).
 */
export class CodexBarReader {
  private lastMtimeMs: number | null = null;
  private pending: UsageReadingsMsg | null = null;

  constructor(private readonly o: { path?: string; send: (m: UsageReadingsMsg) => boolean; log: Log }) {}

  async tick(): Promise<CodexBarTick> {
    const path = this.o.path ?? CODEXBAR_CLAUDE_HISTORY;
    let st;
    try {
      st = await stat(path);
    } catch {
      this.lastMtimeMs = null;
      return this.flush() ?? "missing";
    }
    if (st.mtimeMs === this.lastMtimeMs) return this.flush() ?? "unchanged";
    this.lastMtimeMs = st.mtimeMs;
    let msg: UsageReadingsMsg | null = null;
    try {
      if (st.size <= MAX_BYTES) msg = parseCodexBarHistory(await readFile(path, "utf8"));
    } catch {
      msg = null;
    }
    if (!msg) {
      // Nur die Art, nie Inhalt oder Pfad-Details.
      this.o.log("codexbar-unlesbar", { bytes: st.size });
      return this.flush() ?? "error";
    }
    this.pending = msg;
    return this.flush() ?? "sent";
  }

  /** Liegenden Bericht senden. `undefined` = nichts lag an. */
  private flush(): "sent" | "pending" | undefined {
    if (!this.pending) return undefined;
    let ok: boolean;
    try {
      ok = this.o.send(this.pending);
    } catch {
      ok = false;
    }
    if (!ok) return "pending";
    this.pending = null;
    return "sent";
  }

  /** Sofort einmal, dann alle `ms`. Liefert eine Stopp-Funktion. Fehler still. */
  start(ms = CODEXBAR_POLL_MS): () => void {
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      void this.tick()
        .catch(() => undefined)
        .finally(() => (busy = false));
    };
    run();
    const t = setInterval(run, ms);
    t.unref?.();
    return () => clearInterval(t);
  }
}
