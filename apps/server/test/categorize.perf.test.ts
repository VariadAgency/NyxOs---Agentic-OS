import type { IngestItem } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

/**
 * Leistungstest: `loadCategorizeFeatures` scannte bisher bei JEDEM Ingest
 * ALLE `tool_call`-Events einer Session neu (voller Tabellen-Scan), um Skill-Aufrufe fürs Einsortieren
 * zu finden — bei einer Session mit 20.000 Events wurde so jeder einzelne weitere Hook (z. B. ein
 * Stop-Hook, der selbst nur EIN neues Event mitbringt) spürbar langsamer. Der Fix (`SkillsCache` in
 * `store.ts`) lässt nur den ERSTEN Fehltreffer voll scannen; jeder weitere Ingest derselben Session
 * ergänzt nur die Skill-Namen aus dem eigenen Batch.
 *
 * Gemessen (dieser Rechner, 20 Folge-Ingests je 1 Hook-Event nach 20.000 vorhandenen `tool_call`-
 * Events): VORHER ~37 ms je Ingest (Ø 36,9 ms) → NACHHER ~7 ms je Ingest (Ø 7,2 ms), Faktor ~5.
 * Grenzwert hier großzügig für CI (langsamere/geteilte Runner): 20 Folge-Ingests zusammen unter
 * 600 ms — das reißt die alte volle Rescan-Variante (≈ 738 ms gemessen) sicher, die neue (≈ 144 ms
 * gemessen) bleibt sicher darunter.
 */

const N_EVENTS = 20_000;
const N_FOLLOWUPS = 20;
const SID = "perf-session-skills-20k";

function toolCallEvent(i: number): IngestItem {
  const isSkill = i % 20 === 0;
  return {
    type: "event",
    event: {
      id: `tc-${i}`,
      tool: "claude",
      sessionId: SID,
      ts: new Date(Date.now() + i * 1000).toISOString(),
      kind: "tool_call",
      source: "file",
      data: isSkill ? { name: "Skill", target: `skill-${i % 5}` } : { name: "Read" },
    },
  };
}

describe("Leistung: Skill-Zwischenspeicher bei großen Sessions", () => {
  it(
    "20 Folge-Ingests nach 20.000 tool_call-Events bleiben zusammen deutlich unter 600 ms (voller Rescan je Hook wäre > 700 ms)",
    async () => {
      const t = await setup();

      const CHUNK = 500;
      for (let start = 0; start < N_EVENTS; start += CHUNK) {
        const items: IngestItem[] = [];
        for (let i = start; i < Math.min(start + CHUNK, N_EVENTS); i++) items.push(toolCallEvent(i));
        const res = await t.post("/ingest/events", { items });
        expect(res.status).toBe(200);
      }

      const t0 = performance.now();
      for (let i = 0; i < N_FOLLOWUPS; i++) {
        const res = await t.post("/ingest/events", {
          items: [
            {
              type: "event",
              event: { id: `stop-${i}`, tool: "claude", sessionId: SID, ts: new Date(Date.now() + (N_EVENTS + i) * 1000).toISOString(), kind: "hook", source: "hook", data: { event: "Stop" } },
            },
          ],
        });
        expect(res.status).toBe(200);
      }
      const totalMs = performance.now() - t0;

      console.log(`[categorize-perf] ${N_FOLLOWUPS} Folge-Ingests nach ${N_EVENTS} Events: ${totalMs.toFixed(0)} ms gesamt, Ø ${(totalMs / N_FOLLOWUPS).toFixed(1)} ms`);
      expect(totalMs).toBeLessThan(600);
    },
    60_000,
  );
});
