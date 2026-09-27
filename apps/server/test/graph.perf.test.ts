import type { VaultNote } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

/**
 * PG Leistung: synthetischer Vault in Größe des echten (≈ 5.100 Notizen, ≈ 23.000 Link-Ziele) —
 * Gesamtgraph aus dem Cache < 300 ms, Neuaufbau (erste Anfrage) gemessen und begrenzt.
 */
describe("Graph-Leistung (synthetischer Vault in Echtgröße)", () => {
  it("Gesamtgraph < 300 ms aus dem Cache, Neuaufbau < 3 s", async () => {
    const t = await setup();
    const N = 5100;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const notes: VaultNote[] = [];
    for (let i = 0; i < N; i++) {
      const folder = `Ordner ${i % 25}`;
      const links: string[] = [];
      const k = Math.floor(rand() * 9);
      for (let j = 0; j < k; j++) links.push(`Notiz ${Math.floor(rand() * N * 1.05)}`); // ~5 % unaufgelöst
      notes.push({ path: `${folder}/Notiz ${i}.md`, title: `Notiz ${i}`, heading: null, folder, tags: [], links, mentions: [], mtime: "2026-09-20T10:00:00.000Z", size: 100 });
    }
    for (let i = 0; i < N; i += 1000) {
      const res = await t.post("/ingest/vault", { root: "/v", syncId: "p", mode: "full", notes: notes.slice(i, i + 1000), deleted: [], done: i + 1000 >= N });
      expect(res.status).toBe(200);
    }

    let t0 = performance.now();
    const first = await t.app.request("/api/graph");
    const coldMs = performance.now() - t0;
    expect(first.status).toBe(200);
    const body = (await first.json()) as { nodes: unknown[]; links: unknown[]; stats: { buildMs: number } };
    expect(body.nodes.length).toBeGreaterThan(5100);
    expect(body.links.length).toBeGreaterThan(15_000);

    t0 = performance.now();
    const warm = await t.app.request("/api/graph");
    await warm.text();
    const warmMs = performance.now() - t0;
    console.log(`[graph-perf] Knoten ${body.nodes.length}, Kanten ${body.links.length}, Neuaufbau ${coldMs.toFixed(0)} ms (Bau ${body.stats.buildMs} ms), aus Cache ${warmMs.toFixed(1)} ms`);
    expect(warmMs).toBeLessThan(300);
    expect(coldMs).toBeLessThan(3000);
  });
});
