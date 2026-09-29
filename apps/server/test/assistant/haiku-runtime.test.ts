// Haiku-Laufzeit: Streaming, Quellen-Prüfung, Budget, Zeitlimit, Warteschlange, MCP-Token-Umfang.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { haikuCalls, haikuMessages, sessions } from "../../src/db/schema.js";
import { EngineTimeoutError, type EngineEvent } from "../../src/haiku/engine.js";
import { patchHaikuSettings } from "../../src/haiku/settings.js";
import { answer, CTX, FakeEngine, MemoryIdeas, readNdjson, setupAssistant } from "./assistant-helpers.js";

async function addSession(db: Awaited<ReturnType<typeof setupAssistant>>["db"], id: string, title: string, state = "waiting") {
  await db.insert(sessions).values({ id: `claude:${id}`, tool: "claude", sessionId: id, title, state, categoryArt: "coding", categoryBaustelleSlug: "nyxos", lastActivityAt: new Date().toISOString() });
}

describe("Haiku-Chat", () => {
  it("streamt NDJSON, prüft Quellen gegen die DB und protokolliert den Aufruf", async () => {
    const engine = new FakeEngine(answer("Die Session wartet auf dich [[session:claude:aaa]]. Erfunden [[session:claude:gibtsnicht]]."));
    const t = await setupAssistant({ engine });
    await addSession(t.db, "aaa", "Echte Session");
    const res = await t.json("/api/haiku/chat", { message: "Was wartet?", context: CTX });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readNdjson(res);
    expect(events[0]).toMatchObject({ type: "thread" });
    expect(events.some((e) => e.type === "status" && e.status === "thinking")).toBe(true);
    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(deltas).not.toContain("[[");
    const done = events.find((e) => e.type === "done") as Extract<(typeof events)[number], { type: "done" }>;
    expect(done.sources).toEqual([{ kind: "session", id: "claude:aaa", label: "Echte Session", href: "/sessions/coding/nyxos/aaa" }]);
    expect(done.text).toBe("Die Session wartet auf dich [1]. Erfunden.");
    expect(done.estimate).toBe(false);
    // Kontext geht mit in den Prompt, Frage über stdin/Prompt, Werkzeuge nur full-Umfang.
    expect(engine.requests[0]?.prompt).toContain("Tab „sessions“");
    expect(engine.requests[0]?.tools).toContain("sessions_suchen");
    const [call] = await t.db.select().from(haikuCalls);
    expect(call).toMatchObject({ kind: "chat", status: "ok", inputTokens: 100, outputTokens: 20, costUsd: 0.001 });
    const msgs = await t.db.select().from(haikuMessages);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("Antwort ohne gültige Quelle ist eine Einschätzung; Faden geht als gekürzter Verlauf mit (kein --resume)", async () => {
    const engine = new FakeEngine(answer("Ich schätze, heute ist ruhig."));
    const t = await setupAssistant({ engine });
    const first = await readNdjson(await t.json("/api/haiku/chat", { message: "Wie ist die Lage?", context: CTX }));
    const done = first.find((e) => e.type === "done") as { estimate: boolean };
    expect(done.estimate).toBe(true);
    const threadId = (first[0] as { threadId: number }).threadId;
    await readNdjson(await t.json("/api/haiku/chat", { threadId, message: "Und morgen?", context: CTX }));
    expect(engine.requests[1]?.resumeSessionId).toBeNull();
    expect(engine.requests[1]?.prompt).toContain("Frage: Wie ist die Lage?");
    expect(engine.requests[1]?.prompt).toContain("Deine Antwort: Ich schätze, heute ist ruhig.");
    const thread = (await (await t.app.request(`/api/haiku/threads/${threadId}`)).json()) as { messages: unknown[] };
    expect(thread.messages).toHaveLength(4);
  });

  it("Tages-Budget erreicht → Fehler 'budget', kein Motor-Aufruf", async () => {
    const engine = new FakeEngine(answer("x"));
    const t = await setupAssistant({ engine });
    await patchHaikuSettings(t.db, { dailyBudgetUsd: 0.01 });
    await t.db.insert(haikuCalls).values({ kind: "chat", engine: "claude-cli", status: "ok", costUsd: 0.02 });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "budget" });
    expect(engine.requests).toHaveLength(0);
    const calls = await t.db.select().from(haikuCalls).where(eq(haikuCalls.status, "budget"));
    expect(calls).toHaveLength(1);
  });

  it("Motor nicht bereit → 'not_ready' (nicht mehr „Haiku ist aus“); Zeitlimit → 'timeout' im Protokoll", async () => {
    const off = new FakeEngine(answer("x"));
    off.ok = false;
    const t1 = await setupAssistant({ engine: off });
    const e1 = await readNdjson(await t1.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(e1.find((e) => e.type === "error")).toMatchObject({ code: "not_ready", message: "fake aus" });

    const slow = new FakeEngine(async function* (req) {
      yield { type: "delta", text: "…" } as EngineEvent;
      throw new EngineTimeoutError(req.timeoutMs);
    });
    const t2 = await setupAssistant({ engine: slow });
    const e2 = await readNdjson(await t2.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(e2.find((e) => e.type === "error")).toMatchObject({ code: "timeout" });
    const [call] = await t2.db.select().from(haikuCalls);
    expect(call?.status).toBe("timeout");
    expect(slow.requests[0]?.timeoutMs).toBeGreaterThanOrEqual(90_000); // wächst mit der erlaubten Antwortlänge
  });

  it("Warteschlange: zweiter Lauf wartet, bis der erste fertig ist", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const engine = new FakeEngine(async function* () {
      n++;
      if (n === 1) await gate;
      yield* answer(`Antwort ${n}`)({} as never);
    });
    const t = await setupAssistant({ engine });
    const a = t.runtime.run({ kind: "chat", scope: "none", systemPrompt: "s", prompt: "1" });
    await new Promise((r) => setTimeout(r, 20));
    const events: string[] = [];
    const b = (async () => {
      for await (const ev of t.runtime.ask({ kind: "chat", scope: "none", systemPrompt: "s", prompt: "2" })) events.push(ev.type === "status" ? `${ev.type}:${ev.status}:${ev.position ?? ""}` : ev.type);
    })();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.runtime.queueState()).toEqual({ running: 1, waiting: 1 });
    release();
    await Promise.all([a, b]);
    expect(events[0]).toBe("status:queued:1");
    expect(events).toContain("final");
    expect(t.runtime.queueState()).toEqual({ running: 0, waiting: 0 });
  });
});

describe("MCP-Brücke: Einmal-Token bindet den Werkzeug-Umfang", () => {
  it("full sieht alle Werkzeuge, idealink NUR ideen_suchen + idee_anlegen; fremde Aufrufe 403; ohne Token 401", async () => {
    const seen: Record<string, unknown> = {};
    // eslint-disable-next-line prefer-const -- der Motor braucht die App, die App den Motor (Kreisbezug)
    let t!: Awaited<ReturnType<typeof setupAssistant>>;
    const engine = new FakeEngine(async function* (req) {
      const auth = { authorization: `Bearer ${req.runToken}` };
      const list = (await (await t.app.request("/haiku-mcp/tools", { headers: auth })).json()) as { tools: { name: string }[] };
      seen[req.scope] = list.tools.map((x: { name: string }) => x.name);
      if (req.scope === "idealink") {
        const bad = await t.app.request("/haiku-mcp/call", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "sessions_suchen", arguments: {} }) });
        seen.badStatus = bad.status;
        const ok = await t.app.request("/haiku-mcp/call", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "idee_anlegen", arguments: { titel: "Dunkelmodus", beschreibung: "Bitte dunkel", herkunft: "Admin" } }) });
        seen.okStatus = ok.status;
      }
      yield* answer("ok")(req);
    });
    const ideas = new MemoryIdeas();
    t = await setupAssistant({ engine, ideas });
    await t.runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    // Echter Link (die Ideen-Obergrenze zählt je Link in der DB).
    const created = (await (await t.json("/api/idealinks", { name: "Lena", expiresInDays: 7, ratePerHour: 10 })).json()) as { link: { id: number } };
    await t.runtime.run({ kind: "idealink", scope: "idealink", systemPrompt: "s", prompt: "p", ideaLink: { id: created.link.id, name: "Lena", conversationId: "c1" } });
    expect(seen.full).toEqual(expect.arrayContaining(["sessions_suchen", "freigaben_liste", "frage_stellen", "ideen_suchen", "idee_anlegen"]));
    expect(seen.idealink).toEqual(["ideen_suchen", "idee_anlegen"]);
    expect(seen.badStatus).toBe(403);
    expect(seen.okStatus).toBe(200);
    // Herkunft kommt vom Server, die Modell-Eingabe "herkunft: Admin" wird ignoriert.
    expect(ideas.items[0]).toMatchObject({ title: "Dunkelmodus", origin: "Link: Lena" });
    // Nach dem Lauf ist das Token wertlos.
    const late = await t.app.request("/haiku-mcp/tools", { headers: { authorization: `Bearer ${engine.requests[1]?.runToken}` } });
    expect(late.status).toBe(401);
    expect((await t.app.request("/haiku-mcp/tools")).status).toBe(401);
  });
});
