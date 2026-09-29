// Anbieter-Farben (vorher hatten DeepSeek und Gemini dieselbe Farbe, OpenRouter fast dieselbe):
// jeder Anbieter hat einen eigenen, klar anderen Farbton; OpenAI = App-Blau.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_KINDS } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { PROVIDER_COLOR } from "../src/features/settings/providerColors";

const css = readFileSync(join(__dirname, "..", "src", "app.css"), "utf8");
// Nur der erste (dunkle Standard-)Block `:root` zählt – Tokens stehen dort als Hex.
const tokenHex = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m?.[1]) throw new Error(`Token --${name} ohne Hex-Wert`);
  return m[1].toLowerCase();
};
const hexOf = (color: string): string => {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(color);
  if (!m?.[1]) throw new Error(`keine Token-Farbe: ${color}`);
  return tokenHex(m[1]);
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe("Anbieter-Farben", () => {
  it("jeder Anbieter hat eine Farbe", () => {
    for (const k of PROVIDER_KINDS) expect(PROVIDER_COLOR[k], k).toBeTruthy();
  });

  it("OpenAI nutzt das App-Blau (--a-acc), Anthropic das Claude-Orange", () => {
    expect(PROVIDER_COLOR.openai).toBe("var(--a-acc)");
    expect(hexOf(PROVIDER_COLOR.openai)).toBe("#4da3ff");
    expect(PROVIDER_COLOR.anthropic).toBe("var(--a-claude)");
  });

  it("alle Farben sind paarweise klar verschieden (auch die aufgelösten Hex-Werte)", () => {
    const entries = PROVIDER_KINDS.map((k) => [k, hexOf(PROVIDER_COLOR[k])] as const);
    expect(new Set(entries.map(([, h]) => h)).size).toBe(entries.length);
    // Mindestabstand im RGB-Raum – „fast gleich“ (vorher Indigo #7b8cff neben Blau #4da3ff ≈ 52) fällt durch.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [ka, ha] = entries[i] as readonly [string, string];
        const [kb, hb] = entries[j] as readonly [string, string];
        const [a, b] = [rgb(ha), rgb(hb)];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        expect(dist, `${ka} ${ha} vs ${kb} ${hb}`).toBeGreaterThan(70);
      }
    }
  });
});
