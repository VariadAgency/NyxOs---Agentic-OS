// Bilder im Session-Chat. Früher erschien ein gesendetes Bild im Chat nur als „[Image #1]“.
// Claude Code legt das eingefügte Bild im Verlauf ab (Block `type: "image"`, base64). Der Server meldet es
// jetzt am Nutzer-Eintrag (`images`) und liefert es über `/api/sessions/:id/attachments/:itemId/:n` aus —
// nur Bilder aus des Nutzers eigenen Eingaben dieser Session, nur mit Anmeldung, nur echte Bild-Arten.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { TranscriptResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { needsAuth } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;
const SID = "bbbbbbbb-0000-4000-8000-00000000f2b1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

async function uploadArchive(t: App, raw: Buffer) {
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: t.auth.authorization,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": SID,
      "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${SID}.jsonl`),
      "x-nyxos-sha256": createHash("sha256").update(raw).digest("hex"),
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
}

function lines() {
  return [
    {
      type: "user",
      uuid: "u-img",
      timestamp: "2026-09-25T12:48:42.000Z",
      sessionId: SID,
      cwd: "/x",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Image #1] Welche Farbe hat dieses Bild?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
        ],
      },
    },
    // Ein Werkzeug-Ergebnis mit Bild (z. B. Screenshot von Claude) ist KEIN eigener Upload.
    {
      type: "user",
      uuid: "u-tool",
      timestamp: "2026-09-25T12:48:44.000Z",
      sessionId: SID,
      message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }] }] },
    },
    // SVG kann Skript enthalten — nie ausliefern.
    {
      type: "user",
      uuid: "u-svg",
      timestamp: "2026-09-25T12:48:46.000Z",
      sessionId: SID,
      message: { role: "user", content: [{ type: "text", text: "[Image #2]" }, { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" } }] },
    },
  ];
}

describe("Chat-Bilder", () => {
  it("meldet das Bild am Nutzer-Eintrag und liefert es als PNG aus", async () => {
    const t = await setup();
    await uploadArchive(t, Buffer.from(lines().map((l) => JSON.stringify(l)).join("\n") + "\n"));
    const res = await t.app.request(`/api/sessions/${SID}/transcript?direction=forward`);
    const body = (await res.json()) as TranscriptResponse;
    const user = body.items.find((i) => i.role === "user" && i.text?.includes("Welche Farbe"));
    expect(user?.images).toEqual([{ n: 1, mediaType: "image/png", bytes: PNG.length }]);

    const img = await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(user?.id ?? "")}/1`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("kein Bild aus Werkzeug-Ergebnissen, kein SVG, kein falscher Index", async () => {
    const t = await setup();
    await uploadArchive(t, Buffer.from(lines().map((l) => JSON.stringify(l)).join("\n") + "\n"));
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`claude:${SID}:u-tool`)}/1`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`claude:${SID}:u-svg`)}/1`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`claude:${SID}:u-img`)}/2`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`claude:${SID}:u-img`)}/0`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/andere-session/attachments/${encodeURIComponent(`claude:${SID}:u-img`)}/1`)).status).toBe(404);
  });

  it("Bilder gibt es nur mit Anmeldung, auch wenn Lesen sonst frei ist", () => {
    expect(needsAuth("GET", `/api/sessions/claude:${SID}/attachments/x/1`, false)).toBe(true);
    expect(needsAuth("GET", `/api/sessions/claude:${SID}/transcript`, false)).toBe(false);
  });
});

describe("Chat-Bilder – Anmeldung wirklich Pflicht", () => {
  it("ohne Anmeldung 401 an der echten App, auch wenn Lesen sonst frei ist; der Verlauf bleibt lesbar", async () => {
    const t = await setup({ signedIn: false });
    await uploadArchive(t, Buffer.from(lines().map((l) => JSON.stringify(l)).join("\n") + "\n"));
    const id = encodeURIComponent(`claude:${SID}:u-img`);
    const res = await t.app.request(`/api/sessions/${SID}/attachments/${id}/1`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/^image\//);
    // HEAD scheitert schon an der Content-Type-Pflicht (415) — jedenfalls nie 200.
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${id}/1`, { method: "HEAD" })).status).not.toBe(200);
    expect((await t.app.request(`/api/sessions/claude:${SID}/attachments/${id}/1`)).status).toBe(401);
    expect((await t.app.request(`/api/sessions/${SID}/transcript?direction=forward`)).status).toBe(200);
    // Mit Anmeldung (Cookie) kommt das Bild.
    const ok = await t.app.request(`/api/sessions/${SID}/attachments/${id}/1`, { headers: { cookie: t.authHeaders.cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
  });

  it("leere oder fremde Eintrags-ID liefert nichts", async () => {
    const t = await setup();
    await uploadArchive(t, Buffer.from(lines().map((l) => JSON.stringify(l)).join("\n") + "\n"));
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`claude:${SID}:`)}/1`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/${SID}/attachments/${encodeURIComponent(`codex:${SID}:u-img`)}/1`)).status).toBe(404);
  });
});
