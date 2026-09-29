import { describe, expect, it } from "vitest";
import { computeSessionState, IDLE_AFTER_MS, type SessionStateRow } from "../src/state.js";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const row = (over: Partial<SessionStateRow> = {}): SessionStateRow => ({
  status: "running",
  turnOpen: true,
  sessionEndReceivedAt: null,
  lastActivityAt: new Date(NOW).toISOString(),
  closedAt: null,
  ...over,
});

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("computeSessionState (Tabellen-Tests)", () => {
  it.each<[string, SessionStateRow, ReturnType<typeof computeSessionState>]>([
    ["läuft: Prozess lebt, Runde offen, gerade aktiv", row(), "running"],
    ["läuft: Prozess lebt, Runde offen, 29:59 still (unter der Schwelle)", row({ lastActivityAt: minutesAgo(29.983333) }), "running"],
    ["läuft: keine lastActivityAt bekannt, sonst normal", row({ lastActivityAt: null }), "running"],
    ["ruht: Prozess lebt, Runde offen, genau 30:00 still", row({ lastActivityAt: minutesAgo(30) }), "idle"],
    ["ruht: Prozess lebt, Runde offen, 30:01 still", row({ lastActivityAt: minutesAgo(30.0166667) }), "idle"],
    ["ruht: sehr lange still", row({ lastActivityAt: minutesAgo(600) }), "idle"],
    ["wartet: Runde durch Stop/Notification geschlossen, gerade eben", row({ turnOpen: false }), "waiting"],
    ["wartet: Runde geschlossen, schlägt 'ruht' auch nach sehr langer Stille (wartet hat Vorrang)", row({ turnOpen: false, lastActivityAt: minutesAgo(600) }), "waiting"],
    ["wartet: Runde geschlossen, keine lastActivityAt bekannt", row({ turnOpen: false, lastActivityAt: null }), "waiting"],
    ["abgestürzt: Prozess weg, kein SessionEnd, Runde war offen", row({ status: "ended", turnOpen: true, sessionEndReceivedAt: null }), "crashed"],
    ["beendet (kein Laufzeit-Zustand): Prozess weg, kein SessionEnd, aber Runde war zu (Stop kam noch durch)", row({ status: "ended", turnOpen: false, sessionEndReceivedAt: null }), null],
    ["beendet (kein Laufzeit-Zustand): Prozess weg, SessionEnd kam, Runde war offen", row({ status: "ended", turnOpen: true, sessionEndReceivedAt: minutesAgo(1) }), null],
    ["beendet (kein Laufzeit-Zustand): Prozess weg, SessionEnd kam, Runde war zu", row({ status: "ended", turnOpen: false, sessionEndReceivedAt: minutesAgo(1) }), null],
    ["geschlossen hat Vorrang vor läuft", row({ closedAt: minutesAgo(1) }), "closed"],
    ["geschlossen hat Vorrang vor wartet", row({ closedAt: minutesAgo(1), turnOpen: false }), "closed"],
    ["geschlossen hat Vorrang vor ruht", row({ closedAt: minutesAgo(1), lastActivityAt: minutesAgo(600) }), "closed"],
    ["geschlossen hat Vorrang vor abgestürzt", row({ closedAt: minutesAgo(1), status: "ended", turnOpen: true, sessionEndReceivedAt: null }), "closed"],
    ["geschlossen hat Vorrang vor sauber beendet", row({ closedAt: minutesAgo(1), status: "ended", turnOpen: false, sessionEndReceivedAt: minutesAgo(2) }), "closed"],
    ["reopen: closedAt wieder null → normale Berechnung greift wieder (läuft)", row({ closedAt: null }), "running"],
  ])("%s", (_name, input, expected) => {
    expect(computeSessionState(input, NOW)).toBe(expected);
  });

  it("Schwelle liegt exakt bei IDLE_AFTER_MS = 30 Minuten", () => {
    expect(IDLE_AFTER_MS).toBe(30 * 60 * 1000);
    const justUnder = row({ lastActivityAt: new Date(NOW - (IDLE_AFTER_MS - 1)).toISOString() });
    const exact = row({ lastActivityAt: new Date(NOW - IDLE_AFTER_MS).toISOString() });
    expect(computeSessionState(justUnder, NOW)).toBe("running");
    expect(computeSessionState(exact, NOW)).toBe("idle");
  });
});
