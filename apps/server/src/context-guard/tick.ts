// Kontext-Wächter — Orchestrierung: bei jedem Ingest (nur die betroffenen Sessions) und im
// 60-s-Ticker (alle laufenden Sessions, s. app.ts `tickStates`) wird für jede Session die Schwelle
// aufgelöst, der aktuelle Kontext-Anteil geholt, `decideContextGuardActions` (reine Funktion,
// monitor.ts) gefragt und das Ergebnis ausgeführt: Hinweis (Badge + Push), Erzwingen (`/compact`
// über die Brücke `send_text`, nur wartend + tmux). Jede Wirkung landet in `context_guard_events`;
// `context_guard_state` verhindert ein zweites Senden je Überschreitung.
import { computeContextPct, TMUX_NAME_RE, type PushSettings, t } from "@nyxos/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { COMPACT_TTL_HOURS, deliverOrQueue, dropStaleCompact, type DeliveryRpc } from "../delivery/queue.js";
import { contextGuardEvents, contextGuardState, sessions } from "../db/schema.js";
import type { LiveHub } from "../live.js";
import { notify } from "../push/dispatcher.js";
import type { NtfySender } from "../push/ntfy.js";
import { loadOrInitSettings } from "../push/settings.js";
import { decideContextGuardActions } from "./monitor.js";
import { resolveForSession } from "./store.js";

/** Kontext-Anteil einer Session (0–100) oder `null` = unbekannt. **Übergabe-Punkt:**
 * `computeContextPct` (packages/shared/src/usage.ts, W-1-Vorarbeit dort) liefert den echten Wert
 * aus den Token-Angaben der letzten Antwort vs. Kontextfenster. */
export type ContextPctSource = (session: SessionRow) => number | null;
export const NO_CONTEXT_PCT_SOURCE: ContextPctSource = () => null;

/** Test-Überschreibung für den echten Nachweis auf der Probe ("künstlich
 * niedrige Schwelle … bzw. Test-Überschreibung"). `NYXOS_CONTEXT_GUARD_TEST_PCT=<0-100>` lässt
 * JEDE laufende Session so behandeln, als läge ihr Kontext-Anteil genau dort — nur so gesetzt beim
 * Probe-Start für diese eine Messung, nie in Produktion (kein Aufruf setzt das automatisch).
 * Ungültiger/fehlender Wert → `NO_CONTEXT_PCT_SOURCE`. */
export function contextPctSourceFromEnv(env = process.env): ContextPctSource {
  const raw = env.NYXOS_CONTEXT_GUARD_TEST_PCT;
  if (raw === undefined) return NO_CONTEXT_PCT_SOURCE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return NO_CONTEXT_PCT_SOURCE;
  return () => n;
}

/** ist seit I8 in main (`sessions.lastUsage`/`lastUsageModel`/`modelContextWindow`, Migration
 * 0010): echter Kontext-Anteil aus den zuletzt gemeldeten Token-Zahlen statt geraten.
 * `computeContextPct` liefert eine Nachkommastelle (z. B. 40,8) — `context_guard_state.last_pct`
 * ist `integer` (Fund beim I8-Probe-Lauf: jede Ingest-Aktualisierung schlug mit "invalid input
 * syntax for type integer" fehl), deshalb hier runden. Vergleiche gegen die (ganzzahligen)
 * Schwellen in `decideContextGuardActions` bleiben dadurch konsistent zur angezeigten Zahl
 * (`ContextRing` rundet ebenfalls). */
export function contextPctFromSession(row: SessionRow): number | null {
  const pct = computeContextPct(row.lastUsage, row.lastUsageModel, row.modelContextWindow);
  return pct === null ? null : Math.round(pct);
}

/** Für `createApp`: Test-Überschreibung (Probe) hat Vorrang, sonst der echte P6-Wert. */
export function defaultContextPctSource(env = process.env): ContextPctSource {
  const test = contextPctSourceFromEnv(env);
  return (row) => test(row) ?? contextPctFromSession(row);
}

export interface SessionRow {
  id: string;
  models: string[];
  state: string | null;
  attachable: boolean;
  tmuxName: string | null;
  title: string | null;
  sessionId: string;
  categoryArt: string | null;
  categoryBaustelleSlug: string | null;
  /** (seit I8 in main): Grundlage für `contextPctFromSession`/`computeContextPct`. */
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  lastUsageModel: string | null;
  modelContextWindow: number | null;
}

export interface BridgeRpc {
  rpc(method: "send_text", params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }>;
}

export interface ContextGuardTickDeps {
  db: Db;
  hub: LiveHub;
  bridgeHub: BridgeRpc;
  pushSender: NtfySender;
  getContextPct: ContextPctSource;
  isHaiku?: (session: SessionRow) => boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

function sessionPath(row: Pick<SessionRow, "sessionId" | "categoryArt" | "categoryBaustelleSlug">): string {
  return `/sessions/${row.categoryArt ?? "unsortiert"}/${row.categoryBaustelleSlug ?? "_"}/${row.sessionId}`;
}

async function loadState(db: Db, sessionKey: string) {
  const [row] = await db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, sessionKey)).limit(1);
  return row ?? { sessionKey, lastPct: null, hinweisNotifiedAt: null, erzwingenAttemptedAt: null, updatedAt: new Date(0).toISOString() };
}

async function upsertState(db: Db, sessionKey: string, patch: { lastPct?: number | null; hinweisNotifiedAt?: string | null; erzwingenAttemptedAt?: string | null }) {
  const set = { ...patch, updatedAt: new Date().toISOString() };
  const existing = await db.select({ sessionKey: contextGuardState.sessionKey }).from(contextGuardState).where(eq(contextGuardState.sessionKey, sessionKey)).limit(1);
  if (existing.length > 0) {
    await db.update(contextGuardState).set(set).where(eq(contextGuardState.sessionKey, sessionKey));
  } else {
    await db.insert(contextGuardState).values({ sessionKey, ...set });
  }
}

async function logEvent(db: Db, sessionKey: string, kind: "hinweis" | "erzwingen" | "manuell", pctAtTrigger: number | null, action: string, detail?: Record<string, unknown>) {
  await db.insert(contextGuardEvents).values({ sessionKey, kind, pctAtTrigger, action, detail: detail ?? null });
}

/** Wettlauf: der 60-s-Ticker und ein Ingest-Aufruf können dieselbe Session
 * gleichzeitig prüfen — beide läsen sonst `erzwingenAttemptedAt: null`, bevor einer geschrieben hat,
 * und schicken beide `/compact`. Diese Markierung ist EIN atomares SQL-Statement (Insert mit
 * bedingtem "ON CONFLICT ... DO UPDATE ... WHERE erzwingen_attempted_at IS NULL"): egal ob die Zeile
 * schon existiert oder nicht, nur EIN gleichzeitiger Aufrufer bekommt eine zurückgegebene Zeile und
 * darf senden — der andere sieht `claimed: false` und lässt es. */
async function tryClaimErzwingen(db: Db, sessionKey: string, at: string): Promise<boolean> {
  const rows = await db
    .insert(contextGuardState)
    .values({ sessionKey, erzwingenAttemptedAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: contextGuardState.sessionKey,
      set: { erzwingenAttemptedAt: at, updatedAt: at },
      setWhere: sql`${contextGuardState.erzwingenAttemptedAt} is null`,
    })
    .returning({ sessionKey: contextGuardState.sessionKey });
  return rows.length > 0;
}

/** Eine Session gegen ihre Schwellen prüfen und ggf. Hinweis/Erzwingen auslösen. Nie werfend —
 * Fehler werden geloggt (der Ticker/Ingest darf dadurch nie selbst scheitern, wie bei push/waiting). */
export async function checkSession(deps: ContextGuardTickDeps, row: SessionRow, pushSettings: PushSettings): Promise<void> {
  const pct = deps.getContextPct(row);
  const model = row.models[row.models.length - 1] ?? null;
  const isHaiku = deps.isHaiku?.(row) ?? false;
  const thresholds = await resolveForSession(deps.db, { sessionKey: row.id, model, isHaiku });
  const state = await loadState(deps.db, row.id);
  const decision = decideContextGuardActions({
    pct,
    thresholds,
    sessionState: row.state,
    attachable: row.attachable && !!row.tmuxName && TMUX_NAME_RE.test(row.tmuxName),
    state: { hinweisNotifiedAt: state.hinweisNotifiedAt, erzwingenAttemptedAt: state.erzwingenAttemptedAt },
  });
  // Unter der Hinweis-Schwelle braucht niemand mehr ein wartendes `/compact` (Badge oder Erzwingen).
  if (pct !== null && pct < thresholds.hinweisPct && (await dropStaleCompact(deps.db, row.id)) > 0) deps.hub.broadcast({ type: "deliveries", sessionId: row.id });

  if (!decision.notify && !decision.resetHinweis && !decision.forceCompact && !decision.resetErzwingen) {
    if (pct !== state.lastPct) await upsertState(deps.db, row.id, { lastPct: pct });
    return;
  }

  const patch: Parameters<typeof upsertState>[2] = { lastPct: pct };
  let changed = false;

  if (decision.resetHinweis) patch.hinweisNotifiedAt = null;
  if (decision.resetErzwingen) patch.erzwingenAttemptedAt = null;

  if (decision.notify) {
    patch.hinweisNotifiedAt = new Date().toISOString();
    changed = true;
    await logEvent(deps.db, row.id, "hinweis", pct, "notified");
    try {
      await notify(
        {
          kind: "context_guard_hinweis",
          title: t("Kontext-Wächter"),
          message: t("{title}: Kontext {pct}% – Komprimieren empfohlen", { title: row.title ?? row.sessionId, pct }),
          path: sessionPath(row),
          sessionKey: row.id,
        },
        { db: deps.db, sender: deps.pushSender, settings: pushSettings },
      );
    } catch (e) {
      deps.log("context-guard-push-fehler", { sessionKey: row.id, error: String(e) });
    }
  }

  if (decision.forceCompact) {
    // Atomar VOR dem Senden markieren — nicht über `patch`/`upsertState` unten,
    // die lesen-dann-schreiben und den Wettlauf nicht verhindern würden.
    const claimed = await tryClaimErzwingen(deps.db, row.id, new Date().toISOString());
    if (!claimed) {
      await logEvent(deps.db, row.id, "erzwingen", pct, "compact_skipped_race");
    } else {
      changed = true;
      try {
        // „Erzwingen“ wartet — ist der Bildschirm gerade nicht frei (Freigabe-Frage, angefangener
        // Text, Spinner), geht `/compact` in die Zustell-Warteschlange statt verloren (der Merker oben
        // verhindert ja einen zweiten Versuch) und raus, sobald die Session wieder wartet.
        const r = await deliverOrQueue({ db: deps.db, bridge: deps.bridgeHub as DeliveryRpc, hub: deps.hub, log: deps.log }, { sessionKey: row.id, kind: "compact", text: "/compact", dedupeKey: "compact", ttlHours: COMPACT_TTL_HOURS });
        const action = r.status === "sent" ? "compact_sent" : r.status === "queued" ? "compact_queued" : "compact_failed";
        await logEvent(deps.db, row.id, "erzwingen", pct, action, { reason: r.status === "sent" ? null : r.reason });
      } catch (e) {
        await logEvent(deps.db, row.id, "erzwingen", pct, "compact_failed", { error: String(e) });
        deps.log("context-guard-erzwingen-fehler", { sessionKey: row.id, error: String(e) });
      }
    }
  }

  if (changed || decision.resetHinweis || decision.resetErzwingen) await upsertState(deps.db, row.id, patch);
  deps.hub.broadcast({ type: "context_guard", sessionId: row.id });
}

/** Läuft im 60-s-Ticker (`app.ts` `tickStates`) über alle Sessions mit lebendem Prozess. */
export async function runContextGuardTicker(deps: ContextGuardTickDeps): Promise<void> {
  const rows = await deps.db
    .select({
      id: sessions.id,
      models: sessions.models,
      state: sessions.state,
      attachable: sessions.attachable,
      tmuxName: sessions.tmuxName,
      title: sessions.title,
      sessionId: sessions.sessionId,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      status: sessions.status,
      lastUsage: sessions.lastUsage,
      lastUsageModel: sessions.lastUsageModel,
      modelContextWindow: sessions.modelContextWindow,
    })
    .from(sessions)
    .where(eq(sessions.status, "running"));
  if (rows.length === 0) return;
  const pushSettings = await loadOrInitSettings(deps.db);
  for (const row of rows) await checkSession(deps, row, pushSettings);
}

/** Läuft nach jedem Ingest, nur für die vom Batch betroffenen Sessions (schneller als der volle Ticker). */
export async function runContextGuardForSessions(deps: ContextGuardTickDeps, sessionKeys: string[]): Promise<void> {
  if (sessionKeys.length === 0) return;
  const rows = await deps.db
    .select({
      id: sessions.id,
      models: sessions.models,
      state: sessions.state,
      attachable: sessions.attachable,
      tmuxName: sessions.tmuxName,
      title: sessions.title,
      sessionId: sessions.sessionId,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      status: sessions.status,
      lastUsage: sessions.lastUsage,
      lastUsageModel: sessions.lastUsageModel,
      modelContextWindow: sessions.modelContextWindow,
    })
    .from(sessions)
    .where(inArray(sessions.id, sessionKeys));
  const running = rows.filter((r) => r.status === "running");
  if (running.length === 0) return;
  const pushSettings = await loadOrInitSettings(deps.db);
  for (const row of running) await checkSession(deps, row, pushSettings);
}
