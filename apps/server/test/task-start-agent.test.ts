// „Aufgabe → Agent starten“: Der Aufgaben-Tab öffnet den bestehenden Dialog „Neue Session“ vorbelegt.
// Kein neuer Start-Weg — `POST /api/terminal/start` nimmt optional `entryId` an. Nach dem Start (nur nach des Nutzers
// Klick) hängt die Session am Auftrag: `startedSessionKey` + Verknüpfung „gestartet“. Die Stufe bleibt, wie sie
// ist (die setzt nur Reife-Check/Automatik).
import type { ServerToBridge } from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, links } from "../src/db/schema.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const SID = "7a1b2c3d-1111-4222-8333-944455556666";

function bridgeStarting(hub: BridgeHub, seen: Record<string, unknown>[]) {
  hub.attach(
    {
      send(data: string) {
        const m = JSON.parse(data) as ServerToBridge;
        if (m.op !== "rpc" || m.method !== "start") return;
        seen.push(m.params as Record<string, unknown>);
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: m.id, ok: true, result: { tmuxName: "zc-claude-t3t3t3t3", tool: "claude", sessionId: SID, startedMs: 5 } })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r2", tmuxSocket: "nyxos", caps: [] }));
}

const start = (t: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) =>
  t.app.request("/api/terminal/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Aufgabe → Agent starten", () => {
  it("Start mit entryId verknüpft die neue Session mit dem Auftrag (Stufe bleibt)", async () => {
    const hub = new BridgeHub();
    const seen: Record<string, unknown>[] = [];
    bridgeStarting(hub, seen);
    const t = await setup({ bridgeHub: hub });
    const [e] = await t.db.insert(entries).values({ kind: "aufgabe", title: "Finder schneller", stage: "geplant", sourceType: "goal", sourceId: "tools/NyxOS/auftraege/R2-nyx/GOAL.md" }).returning({ id: entries.id });
    const id = e?.id ?? 0;
    const res = await start(t, { tool: "claude", model: "opus", cwd: "/Users/x/projects/tools/NyxOS", prompt: "/goal auftraege/R2-nyx/GOAL.md", entryId: id });
    expect(res.status).toBe(200);
    // Die Brücke bekommt nur die bekannten Start-Felder, kein entryId.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: "claude", model: "opus", prompt: "/goal auftraege/R2-nyx/GOAL.md" });
    expect(seen[0]?.entryId).toBeUndefined();
    const [row] = await t.db.select().from(entries).where(eq(entries.id, id));
    expect(row?.startedSessionKey).toBe(`claude:${SID}`);
    expect(row?.stage).toBe("geplant");
    const l = await t.db.select().from(links).where(and(eq(links.fromType, "entry"), eq(links.fromId, String(id))));
    expect(l).toEqual([expect.objectContaining({ toType: "session", toId: `claude:${SID}`, relation: "gestartet" })]);
    // Die Aufgabenliste zeigt die Session am Auftrag.
    const list = (await (await t.app.request("/api/entries")).json()) as { entries: { id: number; startedSessionKey: string | null }[] };
    expect(list.entries.find((x) => x.id === id)?.startedSessionKey).toBe(`claude:${SID}`);
  });

  it("unbekannter oder ungültiger Auftrag → kein Start (404/400), nichts verknüpft; ohne entryId wie bisher", async () => {
    const hub = new BridgeHub();
    const seen: Record<string, unknown>[] = [];
    bridgeStarting(hub, seen);
    const t = await setup({ bridgeHub: hub });
    expect((await start(t, { tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null, entryId: 9999 })).status).toBe(404);
    expect((await start(t, { tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null, entryId: "1; drop" })).status).toBe(400);
    expect((await start(t, { tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null, entryId: -3 })).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await start(t, { tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null })).status).toBe(200);
    expect((await start(t, { tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null, entryId: null })).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(await t.db.select().from(links)).toEqual([]);
  });
});
