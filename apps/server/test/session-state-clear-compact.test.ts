// Zustand nach „/clear“ und nach Komprimierung – mit den Hook-Folgen, wie sie live ankommen
// (so im echten Betrieb beobachtet: „/compact“ und „/clear“ lösen KEIN UserPromptSubmit aus,
// bei der Komprimierung kommt ein SubagentStop, danach `SessionStart` mit `source: "compact"`).
// „/clear“ beginnt in Claude Code eine NEUE Session (neue Datei, neue ID) mit `SessionStart` `source: "clear"` –
// Claude steht dort leer an der Eingabe. Fixture: packages/shared/test/fixtures/claude/sess-clear.jsonl.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSessionParser, type IngestItem, type SessionEvent } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { sessionKey } from "../src/store.js";
import { setup } from "./helpers.js";

const OLD = "dddddddd-0000-4000-8000-0000000001d0";
const NEW = "dddddddd-0000-4000-8000-00000000c1ea";
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude");
const CWD = "/Users/alex/projects/tools/NyxOS";

const hook = (sid: string, event: string, ts: string, extra: Record<string, unknown> = {}): IngestItem => ({
  type: "event",
  event: { id: `hook:claude:${sid}:${ts}-${event}`, tool: "claude", sessionId: sid, ts, kind: "hook", source: "hook", data: { event, cwd: CWD, ...extra } },
});

/** Datei-Events der Fixture, Zeitstempel auf `at` verschoben (sonst gälte die Session nach 30 Min als „ruht“). */
function fileEvents(sid: string, file: string, at: string): IngestItem[] {
  const p = new ClaudeSessionParser(sid);
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .flatMap((l) => p.push(l))
    .map((e: SessionEvent): IngestItem => ({ type: "event", event: { ...e, ts: at } }));
}

async function row(t: Awaited<ReturnType<typeof setup>>, sid: string) {
  const [s] = await t.db.select().from(sessions).where(eq(sessions.id, sessionKey("claude", sid)));
  return s;
}

describe("Zustand nach „/clear“", () => {
  it("die neue, leere Session wartet auf Alex (kein „läuft“)", async () => {
    const t = await setup();
    const now = Date.now();
    const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
    const items: IngestItem[] = [
      hook(OLD, "SessionStart", at(0), { source: "startup" }),
      hook(OLD, "UserPromptSubmit", at(1), { prompt: "Mach was" }),
      hook(OLD, "Stop", at(5)),
      // der Nutzer tippt „/clear“: kein UserPromptSubmit; die alte Session endet, eine neue beginnt.
      hook(OLD, "SessionEnd", at(10), { reason: "clear" }),
      hook(NEW, "SessionStart", at(10.1), { source: "clear" }),
      ...fileEvents(NEW, "sess-clear.jsonl", at(10.05)),
    ];
    expect((await t.post("/ingest/events", { items })).status).toBe(200);
    expect((await row(t, OLD))?.state).toBeNull();
    const s = await row(t, NEW);
    expect(s?.status).toBe("running");
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");

    // Die erste echte Frage öffnet die Runde wieder.
    await t.post("/ingest/events", { items: [hook(NEW, "UserPromptSubmit", at(20), { prompt: "Neue Aufgabe" })] });
    expect((await row(t, NEW))?.state).toBe("running");
  });
});

describe("Komprimierung mit der echten Hook-Folge", () => {
  it("„/compact“ ohne UserPromptSubmit: nach der Komprimierung wartet die Session", async () => {
    const t = await setup();
    const now = Date.now();
    const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
    const items: IngestItem[] = [
      hook(OLD, "SessionStart", at(0), { source: "startup" }),
      hook(OLD, "UserPromptSubmit", at(1), { prompt: "Mach was" }),
      hook(OLD, "Stop", at(5)),
      hook(OLD, "SubagentStop", at(30)),
      hook(OLD, "SessionStart", at(30.5), { source: "compact" }),
      { type: "event", event: { id: `claude:${OLD}:boundary`, tool: "claude", sessionId: OLD, ts: at(30.6), kind: "compaction", source: "file", data: { subtype: "compact_boundary", trigger: "manual" } } },
    ];
    await t.post("/ingest/events", { items });
    expect((await row(t, OLD))?.state).toBe("waiting");
  });

  it("automatische Komprimierung mitten in der Runde (mit SubagentStop) lässt sie offen – auch in beliebiger Ankunftsreihenfolge", async () => {
    const now = Date.now();
    const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
    const base: IngestItem[] = [
      hook(OLD, "SessionStart", at(0), { source: "startup" }),
      hook(OLD, "UserPromptSubmit", at(1), { prompt: "Bau das Feature" }),
      hook(OLD, "PostToolUse", at(2)),
    ];
    const compaction: IngestItem[] = [
      hook(OLD, "PreCompact", at(3), { trigger: "auto" }),
      hook(OLD, "SubagentStop", at(20)),
      hook(OLD, "SessionStart", at(20.5), { source: "compact" }),
      { type: "event", event: { id: `claude:${OLD}:auto`, tool: "claude", sessionId: OLD, ts: at(20.6), kind: "compaction", source: "file", data: { subtype: "compact_boundary", trigger: "auto" } } },
    ];
    for (const order of [compaction, [...compaction].reverse()]) {
      const t = await setup();
      await t.post("/ingest/events", { items: base });
      for (const it of order) await t.post("/ingest/events", { items: [it] });
      const s = await row(t, OLD);
      expect(s?.turnOpen).toBe(true);
      expect(s?.state).toBe("running");
    }
  });
});
