// Haiku-Fäden. Ist der Motor nicht bereit, entsteht KEIN leerer Faden (2 Fäden ohne
// Antwort in der DB); der Faden kann temporär sein (Marke + Restzeit in der Liste) und umgeschaltet werden.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { haikuMessages, haikuSettings, haikuThreads } from "../../src/db/schema.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant-helpers.js";

interface ThreadOut {
  id: number;
  title: string;
  temporary: boolean;
  expiresAt: string | null;
}

describe("kein leerer Faden", () => {
  it("Motor nicht bereit: Fehler im Strom, aber weder Faden noch Nachricht in der DB", async () => {
    const engine = new FakeEngine(answer("nie"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Wer bist du?", context: CTX }));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0]).toMatchObject({ code: "not_ready" });
    expect(await t.db.select().from(haikuThreads)).toHaveLength(0);
    expect(await t.db.select().from(haikuMessages)).toHaveLength(0);
  });

  it("Haiku aus: ebenso kein Faden", async () => {
    const t = await setupAssistant();
    await t.db.insert(haikuSettings).values({ id: 1, engine: "off" }).onConflictDoUpdate({ target: haikuSettings.id, set: { engine: "off" } });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(await t.db.select().from(haikuThreads)).toHaveLength(0);
  });

  it("bestehender Faden + Motor nicht bereit: keine unbeantwortete Frage wird angehängt", async () => {
    const engine = new FakeEngine(answer("Hallo."));
    const t = await setupAssistant({ engine });
    const first = await readNdjson(await t.json("/api/haiku/chat", { message: "Eins", context: CTX }));
    const threadId = (first.find((e) => e.type === "thread") as { threadId: number }).threadId;
    engine.ok = false;
    await readNdjson(await t.json("/api/haiku/chat", { threadId, message: "Zwei", context: CTX }));
    const msgs = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, threadId));
    expect(msgs.map((m) => m.text)).toEqual(["Eins", "Hallo."]);
  });

  it("Motor bereit: Faden entsteht wie bisher (Frage + Antwort)", async () => {
    const t = await setupAssistant();
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(events[0]?.type).toBe("thread");
    expect(events.at(-1)?.type).toBe("done");
    expect(await t.db.select().from(haikuMessages)).toHaveLength(2);
  });
});

describe("temporäre Haiku-Fäden", () => {
  it("„Temporär“ beim ersten Senden → Faden ist temporär, Liste zeigt Restzeit", async () => {
    const t = await setupAssistant();
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Kurz was testen", context: CTX, temporary: true }));
    const threadId = (events.find((e) => e.type === "thread") as { threadId: number }).threadId;
    const { threads } = (await (await t.app.request("/api/haiku/threads")).json()) as { threads: ThreadOut[] };
    const th = threads.find((x) => x.id === threadId);
    expect(th).toMatchObject({ temporary: true });
    const left = Date.parse(th?.expiresAt ?? "") - Date.now();
    expect(left).toBeGreaterThan(5.9 * 3_600_000);
    expect(left).toBeLessThanOrEqual(6 * 3_600_000);
  });

  it("Umschalten per PATCH; normaler Faden hat keine Restzeit", async () => {
    const t = await setupAssistant();
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Bleibt", context: CTX }));
    const threadId = (events.find((e) => e.type === "thread") as { threadId: number }).threadId;
    let threads = ((await (await t.app.request("/api/haiku/threads")).json()) as { threads: ThreadOut[] }).threads;
    expect(threads[0]).toMatchObject({ temporary: false, expiresAt: null });
    const res = await t.json(`/api/haiku/threads/${threadId}`, { temporary: true }, "PATCH");
    expect(res.status).toBe(200);
    threads = ((await (await t.app.request("/api/haiku/threads")).json()) as { threads: ThreadOut[] }).threads;
    expect(threads[0]?.temporary).toBe(true);
    expect((await t.json("/api/haiku/threads/99999", { temporary: true }, "PATCH")).status).toBe(404);
  });
});
