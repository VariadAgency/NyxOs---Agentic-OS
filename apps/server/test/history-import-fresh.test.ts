// Frisches System: die Brücke liefert nur Verlaufsdateien (keine Hook-Ereignisse), der Verlauf ist alt und
// sein Arbeitsordner liegt irgendwo (Projektordner leer = alles erfassen). Die Session muss trotzdem in der
// Liste stehen — nicht versteckt und nicht vom Aufräum-Takt archiviert. („beendet“ meldet danach das
// Lebenszeichen der Brücke, s. apps/bridge/test/e2e.test.ts.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSessionParser, type IngestItem } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { runTemporaryTicker } from "../src/temporary.js";
import { setup } from "./helpers.js";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const FIXTURE = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude", "sess-a.jsonl");

/** Was die Brücke aus der Datei macht (Events + Zusammenfassung), mit Zeitstempeln aus einem früheren Jahr. */
function transcriptItems(): IngestItem[] {
  const p = new ClaudeSessionParser(SID);
  const text = readFileSync(FIXTURE, "utf8").replaceAll("2026-09-2", "2024-03-1");
  const events = text.split("\n").flatMap((l) => p.push(l));
  return [...events.map((event): IngestItem => ({ type: "event", event })), { type: "summary", summary: p.summary() }];
}

describe("Verlauf ohne Hooks auf einem frischen System", () => {
  it("alte Session mit beliebigem Arbeitsordner erscheint in /api/sessions und bleibt dort", async () => {
    const t = await setup();
    const items = transcriptItems();
    expect(items.length).toBeGreaterThan(10);
    expect((await t.post("/ingest/events", { items })).status).toBe(200);

    await runTemporaryTicker(t.db, { probeSocket: false });
    const res = await t.app.request("/api/sessions");
    const { sessions } = (await res.json()) as { sessions: { sessionId: string; title: string | null; cwd: string | null }[] };
    const s = sessions.find((x) => x.sessionId === SID);
    expect(s).toMatchObject({ title: "Session-Liste bauen", cwd: "/Users/alex/projects" });
  });
});
