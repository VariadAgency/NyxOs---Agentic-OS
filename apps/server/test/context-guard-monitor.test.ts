// Kontext-Wächter — reine Entscheidungsfunktion: Hinweis genau einmal je Überschreitung,
// Erzwingen nur bei "wartet" + tmux, kein Doppel-Senden, Rücksetzen bei sinkendem Kontext-Anteil.
import type { ResolvedContextGuardThresholds } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { decideContextGuardActions } from "../src/context-guard/monitor.js";

const thresholds: ResolvedContextGuardThresholds = { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, source: "default" };
const freshState = { hinweisNotifiedAt: null, erzwingenAttemptedAt: null };

describe("decideContextGuardActions", () => {
  it("unbekannter Kontext-Anteil (null) → nichts tun", () => {
    expect(decideContextGuardActions({ pct: null, thresholds, sessionState: "waiting", attachable: true, state: freshState })).toEqual({
      notify: false,
      resetHinweis: false,
      forceCompact: false,
      resetErzwingen: false,
    });
  });

  it("unter der Hinweis-Schwelle → kein Hinweis, kein Erzwingen", () => {
    expect(decideContextGuardActions({ pct: 59, thresholds, sessionState: "waiting", attachable: true, state: freshState }).notify).toBe(false);
  });

  it("über der Hinweis-Schwelle, unter Erzwingen → genau einmal Hinweis", () => {
    const d = decideContextGuardActions({ pct: 65, thresholds, sessionState: "running", attachable: true, state: freshState });
    expect(d).toMatchObject({ notify: true, forceCompact: false });
  });

  it("kein zweiter Hinweis, solange schon notifiziert (kein Doppel-Senden)", () => {
    const already = { hinweisNotifiedAt: "2026-09-25T00:00:00Z", erzwingenAttemptedAt: null };
    const d = decideContextGuardActions({ pct: 65, thresholds, sessionState: "running", attachable: true, state: already });
    expect(d.notify).toBe(false);
  });

  it("über Erzwingen-Schwelle + wartet + tmux → Erzwingen", () => {
    const d = decideContextGuardActions({ pct: 85, thresholds, sessionState: "waiting", attachable: true, state: freshState });
    expect(d.forceCompact).toBe(true);
  });

  it("über Erzwingen-Schwelle, aber Runde läuft noch (nicht 'waiting') → kein Erzwingen", () => {
    const d = decideContextGuardActions({ pct: 85, thresholds, sessionState: "running", attachable: true, state: freshState });
    expect(d.forceCompact).toBe(false);
  });

  it("über Erzwingen-Schwelle, wartet, aber nicht in tmux (attachable=false) → kein Erzwingen", () => {
    const d = decideContextGuardActions({ pct: 85, thresholds, sessionState: "waiting", attachable: false, state: freshState });
    expect(d.forceCompact).toBe(false);
  });

  it("kein zweiter Erzwingen-Versuch, solange schon versucht (kein Doppel-Senden/keine Schleife)", () => {
    const already = { hinweisNotifiedAt: "2026-09-25T00:00:00Z", erzwingenAttemptedAt: "2026-09-25T00:01:00Z" };
    const d = decideContextGuardActions({ pct: 85, thresholds, sessionState: "waiting", attachable: true, state: already });
    expect(d.forceCompact).toBe(false);
  });

  it("Erzwingen bleibt vorgemerkt, solange Session noch nicht wartet — sobald sie wartet, wird versucht", () => {
    const running = decideContextGuardActions({ pct: 85, thresholds, sessionState: "running", attachable: true, state: freshState });
    expect(running.forceCompact).toBe(false); // noch nicht versucht — kein Merker gesetzt
    const waiting = decideContextGuardActions({ pct: 85, thresholds, sessionState: "waiting", attachable: true, state: freshState });
    expect(waiting.forceCompact).toBe(true);
  });

  it("Kontext-Anteil sinkt wieder unter die Hinweis-Schwelle → beide Merker zurücksetzen", () => {
    const already = { hinweisNotifiedAt: "2026-09-25T00:00:00Z", erzwingenAttemptedAt: "2026-09-25T00:01:00Z" };
    const d = decideContextGuardActions({ pct: 40, thresholds, sessionState: "waiting", attachable: true, state: already });
    expect(d).toMatchObject({ notify: false, forceCompact: false, resetHinweis: true, resetErzwingen: true });
  });

  it("Kontext-Anteil sinkt unter Erzwingen, bleibt aber über Hinweis → nur Erzwingen-Merker zurücksetzen", () => {
    const already = { hinweisNotifiedAt: "2026-09-25T00:00:00Z", erzwingenAttemptedAt: "2026-09-25T00:01:00Z" };
    const d = decideContextGuardActions({ pct: 70, thresholds, sessionState: "waiting", attachable: true, state: already });
    expect(d).toMatchObject({ resetHinweis: false, resetErzwingen: true });
  });

  it("Erzwingen abgeschaltet → nie forceCompact, Hinweis funktioniert weiter", () => {
    const off: ResolvedContextGuardThresholds = { hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: null, source: "default" };
    const d = decideContextGuardActions({ pct: 95, thresholds: off, sessionState: "waiting", attachable: true, state: freshState });
    expect(d).toMatchObject({ notify: true, forceCompact: false });
  });
});

describe("contextPctSourceFromEnv — Test-Überschreibung für den echten Nachweis auf der Probe", () => {
  it("ohne Umgebungsvariable → unbekannt (null), nie geraten", async () => {
    const { contextPctSourceFromEnv } = await import("../src/context-guard/tick.js");
    const src = contextPctSourceFromEnv({});
    expect(src({ id: "x" } as never)).toBeNull();
  });

  it("gültiger Wert → konstanter Test-Kontext-Anteil für jede Session", async () => {
    const { contextPctSourceFromEnv } = await import("../src/context-guard/tick.js");
    const src = contextPctSourceFromEnv({ NYXOS_CONTEXT_GUARD_TEST_PCT: "95" });
    expect(src({ id: "a" } as never)).toBe(95);
    expect(src({ id: "b" } as never)).toBe(95);
  });

  it("ungültiger Wert (außerhalb 0-100, keine Zahl) → null statt geraten", async () => {
    const { contextPctSourceFromEnv } = await import("../src/context-guard/tick.js");
    expect(contextPctSourceFromEnv({ NYXOS_CONTEXT_GUARD_TEST_PCT: "abc" })({ id: "x" } as never)).toBeNull();
    expect(contextPctSourceFromEnv({ NYXOS_CONTEXT_GUARD_TEST_PCT: "150" })({ id: "x" } as never)).toBeNull();
  });
});

describe("contextPctFromSession/defaultContextPctSource — Verdrahtung mit der Kontext-Berechnung (getContextPct ← computeContextPct)", () => {
  const row = { id: "claude:a", lastUsage: { input: 100_000, output: 0, cacheRead: 400_000, cacheCreation: 0 }, lastUsageModel: "claude-opus-5", modelContextWindow: null } as never;

  it("contextPctFromSession rechnet den echten Anteil aus lastUsage/lastUsageModel/modelContextWindow (computeContextPct 1:1)", async () => {
    const { contextPctFromSession } = await import("../src/context-guard/tick.js");
    expect(contextPctFromSession(row)).toBe(50);
  });

  it("contextPctFromSession ohne Nutzungsdaten → null (nie geraten)", async () => {
    const { contextPctFromSession } = await import("../src/context-guard/tick.js");
    expect(contextPctFromSession({ id: "claude:b", lastUsage: null, lastUsageModel: null, modelContextWindow: null } as never)).toBeNull();
  });

  it("contextPctFromSession rundet auf eine ganze Zahl (computeContextPct liefert eine Nachkommastelle, `context_guard_state.last_pct` ist `integer` — ungerundet schlug jedes Ingest mit einem DB-Fehler fehl)", async () => {
    const { contextPctFromSession } = await import("../src/context-guard/tick.js");
    // 3.266/8.000 = 40,825 % → computeContextPct rundet auf eine Nachkommastelle (40,8);
    // contextPctFromSession muss zusätzlich auf eine ganze Zahl runden (41).
    const decimalRow = { id: "claude:c", lastUsage: { input: 3266, output: 0, cacheRead: 0, cacheCreation: 0 }, lastUsageModel: "claude-opus-5", modelContextWindow: 8000 } as never;
    const pct = contextPctFromSession(decimalRow);
    expect(pct).toBe(41);
    expect(Number.isInteger(pct)).toBe(true);
  });

  it("defaultContextPctSource: Test-Überschreibung hat Vorrang vor dem echten Wert", async () => {
    const { defaultContextPctSource } = await import("../src/context-guard/tick.js");
    const src = defaultContextPctSource({ NYXOS_CONTEXT_GUARD_TEST_PCT: "95" });
    expect(src(row)).toBe(95);
  });

  it("defaultContextPctSource: ohne Test-Überschreibung → echter Wert aus der Session", async () => {
    const { defaultContextPctSource } = await import("../src/context-guard/tick.js");
    const src = defaultContextPctSource({});
    expect(src(row)).toBe(50);
  });
});
