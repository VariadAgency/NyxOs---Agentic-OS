// Session-Steuerung über den Server – Liste je Werkzeug, Befehl geht nur über die sichere
// Zustellung (wartet, bis die Session wartet), nichts, was das Werkzeug nicht kann; Nyx darf es auch.
import { BRIDGE_CAP_CHAT, type ServerToBridge, type SessionControlsView } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessionDeliveries, sessions } from "../src/db/schema.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { ROUTE_PURPOSES } from "../src/nyx/appApi/catalog.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Rpc = Extract<ServerToBridge, { op: "rpc" }>;

function fakeBridge(hub: BridgeHub) {
  const calls: Rpc[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        calls.push(msg);
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result: { sent: true } })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r1", tmuxSocket: "zentrale", caps: [BRIDGE_CAP_CHAT] }));
  return { sends: () => calls.filter((c) => c.method === "send_text") };
}

type T = Awaited<ReturnType<typeof setup>>;
async function insert(t: T, o: Partial<typeof sessions.$inferInsert> & { id: string; sessionId: string }) {
  await t.db.insert(sessions).values({ tool: "claude", status: "running", state: "running", attachable: true, tmuxName: "zc-claude-aaaa1111", models: ["claude-opus-5-5"], ...o });
}
const post = (t: T, id: string, body: unknown) => t.app.request(`/api/sessions/${id}/controls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Session-Steuerung (Server)", () => {
  it("GET: Claude-Session → Anthropic-Liste + Stufen; Codex → kein Wechsel, aber Komprimieren", async () => {
    const t = await setup();
    await insert(t, { id: "claude:c1", sessionId: "c1", lastUsageModel: "claude-opus-5-5" });
    await insert(t, { id: "codex:x1", sessionId: "x1", tool: "codex", models: ["gpt-6-astra"], tmuxName: "zc-codex-bbbb2222" });
    const c = (await (await t.app.request("/api/sessions/claude:c1/controls")).json()) as SessionControlsView;
    expect(c.currentModel).toBe("claude-opus-5-5");
    expect(c.model.options.every((m) => m.id.startsWith("claude-"))).toBe(true);
    expect(c.effort.levels).toContain("max");
    const x = (await (await t.app.request("/api/sessions/codex:x1/controls")).json()) as SessionControlsView;
    expect(x.model.canSwitch).toBe(false);
    expect(x.model.options).toEqual([]);
    expect(x.compact.available).toBe(true);
    expect((await t.app.request("/api/sessions/claude:nope/controls")).status).toBe(404);
  });

  it("POST Modell: Session arbeitet → Warteschlange (nichts getippt), wartet → `/model <id>` mit Bildschirm-Prüfung", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insert(t, { id: "claude:c2", sessionId: "c2" });
    const r1 = await post(t, "claude:c2", { kind: "model", model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ status: "queued", command: "/model claude-sonnet-5" });
    expect(b.sends()).toHaveLength(0);
    // Neue Wahl ersetzt die alte, die noch wartet (nie zwei Modellwechsel hintereinander).
    await post(t, "claude:c2", { kind: "model", model: "claude-fable-5-1" });
    const rows = await t.db.select().from(sessionDeliveries).where(eq(sessionDeliveries.sessionKey, "claude:c2"));
    expect(rows.filter((r) => r.status === "queued").map((r) => (r.payload as { text: string }).text)).toEqual(["/model claude-fable-5-1"]);
    expect(rows.every((r) => r.kind === "control")).toBe(true);

    await insert(t, { id: "claude:c3", sessionId: "c3", state: "waiting", tmuxName: "zc-claude-cccc3333" });
    const r2 = await post(t, "claude:c3", { kind: "effort", level: "high" });
    expect(await r2.json()).toMatchObject({ status: "sent", command: "/effort high" });
    expect(b.sends()[0]).toMatchObject({ params: { text: "/effort high", onlyWhenWaiting: true, hookWaiting: true } });
  });

  it("POST: nichts, was das Werkzeug/Modell nicht kann (400) – und ohne NyxOS-Terminal ehrlich 409", async () => {
    const t = await setup();
    fakeBridge(t.bridgeHub);
    await insert(t, { id: "claude:c4", sessionId: "c4", lastUsageModel: "claude-haiku-4-5-20251001", state: "waiting" });
    await insert(t, { id: "codex:x2", sessionId: "x2", tool: "codex", models: ["gpt-6-astra"], tmuxName: "zc-codex-dddd4444", state: "waiting" });
    await insert(t, { id: "claude:c5", sessionId: "c5", attachable: false, tmuxName: null });
    expect((await post(t, "claude:c4", { kind: "effort", level: "low" })).status).toBe(400);
    expect((await post(t, "claude:c4", { kind: "model", model: "gpt-5" })).status).toBe(400);
    expect((await post(t, "codex:x2", { kind: "model", model: "gpt-5.5" })).status).toBe(400);
    expect((await post(t, "claude:c4", { kind: "wat" })).status).toBe(400);
    expect((await post(t, "claude:c5", { kind: "model", model: "claude-sonnet-5" })).status).toBe(409);
    const all = await t.db.select().from(sessionDeliveries);
    expect(all.filter((r) => r.kind === "control")).toHaveLength(0);
  });

  it("Nyx darf es auch (app_api: direkt, mit Zweck im Katalog)", () => {
    expect(classifyApiRequest("GET", "/api/sessions/claude:c1/controls").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/sessions/claude:c1/controls").access).toBe("direkt");
    expect(ROUTE_PURPOSES["GET /api/sessions/:id/controls"]).toBeTruthy();
    expect(ROUTE_PURPOSES["POST /api/sessions/:id/controls"]).toBeTruthy();
  });
});
