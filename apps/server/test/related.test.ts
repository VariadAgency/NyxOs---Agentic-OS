import type { IngestItem, SessionSummary } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

/**
 * `GET /api/sessions/:id/related`: Eltern-/Kind-Session (aus `parentSessionId`) plus
 * Sessions, die mindestens eine derselben Dateien GESCHRIEBEN haben (`session_files`, `mode =
 * 'write'` auf beiden Seiten) (s. `RefsPanel.tsx`).
 */

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: null,
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T10:00:00.000Z",
  models: [],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: null,
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});

const summaryItem = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });

describe("Bezüge: GET /api/sessions/:id/related", () => {
  it("liefert 404 für eine unbekannte Session", async () => {
    const t = await setup();
    const res = await t.app.request("/api/sessions/claude:unbekannt/related");
    expect(res.status).toBe(404);
  });

  it("liefert Eltern- und Kind-Session", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "eltern", title: "Eltern-Session" })),
        summaryItem(summary({ sessionId: "kind-1", title: "Kind 1", parentSessionId: "eltern" })),
        summaryItem(summary({ sessionId: "kind-2", title: "Kind 2", parentSessionId: "eltern" })),
      ],
    });

    const kindRes = await t.app.request("/api/sessions/claude:kind-1/related");
    expect(kindRes.status).toBe(200);
    const kindBody = (await kindRes.json()) as { parent: { sessionId: string } | null; children: unknown[] };
    expect(kindBody.parent?.sessionId).toBe("eltern");
    expect(kindBody.children).toHaveLength(0);

    const elternRes = await t.app.request("/api/sessions/claude:eltern/related");
    const elternBody = (await elternRes.json()) as { parent: unknown; children: { sessionId: string }[] };
    expect(elternBody.parent).toBeNull();
    expect(elternBody.children.map((c) => c.sessionId).sort()).toEqual(["kind-1", "kind-2"]);
  });

  it("findet Sessions mit gemeinsam geschriebenen Dateien, sortiert nach Anzahl absteigend", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "basis", title: "Basis", filesWritten: ["/a.ts", "/b.ts"] })),
        // Teilt beide Dateien mit "basis" → sharedCount 2, muss vor "eine-datei" stehen.
        summaryItem(summary({ sessionId: "beide-dateien", title: "Beide Dateien", filesWritten: ["/a.ts", "/b.ts", "/c.ts"] })),
        // Teilt nur eine Datei → sharedCount 1.
        summaryItem(summary({ sessionId: "eine-datei", title: "Eine Datei", filesWritten: ["/a.ts"] })),
        // Liest nur (kein "write") → zählt nicht als Bezug.
        summaryItem(summary({ sessionId: "nur-gelesen", title: "Nur gelesen", filesRead: ["/a.ts"] })),
        // Ganz ohne Bezug.
        summaryItem(summary({ sessionId: "unbeteiligt", title: "Unbeteiligt", filesWritten: ["/z.ts"] })),
      ],
    });

    const res = await t.app.request("/api/sessions/claude:basis/related");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sameFiles: { sessionId: string; sharedFiles: string[]; sharedCount: number; art: string; title: string | null }[];
    };
    expect(body.sameFiles.map((s) => s.sessionId)).toEqual(["beide-dateien", "eine-datei"]);
    expect(body.sameFiles[0]).toMatchObject({ sharedCount: 2, sharedFiles: ["/a.ts", "/b.ts"], title: "Beide Dateien" });
    expect(body.sameFiles[1]).toMatchObject({ sharedCount: 1, sharedFiles: ["/a.ts"] });
  });

  it("kappt sharedFiles auf 5 Beispiele, sharedCount trägt trotzdem die echte Gesamtzahl", async () => {
    const t = await setup();
    const many = Array.from({ length: 7 }, (_, i) => `/f${i}.ts`);
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "viele-a", title: "Viele A", filesWritten: many })),
        summaryItem(summary({ sessionId: "viele-b", title: "Viele B", filesWritten: many })),
      ],
    });

    const res = await t.app.request("/api/sessions/claude:viele-a/related");
    const body = (await res.json()) as { sameFiles: { sharedFiles: string[]; sharedCount: number }[] };
    expect(body.sameFiles).toHaveLength(1);
    expect(body.sameFiles[0]?.sharedCount).toBe(7);
    expect(body.sameFiles[0]?.sharedFiles).toHaveLength(5);
  });

  it("liefert höchstens 20 Bezugs-Sessions", async () => {
    const t = await setup();
    const items: IngestItem[] = [summaryItem(summary({ sessionId: "basis-viele", title: "Basis", filesWritten: ["/shared.ts"] }))];
    for (let i = 0; i < 25; i++) items.push(summaryItem(summary({ sessionId: `bezug-${i}`, title: `Bezug ${i}`, filesWritten: ["/shared.ts"] })));
    await t.post("/ingest/events", { items });

    const res = await t.app.request("/api/sessions/claude:basis-viele/related");
    const body = (await res.json()) as { sameFiles: unknown[] };
    expect(body.sameFiles).toHaveLength(20);
  });
});
