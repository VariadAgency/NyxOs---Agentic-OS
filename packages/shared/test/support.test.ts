// Contracts and diagnostics clean-up of "Feedback & Unterstützen" (support.ts).
import { describe, expect, it } from "vitest";
import {
  describeUserAgent,
  readSupportEmbedMessage,
  sanitizeDiagnosticText,
  sanitizeDiagnostics,
  sanitizePagePath,
  SUPPORT_LIMITS,
  SUPPORT_URL_DEFAULT,
  SupportBugInputSchema,
  SupportDonateInputSchema,
  SupportDraftInputSchema,
  SupportIdeaInputSchema,
  supportOriginOf,
  type SupportDiagnostics,
} from "../src/support.js";

const DIRTY = [
  "ENOENT: no such file or directory, open '/Users/alex-example/Projects/secret-app/src/index.ts'",
  "fetch failed: https://build-box.example.org:8443/api/run?token=abc (from mac-mini.tail1234.ts.net)",
  "connect ECONNREFUSED 192.168.178.20:5432 and fe80::1ff:fe23:4567:890a",
  "Contact alex.example@mail-example.com – Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
  "session 3f2b8c1e-9a4d-4e21-b7c0-5d6e7f8a9b0c key sk-ant-api03-example_key_value_1234567890",
  "C:\\Users\\alex-example\\AppData\\Local\\nyxos\\log.txt and ~/Library/Logs/nyxos.log",
  "Hallo Alexandra, dein Rechner alexandra-mbp",
  "raw 0123456789abcdef0123456789abcdef and ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234",
].join("\n");

describe("sanitizeDiagnosticText", () => {
  const clean = sanitizeDiagnosticText(DIRTY, { words: ["Alexandra"] });

  it("entfernt Pfade, Hostnamen, IPs, E-Mails, Tokens, IDs und persönliche Wörter", () => {
    expect(clean).not.toMatch(/\/Users\/|alex-example|secret-app|AppData|Library\/Logs/);
    expect(clean).not.toMatch(/build-box|example\.org|tail1234|ts\.net/);
    expect(clean).not.toMatch(/192\.168|fe80::/);
    expect(clean).not.toMatch(/@|mail-example/);
    expect(clean).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123|sk-ant|example_key|token=abc/);
    expect(clean).not.toMatch(/3f2b8c1e|0123456789abcdef0123|ABCDEFGHIJKLMNOP/);
    expect(clean).not.toMatch(/Alexandra/i);
    // what is left still helps
    expect(clean).toContain("ENOENT");
    expect(clean).toContain("https://[host]");
    expect(clean).toContain("[path]");
    expect(clean).toContain("[ip]");
    expect(clean).toContain("[email]");
    expect(clean).toContain("[id]");
    expect(clean).toContain("[name]");
  });

  it("ist idempotent (Vorschau = das, was der Server weiterreicht)", () => {
    expect(sanitizeDiagnosticText(clean, { words: ["Alexandra"] })).toBe(clean);
  });

  it("lässt API-Wege, Uhrzeiten und normale Sätze stehen", () => {
    const s = "POST /api/support/bug antwortete 500 um 12:30:45 – Server hat ein Problem";
    expect(sanitizeDiagnosticText(s)).toBe(s);
  });
});

describe("sanitizeDiagnostics", () => {
  const raw: SupportDiagnostics = {
    version: "0.1.0",
    mode: "local",
    os: "macOS",
    browser: "Chrome 140",
    page: "/sessions/coding/secret-project/3f2b8c1e-9a4d-4e21-b7c0-5d6e7f8a9b0c?tab=terminal",
    language: "de",
    errors: Array.from({ length: 14 }, (_, i) => ({ source: "browser" as const, at: "2026-09-28T10:00:00.000Z", message: `Fehler ${i} in /home/alex-example/app.js ${"x".repeat(400)}` })),
  };
  const clean = sanitizeDiagnostics(raw);

  it("zeigt nur den Bereich der Seite und höchstens 10 kurze Fehler", () => {
    expect(clean.page).toBe("/sessions/…");
    expect(clean.errors).toHaveLength(SUPPORT_LIMITS.errors);
    expect(clean.errors[0]?.message).toContain("Fehler 4");
    for (const e of clean.errors) {
      expect(e.message.length).toBeLessThanOrEqual(SUPPORT_LIMITS.errorChars);
      expect(e.message).not.toContain("/home/");
    }
    expect(sanitizeDiagnostics(clean)).toEqual(clean);
  });

  it("Seitenpfade", () => {
    expect(sanitizePagePath("/overview")).toBe("/overview");
    expect(sanitizePagePath("/")).toBe("/");
    expect(sanitizePagePath("/Users/x")).toBe("/");
    expect(sanitizePagePath("/einstellungen/nyx#a")).toBe("/einstellungen/…");
  });
});

describe("describeUserAgent", () => {
  it("nur Familie + Hauptversion", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36")).toEqual({ browser: "Chrome 140", os: "macOS" });
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")).toEqual({ browser: "Safari 26", os: "iOS" });
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0")).toEqual({ browser: "Firefox 150", os: "Windows" });
    expect(describeUserAgent("")).toEqual({ browser: "unknown", os: "unknown" });
  });
});

describe("Verträge", () => {
  it("Fehlermeldung: Pflichtfeld, E-Mail optional, leere E-Mail wird null", () => {
    expect(SupportBugInputSchema.safeParse({ what: "" }).success).toBe(false);
    const ok = SupportBugInputSchema.parse({ what: "Knopf reagiert nicht", email: "" });
    expect(ok).toMatchObject({ what: "Knopf reagiert nicht", before: "", expected: "", email: null, diagnostics: null, screenshot: null });
    expect(SupportBugInputSchema.safeParse({ what: "Knopf reagiert nicht", email: "kein-mail" }).success).toBe(false);
    expect(SupportBugInputSchema.safeParse({ what: "x".repeat(SUPPORT_LIMITS.textChars + 1) }).success).toBe(false);
  });

  it("Bildschirmfoto: nur Bildtypen, Größenlimit", () => {
    const shot = { name: "a.png", type: "image/png", dataBase64: "iVBORw0KGgo=" };
    expect(SupportBugInputSchema.safeParse({ what: "abc", screenshot: shot }).success).toBe(true);
    expect(SupportBugInputSchema.safeParse({ what: "abc", screenshot: { ...shot, type: "image/svg+xml" } }).success).toBe(false);
    const tooBig = "A".repeat(Math.ceil(SUPPORT_LIMITS.screenshotBytes / 3) * 4 + 4);
    expect(SupportBugInputSchema.safeParse({ what: "abc", screenshot: { ...shot, dataBase64: tooBig } }).success).toBe(false);
  });

  it("Idee: drei Stufen", () => {
    expect(SupportIdeaInputSchema.safeParse({ title: "Dunkles Thema", description: "Bitte heller", importance: "important" }).success).toBe(true);
    expect(SupportIdeaInputSchema.safeParse({ title: "Dunkles Thema", description: "Bitte heller", importance: "egal" }).success).toBe(false);
  });

  it("Spende: 1 € bis 1000 €, einmalig/monatlich, Euro", () => {
    expect(SupportDonateInputSchema.parse({ amountCents: 500, interval: "once" })).toEqual({ amountCents: 500, currency: "EUR", interval: "once", name: "", message: "", publicThanks: false });
    expect(SupportDonateInputSchema.safeParse({ amountCents: 50, interval: "once" }).success).toBe(false);
    expect(SupportDonateInputSchema.safeParse({ amountCents: 500, interval: "yearly" }).success).toBe(false);
    expect(SupportDonateInputSchema.safeParse({ amountCents: 500.5, interval: "once" }).success).toBe(false);
  });

  it("Entwurf (Nyx) je Art", () => {
    expect(SupportDraftInputSchema.parse({ kind: "idea", title: "X" })).toEqual({ kind: "idea", title: "X", description: "", importance: "important" });
    expect(SupportDraftInputSchema.safeParse({ kind: "donate" }).success).toBe(false);
  });

  it("Standard-Adresse ist leer (Meldestelle noch nicht eingerichtet)", () => {
    expect(SUPPORT_URL_DEFAULT).toBe("");
    expect(supportOriginOf("https://support.example.org/v1")).toBe("https://support.example.org");
    expect(supportOriginOf("javascript:alert(1)")).toBeNull();
  });
});

describe("Nachrichten der Bezahlseite (postMessage)", () => {
  const frame = {};
  const origin = "https://support.example.org";

  it("nur von der erlaubten Herkunft und aus genau diesem Rahmen", () => {
    expect(readSupportEmbedMessage({ origin, source: frame, data: { type: "nyxos-support:paid", reference: "D-1" } }, { origin, source: frame })).toEqual({ type: "nyxos-support:paid", reference: "D-1" });
    expect(readSupportEmbedMessage({ origin: "https://evil.example.com", source: frame, data: { type: "nyxos-support:paid" } }, { origin, source: frame })).toBeNull();
    expect(readSupportEmbedMessage({ origin, source: {}, data: { type: "nyxos-support:paid" } }, { origin, source: frame })).toBeNull();
    expect(readSupportEmbedMessage({ origin, source: frame, data: { type: "nyxos-support:paid" } }, { origin: null, source: frame })).toBeNull();
  });

  it("unbekannte Formen werden ignoriert", () => {
    expect(readSupportEmbedMessage({ origin, data: "nyxos-support:paid" }, { origin })).toBeNull();
    expect(readSupportEmbedMessage({ origin, data: { type: "nyxos-support:refund" } }, { origin })).toBeNull();
    expect(readSupportEmbedMessage({ origin, data: { type: "nyxos-support:resize", height: 99999 } }, { origin })).toBeNull();
    expect(readSupportEmbedMessage({ origin, data: { type: "nyxos-support:cancelled" } }, { origin })).toEqual({ type: "nyxos-support:cancelled" });
  });
});
