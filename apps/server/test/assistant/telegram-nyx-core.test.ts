// Telegram spricht mit dem Nyx-Kern (nicht mehr über den alten Haiku-Weg): gleicher System-Prompt mit
// Kanal-Regeln, eingefrorenes Gedächtnis, Sprechfassung, Kanal „telegram“ bzw. „voice“ bei Sprachnachrichten,
// Bilder aus show_image als Foto, /compact = Verdichtung des Kerns im selben Faden.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { haikuMessages, haikuThreads } from "../../src/db/schema.js";
import type { EngineEvent, EngineRequest } from "../../src/haiku/engine.js";
import { storeNyxFile } from "../../src/nyx/files.js";
import { TELEGRAM_TURN_NOTE, VOICE_TURN_NOTE } from "../../src/nyx/prompt.js";
import { runtimeNyxChannel, type NyxAskRequest, type NyxEvent } from "../../src/telegram/nyx.js";
import { FakeEngine, setupAssistant } from "./assistant-helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function scripted(step: (req: EngineRequest) => Promise<string>): (req: EngineRequest) => AsyncIterable<EngineEvent> {
  return async function* (req) {
    const text = await step(req);
    yield { type: "delta", text };
    yield { type: "result", text, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.0001 }, model: "fake-haiku", sessionId: null, isError: false, error: null };
  };
}

async function setup(step: (req: EngineRequest) => Promise<string>) {
  const engine = new FakeEngine(scripted(step));
  const t = await setupAssistant({ engine });
  const channel = runtimeNyxChannel({ db: t.db, hub: t.hub, archiveDir: t.archiveDir, core: () => t.haiku.nyx });
  const ask = async (over: Partial<NyxAskRequest> = {}) => {
    const events: NyxEvent[] = [];
    for await (const ev of channel.ask({ threadId: null, message: "Wie ist die Lage?", channel: "telegram", voice: false, attachments: [], signal: new AbortController().signal, ...over })) events.push(ev);
    return events;
  };
  return { t, engine, channel, ask };
}

describe("Telegram ↔ Nyx-Kern", () => {
  it("Text: Nyx-Prompt mit Telegram-Regeln, Gedächtnis eingefroren, Antwort mit Sprechfassung im Faden", async () => {
    const { t, engine, ask } = await setup(async () => "**Zwei Sessions** warten auf dich.");
    const events = await ask();
    const threadId = (events.find((e) => e.type === "thread") as { threadId: number }).threadId;
    expect(events.at(-1)).toEqual({ type: "done", text: "**Zwei Sessions** warten auf dich.", speak: "Zwei Sessions warten auf dich." });
    const req = engine.requests.at(-1);
    expect(req?.systemPrompt).toMatch(/Nyx/);
    // Nyx-Kern-Prompt (nyx/prompt.ts), nicht der alte Ideen-Chat-Prompt (CHAT_SYSTEM, seit NR „Du bist Nyx, der Assistent …“).
    expect(req?.systemPrompt).toMatch(/^Du bist Nyx, der persönliche Assistent/);
    expect(req?.systemPrompt).not.toMatch(/^Du bist Nyx, der Assistent/);
    expect(req?.prompt).toContain(TELEGRAM_TURN_NOTE);
    const [thread] = await t.db.select().from(haikuThreads).where(eq(haikuThreads.id, threadId));
    expect(thread).toMatchObject({ topic: "telegram" });
    expect(thread?.memorySnapshot).not.toBeNull();
    const msgs = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, threadId)).orderBy(haikuMessages.id);
    expect(msgs.map((m) => [m.role, m.channel])).toEqual([
      ["user", "telegram"],
      ["assistant", "telegram"],
    ]);
    expect(msgs[1]?.speak).toBe("Zwei Sessions warten auf dich.");
  });

  it("Sprachnachricht: Kanal voice (Sprech-Regeln), im selben Faden weiter", async () => {
    const { engine, ask } = await setup(async () => "Alles ruhig.");
    const first = await ask();
    const threadId = (first.find((e) => e.type === "thread") as { threadId: number }).threadId;
    const second = await ask({ threadId, voice: true, message: "Und jetzt?" });
    expect(second.find((e) => e.type === "thread")).toEqual({ type: "thread", threadId });
    expect(engine.requests.at(-1)?.prompt).toContain(VOICE_TURN_NOTE);
    expect(engine.requests.at(-1)?.systemPrompt).toMatch(/vorgelesen/);
  });

  it("show_image im Lauf → Bild kommt als Foto-Ereignis (nur aus dem eigenen Faden)", async () => {
    let fileId = 0;
    const { t, ask } = await setup(async (req) => {
      await req.callTool("show_image", { bild_id: fileId, titel: "Simulator" });
      return "Hier ist das Bild.";
    });
    fileId = (await storeNyxFile(t.db, t.archiveDir, t.hub, { bytes: PNG, mime: "image/png", name: "sim.png", source: "simulator" })).id;
    const events = await ask({ message: "Zeig mir den Simulator." });
    const image = events.find((e) => e.type === "image") as Extract<NyxEvent, { type: "image" }> | undefined;
    expect(image).toMatchObject({ title: "Simulator", mime: "image/png", name: "sim.png" });
    expect(Buffer.from(image?.data ?? []).equals(PNG)).toBe(true);
    // Reihenfolge: Bild vor der Antwort.
    expect(events.findIndex((e) => e.type === "image")).toBeLessThan(events.findIndex((e) => e.type === "done"));
  });

  // (Der Nutzer: „über Telegram anweisen, den Tab zu wechseln, eine Session anzuklicken und da was reinzuschreiben“):
  // auch von Telegram aus darf Nyx den NyxOS-Cursor benutzen – nur auf ausdrücklichen Wunsch (Hinweis in der Lage-Zeile).
  it("Telegram (auch Sprachnachricht) hat die Browser-Steuerung, mit Hinweis: nur auf ausdrücklichen Wunsch", async () => {
    const { engine, ask } = await setup(async () => "Erledigt.");
    await ask();
    await ask({ voice: true, message: "Öffne die Sessions." });
    for (const req of engine.requests.slice(-2)) {
      expect(req.tools).toContain("ui_navigate");
      expect(req.toolDefs.map((d) => d.name)).toContain("ui_click");
      expect(req.systemPrompt).toMatch(/Plattform steuern/);
      expect(req.prompt).toMatch(/nur, wenn er ausdrücklich/);
    }
  });

  it("/compact: Verdichtung des Kerns im selben Faden; ohne Faden ehrlich „nichts zu verdichten“", async () => {
    const { t, channel } = await setup(async () => "ok");
    const empty = await channel.compact(null);
    expect(empty).toMatchObject({ threadId: null, compacted: false });
    const [thread] = await t.db.insert(haikuThreads).values({ scope: "full", topic: "telegram", day: "2026-09-25", title: "Telegram" }).returning();
    const id = (thread as { id: number }).id;
    const r = await channel.compact(id);
    expect(r).toMatchObject({ threadId: id, compacted: false, summary: expect.stringMatching(/nichts zu verdichten/) });
    expect(await t.db.select().from(haikuThreads)).toHaveLength(1);
  });
});
