// Nyx verspricht bei Erinnerungen nur Kanäle, die wirklich gehen (früher „auch in Telegram“, obwohl Telegram
// nicht verbunden war). Es zählt, was der Melder wirklich kann: ohne gekoppelten, verbundenen Bot wird nur im Nyx-Tab
// gemeldet – das Werkzeug sagt es ehrlich, und der System-Prompt kennt den Stand.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nyxSchedules } from "../../src/db/schema.js";
import { setupAssistant } from "./assistant-helpers.js";

describe("Erinnerungen: nur versprechen, was geht", () => {
  it("Telegram nicht verbunden → Erinnerung nur im Nyx-Tab, ehrlicher Hinweis, Prompt weiß es", async () => {
    const t = await setupAssistant();
    const nyx = t.haiku.nyx;
    if (!nyx) throw new Error("Nyx-Kern fehlt");
    expect(await nyx.notifier.channelReady("telegram")).toBe(false);
    const r = (await nyx.callTool("schedule", { action: "create", name: "Wasser trinken", prompt: "Erinnere Alex ans Wasser.", mode: "remind", when: { type: "once", inMinutes: 5 }, deliver: "both" }, null)) as { id: number; hinweis?: string };
    expect(r.hinweis).toMatch(/Telegram ist nicht verbunden/);
    const [row] = await t.db.select().from(nyxSchedules).where(eq(nyxSchedules.id, r.id));
    expect(row?.deliver).toBe("web");
    expect(await nyx.systemPrompt({ channel: "web" })).toMatch(/Telegram ist noch nicht einsatzbereit/);
  });

  it("Telegram verbunden → Zustellung bleibt, kein Warnhinweis", async () => {
    const t = await setupAssistant();
    const nyx = t.haiku.nyx;
    if (!nyx) throw new Error("Nyx-Kern fehlt");
    nyx.notifier.registerChannel("telegram", async () => {}, async () => true);
    const r = (await nyx.callTool("schedule", { action: "create", name: "Build prüfen", prompt: "Prüfe den Build.", mode: "remind", when: { type: "once", inMinutes: 5 }, deliver: "both" }, null)) as { id: number; hinweis?: string };
    expect(r.hinweis).toBeUndefined();
    const [row] = await t.db.select().from(nyxSchedules).where(eq(nyxSchedules.id, r.id));
    expect(row?.deliver).toBe("both");
    expect(await nyx.systemPrompt({ channel: "web" })).not.toMatch(/Telegram ist noch nicht einsatzbereit/);
  });
});
