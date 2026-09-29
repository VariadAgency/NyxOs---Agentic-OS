// Audit-Detail. Der Befund kommt aus der Plan-Zeile (Rang, Stufe, Schwere, R, Aufwand, Paket,
// „vorher abschließen“), der VOLLE Text aus der verlinkten Audit-Datei auf dem Rechner (über die Brücke) — und
// wird auf dem Server gespiegelt, damit er auch bei zugeklapptem Mac da ist.
import { createHash } from "node:crypto";
import { BRIDGE_CAP_FINDER, type AuditDetail, type FinderReadResult, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, importFiles, sessionFiles, sessions } from "../src/db/schema.js";
import { importAuditTexts, importGoalFiles } from "../src/entries/import.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const PLAN_PATH = "App/docs/audit-2026-09/11-Priorisierter-Massnahmenplan/MASSNAHMENPLAN.md";
const SRC_PATH = "App/docs/audit-2026-09/02-Sicherheit/Backend-Community-Sicherheit.md";
const PLAN = `# Maßnahmenplan

## Gemeinsam eingeplante Pakete

| Paket | Befunde | Gesamtaufwand einmal | Gemeinsame Arbeit |
|---|---|---|---|
| P-KOMM | B-115, B-116 | L | Seitengrößen und Besitzrechte gemeinsam prüfen. |

## Gesamtreihenfolge sämtlicher Befunde

| Rang | Stufe | Befund / zu behebendes Problem | Schwere | R | Originalaufwand | Paket | Vorher abschließen |
|---:|---:|---|---|---:|---|---|---|
| 1 | 0 | [B-115 — Negative Seitengröße führt zum Absturz](../02-Sicherheit/Backend-Community-Sicherheit.md) | Kritisch | 5 | S | P-KOMM | — |
| 2 | 0 | [B-116 — Fremder wird Besitzer der Community](../02-Sicherheit/Backend-Community-Sicherheit.md#b-116) | Hoch | 4 | M | P-KOMM | — |
| 3 | 1 | [B-60 — Fremde Stempelkarten lesbar](../02-Sicherheit/Backend-Identitaet.md) | Kritisch | 5 | M | P-B-60 | B-115 |
`;
const SOURCE = `# Sicherheit — Community-Service

## Befunde

### [B-115] Negative Seitengröße führt zum Absturz

**Beleg:** \`FeedController.swift:40\` rechnet mit \`limit\` ohne Prüfung.

| Weg | Folge |
|---|---|
| GET /feed?limit=-1 | Absturz |

### [B-116] Fremder wird Besitzer der Community

Text zu B-116.

## Abschluss

Ende.
`;
const GOAL = "# P9 Community härten\n\nZiel: B-115 und B-116 beheben.\n";

function fakeBridge(hub: BridgeHub, files: Record<string, string>) {
  const calls: Record<string, unknown>[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc" || msg.method !== "finder") return;
        const p = msg.params as Record<string, unknown>;
        calls.push(p);
        const content = files[String(p.rel)];
        let out: unknown;
        if (content === undefined) out = { ok: false, error: "Diese Datei gibt es nicht mehr.", code: "finder_not_found" };
        else if (p.op === "stat") out = { ok: true, result: { root: p.root, writable: true, entry: { name: "x.md", rel: p.rel, kind: "markdown", isDir: false, size: Buffer.byteLength(content), mtimeMs: Date.parse("2026-09-21T10:00:00.000Z"), children: null, hidden: false, secret: false, link: false } } };
        else {
          const buf = Buffer.from(content);
          const r: FinderReadResult = { b64: buf.toString("base64"), offset: 0, size: buf.length, mtimeMs: Date.parse("2026-09-21T10:00:00.000Z"), sha256: createHash("sha256").update(buf).digest("hex"), eof: true };
          out = { ok: true, result: r };
        }
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ...(out as object) })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r2", tmuxSocket: "nyxos", caps: [BRIDGE_CAP_FINDER] }));
  return calls;
}

async function seed(t: Awaited<ReturnType<typeof setup>>) {
  await t.db.insert(importFiles).values([
    { path: PLAN_PATH, content: PLAN, sha256: "a", sizeBytes: PLAN.length },
    { path: "tools/NyxOS/auftraege/P9-komm/GOAL.md", content: GOAL, sha256: "b", sizeBytes: GOAL.length },
  ]);
  await importAuditTexts(t.db, [PLAN], { markMissing: false });
  await importGoalFiles(t.db, [{ path: "tools/NyxOS/auftraege/P9-komm/GOAL.md", content: GOAL }], { markMissing: false });
  const ids = Object.fromEntries((await t.db.select({ id: entries.id, sourceId: entries.sourceId }).from(entries)).map((r) => [r.sourceId, r.id]));
  await t.db.insert(sessions).values({ id: "claude:s-audit", sessionId: "s-audit", tool: "claude", status: "running", state: "waiting", title: "Audit Community lesen" });
  await t.db.insert(sessionFiles).values({ sessionKey: "claude:s-audit", path: `/Users/alex/projects/${SRC_PATH}`, mode: "read" });
  return ids as Record<string, number>;
}

describe("Audit-Detail", () => {
  it("zeigt Befund-Werte, den Abschnitt, die ganze Datei, Verwandte, Aufträge und Sessions", async () => {
    const hub = new BridgeHub();
    const calls = fakeBridge(hub, { [SRC_PATH]: SOURCE });
    const t = await setup({ bridgeHub: hub });
    const ids = await seed(t);
    const res = await t.app.request(`/api/audits/${ids["B-115"]}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as AuditDetail;
    expect(d.finding).toEqual({ id: "B-115", title: "Negative Seitengröße führt zum Absturz", rang: 1, stufe: 0, schwere: "Kritisch", risiko: 5, aufwand: "S", paket: "P-KOMM", vorher: [], paketArbeit: "Seitengrößen und Besitzrechte gemeinsam prüfen." });
    expect(d.planPath).toBe(PLAN_PATH);
    expect(d.source?.path).toBe(SRC_PATH);
    expect(d.source?.origin).toBe("mac");
    expect(d.source?.content).toBe(SOURCE);
    expect(d.source?.updatedAt).toBe("2026-09-21T10:00:00.000Z");
    expect(d.source?.section?.startsWith("### [B-115] Negative Seitengröße")).toBe(true);
    expect(d.source?.section).toContain("| GET /feed?limit=-1 | Absturz |");
    expect(d.source?.section).not.toContain("B-116] Fremder");
    expect(d.related.map((r) => [r.findingId, r.reason, r.entryId])).toEqual([["B-116", "paket", ids["B-116"]]]);
    expect(d.tasks.map((x) => x.title)).toEqual(["P9 Community härten"]);
    expect(d.sessions.map((s) => s.title)).toEqual(["Audit Community lesen"]);
    expect(calls.every((c) => c.root === "project")).toBe(true);
  });

  it("nennt, was vorher erledigt sein muss", async () => {
    const hub = new BridgeHub();
    fakeBridge(hub, {});
    const t = await setup({ bridgeHub: hub });
    const ids = await seed(t);
    const d = (await (await t.app.request(`/api/audits/${ids["B-60"]}`)).json()) as AuditDetail;
    expect(d.finding?.vorher).toEqual(["B-115"]);
    expect(d.related).toEqual([expect.objectContaining({ findingId: "B-115", reason: "vorher", entryId: ids["B-115"], schwere: "Kritisch" })]);
    // Datei auf dem Rechner fehlt und es gibt keinen Spiegel: ehrlich leer, kein Fehler
    expect(d.source).toMatchObject({ path: "App/docs/audit-2026-09/02-Sicherheit/Backend-Identitaet.md", content: null, origin: null });
  });

  it("Mac zugeklappt: der gespiegelte Stand wird gezeigt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    fakeBridge(hub, { [SRC_PATH]: SOURCE });
    const ids = await seed(t);
    expect((await t.app.request(`/api/audits/${ids["B-115"]}`)).status).toBe(200);
    hub.detach((hub as unknown as { bridge: { socket: Parameters<BridgeHub["detach"]>[0] } }).bridge.socket);
    const d = (await (await t.app.request(`/api/audits/${ids["B-116"]}`)).json()) as AuditDetail;
    expect(d.source?.origin).toBe("spiegel");
    expect(d.source?.section?.startsWith("### [B-116] Fremder wird Besitzer")).toBe(true);
    expect(d.source?.section).not.toContain("## Abschluss");
  });

  it("nur Audit-Einträge; sonst 404", async () => {
    const t = await setup({ bridgeHub: new BridgeHub() });
    await seed(t);
    const [goal] = await t.db.select({ id: entries.id }).from(entries).where(eq(entries.kind, "aufgabe"));
    expect((await t.app.request(`/api/audits/${goal?.id}`)).status).toBe(404);
    expect((await t.app.request(`/api/audits/abc`)).status).toBe(400);
  });
});

describe("Plan-Links", () => {
  it("ein kaputter Link (%-Folge) oder einer aus App/docs hinaus bricht das Detail nicht und wird nie gelesen", async () => {
    const { parsePlan } = await import("../src/audits/detail.js");
    const text = [
      "| 1 | 0 | [B-1 — Kaputt](../x%E0.md) | Hoch | 4 | S | P-1 | — |",
      "| 2 | 0 | [B-2 — Hinaus](../../../backend/.env.md) | Hoch | 4 | S | P-1 | — |",
      "| 3 | 0 | [B-3 — Gut](../02-Sicherheit/A.md) | Hoch | 4 | S | P-1 | — |",
    ].join("\n");
    const plan = parsePlan("App/docs/audits/01-Plan/MASSNAHMENPLAN.md", text);
    expect(plan.rows.get("B-1")?.sourcePath).toBeNull();
    expect(plan.rows.get("B-2")?.sourcePath).toBeNull();
    expect(plan.rows.get("B-3")?.sourcePath).toBe("App/docs/audits/02-Sicherheit/A.md");
  });
});
