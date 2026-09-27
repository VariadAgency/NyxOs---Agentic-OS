// Numerische IDs in Routen: `GET /api/entries/abc/start-plan` gab 500 statt 404, weil
// `Number("abc")` = NaN in die Datenbank ging. Alle Routen mit numerischer `:id` prüfen die ID jetzt
// an EINER Stelle (`src/ids.ts`) und antworten mit 404 — nie mit 500.
import { describe, expect, it } from "vitest";
import { MAX_SERIAL_ID, parseSerialId } from "../src/ids.js";
import { setup } from "./helpers.js";

const BAD_IDS = ["abc", "NaN", "1e20", "99999999999", "0", "-1", "1.5", "0x10", "01"];

const ROUTES: { method: string; path: (id: string) => string; body?: unknown }[] = [
  { method: "GET", path: (id) => `/api/entries/${id}` },
  { method: "PATCH", path: (id) => `/api/entries/${id}`, body: { priority: "p1" } },
  { method: "DELETE", path: (id) => `/api/entries/${id}` },
  { method: "POST", path: (id) => `/api/entries/${id}/maturity`, body: {} },
  { method: "POST", path: (id) => `/api/entries/${id}/subtasks/complete`, body: { subtaskTitle: "x" } },
  { method: "POST", path: (id) => `/api/entries/${id}/progress`, body: { note: "x" } },
  { method: "POST", path: (id) => `/api/entries/${id}/promote`, body: {} },
  { method: "GET", path: (id) => `/api/entries/${id}/start-plan` },
  { method: "POST", path: (id) => `/api/entries/${id}/start`, body: {} },
  { method: "GET", path: (id) => `/api/usage/prices/${id}` },
  { method: "PATCH", path: (id) => `/api/usage/prices/${id}`, body: {} },
  { method: "GET", path: (id) => `/api/builds/${id}` },
  { method: "GET", path: (id) => `/api/haiku/threads/${id}` },
  { method: "POST", path: (id) => `/api/inbox/${id}/answer`, body: { answer: "x" } },
  { method: "POST", path: (id) => `/api/inbox/${id}/dismiss`, body: {} },
  { method: "POST", path: (id) => `/api/approvals/${id}/decide`, body: { decision: "approve" } },
  { method: "POST", path: (id) => `/api/idealinks/${id}/revoke`, body: {} },
  { method: "DELETE", path: (id) => `/api/reservations/${id}` },
  { method: "PATCH", path: (id) => `/api/rules/${id}`, body: {} },
  { method: "PATCH", path: (id) => `/api/sort-rules/${id}`, body: {} },
];

describe("parseSerialId", () => {
  it("nimmt nur 1 … 2^31-1 in Ziffern an", () => {
    expect(parseSerialId("1")).toBe(1);
    expect(parseSerialId(String(MAX_SERIAL_ID))).toBe(MAX_SERIAL_ID);
    expect(parseSerialId(String(MAX_SERIAL_ID + 1))).toBeNull();
    for (const bad of BAD_IDS) expect(parseSerialId(bad), bad).toBeNull();
    expect(parseSerialId(undefined)).toBeNull();
    expect(parseSerialId(Number.NaN)).toBeNull();
  });
});

describe("Routen mit numerischer :id", () => {
  it("unbrauchbare ID → 404 statt 500, auf jeder Route", async () => {
    const t = await setup();
    const failures: string[] = [];
    for (const r of ROUTES) {
      for (const id of BAD_IDS) {
        const res = await t.app.request(r.path(id), {
          method: r.method,
          headers: { "content-type": "application/json", ...t.auth },
          ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        });
        if (res.status !== 404) failures.push(`${r.method} ${r.path(id)} → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("„Alle freigeben“ mit unbrauchbaren IDs im Körper → 200, nichts freigegeben (kein 500)", async () => {
    const t = await setup();
    const ids = BAD_IDS.flatMap((id) => [`inbox:${id}`, `approval:${id}`]);
    const res = await t.post("/api/haiku/release-all", { ids });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { released: number }).released).toBe(0);
  });

  it("Großansicht eines Eintrags mit einem kaputten Eintrags-Link stürzt nicht ab", async () => {
    const t = await setup();
    const created = (await (await t.post("/api/entries", { kind: "bug", title: "Mit kaputtem Link" })).json()) as { entry: { id: number } };
    await t.post("/api/entries/link", { fromType: "entry", fromId: String(created.entry.id), toType: "entry", toId: "abc", relation: "verwandt" });
    const res = await t.app.request(`/api/entries/${created.entry.id}`);
    expect(res.status).toBe(200);
  });
});
