import type { IngestItem } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { backfillStates, sessionKey } from "../src/store.js";
import { setup } from "./helpers.js";

/**
 * Rückrechnung für Bestandsdaten. Jeder Fall spielt zuerst die echte Event-Historie über
 * `/ingest/events` ein (der Live-Pfad berechnet dabei schon korrekt) und verstellt dann gezielt
 * `turn_open` / `session_end_received_at` / `state` auf die Werte, die Migration 0001 für eine
 * Bestands-Session anlegt (`turn_open = true`, `session_end_received_at = null`) bzw. auf einen
 * falschen Zustand — genau der Bug, den `backfillStates` beheben muss: die Rückrechnung muss den
 * korrekten Zustand allein aus `session_events` wiederherstellen, unabhängig vom (verstellten)
 * Spaltenstand der Session-Zeile.
 */

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

const base = Date.now();
const at = (minutesOffset: number) => new Date(base + minutesOffset * 60_000).toISOString();

const hookAt = (event: string, minutesOffset: number, sessionId: string, tool: "claude" | "codex" = "claude"): IngestItem => ({
  type: "event",
  event: { id: `hook:${event}:${minutesOffset}:${sessionId}`, tool, sessionId, ts: at(minutesOffset), kind: "hook", source: "hook", data: { event } },
});

const fileEvent = (
  kind: "prompt" | "assistant" | "tool_call" | "turn_aborted" | "system" | "attachment" | "compaction",
  minutesOffset: number,
  sessionId: string,
  tool: "claude" | "codex" = "claude",
): IngestItem => ({
  type: "event",
  event: { id: `file:${kind}:${minutesOffset}:${sessionId}`, tool, sessionId, ts: at(minutesOffset), kind, source: "file", data: {} },
});

const stateItem = (sessionId: string, running: boolean, minutesOffset: number, tool: "claude" | "codex" = "claude"): IngestItem => ({
  type: "state",
  state: { tool, sessionId, running, observedAt: at(minutesOffset) },
});

/** Verstellt die Session-Zeile wie eine noch nicht rückgerechnete Bestands-Session nach Migration 0001. */
async function corrupt(
  t: Awaited<ReturnType<typeof setup>>,
  key: string,
  patch: Partial<{ turnOpen: boolean; sessionEndReceivedAt: string | null; state: string | null }>,
) {
  await t.db.update(sessions).set(patch).where(eq(sessions.id, key));
}

async function row(t: Awaited<ReturnType<typeof setup>>, key: string) {
  const [s] = await t.db.select().from(sessions).where(eq(sessions.id, key));
  return s;
}

describe("Rückrechnung für Bestandsdaten (backfill-states)", () => {
  it("(a) alte beendete Claude-Session mit Stop-Hook als letztem Signal → state null (beendet), nicht crashed", async () => {
    const t = await setup();
    const sid = "sess-a";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 1, sid)] });
    await t.post("/ingest/events", { items: [stateItem(sid, false, 5)] });

    await corrupt(t, key, { turnOpen: true, sessionEndReceivedAt: null, state: "crashed" });

    const result = await backfillStates(t.db, base + 10 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.state).toBeNull();
    expect(s?.turnOpen).toBe(false);
    expect(s?.sessionEndReceivedAt).toBeNull();
  });

  it("(b) beendete Claude-Session ohne Hooks, letztes Event 'assistant' → Runde gilt als zu (null, kein Absturz)", async () => {
    const t = await setup();
    const sid = "sess-b";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [fileEvent("prompt", 0, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("assistant", 1, sid)] });
    await t.post("/ingest/events", { items: [stateItem(sid, false, 5)] });

    await corrupt(t, key, { turnOpen: true, sessionEndReceivedAt: null, state: "crashed" });

    const result = await backfillStates(t.db, base + 10 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBeNull();
  });

  it("(c) beendete Claude-Session ohne Hooks, letztes Event 'tool_call' → abgestürzt", async () => {
    const t = await setup();
    const sid = "sess-c";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [fileEvent("prompt", 0, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("assistant", 1, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("tool_call", 2, sid)] });
    await t.post("/ingest/events", { items: [stateItem(sid, false, 5)] });

    await corrupt(t, key, { turnOpen: false, sessionEndReceivedAt: null, state: "running" });

    const result = await backfillStates(t.db, base + 10 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(true);
    expect(s?.state).toBe("crashed");
  });

  it("(b2) realistische Endfolge (…, assistant, system, system) → Runde zu, kein Absturz", async () => {
    const t = await setup();
    const sid = "sess-b2";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [fileEvent("prompt", 0, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("assistant", 1, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("system", 2, sid)] }); // z. B. turn_duration
    await t.post("/ingest/events", { items: [fileEvent("system", 3, sid)] }); // z. B. stop_hook_summary
    await t.post("/ingest/events", { items: [stateItem(sid, false, 5)] });

    await corrupt(t, key, { turnOpen: true, sessionEndReceivedAt: null, state: "crashed" });

    const result = await backfillStates(t.db, base + 10 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBeNull();
  });

  it("(c2) realistische Endfolge (…, tool_call, system) → Runde bleibt offen, abgestürzt", async () => {
    const t = await setup();
    const sid = "sess-c2";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [fileEvent("prompt", 0, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("assistant", 1, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("tool_call", 2, sid)] });
    await t.post("/ingest/events", { items: [fileEvent("system", 3, sid)] }); // z. B. away_summary mitten in einem Werkzeugaufruf
    await t.post("/ingest/events", { items: [stateItem(sid, false, 5)] });

    await corrupt(t, key, { turnOpen: false, sessionEndReceivedAt: null, state: "running" });

    const result = await backfillStates(t.db, base + 10 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(true);
    expect(s?.state).toBe("crashed");
  });

  it("(d) Session mit SessionEnd-Hook → session_end_received_at wird gesetzt, state null", async () => {
    const t = await setup();
    const sid = "sess-d";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 10, sid)] });

    await corrupt(t, key, { sessionEndReceivedAt: null, state: "crashed" });

    const result = await backfillStates(t.db, base + 20 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.sessionEndReceivedAt).not.toBeNull();
    expect(new Date(s?.sessionEndReceivedAt ?? "").toISOString()).toBe(new Date(at(10)).toISOString());
    expect(s?.state).toBeNull();
  });

  it("(e) laufende Session, Stop-Hook zuletzt → wartet", async () => {
    const t = await setup();
    const sid = "sess-e";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 1, sid)] });

    await corrupt(t, key, { turnOpen: true, state: "running" });

    const result = await backfillStates(t.db, base + 2 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");
  });

  it("(f) Codex turn_aborted zuletzt → Runde zu, Session wartet auf Alex", async () => {
    const t = await setup();
    const sid = "codex-f";
    const key = sessionKey("codex", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid, "codex")] });
    await t.post("/ingest/events", { items: [fileEvent("turn_aborted", 1, sid, "codex")] });

    await corrupt(t, key, { turnOpen: true, state: "running" });

    const result = await backfillStates(t.db, base + 2 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");
  });

  it("(e2) NUR turn_open ist verstellt, state/session_end_received_at/turn_observed_at sind schon korrekt → wird trotzdem korrigiert (rowChanged darf sich nicht allein auf 'state' stützen)", async () => {
    // Regression: `state` kann durch Zufall schon korrekt dastehen (weil sich der berechnete Zustand
    // bei offener wie bei fälschlich offener Runde gleich verhält), während `turn_open` selbst falsch
    // ist. Die Rückrechnung muss JEDES verstellte Feld einzeln erkennen, nicht nur über einen
    // Zustands-Wechsel schließen. Hier bleibt `state` unverändert ("waiting", schon korrekt vor der
    // Korruption) — nur `turn_open` wird verstellt.
    const t = await setup();
    const sid = "sess-e2";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 1, sid)] });

    const before = await row(t, key);
    expect(before?.state).toBe("waiting");
    expect(before?.turnOpen).toBe(false);

    // NUR turn_open verstellen — state, session_end_received_at, turn_observed_at bleiben unangetastet
    // und stehen schon korrekt da.
    await corrupt(t, key, { turnOpen: true });

    const result = await backfillStates(t.db, base + 2 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");
  });

  it("(g) zweiter Lauf ändert nichts mehr, und byState zählt Sessions je Zustand", async () => {
    const t = await setup();
    const sidWaiting = "sess-g-waiting";
    const keyWaiting = sessionKey("claude", sidWaiting);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sidWaiting)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 1, sidWaiting)] });
    await corrupt(t, keyWaiting, { turnOpen: true, state: "running" });

    const sidCrashed = "sess-g-crashed";
    const keyCrashed = sessionKey("claude", sidCrashed);
    await t.post("/ingest/events", { items: [fileEvent("prompt", 0, sidCrashed)] });
    await t.post("/ingest/events", { items: [fileEvent("tool_call", 1, sidCrashed)] });
    await t.post("/ingest/events", { items: [stateItem(sidCrashed, false, 5)] });
    await corrupt(t, keyCrashed, { turnOpen: false, sessionEndReceivedAt: null, state: null });

    const now = base + 10 * 60_000;
    const first = await backfillStates(t.db, now);
    expect(first.changed).toBe(2);
    expect(first.byState.waiting).toBe(1);
    expect(first.byState.crashed).toBe(1);

    const second = await backfillStates(t.db, now);
    expect(second.changed).toBe(0);
  });

  it("(i) SessionEnd, danach neuer SessionStart (Resume) — Rückrechnung darf das alte SessionEnd nicht mehr zählen", async () => {
    const t = await setup();
    const sid = "sess-i";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 1, sid)] });
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 2, sid)] }); // Resume — Prozess läuft laut Live-Pfad schon wieder
    await t.post("/ingest/events", { items: [stateItem(sid, false, 20)] }); // Absturz danach, ohne neues SessionEnd

    // Verstellt genau wie eine Bestandssession nach Migration 0001, VOR der Rückrechnung: der
    // Live-Pfad hätte hier schon korrekt session_end_received_at zurückgesetzt (Fix in
    // store.ts `applyStatus`) — dieser Test prüft die Rückrechnung UNABHÄNGIG davon, also so, als
    // wäre die Session nie live durch den Live-Pfad gelaufen (reine Ableitung aus den Events).
    await corrupt(t, key, { turnOpen: false, sessionEndReceivedAt: at(1), state: null });

    const result = await backfillStates(t.db, base + 30 * 60_000);
    expect(result.changed).toBe(1);

    const s = await row(t, key);
    expect(s?.sessionEndReceivedAt).toBeNull(); // das SessionEnd von vor dem Resume zählt nicht mehr
    expect(s?.turnOpen).toBe(true); // SessionStart (Resume) ist das jüngste Runden-Signal
    expect(s?.state).toBe("crashed");
  });

  it("(h) geschlossene Session bleibt geschlossen, closedAt/closedBy bleiben unangetastet", async () => {
    const t = await setup();
    const sid = "sess-h";
    const key = sessionKey("claude", sid);
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, sid)] });
    const close = await t.post(`/api/sessions/${sid}/close`, { by: "alex" });
    expect(close.status).toBe(200);

    const before = await row(t, key);
    expect(before?.state).toBe("closed");

    await corrupt(t, key, { turnOpen: true, sessionEndReceivedAt: null, state: "running" });

    await backfillStates(t.db, base + 10 * 60_000);

    const s = await row(t, key);
    expect(s?.state).toBe("closed");
    expect(s?.closedAt).toBeTruthy();
    expect(s?.closedBy).toBe("alex");
  });
});
