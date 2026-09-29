import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { TranscriptResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

// Leistungstest: eine echte Session (89d2ca7f) hatte 67 Sub-Agent-Dateien
// (49 MB) neben einer großen Hauptdatei. Vorher: JEDE Anfrage lud den Hauptverlauf UND alle
// Sub-Agent-Dateien nur zum Zählen — beides über denselben 8er-Cache, der dadurch bei jeder
// Anfrage den Hauptverlauf verdrängte (jede Seite wurde neu entpackt, ~1–1,5 s). Fix: (a) die
// Anzahl je Sub-Agent-Block wird nur für die Blöcke auf der tatsächlich angeforderten Seite
// nachgetragen (nicht für den ganzen Verlauf), (b) Sub-Agent-Verläufe laufen über einen eigenen,
// größeren Cache, der den Hauptverlauf-Cache nie verdrängt (s. transcript.ts `annotateSubagentCounts`
// + `subagentTranscriptCache` in app.ts). Diese Datei baut eine synthetische Session mit ~75 MB
// Hauptdatei + 60 Sub-Agent-Dateien (~50 MB gesamt) und misst: erste Seite, Folgeseite (muss ein
// Cache-Treffer auf dem HAUPTVERLAUF bleiben), Abruf eines Sub-Agenten, danach wieder eine
// Hauptverlauf-Seite (muss weiterhin ein Cache-Treffer sein — das ist der eigentliche Befund).
const SID = "subcache0000-0000-4000-8000-000000000098";
const MAIN_TARGET_BYTES = 75 * 1024 * 1024;
const SUBAGENT_COUNT = 60;
const SUBAGENT_TARGET_BYTES = Math.round((50 * 1024 * 1024) / SUBAGENT_COUNT); // ~873 KB je Datei
const INSERT_AGENT_EVERY = 300; // verteilt 60 Sub-Agent-Aufrufe über die ~75 MB Hauptdatei

function agentId(n: number): string {
  return `agent${String(n).padStart(3, "0")}`;
}

/** Hauptdatei: normale Zeilen (Prompt/Denken/Read-Werkzeug/Antwort) plus alle
 * `SUBAGENT_COUNT` Sub-Agent-Aufrufe (Werkzeug "Agent", Ergebnis mit `toolUseResult.agentId`),
 * gleichmäßig verteilt, bis ~75 MB erreicht sind. */
function buildMainFixture(): Buffer {
  const lines: string[] = [];
  const filler = "x".repeat(600);
  let bytes = 0;
  let i = 0;
  let agentsInserted = 0;
  while (bytes < MAIN_TARGET_BYTES || agentsInserted < SUBAGENT_COUNT) {
    const ts = (n: number) => new Date(Date.UTC(2026, 0, 1) + i * 10_000 + n).toISOString();
    const rows: unknown[] =
      i % INSERT_AGENT_EVERY === 0 && agentsInserted < SUBAGENT_COUNT
        ? (() => {
            const id = agentId(agentsInserted);
            agentsInserted++;
            return [
              { type: "user", uuid: `u${i}a`, timestamp: ts(0), sessionId: SID, cwd: "/x", message: { role: "user", content: `Bitte delegiere Aufgabe ${i}. ${filler}` } },
              {
                type: "assistant",
                uuid: `u${i}b`,
                timestamp: ts(1),
                sessionId: SID,
                message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Agent", input: { description: `Unteraufgabe ${i}`, subagent_type: "general-purpose" } }] },
              },
              {
                type: "user",
                uuid: `u${i}c`,
                timestamp: ts(2),
                sessionId: SID,
                message: { role: "user", content: [{ tool_use_id: `t${i}`, type: "tool_result", content: "Befund: ok", is_error: false }] },
                toolUseResult: { status: "completed", agentId: id },
              },
              { type: "assistant", uuid: `u${i}d`, timestamp: ts(3), sessionId: SID, message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "text", text: `Erledigt ${i}. ${filler}` }] } },
            ];
          })()
        : [
            { type: "user", uuid: `u${i}a`, timestamp: ts(0), sessionId: SID, cwd: "/x", message: { role: "user", content: `Bitte prüfe Datei ${i}. ${filler}` } },
            {
              type: "assistant",
              uuid: `u${i}b`,
              timestamp: ts(1),
              sessionId: SID,
              message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/Users/alex/projects/datei-${i}.ts` } }] },
            },
            {
              type: "user",
              uuid: `u${i}c`,
              timestamp: ts(2),
              sessionId: SID,
              message: { role: "user", content: [{ tool_use_id: `t${i}`, type: "tool_result", content: filler }] },
              toolUseResult: { type: "text", file: { filePath: `/Users/alex/projects/datei-${i}.ts` } },
            },
            { type: "assistant", uuid: `u${i}d`, timestamp: ts(3), sessionId: SID, message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "text", text: `Erledigt ${i}. ${filler}` }] } },
          ];
    for (const r of rows) {
      const s = JSON.stringify(r);
      lines.push(s);
      bytes += s.length + 1;
    }
    i++;
  }
  return Buffer.from(lines.join("\n") + "\n");
}

/** Eine Sub-Agent-Datei: ~873 KB eigener Verlauf (Prompt + ein paar Werkzeuge + Antwort). */
function buildSubagentFixture(id: string): Buffer {
  const lines: string[] = [];
  const filler = "y".repeat(600);
  let bytes = 0;
  let i = 0;
  while (bytes < SUBAGENT_TARGET_BYTES) {
    const ts = (n: number) => new Date(Date.UTC(2026, 0, 2) + i * 5_000 + n).toISOString();
    const rows = [
      { type: "user", uuid: `${id}-u${i}a`, timestamp: ts(0), sessionId: id, cwd: "/x", message: { role: "user", content: `Unteraufgabe ${i}. ${filler}` } },
      { type: "assistant", uuid: `${id}-u${i}b`, timestamp: ts(1), sessionId: id, message: { model: "claude-sonnet-5", id: `m${i}`, role: "assistant", content: [{ type: "text", text: `Erledigt ${i}. ${filler}` }] } },
    ];
    for (const r of rows) {
      const s = JSON.stringify(r);
      lines.push(s);
      bytes += s.length + 1;
    }
    i++;
  }
  return Buffer.from(lines.join("\n") + "\n");
}

async function upload(t: Awaited<ReturnType<typeof setup>>, path: string, raw: Buffer) {
  const sha = createHash("sha256").update(raw).digest("hex");
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: t.auth.authorization,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": path.includes("/subagents/") ? SID : SID,
      "x-nyxos-path": encodeURIComponent(path),
      "x-nyxos-sha256": sha,
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
}

describe("Leistung: Sub-Agent-Cache verdrängt den Hauptverlauf nicht mehr", () => {
  it("erste Seite, Folgeseite (Cache-Treffer), Sub-Agent-Abruf, danach wieder Hauptverlauf-Seite (weiter Cache-Treffer)", async () => {
    const t = await setup();
    const main = buildMainFixture();
    const mainMb = Math.round(main.length / 1024 / 1024);
    await upload(t, `-Users-alex-projects/${SID}.jsonl`, main);

    let subagentBytes = 0;
    for (let n = 0; n < SUBAGENT_COUNT; n++) {
      const id = agentId(n);
      const raw = buildSubagentFixture(id);
      subagentBytes += raw.length;
      await upload(t, `-Users-alex-projects/${SID}/subagents/agent-${id}.jsonl`, raw);
    }
    const subMb = Math.round(subagentBytes / 1024 / 1024);

    const t0 = performance.now();
    const first = await t.app.request(`/api/sessions/${SID}/transcript?direction=backward&limit=200`);
    const firstMs = performance.now() - t0;
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TranscriptResponse;
    expect(firstBody.items.length).toBeGreaterThan(0);

    const t1 = performance.now();
    const second = await t.app.request(`/api/sessions/${SID}/transcript?direction=backward&limit=200&cursor=${encodeURIComponent(firstBody.prevCursor ?? "")}`);
    const secondMs = performance.now() - t1;
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as TranscriptResponse;
    expect(secondBody.items.length).toBeGreaterThan(0);

    // Ein Sub-Agent auf dieser Seite: expliziter Abruf (Reiter im Chat) — läuft über den eigenen
    // Sub-Agent-Cache, muss den Hauptverlauf-Cache unangetastet lassen.
    const someAgent = [...firstBody.items, ...secondBody.items].find((it) => it.role === "subagent")?.subagent?.id ?? agentId(SUBAGENT_COUNT - 1);
    const t2 = performance.now();
    const subRes = await t.app.request(`/api/sessions/${SID}/transcript?subagent=${someAgent}&direction=forward&limit=500`);
    const subMs = performance.now() - t2;
    expect(subRes.status).toBe(200);

    // Danach wieder eine Hauptverlauf-Seite: muss weiterhin ein Cache-Treffer sein (das ist der
    // eigentliche Befund — vorher wurde der Hauptverlauf durch die 60 Sub-Agent-Parses verdrängt).
    const t3 = performance.now();
    const third = await t.app.request(`/api/sessions/${SID}/transcript?direction=backward&limit=200`);
    const thirdMs = performance.now() - t3;
    expect(third.status).toBe(200);
    const thirdBody = (await third.json()) as TranscriptResponse;
    expect(thirdBody.items.map((i) => i.id)).toEqual(firstBody.items.map((i) => i.id));

    console.log(
      `[subagent-cache-perf] Hauptdatei ${mainMb} MB, ${SUBAGENT_COUNT} Sub-Agent-Dateien ${subMb} MB — ` +
        `erste Seite ${firstMs.toFixed(0)} ms, Folgeseite ${secondMs.toFixed(0)} ms, Sub-Agent-Abruf ${subMs.toFixed(0)} ms, ` +
        `Hauptverlauf danach ${thirdMs.toFixed(0)} ms (Einträge gesamt ${firstBody.total})`,
    );
    expect(firstMs).toBeLessThan(6000);
    expect(secondMs).toBeLessThan(800);
    // Der eigentliche Befund: nach einem Sub-Agent-Abruf bleibt der Hauptverlauf ein Cache-Treffer
    // (vorher: erneutes Entpacken der ~75 MB, ~1–1,5 s) — enger als die kalte erste Seite.
    expect(thirdMs).toBeLessThan(800);
  });
});
