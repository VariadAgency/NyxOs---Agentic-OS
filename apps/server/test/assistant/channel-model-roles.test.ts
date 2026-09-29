// Nyx-Läufe wählen ihr Modell über die Modell-Rolle (`resolveModel(role)` im Motor-Wähler): Stimme →
// „nyx.voice“, Chat/Telegram → „nyx.chat“. Die Profil-Hinweise des Kanals (Token-Grenze, Denkpause) wirken im Motor.
import { describe, expect, it } from "vitest";
import type { ModelRole } from "@nyxos/shared";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant-helpers.js";

async function setup() {
  const engine = new FakeEngine(answer("Alles ruhig."));
  const t = await setupAssistant({ engine });
  const roles: (ModelRole | null | undefined)[] = [];
  // Motor-Wähler mithören (liefert null = Standard-Motor, wie ohne zugewiesenen Anbieter).
  t.runtime.useModels({ engineForRun: async (_kind, role) => (roles.push(role), null) });
  const chat = async (channel: "web" | "voice" | "telegram") => readNdjson(await t.json("/api/haiku/chat", { message: "Wie ist die Lage?", context: CTX, channel }));
  return { t, engine, roles, chat };
}

describe("Modell-Rolle und Profil-Hinweise je Kanal", () => {
  it("Stimme → nyx.voice, kurz und ohne Denkpause; Chat → nyx.chat", async () => {
    const { engine, roles, chat } = await setup();
    await chat("voice");
    expect(roles.at(-1)).toBe("nyx.voice");
    const voiceReq = engine.requests.at(-1);
    expect(voiceReq?.thinking).toBe(false);
    expect(voiceReq?.maxTokens).toBeLessThanOrEqual(3000); // Sicherheitsgrenze statt harter Kappung
    await chat("web");
    expect(roles.at(-1)).toBe("nyx.chat");
    expect(engine.requests.at(-1)?.maxTokens).toBeGreaterThan(voiceReq?.maxTokens ?? 0);
  });

  it("Telegram → nyx.chat mit der Telegram-Grenze", async () => {
    const { engine, roles, chat } = await setup();
    await chat("telegram");
    expect(roles.at(-1)).toBe("nyx.chat");
    expect(engine.requests.at(-1)?.maxTokens).toBeLessThanOrEqual(3000); // Sicherheitsgrenze
  });

  it("zugewiesener Anbieter nicht erreichbar → ehrlicher Fehler VOR dem Faden (kein Faden ohne Antwort)", async () => {
    const engine = new FakeEngine(answer("nie"));
    const t = await setupAssistant({ engine });
    // Stimme ist einem Anbieter zugewiesen, der gerade nicht geht; der Standard-Motor wäre bereit.
    t.runtime.useModels({
      engineForRun: async (_kind, role) => {
        if (role === "nyx.voice") throw new Error("Der Anbieter für Nyx-Stimme antwortet gerade nicht.");
        return null;
      },
    });
    const { haikuThreads } = await import("../../src/db/schema.js");
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Wie ist die Lage?", context: CTX, channel: "voice" }));
    expect(events).toEqual([{ type: "error", code: "not_ready", message: "Der Anbieter für Nyx-Stimme antwortet gerade nicht." }]);
    expect(await t.db.select().from(haikuThreads)).toHaveLength(0);
    expect(engine.requests).toHaveLength(0);
  });
});
