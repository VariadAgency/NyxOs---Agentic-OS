// Telegram-Start: mit echtem Token blieb früher NyxOS ewig auf „Verbindet mit Telegram …“ – grammY wiederholt Netzfehler beim
// Start still und endlos. Jetzt: erst ein direkter getMe-Aufruf, Fehler landen im Log und als Satz.
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import { errorDetail, TelegramService } from "../src/telegram/service.js";
import { staticTokenSource } from "../src/telegram/tokens.js";
import { sharedDb } from "./helpers.js";

const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Telegram-Start hängt nicht still", () => {
  it("Netzfehler beim Start → Zustand „error“ mit Satz und Log (nicht ewig „starting“)", async () => {
    const db = await sharedDb();
    const logs: { msg: string; data?: Record<string, unknown> }[] = [];
    const svc = new TelegramService({
      db,
      tokens: staticTokenSource(TOKEN),
      log: (msg: string, data?: Record<string, unknown>) => logs.push({ msg, data }),
      // Port 9 (discard) auf localhost: Verbindung wird abgelehnt → grammY-HttpError
      botFactory: (t: string) => new Bot(t, { client: { apiRoot: "http://127.0.0.1:9" } }),
    } as never);
    await svc.start();
    const until = Date.now() + 5000;
    let st = await svc.status();
    while (st.state === "starting" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      st = await svc.status();
    }
    await svc.stop();
    expect(st.state).toBe("error");
    expect(st.sentence).toContain("Telegram");
    const fail = logs.find((l) => l.msg === "telegram-polling-fehler");
    expect(fail?.data?.kind).toBe("HttpError");
    expect(JSON.stringify(fail)).not.toContain(TOKEN.split(":")[1]);
  });

  it("errorDetail schreibt nie das Token ins Log", () => {
    const d = errorDetail(Object.assign(new Error(`Network request for 'getMe' failed! https://api.telegram.org/bot${TOKEN}/getMe`), { name: "HttpError" }));
    expect(d.detail).not.toContain(TOKEN);
    expect(d.detail).toContain("bot<token>");
  });
});

describe("Server-Bundle behält Klassennamen", () => {
  it("build.mjs bündelt mit keepNames (sonst lehnt node-fetch grammYs AbortSignal2 ab)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
    expect(src.match(/keepNames: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
