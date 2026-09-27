import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { TranscriptResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

// Leistungstest: der größte bekannte echte Verlauf hatte 78 MB roh
// (Session 89d2ca7f). Diese Datei baut strukturgleiche, aber synthetische Zeilen (kein echter
// Inhalt) in derselben Größenordnung und misst erste Seite / Folgeseite gegen den echten Server.
// Grenzwerte hier sind großzügig für CI (langsamere Maschinen, gemeinsam genutzte Runner); die
// tatsächlich lokal gemessenen Werte liegen deutlich darunter.
const SID = "perf00000000-0000-4000-8000-000000000099";
const TARGET_RAW_BYTES = 75 * 1024 * 1024;

function buildFixture(): Buffer {
  const lines: string[] = [];
  let bytes = 0;
  let i = 0;
  // Ein Umlauf: Prompt, Denken (wird verworfen), zwei Werkzeug-Aufrufe mit Ergebnis, Antworttext.
  // `filler` sorgt dafür, dass wir ohne Millionen Zeilen auf ~75 MB kommen (wie ein echter,
  // sehr langer Verlauf mit vielen großen Werkzeug-Ausgaben).
  const filler = "x".repeat(600);
  while (bytes < TARGET_RAW_BYTES) {
    const ts = (n: number) => new Date(Date.UTC(2026, 0, 1) + i * 10_000 + n).toISOString();
    const rows = [
      { type: "user", uuid: `u${i}a`, timestamp: ts(0), sessionId: SID, cwd: "/x", message: { role: "user", content: `Bitte prüfe Datei ${i}. ${filler}` } },
      {
        type: "assistant",
        uuid: `u${i}b`,
        timestamp: ts(1),
        sessionId: SID,
        message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "thinking", thinking: filler }] },
      },
      {
        type: "assistant",
        uuid: `u${i}c`,
        timestamp: ts(2),
        sessionId: SID,
        message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/Users/alex/projects/datei-${i}.ts` } }] },
      },
      {
        type: "user",
        uuid: `u${i}d`,
        timestamp: ts(3),
        sessionId: SID,
        message: { role: "user", content: [{ tool_use_id: `t${i}`, type: "tool_result", content: filler }] },
        toolUseResult: { type: "text", file: { filePath: `/Users/alex/projects/datei-${i}.ts` } },
      },
      { type: "assistant", uuid: `u${i}e`, timestamp: ts(4), sessionId: SID, message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "text", text: `Erledigt ${i}. ${filler}` }] } },
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

describe("Leistung: großer Verlauf", () => {
  it("erste Seite < 5 s, Folgeseite aus dem Cache < 500 ms (Grenzwerte großzügig für CI)", async () => {
    const t = await setup();
    const raw = buildFixture();
    const mb = Math.round(raw.length / 1024 / 1024);
    const sha = createHash("sha256").update(raw).digest("hex");
    const gz = gzipSync(raw);

    const uploadRes = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gz,
      headers: {
        authorization: t.auth.authorization,
        "x-nyxos-tool": "claude",
        "x-nyxos-session": SID,
        "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${SID}.jsonl`),
        "x-nyxos-sha256": sha,
        "x-nyxos-size": String(raw.length),
      },
    });
    expect(uploadRes.status).toBe(200);

    const t0 = performance.now();
    const first = await t.app.request(`/api/sessions/${SID}/transcript?direction=backward&limit=200`);
    const firstMs = performance.now() - t0;
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TranscriptResponse;
    expect(firstBody.items).toHaveLength(200);
    // Kein Denk-Eintrag, auch im großen Verlauf nicht.
    for (const item of firstBody.items) expect(item.thinking).toBe(false);

    const t1 = performance.now();
    const second = await t.app.request(`/api/sessions/${SID}/transcript?direction=backward&limit=200&cursor=${encodeURIComponent(firstBody.prevCursor ?? "")}`);
    const secondMs = performance.now() - t1;
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as TranscriptResponse;
    expect(secondBody.items).toHaveLength(200);

    console.log(`[transcript-perf] Rohdatei ${mb} MB, erste Seite ${firstMs.toFixed(0)} ms, Folgeseite ${secondMs.toFixed(0)} ms, Einträge gesamt ${firstBody.total}`);
    expect(firstMs).toBeLessThan(5000);
    expect(secondMs).toBeLessThan(500);
    // Kein eigener Timeout mehr hier — das eigene Vitest-Projekt "server-perf"
    // (apps/server/vitest.perf.config.ts) setzt 60 s fürs Fixture-Bauen, seriell zur zweiten
    // Perf-Datei (s. Begründung dort). Die scharfen Grenzen oben (5000/500 ms) bleiben unverändert.
  });
});
