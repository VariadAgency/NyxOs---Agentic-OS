// Ehrlichkeits- und Stilregeln für Nyx, abgeleitet aus Gesprächen mit dem laufenden Nyx:
// „Lage per Telegram geschrieben“ ohne Telegram → Ehrlichkeits-Korrektur + Regel im Prompt (auch ohne schedule).
// Sprechtext „drei Sessions,,.“ / „warten und.“ (Quellen-Nummern-Listen), „1.809, Dollar Codex 333“.
// „Wie viel von meinem Limit?“ → nutzung kennt das Fenster (5 Std/Woche + was der Anbieter meldet).
// keine Antwort auf eine andere Frage, „nicht gemeldet“ ist nicht „null“.
import type { HaikuStreamEvent } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { computeBenchTruth } from "../src/haiku/benchTruth.js";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { correctFalseSendClaim, SEND_TRUTH, SEND_TRUTH_EN, SendClaimStream } from "../src/nyx/honesty.js";
import { buildNyxSystemPrompt, languageRule } from "../src/nyx/prompt.js";
import { toSpeakText } from "../src/nyx/speak.js";
import { registerNyxTools } from "../src/nyx/tools.js";
import { setup } from "./helpers.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant/assistant-helpers.js";

describe("keine erfundene Telegram-Nachricht", () => {
  it("ersetzt „per Telegram geschrieben/geschickt“ im Web durch den ehrlichen Satz, der Rest bleibt", () => {
    const out = correctFalseSendClaim("Lage per Telegram geschrieben:\n\n**3 Sessions laufen.**", "web");
    expect(out).not.toMatch(/per Telegram geschrieben/i);
    expect(out).toContain(SEND_TRUTH);
    expect(out).toContain("**3 Sessions laufen.**");
    expect(correctFalseSendClaim("Ich hab dir die Lage per Telegram geschickt.", "web")).not.toMatch(/geschickt/);
    expect(correctFalseSendClaim("Hab's dir in Telegram geschickt 👍", "voice")).toContain(SEND_TRUTH);
    expect(correctFalseSendClaim("Die Nachricht an Telegram ist raus.", "web")).toContain(SEND_TRUTH);
  });
  it("lässt ehrliche Sätze und den Telegram-Kanal selbst in Ruhe", () => {
    const honest = "Telegram ist nicht verbunden – ich kann dir nichts per Telegram schicken.";
    expect(correctFalseSendClaim(honest, "web")).toBe(honest);
    expect(correctFalseSendClaim("Hast du das per Telegram geschickt bekommen?", "web")).toBe("Hast du das per Telegram geschickt bekommen?");
    // Über Telegram gestellt, geht die Antwort wirklich über Telegram raus.
    expect(correctFalseSendClaim("Lage per Telegram geschickt.", "telegram")).toBe("Lage per Telegram geschickt.");
  });
  it("Chat-Runde: das Modell behauptet den Versand → Alex bekommt den ehrlichen Satz", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Lage per Telegram geschrieben:\n\n3 Sessions laufen, 2 warten.")) });
    const done = (await readNdjson(await t.json("/api/haiku/chat", { message: "Schick mir die Lage per Telegram.", context: CTX }))).find((e) => e.type === "done") as { text: string } | undefined;
    expect(done?.text).not.toMatch(/per Telegram geschrieben/);
    expect(done?.text).toContain(SEND_TRUTH);
    expect(done?.text).toContain("3 Sessions laufen, 2 warten.");
  });
  it("Prompt: ohne Telegram-Verbindung steht die Regel immer drin – nicht nur bei geplanten Aufgaben", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage", "nutzung"], channel: "web", telegram: false });
    expect(p).toMatch(/Telegram ist noch nicht einsatzbereit/);
    expect(p).toMatch(/Sofort woandershin schicken \(Telegram, Mail, an Dritte\) kannst du nicht/);
    // mit schedule stand der Telegram-Hinweis doppelt drin.
    const withSchedule = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage", "schedule"], channel: "web", telegram: false });
    expect(withSchedule.match(/Telegram ist noch nicht einsatzbereit/g)).toHaveLength(1);
    // Telegram verbunden + schedule: der echte Weg nach Telegram wird genannt, nicht „geht gar nicht“.
    expect(buildNyxSystemPrompt({ memoryBlock: "", tools: ["schedule"], channel: "web", telegram: true })).toMatch(/schedule mit deliver telegram/);
  });
});

describe("Telegram-Korrektur: keine Fehlalarme, Englisch, Live-Strom, echte Zustellung", () => {
  it("legitime Sätze bleiben wörtlich", () => {
    const legit = [
      "Ich habe dir eine Freigabe-Karte angelegt.",
      "Die Push-Nachricht ging raus.",
      "Telegram ist nicht verbunden.",
      "Alex hat per Mail geschrieben, dass der Termin steht.",
      "Du hast mir das per Telegram geschickt.",
      "Die Session vom 24.09. hat das Telegram-Modul neu geschrieben.",
      "Das Telegram-Modul ist fertig geschrieben.",
      "Deine Nachricht war: „Lage per Telegram geschrieben“.",
      "I can't send anything via Telegram.",
      "He sent it via email yesterday.",
    ];
    for (const s of legit) expect(correctFalseSendClaim(s, "web"), s).toBe(s);
  });
  it("Englische Behauptung → ehrlicher Satz auf Englisch", () => {
    expect(correctFalseSendClaim("I sent you the status via Telegram. 3 sessions are running.", "web")).toBe(`${SEND_TRUTH_EN} 3 sessions are running.`);
    expect(correctFalseSendClaim("Die Telegram-Nachricht ist raus.", "web")).toBe(SEND_TRUTH);
    expect(correctFalseSendClaim("Die Lage ist per Telegram raus.", "web")).toBe(SEND_TRUTH);
  });
  it("Live-Strom: die erfundene Meldung erscheint (und klingt) nie, auch nicht zerstückelt", () => {
    const s = new SendClaimStream();
    const text = "Lage per Telegram geschrieben:\n\n3 Sessions laufen. Hab's dir auch per Mail geschickt.";
    let out = "";
    for (const part of text.match(/.{1,4}/gs) ?? []) out += s.push(part);
    out += s.end();
    expect(out).not.toMatch(/geschrieben|geschickt/);
    expect(out).toBe(`${SEND_TRUTH}\n\n3 Sessions laufen.`);
    // Ohne Behauptung kommt der Text unverändert durch.
    const plain = new SendClaimStream();
    expect(plain.push("Drei Sessions laufen. Zwei ") + plain.push("warten.") + plain.end()).toBe("Drei Sessions laufen. Zwei warten.");
  });
  it("Chat-Runde mit Stimme: schon die Deltas (die vorgelesen werden) sind korrigiert", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Lage per Telegram geschrieben: 3 Sessions laufen.")) });
    const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Wie ist die Lage?", context: CTX, channel: "voice" }));
    const streamed = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    expect(streamed).not.toMatch(/per Telegram geschrieben/);
    expect(streamed).toContain(SEND_TRUTH);
    expect(streamed).toContain("3 Sessions laufen.");
  });
  it("über Telegram gefragt (auch Sprachnachricht = Kanal voice, remote) → keine Korrektur, die Antwort geht ja dorthin", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Lage per Telegram geschickt: 3 Sessions laufen.")) });
    const nyx = t.haiku.nyx;
    if (!nyx) throw new Error("Nyx-Kern fehlt");
    const events: HaikuStreamEvent[] = [];
    for await (const ev of nyx.ask({ message: "Schick mir die Lage per Telegram", context: CTX, channel: "voice", remote: true })) events.push(ev);
    const done = events.find((e) => e.type === "done") as { text: string } | undefined;
    expect(done?.text).toBe("Lage per Telegram geschickt: 3 Sessions laufen.");
  });
  it("schedule lief und Telegram ist verbunden → der Versand kann echt sein, keine Korrektur; ohne Telegram schon", async () => {
    const script = (req: EngineRequest): AsyncIterable<EngineEvent> =>
      (async function* () {
        yield { type: "tool", name: "schedule" } as EngineEvent;
        await req.callTool("schedule", { action: "list" });
        yield* answer("Ich hab dir die Lage per Telegram geschickt.")(req);
      })();
    const ask = async (telegram: boolean) => {
      const t = await setupAssistant({ engine: new FakeEngine(script) });
      const nyx = t.haiku.nyx;
      if (!nyx) throw new Error("Nyx-Kern fehlt");
      if (telegram) nyx.notifier.registerChannel("telegram", async () => {}, async () => true);
      const events = await readNdjson(await t.json("/api/haiku/chat", { message: "Schick mir die Lage per Telegram", context: CTX }));
      return {
        done: (events.find((e) => e.type === "done") as { text: string } | undefined)?.text,
        streamed: events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join(""),
      };
    };
    const on = await ask(true);
    expect(on.done).toBe("Ich hab dir die Lage per Telegram geschickt.");
    expect(on.streamed).toBe("Ich hab dir die Lage per Telegram geschickt.");
    const off = await ask(false);
    expect(off.done).toBe(SEND_TRUTH);
    expect(off.streamed).toBe(SEND_TRUTH);
  });
});

describe("ehrlich bei fehlendem Werkzeug und fehlenden Feldern", () => {
  it("Prompt: nie eine andere Frage beantworten; was ein Werkzeug nicht meldet, ist unbekannt", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web" });
    expect(p).toMatch(/Kein passendes Werkzeug/);
    expect(p).toMatch(/nicht die Antwort auf eine andere Frage/);
    expect(p).toMatch(/fehlt ein Feld/i);
  });
});

describe("Stil: keine Floskel-Rückfrage, Rückfrage bei Unklarem, Sprache wie Alex", () => {
  it("Prompt enthält die drei Regeln", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web" });
    expect(p).toMatch(/Keine Floskel-Rückfrage/);
    expect(p).toMatch(/höchstens zwei Möglichkeiten/);
    // Genau EINE Sprach-Regel.
    expect(p).toContain(languageRule());
    expect(p.match(/^Sprache:/gm)).toHaveLength(1);
  });
});

describe("Stimme: Zahlen bleiben Ziffern", () => {
  it("die Sprech-Regel verlangt Ziffern wie aus dem Werkzeug – das Modell schreibt nie selbst Wörter (live: 63 → „Sechsundsiebzig“)", () => {
    const voice = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "voice" });
    expect(voice).toMatch(/als Ziffern mit genau dem Wert aus dem Werkzeug/);
    expect(voice).not.toContain("dreiundsechzig");
  });
});

describe("Sprechfassung", () => {
  it("Listen von Quellen-Nummern verschwinden samt Kommas und „und“", () => {
    expect(toSpeakText("Es laufen gerade drei Sessions [1], [2], [3].")).toBe("Es laufen gerade drei Sessions.");
    expect(toSpeakText("2 Sessions warten [1] und [2]. Gut.")).toBe("2 Sessions warten. Gut.");
    expect(toSpeakText("Laufen: 3 Sessions [1], [2], [3] (die Neumorphic-Session gerade aktiv).")).toBe("Laufen: 3 Sessions (die Neumorphic-Session gerade aktiv).");
  });
  it("Beträge bleiben unverändert – die Stimme (text_de/text_en) liest sie, das Komma danach gehört nicht dazu", () => {
    // vorher „1.809 Dollar“ (Deutsch fest verdrahtet); jetzt entscheidet die Stimme je Satz die Sprache.
    expect(toSpeakText("Claude kostet dich diese Woche $1.809, Codex $333.")).toBe("Claude kostet dich diese Woche $1.809, Codex $333.");
    expect(toSpeakText("Claude: 6,3 Mrd. Tokens (~ 1.810 USD).")).toBe("Claude: 6,3 Milliarden Tokens (~ 1.810 USD).");
    expect(toSpeakText("Kosten 12,50 €, danach nichts.")).toBe("Kosten 12,50 €, danach nichts.");
  });
});

describe("freigaben_liste kennt die Freigabe-Karten, die Nyx selbst anlegt", () => {
  it("Karte aus freigabe_anfragen zählt als offene Freigabe (vorher: „Null offen“ direkt nach dem Anlegen)", async () => {
    const { db } = await setup();
    const reg = buildDefaultRegistry();
    const ctx = { db, scope: "full" as const, ideaLink: null, ideas: null };
    const before = (await reg.call("full", "freigaben_liste", {}, ctx)) as { anzahl_offen: number };
    expect(before.anzahl_offen).toBe(0);
    await reg.call("full", "freigabe_anfragen", { aktion: "loeschen", titel: "Alle alten Worktrees löschen" }, ctx);
    const after = (await reg.call("full", "freigaben_liste", {}, ctx)) as { anzahl_offen: number; freigabe_karten: { ref: string; titel: string }[] };
    expect(after.anzahl_offen).toBe(1);
    expect(after.freigabe_karten[0]).toMatchObject({ titel: "Freigabe: Alle alten Worktrees löschen" });
    expect(after.freigabe_karten[0]?.ref).toMatch(/^\[\[inbox:\d+\]\]$/);
    // `lage` (für „Wie viele …?“ zuerst gefragt) und die Prüfstand-Wahrheit zählen genauso – sonst wieder „Null“.
    const lage = (await reg.call("full", "lage", {}, ctx)) as { freigaben_offen: number; freigaben: { blockierte_befehle: number; freigabe_karten: number } };
    expect(lage.freigaben_offen).toBe(1);
    expect(lage.freigaben).toMatchObject({ blockierte_befehle: 0, freigabe_karten: 1 });
    const { truths } = await computeBenchTruth(db);
    expect(truths.find((x) => x.id === "q09")?.answer).toBe(1);
  });
});

describe("nutzung kennt das Limit-Fenster", () => {
  it("liefert je Werkzeug 5-Std-/Wochen-Tokens und was der Anbieter meldet (ehrlich null, wenn nichts gemeldet)", async () => {
    const { db } = await setup();
    const reg = buildDefaultRegistry();
    registerNyxTools(reg, { hub: { broadcast: () => {} } as never, bridgeHub: null, archiveDir: null, runner: () => null, serverSnapshot: () => null });
    const res = (await reg.call("full", "nutzung", {}, { db, scope: "full", ideaLink: null, ideas: null })) as {
      limit_fenster: { werkzeug: string; tokens_5_std: number; tokens_7_tage: number; anbieter_meldet: { fuenf_std_prozent: number | null; woche_prozent: number | null; limit_erreicht: boolean } }[];
      limit_hinweis: string;
    };
    expect(res.limit_fenster.map((f) => f.werkzeug)).toEqual(["claude", "codex"]);
    expect(res.limit_fenster[0]).toMatchObject({ tokens_5_std: 0, tokens_7_tage: 0, anbieter_meldet: { fuenf_std_prozent: null, woche_prozent: null, limit_erreicht: false } });
    expect(res.limit_hinweis).toMatch(/null/);
  });
});
