// Schlau einfügen (Schlüssel-Art am Präfix/Namen) + Modell-Katalog mit genauen Kennungen.
import { describe, expect, it } from "vitest";
import { ACCESS_IDS, ACCESS_ITEMS, catalogModel, describeModel, detectCredentialKind, detectCredentials, formatContext, formatPrice, MODEL_CATALOG } from "../src/access.js";

const TG = "123456789:AAH-abcdefghijklmnopqrstuvwxyz01234";
// Unechte Anthropic-Schlüssel, zusammengesetzt, damit kein Geheimnis-Scanner im Quelltext anschlägt.
const ANT_PREFIX = "sk-ant-api03-";
const ANT = ANT_PREFIX + "abcdefghijklmnopqrstuvwxyz0123";
const ANT_SECOND = ANT_PREFIX + "zweiterSchluesselDerIgnoriertWird000";

describe("detectCredentialKind", () => {
  it.each([
    [ANT, "anthropic"],
    ["sk-or-v1-0123456789abcdef0123456789abcdef", "openrouter"],
    ["sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "openai"],
    ["sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh", "openai"],
    ["sk-0123456789abcdef0123456789abcdef", "deepseek"],
    ["AIzaSyA-0123456789abcdefghijklmnopqrstu", "gemini"],
    [TG, "telegram"],
    ["gsk_abcdefghijklmnopqrstuvwxyz0123", "groq"],
    ["xai-abcdefghijklmnopqrstuvwxyz0123", "xai"],
    ["http://127.0.0.1:11434/v1", "ollama"],
    ["http://localhost:1234/v1", "lmstudio"],
  ])("%s → %s", (value, id) => {
    expect(detectCredentialKind(value)).toBe(id);
  });

  it("rät nie bei Unbekanntem", () => {
    expect(detectCredentialKind("hallo")).toBeNull();
    expect(detectCredentialKind("sk-kurz")).toBeNull();
    expect(detectCredentialKind("123:abc")).toBeNull();
  });
});

describe("detectCredentials", () => {
  it("erkennt viele Schlüssel in einem Text (Liste, .env, Anführungszeichen) – je Zugang der erste", () => {
    const text = [
      "Hier meine Schlüssel:",
      `${ANT}, sk-or-v1-0123456789abcdef0123456789abcdef`,
      'export OPENAI_API_KEY="sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"',
      `TELEGRAM_BOT_TOKEN=${TG}`,
      "AIzaSyA-0123456789abcdefghijklmnopqrstu",
      ANT_SECOND,
    ].join("\n");
    const found = detectCredentials(text);
    const byId = Object.fromEntries(found.map((f) => [f.id, f]));
    expect(Object.keys(byId).sort()).toEqual(["anthropic", "gemini", "openai", "openrouter", "telegram"]);
    expect(byId.anthropic?.value).toBe(ANT);
    expect(byId.openai).toMatchObject({ value: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", by: "name" });
    expect(byId.telegram?.value).toBe(TG);
  });
});

describe("Zugänge", () => {
  it("jeder Zugang hat Zweck, Schritte und offiziellen Link", () => {
    expect(ACCESS_ITEMS.map((i) => i.id).sort()).toEqual([...ACCESS_IDS].sort());
    for (const i of ACCESS_ITEMS) {
      expect(i.purpose.length).toBeGreaterThan(10);
      expect(i.steps.length).toBeGreaterThan(0);
      expect(i.link.url).toMatch(/^https:\/\//);
    }
    expect(ACCESS_ITEMS.find((i) => i.id === "telegram")?.link.url).toContain("BotFather");
  });
});

describe("Modell-Katalog", () => {
  it("nennt genaue Kennungen und Versionen", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    for (const id of ["claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"]) expect(ids).toContain(id);
    expect(describeModel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5 · claude-haiku-4-5-20251001");
    expect(describeModel("haiku")).toBe("Claude Haiku 4.5 · claude-haiku-4-5-20251001");
    expect(describeModel("irgendwas-neues")).toBe("irgendwas-neues");
    expect(catalogModel("claude-opus-5-5")).toMatchObject({ name: "Claude Opus 5.5", context: 1_000_000, priceIn: 4, priceOut: 20 });
  });

  it("zeigt Kontext und Preis kurz", () => {
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(200_000)).toBe("200K");
    expect(formatPrice({ priceIn: 1, priceOut: 5 })).toBe("$1 / $5");
    expect(formatPrice({ priceIn: 0.05, priceOut: 0.4, approx: true })).toBe("ca. $0.05 / $0.4");
  });
});
