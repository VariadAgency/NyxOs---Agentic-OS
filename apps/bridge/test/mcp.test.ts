// Der stdio-MCP-Server "nyxos" leitet an die echte
// Server-API weiter. Getestet gegen einen echten Server (PGlite, wie das übrige Repo) — nicht gegen
// einen Mock — damit der komplette Weg (Werkzeug → HTTP → Store → DB) bewiesen ist. Das eigentliche
// stdio-Framing (`runMcpServer`) ist eine dünne Hülle um `callTool`/`toolList`; die wird hier direkt
// geprüft (schneller, gleiche Abdeckung — s. Bericht).
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { setup, TOKEN } from "../../server/test/helpers.js";
import { callTool, toolList } from "../src/mcp.js";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

async function world() {
  const srv = await setup();
  const server = serve({ fetch: srv.app.fetch, port: 0, hostname: "127.0.0.1" });
  srv.injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  stops.push(() => void server.close());
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { srv, serverUrl };
}

describe("bridge/mcp", () => {
  it("tools/list nennt alle 7 Werkzeuge", async () => {
    const names = toolList().map((t) => t.name);
    expect(names.sort()).toEqual(["eintrag_anlegen", "eintrag_lesen", "eintrag_suchen", "fortschritt_melden", "frage_stellen", "teilaufgabe_erledigt", "verknuepfen"].sort());
  });

  it("eintrag_anlegen + teilaufgabe_erledigt x3 bewegen den Balken — Session kommt NUR aus der Umgebung, nie aus dem Werkzeug-Aufruf", async () => {
    const { serverUrl } = await world();
    const ctx = { serverUrl, sessionKey: "claude:mcp-demo-session", machineToken: TOKEN };
    const created = (await callTool("eintrag_anlegen", { kind: "bug", title: "MCP-Demo-Bug", subtasks: ["S1", "S2", "S3"] }, ctx)) as {
      entry: { id: number };
    };
    expect(created.entry.id).toBeGreaterThan(0);

    const detail = (await callTool("eintrag_lesen", { id: created.entry.id }, ctx)) as { subtasks: { id: number }[] };
    expect(detail.subtasks).toHaveLength(3);

    for (const s of detail.subtasks) {
      const after = (await callTool("teilaufgabe_erledigt", { entryId: created.entry.id, subtaskId: s.id }, ctx)) as { entry: { progressPercent: number; stage: string } };
      expect(after.entry.progressPercent).toBeGreaterThan(0);
    }
    const final = (await callTool("eintrag_lesen", { id: created.entry.id }, ctx)) as { entry: { progressPercent: number; stage: string } };
    expect(final.entry.progressPercent).toBe(100);
    expect(final.entry.stage).toBe("pruefen");
  });

  it("fortschritt_melden trägt eine Notiz in den Verlauf ein", async () => {
    const { serverUrl } = await world();
    const ctx = { serverUrl, sessionKey: "claude:mcp-demo-2", machineToken: TOKEN };
    const created = (await callTool("eintrag_anlegen", { kind: "idee", title: "Notiz-Test" }, ctx)) as { entry: { id: number } };
    await callTool("fortschritt_melden", { entryId: created.entry.id, note: "Recherche läuft, erste Ergebnisse da" }, ctx);
    const detail = (await callTool("eintrag_lesen", { id: created.entry.id }, ctx)) as { events: { kind: string; data: { note?: string } }[] };
    expect(detail.events.some((e) => e.kind === "fortschritt" && e.data.note?.includes("Recherche läuft"))).toBe(true);
  });

  it("frage_stellen verknüpft die Frage mit dem blockierten Eintrag", async () => {
    const { serverUrl } = await world();
    const ctx = { serverUrl, sessionKey: null, machineToken: TOKEN };
    const blocked = (await callTool("eintrag_anlegen", { kind: "bug", title: "Wartet auf Antwort" }, ctx)) as { entry: { id: number } };
    await callTool("frage_stellen", { title: "iOS 27: eigenes Glas oder Standard?", blocksEntryId: blocked.entry.id }, ctx);
    const detail = (await callTool("eintrag_lesen", { id: blocked.entry.id }, ctx)) as { links: { relation: string }[] };
    expect(detail.links.some((l) => l.relation === "blockiert")).toBe(true);
  });

  it("eintrag_suchen filtert nach Art", async () => {
    const { serverUrl } = await world();
    const ctx = { serverUrl, sessionKey: null, machineToken: TOKEN };
    await callTool("eintrag_anlegen", { kind: "bug", title: "Such-Bug" }, ctx);
    await callTool("eintrag_anlegen", { kind: "problem", title: "Such-Problem" }, ctx);
    const result = (await callTool("eintrag_suchen", { kind: "bug" }, ctx)) as { entries: { kind: string }[] };
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((e) => e.kind === "bug")).toBe(true);
  });

  it("unbekanntes Werkzeug wirft einen klaren Fehler statt still zu scheitern", async () => {
    await expect(callTool("nicht_vorhanden", {}, { serverUrl: "http://127.0.0.1:1", sessionKey: null })).rejects.toThrow("Unbekanntes Werkzeug");
  });
});
