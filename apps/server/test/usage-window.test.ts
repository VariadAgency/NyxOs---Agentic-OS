// Nutzung: Heatmap Tag × Stunde und Fenster-Stand (Ringe im Tab „Nutzung", Kachel „Max-Fenster").
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const row = (over: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(),
  tool: "claude",
  model: "claude-opus-5",
  project: "andere",
  sessionKey: null,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  reasoning: 0,
  ...over,
});

type Hourly = { cells: { dow: number; hour: number; tokens: number }[] };
type Windows = { windows: { tool: string; tokens5h: number; peak5h: number; tokens7d: number; peak7d: number; hourly24: number[]; reported: { limitReached: boolean } }[] };

describe("GET /api/usage/hourly + /api/usage/window", () => {
  it("Heatmap bucketet nach Berliner Wochentag/Stunde (ISO: 1 = Montag)", async () => {
    const { post, app } = await setup();
    const ts = new Date(Date.now() - 2 * 86_400_000);
    ts.setUTCHours(22, 30, 0, 0); // 22:30 UTC = 00:30 Berlin am Folgetag (Sommerzeit) — Tages- UND Stundenwechsel
    expect((await post("/ingest/usage", { items: [row({ ts: ts.toISOString(), input: 10 })] })).status).toBe(200);
    const body = (await (await app.request("/api/usage/hourly?range=7")).json()) as Hourly;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(ts);
    const hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "") + 1;
    expect(body.cells).toEqual([{ dow, hour, tokens: 10 }]);
  });

  it("Heatmap filtert nach Werkzeug und Zeitraum", async () => {
    const { post, app } = await setup();
    await post("/ingest/usage", {
      items: [row({ input: 5 }), row({ tool: "codex", model: "gpt-6", input: 7 }), row({ ts: new Date(Date.now() - 20 * 86_400_000).toISOString(), input: 3 })],
    });
    const codex = (await (await app.request("/api/usage/hourly?range=7&tool=codex")).json()) as Hourly;
    expect(codex.cells.reduce((a, c) => a + c.tokens, 0)).toBe(7);
    const week = (await (await app.request("/api/usage/hourly?range=7")).json()) as Hourly;
    expect(week.cells.reduce((a, c) => a + c.tokens, 0)).toBe(12);
    const month = (await (await app.request("/api/usage/hourly?range=30")).json()) as Hourly;
    expect(month.cells.reduce((a, c) => a + c.tokens, 0)).toBe(15);
  });

  it("Fenster: 5-Std-Summe, Spitzenwert nie kleiner als der aktuelle Wert, 24 Stundenwerte", async () => {
    const { post, app } = await setup();
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    await post("/ingest/usage", { items: [row({ ts: at(1), input: 100 }), row({ ts: at(30), input: 900 })] });
    const body = (await (await app.request("/api/usage/window")).json()) as Windows;
    const claude = body.windows.find((w) => w.tool === "claude");
    expect(claude?.tokens5h).toBe(100);
    expect(claude?.peak5h).toBe(900);
    expect(claude?.tokens7d).toBe(1000);
    expect(claude?.peak7d).toBeGreaterThanOrEqual(1000);
    expect(claude?.hourly24).toHaveLength(24);
    expect(claude?.hourly24.reduce((a, b) => a + b, 0)).toBe(100);
    expect(claude?.reported.limitReached).toBe(false);
    const codex = body.windows.find((w) => w.tool === "codex");
    expect(codex?.tokens5h).toBe(0);
  });
});
