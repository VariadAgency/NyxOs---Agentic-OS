// Verdrahtung: Der Chat-Motor bekommt den Persönlichkeits-Abschnitt aus dem gespeicherten Profil.
// Regler ändern → der System-Prompt des nächsten Laufs ändert sich (grüner Build beweist das nicht).
import { DEFAULT_NYX_PROFILE, type NyxProfile } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant-helpers.js";

const put = (t: Awaited<ReturnType<typeof setupAssistant>>, profile: NyxProfile) => t.json("/api/nyx/profile", profile, "PUT");

describe("Chat nutzt buildPersona", () => {
  it("ohne Profil: Startwerte (Alex, du) im System-Prompt, Grund-Regeln bleiben", async () => {
    const engine = new FakeEngine(answer("Hallo."));
    const t = await setupAssistant({ engine });
    await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    const sys = engine.requests.at(-1)?.systemPrompt ?? "";
    expect(sys).toContain("Fakten und Belege"); // Grund-Regeln des Nyx-Prompts noch da
    expect(sys).toContain("Persönlichkeit und Stil");
    expect(sys).toContain(DEFAULT_NYX_PROFILE.user.role);
  });

  it("Regler kurz → ausführlich und Profil geändert: nächster Lauf hat anderen System-Prompt", async () => {
    const engine = new FakeEngine(answer("Hallo."));
    const t = await setupAssistant({ engine });
    expect((await put(t, { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, length: 0 } })).status).toBe(200);
    await readNdjson(await t.json("/api/haiku/chat", { message: "Eins", context: CTX }));
    const first = engine.requests.at(-1)?.systemPrompt ?? "";
    expect(first).toContain("extrem knapp");

    expect((await put(t, { ...DEFAULT_NYX_PROFILE, user: { ...DEFAULT_NYX_PROFILE.user, notes: "Hört gern Techno." }, sliders: { ...DEFAULT_NYX_PROFILE.sliders, length: 100 } })).status).toBe(200);
    await readNdjson(await t.json("/api/haiku/chat", { message: "Zwei", context: CTX }));
    const second = engine.requests.at(-1)?.systemPrompt ?? "";
    expect(second).toContain("sehr ausführlich");
    expect(second).toContain("Hört gern Techno.");
    expect(second).not.toContain("extrem knapp");
  });

  // „schnell“ muss auch technisch wirken – Regler Tempo ganz links → ohne Denkpause.
  it("Tempo schnell → Lauf ohne Denkpause; gründlich → Standard des Motors", async () => {
    const engine = new FakeEngine(answer("Hallo."));
    const t = await setupAssistant({ engine });
    expect((await put(t, { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, speed: 0 } })).status).toBe(200);
    await readNdjson(await t.json("/api/haiku/chat", { message: "Eins", context: CTX }));
    expect(engine.requests.at(-1)?.thinking).toBe(false);
    expect((await put(t, { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, speed: 100 } })).status).toBe(200);
    await readNdjson(await t.json("/api/haiku/chat", { message: "Zwei", context: CTX }));
    expect(engine.requests.at(-1)?.thinking).not.toBe(false);
  });

  // Profil nicht lesbar (Tabelle fehlt, DB-Fehler) → Chat läuft mit Startwerten weiter.
  it("Profil-Tabelle fehlt: Chat antwortet trotzdem, mit Startwerten", async () => {
    const engine = new FakeEngine(answer("Hallo."));
    const t = await setupAssistant({ engine });
    // Umbenennen statt Löschen: die Test-DB ist geteilt, danach wieder zurück.
    await t.db.execute(sql`ALTER TABLE nyx_profile RENAME TO nyx_profile_weg`);
    let events: unknown[];
    try {
      events = await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    } finally {
      await t.db.execute(sql`ALTER TABLE nyx_profile_weg RENAME TO nyx_profile`);
    }
    expect(events.some((e) => (e as { type: string }).type === "done")).toBe(true);
    expect(engine.requests.at(-1)?.systemPrompt ?? "").toContain(DEFAULT_NYX_PROFILE.user.role);
  });
});

