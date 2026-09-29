// Nyx bedient alles, was der Nutzer in NyxOS kann: neues Werkzeug `ui_select` (Auswahlliste, Radio-Gruppe, Schalter),
// ui_read_screen zeigt Optionen, und der Prompt sagt Nyx, dass er es erst versucht, statt „kann ich nicht“ zu sagen.
import { describe, expect, it } from "vitest";
import { NyxUiBridge, registerNyxUiTools } from "../src/nyx/ui.js";
import { NYX_UI_TOOLS, buildNyxSystemPrompt } from "../src/nyx/prompt.js";
import { ToolRegistry, type ToolContext } from "../src/haiku/tools.js";

type Sent = Record<string, unknown>;

function setup() {
  const sent: Sent[] = [];
  let bridge: NyxUiBridge | null = null;
  let answer: (m: Sent) => Record<string, unknown> = (m) => ({ type: "nyx.ui.result", requestId: m.requestId, ok: true });
  const hub = {
    size: 1,
    broadcast(message: unknown) {
      const m = message as Sent;
      sent.push(m);
      if (m.type === "nyx.ui") queueMicrotask(() => bridge?.receive(answer(m)));
    },
  };
  bridge = new NyxUiBridge({ hub, timeoutMs: 500 });
  const reg = new ToolRegistry();
  registerNyxUiTools(reg, bridge);
  return { sent, reg, setAnswer: (fn: typeof answer) => (answer = fn) };
}

// der Nutzer selbst (Web-Chat): nur solche Runden dürfen klicken/tippen/wählen.
const ctx = { db: null, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web" } as unknown as ToolContext;

describe("ui_select", () => {
  it("gibt es nur im Umfang full und schickt { action: select, target, option } an den Browser", async () => {
    const { sent, reg, setAnswer } = setup();
    expect(reg.namesFor("full")).toContain("ui_select");
    expect(reg.namesFor("idealink")).not.toContain("ui_select");
    setAnswer((m) => ({ type: "nyx.ui.result", requestId: m.requestId, ok: true, detail: "„Opus 5.5“ gewählt." }));
    const r = (await reg.call("full", "ui_select", { target: "new-session:model", option: "Opus 5.5" }, ctx)) as Record<string, unknown>;
    expect(sent[0]).toMatchObject({ type: "nyx.ui", action: "select", target: "new-session:model", option: "Opus 5.5" });
    expect(r).toMatchObject({ erledigt: true, hinweis: "„Opus 5.5“ gewählt." });
  });

  it("Fehler aus dem Browser (keine passende Option) kommt ehrlich an", async () => {
    const { reg, setAnswer } = setup();
    setAnswer((m) => ({ type: "nyx.ui.result", requestId: m.requestId, ok: false, detail: "Zur Wahl: Standard, Opus 5.5" }));
    const r = (await reg.call("full", "ui_select", { target: "Modell", option: "GPT" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ erledigt: false, hinweis: "Zur Wahl: Standard, Opus 5.5" });
  });

  it("ui_click „neue-session“ und „Starten“ werden wirklich geklickt (nicht nur gezeigt)", async () => {
    const { sent, reg } = setup();
    await reg.call("full", "ui_click", { target: "neue-session" }, ctx);
    await reg.call("full", "ui_click", { target: "Starten" }, ctx);
    await reg.call("full", "ui_click", { target: "Session löschen" }, ctx);
    expect(sent.map((m) => m.action)).toEqual(["click", "click", "highlight"]);
  });

  it("ui_read_screen reicht Optionen und aktuellen Wert durch", async () => {
    const { reg, setAnswer } = setup();
    setAnswer((m) => ({
      type: "nyx.ui.screen",
      requestId: m.requestId,
      route: "/sessions",
      title: "Sessions",
      elements: [{ id: "new-session:model", label: "Modell", kind: "select", risk: false, options: ["Standard", "Opus 5.5"], value: "Standard" }],
    }));
    const r = (await reg.call("full", "ui_read_screen", {}, ctx)) as { elemente: Record<string, unknown>[] };
    expect(r.elemente[0]).toEqual({ id: "new-session:model", label: "Modell", art: "select", riskant: false, optionen: ["Standard", "Opus 5.5"], wert: "Standard" });
  });

  it("ui_click-Beschreibung nennt die Freigabe-Liste, nicht mehr „Schließen“", () => {
    const { reg } = setup();
    const d = reg.listFor("full").find((t) => t.name === "ui_click")?.description ?? "";
    expect(d).toMatch(/Löschen, Merge, Push, Deploy/);
    expect(d).not.toMatch(/Löschen, Schließen/);
    expect(reg.listFor("full").find((t) => t.name === "ui_select")?.description).toMatch(/Auswahl/);
  });
});

describe("Prompt: Nyx kann alles, was NyxOS kann", () => {
  const base = { memoryBlock: "", channel: "web" as const, now: new Date("2026-09-26T10:00:00Z") };
  const all = [...NYX_UI_TOOLS];

  it("ui_select gehört zu den UI-Werkzeugen (fällt bei Telegram mit weg)", () => {
    expect(NYX_UI_TOOLS).toContain("ui_select");
  });

  it("Regel: erst ui_read_screen versuchen statt „kann ich nicht“; nur die Freigabe-Liste zeigt er nur", () => {
    const p = buildNyxSystemPrompt({ ...base, tools: all });
    expect(p).toMatch(/nie „kann ich nicht“/i);
    expect(p).toMatch(/ui_select/);
    expect(p).toMatch(/Löschen, Merge, Push, Deploy, Migration/);
    expect(p).not.toMatch(/Riskante Knöpfe \(Löschen, Schließen/);
  });

  it("Rezept „neue Session“ steht drin", () => {
    const p = buildNyxSystemPrompt({ ...base, tools: all });
    for (const s of ["ui_click „neue-session“", "new-session:tool", "new-session:model", "new-session:folder", "new-session:prompt", "new-session:start"]) expect(p).toContain(s);
  });

  it("ohne ui_select (alte Werkzeugliste) steht der UI-Abschnitt trotzdem, nur ohne Auswahl-Rezept", () => {
    const p = buildNyxSystemPrompt({ ...base, tools: ["ui_navigate", "ui_click", "ui_type", "ui_read_screen"] });
    expect(p).toMatch(/Plattform steuern/);
    expect(p).not.toMatch(/new-session:model/);
  });
});
