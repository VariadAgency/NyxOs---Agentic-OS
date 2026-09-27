// Die Zustell-Warteschlange (`session_deliveries`) steht auch im Überblick.
// Die Zahl kommt aus dem Überblick-Schnappschuss (`takeSnapshot`) und ist im Überblick exakt dieselbe.
import { describe, expect, it } from "vitest";
import { sessionDeliveries, sessions } from "../src/db/schema.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
import { setup } from "./helpers.js";

describe("Warteschlange im Überblick", () => {
  it("zählt nur wartende, nicht abgelaufene Nachrichten; Überblick = Schnappschuss; Link führt zur Session", async () => {
    const { db } = await setup();
    const now = new Date();
    const later = new Date(now.getTime() + 3600_000).toISOString();
    const past = new Date(now.getTime() - 60_000).toISOString();
    await db.insert(sessions).values([
      { id: "claude:q1", tool: "claude", sessionId: "q1", title: "Warteschlange A", state: "waiting", closedAt: null },
      { id: "claude:q2", tool: "claude", sessionId: "q2", title: "Warteschlange B", state: "running", closedAt: null },
    ]);
    const d = (sessionKey: string, status: string, expiresAt: string) => ({ sessionKey, kind: "chat", method: "send_message", payload: { text: "hallo" }, status, expiresAt });
    await db.insert(sessionDeliveries).values([
      d("claude:q1", "queued", later),
      d("claude:q1", "queued", later),
      d("claude:q2", "sending", later),
      d("claude:q2", "queued", past), // abgelaufen → zählt nicht
      d("claude:q2", "sent", later),
      d("claude:q2", "cancelled", later),
    ]);

    const snap = await takeSnapshot(db, now);
    expect(snap.pendingDeliveries.count).toBe(3);
    expect(snap.pendingDeliveries.sessions).toBe(2);
    expect(snap.pendingDeliveries.href).toContain("q1");

    const overview = await getOverviewSnapshot(db, "Alex", now);
    expect(overview.pendingDeliveries).toEqual(snap.pendingDeliveries);
  });

  it("leere Warteschlange → 0, kein Link", async () => {
    const { db } = await setup();
    const snap = await takeSnapshot(db);
    expect(snap.pendingDeliveries).toEqual({ count: 0, sessions: 0, href: null, title: null });
    expect((await getOverviewSnapshot(db)).pendingDeliveries).toEqual(snap.pendingDeliveries);
  });
});
