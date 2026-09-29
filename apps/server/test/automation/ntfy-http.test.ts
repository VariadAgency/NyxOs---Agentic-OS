// HttpNtfySender gegen einen echten lokalen HTTP-Empfänger statt eines Fake-Objekts: ein wirklicher `node:http`-Server nimmt die
// JSON-Veröffentlichung entgegen, wie es später ein echter ntfy-Server täte.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpNtfySender } from "../../src/push/ntfy.js";

describe("HttpNtfySender gegen einen echten lokalen HTTP-Empfänger", () => {
  let server: Server;
  let baseUrl: string;
  let received: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("schickt Titel/Text/Priorität/Klick-URL als JSON — inkl. deutscher Umlaute ohne Header-Ärger", async () => {
    const sender = new HttpNtfySender(baseUrl, "geheimes-token");
    const started = Date.now();
    const result = await sender.send({
      topic: "nyxos-test",
      title: "Wartet auf dich — Übergabe für Alex",
      message: "Die Session „Backend-Prüfung“ wartet seit 3 Minuten auf eine Rückmeldung.",
      priority: "high",
      clickUrl: "http://127.0.0.1:47801/sessions/coding/nyxos/abc",
    });
    const tookMs = Date.now() - started;

    expect(result).toEqual({ ok: true, status: 200 });
    expect(tookMs).toBeLessThan(10_000); // < 10 s

    expect(received).toHaveLength(1);
    const first = received[0];
    if (!first) throw new Error("kein Empfang aufgezeichnet");
    const { headers, body } = first;
    expect(headers.authorization).toBe("Bearer geheimes-token");
    expect(body).toEqual({
      topic: "nyxos-test",
      title: "Wartet auf dich — Übergabe für Alex",
      message: "Die Session „Backend-Prüfung“ wartet seit 3 Minuten auf eine Rückmeldung.",
      priority: 4, // "high"
      click: "http://127.0.0.1:47801/sessions/coding/nyxos/abc",
    });
  });

  it("meldet einen nicht erreichbaren Empfänger als ok:false statt zu werfen", async () => {
    const sender = new HttpNtfySender("http://127.0.0.1:1"); // niemand hört dort
    const result = await sender.send({ topic: "t", title: "t", message: "m", priority: "default", clickUrl: null });
    expect(result.ok).toBe(false);
  });
});
