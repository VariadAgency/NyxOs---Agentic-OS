// Ist die Brücke da? Eine Quelle für die Statuszeile, gerechnet mit der Server-Uhr.
//
// Die Web-App rechnete „online" selbst aus `machines.last_seen_at` (< 60 s, Browser-Uhr).
// Diese Spalte wurde aber nur bei HTTP-Ingest-Aufrufen frisch — nie über den dauerhaft offenen Kanal
// `WS /bridge`. In ruhigen Minuten (keine Session schreibt, kein Nutzungs-/Bestands-Takt) sprang die
// Anzeige deshalb auf rot, obwohl der Kanal ununterbrochen offen war (Server-Log 25.09.: verbunden um
// 08:34:26, kein „getrennt"; Ingest-Lücken von 2:35 und 7:51 min).
//
// Neu:
// - Lebenszeichen = Pong auf einen Server-Ping alle 15 s (jeder WebSocket-Client antwortet selbst, auch
//   die schon installierte Brücke) oder jede Nachricht der Brücke.
// - Kurze Aussetzer bis 90 s (Tunnel-Neuaufbau, Server-Neustart) heißen „verbindet neu …", nicht rot.
// - Echte Ausfälle tragen Grund und Beginn („Tunnel zu", „Dienst gestoppt", „Rechner schläft oder ist offline").
// - Jeder Wechsel landet in `bridge_events` (Verlauf im Status-Popover).
import { asc, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bridgeEvents, machines } from "../db/schema.js";
import { t } from "@nyxos/shared";

/** Server pingt den Brücken-Kanal in diesem Takt. */
export const PING_EVERY_MS = 15_000;
/** Drei Pings ohne Antwort: „verbindet neu …" (noch nicht rot). */
export const HEARTBEAT_LATE_MS = 45_000;
/** Bis hierher gilt ein Aussetzer als kurz. Danach: rot mit Grund. */
export const GRACE_MS = 90_000;
/** `machines.last_seen_at` höchstens so oft schreiben (für `/api/machines` und `cli list-machines`). */
const LAST_SEEN_WRITE_MS = 30_000;
/** Takt, in dem Wechsel erkannt und protokolliert werden (auch ohne neues Ereignis, z. B. Ablauf der 90 s). */
export const TICK_MS = 5_000;
/** Verlauf so lange aufheben (die Web-App zeigt 24 h, die Schnittstelle höchstens 7 Tage). */
export const KEEP_EVENTS_MS = 30 * 86_400_000;
/** Aufräumen höchstens so oft (eine Lösch-Abfrage pro Stunde statt pro Takt). */
const PRUNE_EVERY_MS = 3_600_000;

export type PresenceState = "online" | "reconnecting" | "offline";
/** Wie der Kanal zuletzt zuging. */
export type CloseKind = "stopped" | "tunnel" | "silent";

export const REASONS = {
  late: "Rechner antwortet gerade nicht",
  reconnect: "Verbindung wird neu aufgebaut",
  serverRestart: "Server neu gestartet, Rechner verbindet sich",
  stopped: "Dienst gestoppt",
  tunnel: "Tunnel zu",
  silent: "Rechner schläft oder ist offline",
  never: "Rechner schläft oder ist offline",
} as const;

export interface PresenceFacts {
  channelOpen: boolean;
  openSince: number | null;
  lastHeartbeatAt: number | null;
  closedAt: number | null;
  closeKind: CloseKind | null;
  /** Start dieses Server-Prozesses (Anker, falls die Brücke seitdem nie verbunden war). */
  startedAt: number;
}

export interface PresenceView {
  state: PresenceState;
  reason: string | null;
  /** Seit wann dieser Zustand gilt (Server-Uhr, ms). */
  since: number;
  heartbeatAgeMs: number | null;
  channelOpen: boolean;
}

/** Rein: Zustand aus Fakten und Server-Zeit. Die Browser-Uhr spielt keine Rolle mehr (kein Uhren-Versatz). */
export function computePresence(f: PresenceFacts, now: number): PresenceView {
  const heartbeatAgeMs = f.lastHeartbeatAt === null ? null : Math.max(0, now - f.lastHeartbeatAt);
  if (f.channelOpen) {
    const last = Math.max(f.lastHeartbeatAt ?? 0, f.openSince ?? 0);
    const age = now - last;
    if (age < HEARTBEAT_LATE_MS) return { state: "online", reason: null, since: f.openSince ?? last, heartbeatAgeMs, channelOpen: true };
    if (age < GRACE_MS) return { state: "reconnecting", reason: t(REASONS.late), since: last, heartbeatAgeMs, channelOpen: true };
    return { state: "offline", reason: t(REASONS.silent), since: last, heartbeatAgeMs, channelOpen: true };
  }
  const ref = f.closedAt ?? f.startedAt;
  if (now - ref < GRACE_MS) {
    return { state: "reconnecting", reason: t(f.closedAt === null ? REASONS.serverRestart : REASONS.reconnect), since: ref, heartbeatAgeMs, channelOpen: false };
  }
  return { state: "offline", reason: t(f.closeKind ? REASONS[f.closeKind] : REASONS.never), since: ref, heartbeatAgeMs, channelOpen: false };
}

/** WebSocket-Schließcode → Grund. Die Brücke schließt beim Beenden sauber (1000, ältere: ohne Code = 1005);
 * bricht der Tunnel oder die Leitung, kommt kein Schließ-Rahmen an (1006). */
export function classifyClose(code: number | undefined): CloseKind {
  return code === 1000 || code === 1001 || code === 1005 ? "stopped" : "tunnel";
}

/** Der Teil des `ws`-Sockets (roh, von @hono/node-ws), den wir brauchen. */
export interface PingableSocket {
  ping(): void;
  on(event: "pong", fn: () => void): void;
  terminate(): void;
}

/**
 * Pingt einen Kanal und merkt Pongs. Schweigt die Gegenseite `GRACE_MS` lang (Rechner schläft, Leitung tot,
 * TCP hängt halb offen), wird der Socket hart getrennt — sonst hielte der Server ihn ewig für offen.
 */
export class HeartbeatWatch {
  constructor(
    private readonly raw: PingableSocket,
    private readonly o: { now: () => number; onBeat: () => void; onSilent: () => void; lastBeat: () => number | null },
  ) {
    raw.on("pong", () => o.onBeat());
  }

  tick(): void {
    const last = this.o.lastBeat();
    if (last !== null && this.o.now() - last >= GRACE_MS) {
      this.o.onSilent();
      try {
        this.raw.terminate();
      } catch {
        // schon zu
      }
      return;
    }
    try {
      this.raw.ping();
    } catch {
      // Socket schließt gerade — onClose folgt
    }
  }
}

export interface PresenceHistoryItem {
  at: string;
  state: PresenceState;
  reason: string | null;
  /** Bis zum nächsten Wechsel; `null` = läuft noch. */
  durationMs: number | null;
}

export interface BridgePresenceOptions {
  db: Db;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Hält die Fakten (im Speicher, Server-Uhr), schreibt Wechsel in `bridge_events`. */
export class BridgePresence {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private facts: PresenceFacts;
  private machineId: string | null = null;
  private lastSeenWrittenAt = 0;
  private pendingWrite: Promise<unknown> = Promise.resolve();
  private last: { id: number; state: PresenceState; reason: string | null; at: number } | null | undefined = undefined;
  private ticking: Promise<void> | null = null;
  private lastPruneAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(o: BridgePresenceOptions) {
    this.db = o.db;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.facts = { channelOpen: false, openSince: null, lastHeartbeatAt: null, closedAt: null, closeKind: null, startedAt: this.now() };
  }

  connected(machineId: string): void {
    const now = this.now();
    this.machineId = machineId;
    this.facts = { ...this.facts, channelOpen: true, openSince: now, lastHeartbeatAt: now };
    this.writeLastSeen(now, true);
    void this.tick();
  }

  heartbeat(): void {
    if (!this.facts.channelOpen) return;
    const now = this.now();
    const wasLate = now - Math.max(this.facts.lastHeartbeatAt ?? 0, this.facts.openSince ?? 0) >= HEARTBEAT_LATE_MS;
    this.facts.lastHeartbeatAt = now;
    this.writeLastSeen(now, false);
    if (wasLate) void this.tick(); // „verbindet neu" endet genau jetzt, nicht erst beim nächsten Takt
  }

  /** `silent`: der Server hat getrennt, weil 90 s kein Lebenszeichen kam — der Ausfall begann beim letzten. */
  disconnected(kind: CloseKind): void {
    const now = this.now();
    const closedAt = kind === "silent" ? (this.facts.lastHeartbeatAt ?? now) : now;
    this.facts = { ...this.facts, channelOpen: false, closedAt, closeKind: kind };
    void this.tick();
  }

  lastHeartbeatAt(): number | null {
    return this.facts.lastHeartbeatAt;
  }

  nowMs(): number {
    return this.now();
  }

  view(): PresenceView {
    return computePresence(this.facts, this.now());
  }

  get currentMachineId(): string | null {
    return this.machineId;
  }

  private writeLastSeen(now: number, force: boolean): void {
    if (!this.machineId || (!force && now - this.lastSeenWrittenAt < LAST_SEEN_WRITE_MS)) return;
    this.lastSeenWrittenAt = now;
    const id = this.machineId;
    this.pendingWrite = this.pendingWrite
      .then(() => this.db.update(machines).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(machines.id, id)))
      .catch((e: unknown) => this.log("bruecke-lastseen-fehler", { error: String(e) }));
  }

  /** Für Tests und das Herunterfahren: alle ausstehenden Schreibvorgänge abwarten. */
  async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.ticking) await this.ticking;
  }

  /** Erkennt Wechsel und schreibt sie. Läuft im Takt und direkt nach jedem Ereignis. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking.then(() => this.tick());
    this.ticking = this.doTick()
      .catch((e: unknown) => this.log("bruecke-verlauf-fehler", { error: String(e) }))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const now = this.now();
    if (this.lastPruneAt === null || now - this.lastPruneAt >= PRUNE_EVERY_MS) {
      this.lastPruneAt = now;
      await this.db.delete(bridgeEvents).where(lt(bridgeEvents.at, new Date(now - KEEP_EVENTS_MS).toISOString()));
    }
    const v = this.view();
    if (this.last === undefined) {
      const [row] = await this.db.select().from(bridgeEvents).orderBy(desc(bridgeEvents.at), desc(bridgeEvents.id)).limit(1);
      this.last = row ? { id: row.id, state: row.state as PresenceState, reason: row.reason, at: Date.parse(row.at) } : null;
    }
    const last = this.last;
    if (last && last.state === v.state && last.reason === v.reason) return;
    // Aus „verbindet neu" wurde ein echter Ausfall: dieselbe Zeile (Beginn bleibt), nur Zustand/Grund.
    if (last && last.state === "reconnecting" && v.state === "offline" && v.since <= last.at + GRACE_MS) {
      await this.db.update(bridgeEvents).set({ state: v.state, reason: v.reason }).where(eq(bridgeEvents.id, last.id));
      this.last = { ...last, state: v.state, reason: v.reason };
      this.log("bruecke-zustand", { state: v.state, reason: v.reason });
      return;
    }
    // Zurück zu „online" im selben (offenen) Kanal: `since` ist der Kanal-Beginn, der Wechsel ist jetzt.
    const at = v.state === "online" && last && v.since <= last.at ? this.now() : Math.max(v.since, last?.at ?? 0);
    const [row] = await this.db
      .insert(bridgeEvents)
      .values({ machineId: this.machineId, at: new Date(at).toISOString(), state: v.state, reason: v.reason })
      .returning({ id: bridgeEvents.id });
    if (row) this.last = { id: row.id, state: v.state, reason: v.reason, at };
    this.log("bruecke-zustand", { state: v.state, reason: v.reason });
  }

  /** Verlauf der letzten `hours` Stunden, älteste zuerst, mit Dauer bis zum nächsten Wechsel. */
  async history(hours: number): Promise<PresenceHistoryItem[]> {
    const from = new Date(this.now() - hours * 3600_000).toISOString();
    const rows = await this.db
      .select()
      .from(bridgeEvents)
      .where(gte(bridgeEvents.at, from))
      .orderBy(asc(bridgeEvents.at), asc(bridgeEvents.id));
    return rows.map((r, i) => {
      const next = rows[i + 1];
      return { at: new Date(Date.parse(r.at)).toISOString(), state: r.state as PresenceState, reason: r.reason, durationMs: next ? Date.parse(next.at) - Date.parse(r.at) : null };
    });
  }

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
