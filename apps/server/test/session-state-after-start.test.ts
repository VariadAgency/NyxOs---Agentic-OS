// Eine frisch gestartete (`startup`) oder fortgesetzte (`resume`) Claude-Session steht an der
// Eingabe – bis zur ersten Frage „wartet“ sie, statt „läuft“ zu zeigen. Eine echte Runde danach läuft weiter.
// Fixture der Runde: packages/shared/test/fixtures/claude/sess-prompt.jsonl.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSessionParser, type IngestItem, type SessionEvent } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { sessionKey } from "../src/store.js";
import { setup } from "./helpers.js";

const SID = "dddddddd-0000-4000-8000-0000000f6a01";
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude");
const CWD = "/Users/alex/projects/tools/NyxOS";

const hook = (event: string, ts: string, extra: Record<string, unknown> = {}): IngestItem => ({
  type: "event",
  event: { id: `hook:claude:${SID}:${ts}-${event}`, tool: "claude", sessionId: SID, ts, kind: "hook", source: "hook", data: { event, cwd: CWD, ...extra } },
});

/** Datei-Events der Fixture, auf diese Session und den Zeitpunkt `at` umgeschrieben. */
function fileEvents(file: string, at: string): IngestItem[] {
  const p = new ClaudeSessionParser(SID);
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .flatMap((l) => p.push(l))
    .map((e: SessionEvent): IngestItem => ({ type: "event", event: { ...e, sessionId: SID, ts: at } }));
}

async function row(t: Awaited<ReturnType<typeof setup>>) {
  const [s] = await t.db.select().from(sessions).where(eq(sessions.id, sessionKey("claude", SID)));
  return s;
}

describe("Zustand direkt nach dem Start", () => {
  for (const source of ["startup", "resume"]) {
    it(`SessionStart (${source}) ohne erste Frage → „wartet“; eine echte Runde danach → „läuft“`, async () => {
      const t = await setup();
      const now = Date.now();
      const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
      expect((await t.post("/ingest/events", { items: [hook("SessionStart", at(0), { source })] })).status).toBe(200);
      const s = await row(t);
      expect(s?.status).toBe("running");
      expect(s?.turnOpen).toBe(false);
      expect(s?.state).toBe("waiting");

      await t.post("/ingest/events", { items: [hook("UserPromptSubmit", at(10), { prompt: "Bau das Feature" }), ...fileEvents("sess-prompt.jsonl", at(10.5)), hook("PreToolUse", at(11))] });
      expect((await row(t))?.state).toBe("running");
    });
  }
});
