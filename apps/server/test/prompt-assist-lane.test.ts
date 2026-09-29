// „Prompt verbessern“ (Sonnet, bis 180 s) lief in Nyx' einziger Warteschlange und hielt Chat, Stimme und
// Briefing so lange auf. Jetzt hat es eine eigene Spur: ein Nyx-Lauf läuft daneben weiter.
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { describe, expect, it } from "vitest";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

describe("Eigene Spur für „Prompt verbessern“", () => {
  it("ein hängender Prompt-Lauf blockiert einen normalen Nyx-Lauf nicht (Nyx-Warteschlange = 1)", async () => {
    let releasePrompt: () => void = () => {};
    const gate = new Promise<void>((r) => (releasePrompt = r));
    const engine = new FakeEngine((req: EngineRequest) => {
      if (req.prompt.includes("LANGSAM")) {
        return (async function* (): AsyncIterable<EngineEvent> {
          await gate;
          yield* answer("fertig")(req);
        })();
      }
      return answer("schnell")(req);
    });
    const t = await setupAssistant({ engine, concurrency: 1 });
    const slow = t.runtime.run({ kind: "prompt", scope: "none", systemPrompt: "s", prompt: "LANGSAM", lane: "prompt" });
    await new Promise((r) => setTimeout(r, 30));
    const fast = await Promise.race([t.runtime.run({ kind: "chat", scope: "none", systemPrompt: "s", prompt: "hallo" }), new Promise<"blockiert">((r) => setTimeout(() => r("blockiert"), 1500))]);
    expect(fast).not.toBe("blockiert");
    expect(fast !== "blockiert" && fast.type).toBe("final");
    releasePrompt();
    expect((await slow).type).toBe("final");
  });

  it("zwei Prompt-Läufe teilen sich die Spur nacheinander (nie zwei Sonnet-Läufe gleichzeitig)", async () => {
    let active = 0;
    let maxActive = 0;
    const engine = new FakeEngine((req: EngineRequest) =>
      (async function* (): AsyncIterable<EngineEvent> {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
        yield* answer("ok")(req);
      })(),
    );
    const t = await setupAssistant({ engine, concurrency: 1 });
    await Promise.all([1, 2].map(() => t.runtime.run({ kind: "prompt", scope: "none", systemPrompt: "s", prompt: "x", lane: "prompt" })));
    expect(maxActive).toBe(1);
  });
});
