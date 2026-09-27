// Kontext-Wächter — reine Funktionen (kein DB-/Netz-Zugriff): Auflösung Session > Modell >
// Standard (Haiku separat), Validierung der Schwellen, Prozent → Token-Grenze.
import { describe, expect, it } from "vitest";
import {
  CONTEXT_GUARD_DEFAULT,
  ContextGuardThresholdsInputSchema,
  codexFallbackContextWindow,
  pctToTokenLimit,
  resolveContextGuardThresholds,
  type ContextGuardThresholdsInput,
} from "../src/context-guard.js";

const T = (hinweisPct: number, erzwingenPct: number | null = null, erzwingenEnabled = erzwingenPct !== null): ContextGuardThresholdsInput => ({
  hinweisPct,
  erzwingenEnabled,
  erzwingenPct,
});

describe("resolveContextGuardThresholds — Auflösung", () => {
  const defaults = T(60, 80);
  const haiku = T(70, 90);

  it("nur Standard, wenn nichts überschrieben ist", () => {
    expect(resolveContextGuardThresholds({ defaults, haiku, modelOverride: null, sessionOverride: null, isHaiku: false })).toMatchObject({ ...defaults, source: "default" });
  });

  it("Modell schlägt Standard", () => {
    const model = T(55, 85);
    expect(resolveContextGuardThresholds({ defaults, haiku, modelOverride: model, sessionOverride: null, isHaiku: false })).toMatchObject({ ...model, source: "model" });
  });

  it("Session schlägt Modell und Standard", () => {
    const model = T(55, 85);
    const session = T(50, 75);
    expect(resolveContextGuardThresholds({ defaults, haiku, modelOverride: model, sessionOverride: session, isHaiku: false })).toMatchObject({ ...session, source: "session" });
  });

  it("Haiku ersetzt den Standard (nicht das Modell) für Haiku-Sessions", () => {
    expect(resolveContextGuardThresholds({ defaults, haiku, modelOverride: null, sessionOverride: null, isHaiku: true })).toMatchObject({ ...haiku, source: "haiku" });
  });

  it("Session schlägt auch bei einer Haiku-Session (stärkste Stufe)", () => {
    const session = T(50, 75);
    expect(resolveContextGuardThresholds({ defaults, haiku, modelOverride: null, sessionOverride: session, isHaiku: true })).toMatchObject({ ...session, source: "session" });
  });

  it("Standard aus GESAMT-STAND (60 % Hinweis, 80 % Erzwingen)", () => {
    expect(CONTEXT_GUARD_DEFAULT).toEqual({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 });
  });
});

describe("ContextGuardThresholdsInputSchema — Validierung", () => {
  it("50–100 Pflichtbereich", () => {
    expect(ContextGuardThresholdsInputSchema.safeParse(T(49, 80)).success).toBe(false);
    expect(ContextGuardThresholdsInputSchema.safeParse(T(60, 101)).success).toBe(false);
    expect(ContextGuardThresholdsInputSchema.safeParse(T(50, 100)).success).toBe(true);
  });

  it("hinweisPct darf erzwingenPct nicht überschreiten", () => {
    expect(ContextGuardThresholdsInputSchema.safeParse(T(80, 60)).success).toBe(false);
    expect(ContextGuardThresholdsInputSchema.safeParse(T(60, 60)).success).toBe(true);
  });

  it("erzwingenEnabled=true ohne erzwingenPct ist ungültig", () => {
    expect(ContextGuardThresholdsInputSchema.safeParse({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: null }).success).toBe(false);
  });

  it("Erzwingen abschaltbar ohne erzwingenPct", () => {
    expect(ContextGuardThresholdsInputSchema.safeParse({ hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: null }).success).toBe(true);
  });
});

describe("pctToTokenLimit / codexFallbackContextWindow", () => {
  it("rechnet Prozent des Fensters in Tokens um", () => {
    expect(pctToTokenLimit(80, 258_400)).toBe(206_720);
    expect(pctToTokenLimit(100, 1000)).toBe(1000);
  });

  it("unbekanntes Modell → null (nie geraten)", () => {
    expect(codexFallbackContextWindow("unbekanntes-modell-xyz")).toBeNull();
    expect(codexFallbackContextWindow(null)).toBeNull();
    expect(codexFallbackContextWindow("gpt-6-astra")).toBe(258_400);
  });
});
