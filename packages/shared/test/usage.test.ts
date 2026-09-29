import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PRICES, computeContextPct, computeCost, findPrice, resolveContextWindow, type ModelPrice } from "../src/usage.js";

/** Wirft, statt `undefined` durchzureichen — die eingebauten Modelle müssen immer da sein. */
function mustPrice(model: string): ModelPrice {
  const price = findPrice(model);
  if (!price) throw new Error(`Testvoraussetzung: eingebauter Preis für ${model} fehlt`);
  return price;
}

describe("computeCost", () => {
  it("rechnet Claude-Kosten mit dem 1-Std-Cache-Satz (Abgleich gegen echte ccusage-Zahlen, 2026-08-19)", () => {
    const price = mustPrice("claude-opus-5");
    // input=472, output=178041, cacheRead=81677137, cacheCreation1h=842207 (alles 1-Std-TTL) →
    // ccusage lieferte für exakt diese Zahlen 53.714023500000025 USD.
    const cost = computeCost(price, { input: 472, output: 178041, cacheRead: 81677137, cacheCreation5m: 0, cacheCreation1h: 842207 });
    expect(cost).not.toBeNull();
    expect(cost ?? Number.NaN).toBeCloseTo(53.714023500000025, 6);
  });

  it("rechnet Codex-Kosten (Abgleich gegen echte ccusage-Zahlen, 2026-09-07, gpt-6-astra + gpt-5.6-terra)", () => {
    const astra = mustPrice("gpt-6-astra");
    const terra = mustPrice("gpt-5.6-terra");
    const costAstra = computeCost(astra, { input: 3195419, output: 270243, cacheRead: 65728768, cacheCreation5m: 0, cacheCreation1h: 0 });
    const costTerra = computeCost(terra, { input: 211138, output: 14214, cacheRead: 1259264, cacheCreation5m: 0, cacheCreation1h: 0 });
    expect((costAstra ?? 0) + (costTerra ?? 0)).toBeCloseTo(112.03980480000001, 4);
  });

  it("liefert null ohne Preis (nie schätzen)", () => {
    expect(computeCost(undefined, { input: 1, output: 1, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 })).toBeNull();
  });

  it("nutzt den 5-Minuten-Satz, wenn kein 1-Std-Satz hinterlegt ist", () => {
    const price = mustPrice("claude-sonnet-5");
    expect(price.cacheCreation1hPerToken).toBeNull();
    const cost = computeCost(price, { input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 1000 });
    expect(cost).toBeCloseTo(1000 * price.cacheCreation5mPerToken, 9);
  });
});

describe("resolveContextWindow", () => {
  it("bevorzugt das live gemeldete Kontextfenster (Codex) vor der Tabelle", () => {
    expect(resolveContextWindow("gpt-6-astra", 258_400).window).toBe(258_400);
  });
  it("fällt auf die Tabelle zurück, wenn kein Live-Wert vorliegt", () => {
    expect(resolveContextWindow("claude-opus-5", null).window).toBe(1_000_000);
  });
  it("liefert null bei unbekanntem Modell (nie raten)", () => {
    expect(resolveContextWindow("irgendein-neues-modell", null)).toEqual({ window: null, source: null });
  });
});

describe("computeContextPct", () => {
  it("rechnet Input+Cache-Lesen+Cache-Schreiben gegen das Kontextfenster", () => {
    const pct = computeContextPct({ input: 100_000, cacheRead: 400_000, cacheCreation: 0 }, "claude-opus-5", null);
    expect(pct).toBe(50);
  });
  it("liefert null ohne Nutzung", () => {
    expect(computeContextPct(null, "claude-opus-5", null)).toBeNull();
  });
  it("liefert null bei unbekanntem Kontextfenster", () => {
    expect(computeContextPct({ input: 1, cacheRead: 0, cacheCreation: 0 }, "unbekanntes-modell", null)).toBeNull();
  });
});

describe("BUILTIN_MODEL_PRICES", () => {
  it("hat für jedes Modell eine Quelle", () => {
    for (const p of BUILTIN_MODEL_PRICES) expect(p.source.length).toBeGreaterThan(0);
  });
});
