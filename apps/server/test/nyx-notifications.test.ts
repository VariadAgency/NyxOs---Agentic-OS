// Nyx kennt seine Mitteilungen. Anlass: „Du hast mir gerade eine Mitteilung aufs Smartphone geschickt. Weißt du,
// worum es ging?“ – Nyx: „Ich kann nicht sehen, welche Mitteilungen NyxOS dir geschickt hat.“ Jetzt: Protokoll je Weg
// (push_log.channels) + Werkzeug `mitteilungen_liste` + Prompt-Regel „das bist du“.
import { describe, expect, it } from "vitest";
import { pushLog } from "../src/db/schema.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { buildNyxSystemPrompt } from "../src/nyx/prompt.js";
import { registerNyxTools } from "../src/nyx/tools.js";
import { notify } from "../src/push/dispatcher.js";
import { logDelivery } from "../src/push/log.js";
import { patchSettings } from "../src/push/settings.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { setup } from "./helpers.js";

type Item = { zeit: string; wege: { weg: string; zugestellt: boolean }[]; art: string; titel: string; text: string; zugestellt: boolean; sammel: boolean; grund: string | null };

function tools() {
  const reg = buildDefaultRegistry();
  registerNyxTools(reg, { hub: { broadcast: () => {} } as never, bridgeHub: null, archiveDir: null, runner: () => null, serverSnapshot: () => null });
  return reg;
}

describe("Protokoll je Weg", () => {
  it("notify() merkt sich, über welche Wege die Mitteilung ging und ob sie ankam", async () => {
    const { db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await notify({ kind: "usage_warning", title: "Nutzung: Claude-Sitzung fast voll", message: "Claude: Sitzung 88 % belegt, Reset um 20:30.", path: "/usage" }, { db, sender, settings: push });
    const [row] = await db.select().from(pushLog);
    expect(row?.channels).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "ntfy", ok: true })]));
  });
});

describe("Nyx-Werkzeug „mitteilungen_liste“", () => {
  it("liefert die zuletzt verschickte Mitteilung mit Weg, Art, Titel, Text, Zustellung und Sammel-Kennzeichen", async () => {
    const { db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await notify({ kind: "session_waiting", title: "Session wartet", message: "Claude · NyxOS wartet auf dich.", path: "/sessions" }, { db, sender, settings: push, now: new Date(Date.now() - 60_000) });
    await logDelivery(db, { kind: "away_bundle", title: "3 Sachen fertig", message: "Session fertig, Build grün, Nachtlauf fertig", channels: [{ channel: "ntfy", ok: true }], bundle: true });
    await logDelivery(db, { kind: "away_questions", title: "Nyx braucht dich", message: "Soll ich deployen?", channels: [{ channel: "telegram", ok: false }] });
    await notify({ kind: "usage_warning", title: "Nutzung: Claude-Sitzung fast voll", message: "Claude: Sitzung 88 % belegt, Reset um 20:30 (Werte von Anthropic).", path: "/usage" }, { db, sender, settings: push });

    const reg = tools();
    expect(reg.namesFor("full")).toContain("mitteilungen_liste");
    const res = (await reg.call("full", "mitteilungen_liste", { anzahl: 5 }, { db, scope: "full", ideaLink: null, ideas: null })) as { mitteilungen: Item[] };
    const [last, tg, bundle, first] = res.mitteilungen;
    expect(last).toMatchObject({ art: "Nutzungswarnung", titel: "Nutzung: Claude-Sitzung fast voll", zugestellt: true, sammel: false });
    expect(last?.text).toMatch(/Sitzung 88 % belegt/);
    expect(last?.wege).toEqual(expect.arrayContaining([{ weg: "Handy (ntfy)", zugestellt: true }]));
    expect(tg).toMatchObject({ zugestellt: false, wege: [{ weg: "Telegram", zugestellt: false }] });
    expect(bundle).toMatchObject({ sammel: true, wege: [{ weg: "Handy (ntfy)", zugestellt: true }] });
    expect(first).toMatchObject({ titel: "Session wartet", art: "Session wartet" });
  });

  it("Geheimnisse in protokollierten Texten (z. B. Befehl einer Freigabe-Karte) kommen nie bei Nyx an", async () => {
    const { db } = await setup();
    await logDelivery(db, {
      kind: "approval_telegram",
      title: "Freigabe nötig: " + "x".repeat(400),
      message: 'curl -H "Authorization: Bearer abcDEF1234567890xyz" -H "x-api-key: sk-ant-api03-GEHEIM1234567890abcdef" https://x && export GITHUB_TOKEN=ghp_GEHEIM1234567890abcdefgh PASSWORD=hunter2geheim',
      channels: [{ channel: "telegram", ok: true }],
    });
    const res = (await tools().call("full", "mitteilungen_liste", {}, { db, scope: "full", ideaLink: null, ideas: null })) as { mitteilungen: Item[] };
    const out = JSON.stringify(res);
    expect(out).not.toMatch(/GEHEIM|abcDEF1234567890xyz|hunter2geheim/);
    expect(res.mitteilungen[0]?.text).toMatch(/curl/);
    expect(res.mitteilungen[0]?.titel.length).toBeLessThanOrEqual(160);
    const [row] = await db.select().from(pushLog);
    expect(JSON.stringify(row)).not.toMatch(/GEHEIM|hunter2geheim/);
  });

  it("in der Ruhezeit unterdrückte Mitteilungen erscheinen als nicht zugestellt mit Grund", async () => {
    const { db } = await setup();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "23:59" });
    await notify({ kind: "usage_warning", title: "Nutzung", message: "x", path: "/usage" }, { db, sender: new FakeNtfySender(), settings: push, now: new Date("2026-09-26T10:00:00Z") });
    const res = (await tools().call("full", "mitteilungen_liste", {}, { db, scope: "full", ideaLink: null, ideas: null })) as { mitteilungen: Item[] };
    expect(res.mitteilungen[0]).toMatchObject({ zugestellt: false, grund: "Ruhezeit" });
  });
});

describe("Prompt: Mitteilungen verschickt NyxOS in Nyx' Namen", () => {
  it("enthält die Regel, sobald das Werkzeug da ist", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["mitteilungen_liste"], channel: "web" });
    expect(p).toMatch(/das bist du/);
    expect(p).toMatch(/mitteilungen_liste/);
    expect(buildNyxSystemPrompt({ memoryBlock: "", tools: [], channel: "web" })).not.toMatch(/mitteilungen_liste/);
  });
});
