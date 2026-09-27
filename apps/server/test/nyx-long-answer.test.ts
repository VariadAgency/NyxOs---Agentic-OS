// Problem aus dem Alltag: „Nyx bricht lange Antworten ab, liest nicht weiter vor und erinnert sich danach nicht mehr ans
// Vorige.“ Ursache: die Längen-Grenze war eine harte Sperre (CLI `CLAUDE_CODE_MAX_OUTPUT_TOKENS=400` beim Sprechen,
// Protokoll: „exceeded the 400 output token maximum“), und ein abgebrochener Zug wurde gar nicht gespeichert.
import { asc, desc, eq } from "drizzle-orm";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { describe, expect, it, vi } from "vitest";
import { haikuCalls, haikuMessages } from "../src/db/schema.js";
import { DEFAULT_NYX_PROFILE } from "@nyxos/shared";
import { behaviorHints } from "../src/nyx/personaDefault.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant/assistant-helpers.js";

describe("Lange Antworten", () => {
  it("die Längen-Grenze ist nur noch eine großzügige Sicherheitsgrenze – auch beim Sprechen reichen ~4000 Zeichen", () => {
    for (const channel of ["web", "voice", "telegram"] as const) {
      // ~4000 deutsche Zeichen ≈ 1100–1300 Tokens
      expect(behaviorHints(DEFAULT_NYX_PROFILE, channel).maxTokens).toBeGreaterThanOrEqual(1500);
    }
  });

  it("bricht der Motor nach Teil-Text ab, bleibt der Teil als (abgebrochene) Antwort im Faden – Nyx kennt ihn beim nächsten Mal", async () => {
    const prompts: string[] = [];
    let call = 0;
    const engine = new FakeEngine((req: EngineRequest) => {
      prompts.push(req.prompt);
      call++;
      if (call === 1)
        return (async function* (): AsyncIterable<EngineEvent> {
          yield { type: "delta", text: "Ich bin Nyx. Erstens: Sessions im Überblick. Zweitens: Git und Server" };
          yield { type: "result", text: "", usage: { inputTokens: 10, outputTokens: 400, cacheReadTokens: 0, costUsd: 0.001 }, model: "fake", sessionId: null, isError: true, error: "API Error: Claude's response exceeded the 400 output token maximum." };
        })();
      return answer("Weiter mit drittens.")(req);
    });
    const t = await setupAssistant({ engine });
    const first = await readNdjson(await t.json("/api/haiku/chat", { message: "Erzähl ausführlich über dich", context: CTX }));
    expect(first.some((e) => (e as { type: string }).type === "error")).toBe(true);
    const thread = first.find((e) => (e as { type: string }).type === "thread") as { threadId: number } | undefined;
    const rows = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, thread?.threadId ?? -1)).orderBy(asc(haikuMessages.id));
    const assistant = rows.filter((r) => r.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.interrupted).toBe(true);
    expect(assistant[0]?.text).toContain("Zweitens: Git und Server");
    await readNdjson(await t.json("/api/haiku/chat", { message: "Mach weiter", context: CTX, threadId: thread?.threadId }));
    expect(prompts[1]).toContain("Zweitens: Git und Server");
  });

  it("bricht der Motor direkt nach einem Werkzeug ab, landet der Gedanke davor NICHT als Antwort im Faden", async () => {
    const engine = new FakeEngine((req: EngineRequest) =>
      (async function* (): AsyncIterable<EngineEvent> {
        yield { type: "delta", text: "Ich prüfe erst kurz die Sessions." };
        await req.callTool("lage", {}).catch(() => undefined);
        yield { type: "tool", name: "lage" };
        yield { type: "result", text: "", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 }, model: "fake", sessionId: null, isError: true, error: "Motor weg" };
      })(),
    );
    const t = await setupAssistant({ engine });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Wie ist die Lage?", context: CTX }));
    const thread = events.find((e) => (e as { type: string }).type === "thread") as { threadId: number } | undefined;
    const rows = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, thread?.threadId ?? -1));
    expect(rows.filter((r) => r.role === "assistant")).toHaveLength(0);
  });

  it("bricht Alex selbst ab (Stopp/ins Wort fallen), speichert die Runde nichts – sonst doppelt mit /interrupted", async () => {
    let releaseEngine: () => void = () => {};
    const released = new Promise<void>((r) => (releaseEngine = r));
    const engine = new FakeEngine((req: EngineRequest) =>
      (async function* (): AsyncIterable<EngineEvent> {
        yield { type: "delta", text: "Ich bin Nyx und erzähle dir jetzt sehr ausführlich etwas. ".repeat(10) };
        await new Promise<void>((r) => (req.signal?.aborted ? r() : req.signal?.addEventListener("abort", () => r(), { once: true })));
        await released;
        throw new Error("abgebrochen");
      })(),
    );
    const t = await setupAssistant({ engine });
    const res = await t.json("/api/haiku/chat", { message: "Erzähl ausführlich", context: CTX });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    let threadId: number | null = null;
    while (!buf.includes('"delta"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const m = /"threadId":(\d+)/.exec(buf);
      if (m) threadId = Number(m[1]);
    }
    expect(threadId).not.toBeNull();
    await reader.cancel();
    // Der Client meldet, was der Nutzer gehört hat (useNyxConversation.interrupt → saveInterrupted).
    const r = await t.json(`/api/haiku/threads/${threadId}/interrupted`, { heard: "Ich bin Nyx", question: "Erzähl ausführlich" });
    expect(r.status).toBe(200);
    releaseEngine();
    await vi.waitFor(async () => {
      const [call] = await t.db.select().from(haikuCalls).orderBy(desc(haikuCalls.id)).limit(1);
      expect(call?.status).not.toBe("running");
    });
    await new Promise((r2) => setTimeout(r2, 50));
    const rows = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, threadId ?? -1)).orderBy(asc(haikuMessages.id));
    const assistant = rows.filter((x) => x.role === "assistant");
    expect(assistant.map((a) => a.text)).toEqual(["Ich bin Nyx"]);
  });

  it("setzt das Claude-Programm in einer neuen Nachricht fort, zählt der ganze Strom – nicht nur das letzte Stück", async () => {
    const engine = new FakeEngine(() =>
      (async function* (): AsyncIterable<EngineEvent> {
        yield { type: "delta", text: "Teil eins: wer ich bin. " };
        yield { type: "delta", text: "Teil zwei: was ich kann." };
        yield { type: "result", text: "Teil zwei: was ich kann.", usage: { inputTokens: 10, outputTokens: 50, cacheReadTokens: 0, costUsd: 0.001 }, model: "fake", sessionId: null, isError: false, error: null };
      })(),
    );
    const t = await setupAssistant({ engine });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Erzähl ausführlich", context: CTX }));
    const done = events.find((e) => (e as { type: string }).type === "done") as { text: string } | undefined;
    expect(done?.text).toBe("Teil eins: wer ich bin. Teil zwei: was ich kann.");
  });
});
