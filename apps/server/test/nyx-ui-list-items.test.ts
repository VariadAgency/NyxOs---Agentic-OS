// Nyx-Cursor: Listeneinträge (`item:<art>…`) gehen als echter Klick an den Browser – ihr Suchtext ist keine
// Knopf-Beschriftung (eine Aufgabe „Push-Fix“ öffnen ist nicht riskant). `ui_type` kann auf Wunsch abschicken.
import { NyxUiCommandSchema } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolContext } from "../src/haiku/tools.js";
import { NyxUiBridge, registerNyxUiTools } from "../src/nyx/ui.js";

type Sent = Record<string, unknown>;
// Runde vom Nutzer selbst (Web-Chat): nur solche Runden dürfen klicken/tippen/wählen.
const ctx = { db: null, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web" } as unknown as ToolContext;

function setup() {
  const sent: Sent[] = [];
  const holder: { bridge: NyxUiBridge | null } = { bridge: null };
  const hub = {
    size: 1,
    broadcast(m: unknown) {
      sent.push(m as Sent);
      queueMicrotask(() => holder.bridge?.receive({ type: "nyx.ui.result", requestId: (m as Sent).requestId, ok: true }));
    },
  };
  const bridge = new NyxUiBridge({ hub, timeoutMs: 500 });
  holder.bridge = bridge;
  const reg = new ToolRegistry();
  registerNyxUiTools(reg, bridge);
  return { sent, reg };
}

describe("ui_click mit Listeneintrag", () => {
  it("item:task:push fix wird geklickt, nicht nur gezeigt", async () => {
    const { sent, reg } = setup();
    const r = (await reg.call("full", "ui_click", { target: "item:task:push fix" }, ctx)) as Record<string, unknown>;
    expect(sent.map((m) => m.action)).toEqual(["click"]);
    expect(r).toMatchObject({ erledigt: true });
  });

  it("ui_type mit submit schickt submit:true mit; der Vertrag kennt submit", async () => {
    const { sent, reg } = setup();
    await reg.call("full", "ui_type", { target: "suche", text: "Heatmap", submit: true }, ctx);
    expect(sent[0]).toMatchObject({ action: "type", target: "suche", text: "Heatmap", submit: true });
    expect(NyxUiCommandSchema.parse({ action: "type", target: "suche", text: "x", submit: true })).toMatchObject({ submit: true });
  });
});
