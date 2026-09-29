// „Zustellen, sobald sie wartet“: EINE Stelle, über die der Server Text in eine Session
// tippen lässt. Regel: Text/Befehle gehen nur hinein, wenn der Hook-Zustand „wartet“ sagt UND die
// Brücke auf dem Bildschirm eine leere Eingabe sieht (`promptState` = idle, s. apps/bridge prompt.ts).
// Sonst landet der Text hier in der Warteschlange (Tabelle `session_deliveries`, übersteht Neustarts),
// ist in der Oberfläche sichtbar und geht von selbst raus, sobald die Session wartet — oder verfällt
// nach `ttlHours` mit ehrlichem Status „abgelaufen“.
//
// Ausgelöst wird die Zustellung vom 60-s-Takt (`tickStates`) und nach jedem Ingest (Session kann
// gerade auf „wartet“ gewechselt sein). Je Session höchstens EIN Text pro Durchlauf: danach arbeitet
// sie wieder, der nächste wartet auf die nächste Pause (Reihenfolge bleibt erhalten).

import type { BridgeRpcMethod, SessionDeliveryView } from "@nyxos/shared";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionDeliveries, sessions } from "../db/schema.js";
import { t } from "@nyxos/shared";

export type DeliveryView = SessionDeliveryView;
export type DeliveryKind = DeliveryView["kind"];
export type DeliveryMethod = "send_text" | "send_message";
export type DeliveryStatus = DeliveryView["status"];

/** Standard-Verfallszeit: danach ist ein Bescheid meist überholt (der Nutzer sieht „abgelaufen“). */
export const DEFAULT_DELIVERY_TTL_HOURS = 6;
/** `/compact` lohnt sich nur zeitnah — danach zeigt der Wächter ohnehin neu an. */
export const COMPACT_TTL_HOURS = 2;
/** Erledigte Einträge so lange als Verlauf behalten, dann aufräumen. */
export const DELIVERY_HISTORY_DAYS = 7;
const HOUR_MS = 3_600_000;

export interface DeliveryRpc {
  rpc(method: BridgeRpcMethod, params: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }>;
}

export interface DeliveryDeps {
  db: Db;
  bridge: DeliveryRpc | null;
  /** Oberfläche neu laden lassen (`{ type: "deliveries", sessionId }`). */
  hub?: { broadcast(message: unknown): void };
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface DeliveryRequest {
  sessionKey: string;
  kind: DeliveryKind;
  text: string;
  /** Nur Chat: Bildpfade auf dem Rechner (je einzeln eingefügt). */
  images?: string[];
  ttlHours?: number;
  dedupeKey?: string;
  /** Nicht selbst senden, nur einreihen (der Aufrufer hat es gerade schon versucht). */
  queueOnly?: boolean;
  queueReason?: string;
}

export type DeliveryResult =
  | { status: "sent" }
  | { status: "queued"; id: number; reason: string }
  | { status: "rejected"; reason: string };

type Payload = { text: string; images?: string[] };

/**
 * Nach einem Senden meldet der Hook erst mit dem nächsten Ereignis „arbeitet“ — bis dahin sagt er
 * noch „wartet“. So lange nichts Weiteres in dieselbe Session schicken (und nie zwei Sendungen
 * gleichzeitig, z. B. Ticker + Ingest).
 */
export const SEND_COOLDOWN_MS = 20_000;
// Je Brücke (= der eine Weg in die Terminals dieser Server-Instanz; in Tests je `setup()`), nicht prozessweit.
const busyByBridge = new WeakMap<object, Map<string, number>>();
function busyOf(bridge: object): Map<string, number> {
  let m = busyByBridge.get(bridge);
  if (!m) busyByBridge.set(bridge, (m = new Map()));
  return m;
}
/** Sperre für EINE Sendung in diese Session (auch für Wege außerhalb der Schlange, z. B. Chat sofort). */
export function claimSend(bridge: object, key: string, now: number): boolean {
  const busyUntil = busyOf(bridge);
  if ((busyUntil.get(key) ?? 0) > now) return false;
  busyUntil.set(key, now + SEND_COOLDOWN_MS);
  return true;
}
/**
 * Sperre lösen. `now` = Zeitpunkt NACH dem Senden (eine langsame Brücke — Bilder einfügen,
 * Luft lassen — darf die 20 s nicht aufbrauchen). Unklarer Ausgang zählt wie gesendet.
 */
export function releaseSend(bridge: object, key: string, sentOrUnclear: boolean, now: number): void {
  const busyUntil = busyOf(bridge);
  if (sentOrUnclear) busyUntil.set(key, now + SEND_COOLDOWN_MS);
  else busyUntil.delete(key);
}
/** so lange darf ein Eintrag „unterwegs“ sein, sonst ist der Server dabei abgestürzt. */
const SENDING_STALE_MS = 5 * 60_000;
type SessionRow = { id: string; tmuxName: string | null; attachable: boolean; state: string | null };

const NOT_IN_NYXOS = "Diese Session läuft in einem eigenen Fenster auf dem Rechner. Übernimm sie in NyxOS, dann kann ich ihr etwas schicken.";
const WAITS_FOR_PAUSE = "Die Session arbeitet gerade – geht raus, sobald sie auf dich wartet.";
const MAC_OFFLINE = "Dein Mac ist gerade nicht verbunden – geht raus, sobald er wieder da ist und die Session wartet.";
/** Zeitüberschreitung heißt NICHT „nicht angekommen“ — nie ein zweites Mal senden. */
export const UNCLEAR = "Unklar, ob es angekommen ist – der Rechner hat nicht rechtzeitig geantwortet. Schau kurz ins Terminal, bevor du es noch einmal schickst.";

async function loadSession(db: Db, key: string): Promise<SessionRow | null> {
  const [row] = await db.select({ id: sessions.id, tmuxName: sessions.tmuxName, attachable: sessions.attachable, state: sessions.state }).from(sessions).where(eq(sessions.id, key)).limit(1);
  return row ?? null;
}

/** Ein Versuch über die Brücke — immer mit Bildschirm-Prüfung (`onlyWhenWaiting`/`onlyWhenIdle`). */
/** Wie der Chat (session-chat.ts): Bilder einfügen + Luft lassen braucht länger als ein normaler RPC. */
const SEND_MESSAGE_TIMEOUT_MS = 30_000;
type Attempt = { sent: boolean; reason: string | null; gone: boolean; unclear?: boolean };
async function attempt(bridge: DeliveryRpc, tmuxName: string, method: DeliveryMethod, payload: Payload): Promise<Attempt> {
  const outcome =
    method === "send_message"
      ? await bridge.rpc("send_message", { tmuxName, images: payload.images ?? [], text: payload.text, hookWaiting: true, onlyWhenIdle: true }, SEND_MESSAGE_TIMEOUT_MS)
      : await bridge.rpc("send_text", { tmuxName, text: payload.text, submit: true, onlyWhenWaiting: true, hookWaiting: true });
  if (!outcome.ok) {
    if (outcome.code === "not_found") return { sent: false, reason: t("Die Session läuft nicht mehr in NyxOS."), gone: true };
    if (outcome.code === "timeout") return { sent: false, reason: t(UNCLEAR), gone: false, unclear: true };
    return { sent: false, reason: outcome.code === "bridge_offline" ? t(MAC_OFFLINE) : (outcome.error ?? t("Senden hat nicht geklappt – ich versuche es gleich noch einmal.")), gone: false };
  }
  const r = outcome.result as { sent?: boolean; reason?: string } | undefined;
  if (r?.sent === false) return { sent: false, reason: r.reason ?? t(WAITS_FOR_PAUSE), gone: false };
  return { sent: true, reason: null, gone: false };
}

/**
 * Sofort zustellen, wenn Hook UND Bildschirm „wartet“ sagen — sonst in die Warteschlange. Läuft die
 * Session nicht in der NyxOS (kein Terminal), ehrlich ablehnen: dort kann nie etwas ankommen.
 */
export async function deliverOrQueue(deps: DeliveryDeps, req: DeliveryRequest): Promise<DeliveryResult> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  const row = await loadSession(db, req.sessionKey);
  if (!row) return { status: "rejected", reason: t("Diese Session kenne ich nicht.") };
  if (!row.attachable || !row.tmuxName) return { status: "rejected", reason: t(NOT_IN_NYXOS) };
  const payload: Payload = req.images?.length ? { text: req.text, images: req.images } : { text: req.text };
  const method: DeliveryMethod = req.kind === "chat" ? "send_message" : "send_text";

  const queued = await db
    .select({ id: sessionDeliveries.id, dedupeKey: sessionDeliveries.dedupeKey, reason: sessionDeliveries.reason })
    .from(sessionDeliveries)
    .where(and(eq(sessionDeliveries.sessionKey, row.id), eq(sessionDeliveries.status, "queued")))
    .orderBy(asc(sessionDeliveries.id));
  const same = req.dedupeKey ? queued.find((q) => q.dedupeKey === req.dedupeKey) : undefined;
  if (same) return { status: "queued", id: same.id, reason: same.reason ?? t(WAITS_FOR_PAUSE) };

  // Nur sofort, wenn nichts Älteres vor ihm wartet (Reihenfolge) und der Hook „wartet“ sagt.
  let reason = req.queueReason ?? t(WAITS_FOR_PAUSE);
  if (req.queueOnly) {
    // Der Aufrufer hat selbst schon versucht (z. B. Chat) — nur noch einreihen.
  } else if (queued.length === 0 && row.state === "waiting" && deps.bridge && claimSend(deps.bridge, row.id, now)) {
    const r: Attempt = await attempt(deps.bridge, row.tmuxName, method, payload).catch((e: unknown) => ({ sent: false, reason: String(e), gone: false }));
    const after = deps.now?.() ?? Date.now();
    releaseSend(deps.bridge, row.id, r.sent || !!r.unclear, after);
    if (r.sent) {
      deps.log?.("zustellung-gesendet", { session: row.id, kind: req.kind, sofort: true });
      return { status: "sent" };
    }
    if (r.gone) return { status: "rejected", reason: r.reason ?? t(NOT_IN_NYXOS) };
    if (r.unclear) {
      // Sichtbar im Verlauf, aber NICHT wartend — sonst ginge es womöglich ein zweites Mal raus.
      const at = new Date(after).toISOString();
      await db.insert(sessionDeliveries).values({ sessionKey: row.id, kind: req.kind, method, payload, dedupeKey: req.dedupeKey ?? null, status: "failed", reason: t(UNCLEAR), attempts: 1, createdAt: new Date(now).toISOString(), expiresAt: at, lastAttemptAt: at, doneAt: at });
      deps.log?.("zustellung-unklar", { session: row.id, kind: req.kind });
      deps.hub?.broadcast({ type: "deliveries", sessionId: row.id });
      return { status: "rejected", reason: t(UNCLEAR) };
    }
    reason = r.reason ?? reason;
  } else if (!deps.bridge) reason = t(MAC_OFFLINE);
  else if (queued.length > 0) reason = t("Vor dieser Nachricht wartet noch etwas anderes auf die Session – sie geht danach raus.");

  const ttl = (req.ttlHours ?? DEFAULT_DELIVERY_TTL_HOURS) * HOUR_MS;
  const [ins] = await db
    .insert(sessionDeliveries)
    .values({ sessionKey: row.id, kind: req.kind, method, payload, dedupeKey: req.dedupeKey ?? null, reason, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() })
    .returning({ id: sessionDeliveries.id });
  deps.log?.("zustellung-wartet", { session: row.id, kind: req.kind, id: ins?.id });
  deps.hub?.broadcast({ type: "deliveries", sessionId: row.id });
  return { status: "queued", id: ins?.id ?? 0, reason };
}

/**
 * Warteschlange abarbeiten: Abgelaufenes markieren, dann je wartender Session den ÄLTESTEN Eintrag
 * versuchen. `sessionKeys` begrenzt auf bestimmte Sessions (nach einem Ingest). Liefert die Zahl der
 * zugestellten Einträge.
 */
export async function flushDeliveries(deps: DeliveryDeps, sessionKeys?: string[]): Promise<{ sent: number; expired: number }> {
  const { db } = deps;
  const nowMs = deps.now?.() ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const touched = new Set<string>();

  const expired = await db
    .update(sessionDeliveries)
    .set({ status: "expired", doneAt: nowIso, reason: t("Nicht zugestellt: Die Session hat in der Zeit nicht auf dich gewartet.") })
    .where(and(eq(sessionDeliveries.status, "queued"), lte(sessionDeliveries.expiresAt, nowIso)))
    .returning({ sessionKey: sessionDeliveries.sessionKey });
  for (const e of expired) touched.add(e.sessionKey);
  // „unterwegs“ seit Minuten = Server mitten im Senden neu gestartet → ehrlich „unklar“, nie erneut.
  const stuck = await db
    .update(sessionDeliveries)
    .set({ status: "failed", doneAt: nowIso, reason: t(UNCLEAR) })
    .where(and(eq(sessionDeliveries.status, "sending"), lte(sessionDeliveries.lastAttemptAt, new Date(nowMs - SENDING_STALE_MS).toISOString())))
    .returning({ sessionKey: sessionDeliveries.sessionKey });
  for (const e of stuck) touched.add(e.sessionKey);
  await db.delete(sessionDeliveries).where(and(sql`${sessionDeliveries.status} <> 'queued'`, lte(sessionDeliveries.createdAt, new Date(nowMs - DELIVERY_HISTORY_DAYS * 24 * HOUR_MS).toISOString())));

  const where = sessionKeys ? and(eq(sessionDeliveries.status, "queued"), inArray(sessionDeliveries.sessionKey, sessionKeys.length ? sessionKeys : [""])) : eq(sessionDeliveries.status, "queued");
  const rows = await db.select().from(sessionDeliveries).where(where).orderBy(asc(sessionDeliveries.id));
  const first = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!first.has(r.sessionKey)) first.set(r.sessionKey, r);

  let sent = 0;
  for (const item of first.values()) {
    const row = await loadSession(db, item.sessionKey);
    if (!row?.tmuxName || !row.attachable || row.state !== "waiting" || !deps.bridge || !claimSend(deps.bridge, row.id, nowMs)) continue;
    // VOR dem Senden atomar auf „unterwegs“ — wer inzwischen zurückgezogen hat, gewinnt; wer
    // danach zurückziehen will, bekommt ein ehrliches „schon unterwegs“ (statt „zurückgezogen“ + trotzdem getippt).
    const [taken] = await db
      .update(sessionDeliveries)
      .set({ status: "sending", lastAttemptAt: nowIso, attempts: sql`${sessionDeliveries.attempts} + 1` })
      .where(and(eq(sessionDeliveries.id, item.id), eq(sessionDeliveries.status, "queued")))
      .returning({ id: sessionDeliveries.id });
    if (!taken) {
      releaseSend(deps.bridge, row.id, false, nowMs);
      continue;
    }
    const r: Attempt = await attempt(deps.bridge, row.tmuxName, item.method as DeliveryMethod, item.payload as Payload).catch((e: unknown) => ({ sent: false, reason: String(e), gone: false }));
    const afterMs = deps.now?.() ?? Date.now();
    const afterIso = new Date(afterMs).toISOString();
    releaseSend(deps.bridge, row.id, r.sent || !!r.unclear, afterMs);
    const set = r.sent
      ? { status: "sent", doneAt: afterIso, reason: null }
      : r.gone || r.unclear
        ? { status: "failed", doneAt: afterIso, reason: r.reason }
        : { status: "queued", reason: r.reason };
    await db
      .update(sessionDeliveries)
      .set(set)
      .where(and(eq(sessionDeliveries.id, item.id), eq(sessionDeliveries.status, "sending")));
    touched.add(item.sessionKey);
    if (r.sent) {
      sent++;
      deps.log?.("zustellung-gesendet", { session: item.sessionKey, kind: item.kind, id: item.id });
    }
  }
  for (const key of touched) deps.hub?.broadcast({ type: "deliveries", sessionId: key });
  return { sent, expired: expired.length };
}

/** Für die Oberfläche: Wartendes zuerst, dann der jüngste Verlauf. */
export async function listDeliveries(db: Db, sessionKey: string, limit = 20): Promise<DeliveryView[]> {
  const rows = await db
    .select()
    .from(sessionDeliveries)
    .where(eq(sessionDeliveries.sessionKey, sessionKey))
    .orderBy(sql`case when ${sessionDeliveries.status} in ('queued', 'sending') then 0 else 1 end`, sql`${sessionDeliveries.id} desc`)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as DeliveryKind,
    text: (r.payload as Payload).text,
    status: r.status as DeliveryStatus,
    reason: r.reason,
    attempts: r.attempts,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    doneAt: r.doneAt,
  }));
}

/**
 * Wartendes `/compact` verwerfen, sobald der Kontext wieder klein ist (z. B. selbst komprimiert) —
 * sonst käme es Stunden später noch in eine Session, die es gar nicht mehr braucht.
 */
export async function dropStaleCompact(db: Db, sessionKey: string, now = Date.now()): Promise<number> {
  const rows = await db
    .update(sessionDeliveries)
    .set({ status: "cancelled", doneAt: new Date(now).toISOString(), reason: t("Nicht mehr nötig: Der Kontext ist inzwischen wieder klein.") })
    .where(and(eq(sessionDeliveries.sessionKey, sessionKey), eq(sessionDeliveries.kind, "compact"), eq(sessionDeliveries.status, "queued")))
    .returning({ id: sessionDeliveries.id });
  return rows.length;
}

/** Der Nutzer zieht einen wartenden Eintrag zurück. `null` = war schon unterwegs/raus/abgelaufen. */
export async function cancelDelivery(db: Db, id: number, now = Date.now()): Promise<{ sessionKey: string } | null> {
  const [row] = await db
    .update(sessionDeliveries)
    .set({ status: "cancelled", doneAt: new Date(now).toISOString(), reason: t("Von dir zurückgezogen.") })
    .where(and(eq(sessionDeliveries.id, id), eq(sessionDeliveries.status, "queued")))
    .returning({ sessionKey: sessionDeliveries.sessionKey });
  return row ?? null;
}
