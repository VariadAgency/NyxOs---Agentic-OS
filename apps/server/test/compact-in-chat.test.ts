// Komprimierung im Chat: nach „Kontext komprimieren“ stand früher im Transkript „Compacted“, der
// Chat der NyxOS zeigte nur „/compact“, und der Kopf blieb auf „läuft / Claude arbeitet gerade“.
// Echte Zeilenfolge (gekürzt): packages/shared/test/fixtures/claude/sess-compact.jsonl.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ClaudeSessionParser, type IngestItem, type SessionEvent, type TranscriptResponse } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { sessionKey } from "../src/store.js";
import { setup } from "./helpers.js";

const SID = "cccccccc-0000-4000-8000-00000000c0c0";
const FILE = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude", "sess-compact.jsonl");
type App = Awaited<ReturnType<typeof setup>>;

async function uploadArchive(t: App, raw: Buffer) {
  const sha = createHash("sha256").update(raw).digest("hex");
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: t.auth.authorization,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": SID,
      "x-nyxos-path": encodeURIComponent(`-Users-alex-projects-08-Systeme-NyxOS/${SID}.jsonl`),
      "x-nyxos-sha256": sha,
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
}

const hook = (event: string, ts: string, extra: Record<string, unknown> = {}): IngestItem => ({
  type: "event",
  event: { id: `hook:claude:${SID}:${ts}-${event}`, tool: "claude", sessionId: SID, ts, kind: "hook", source: "hook", data: { event, cwd: "/Users/alex/projects/tools/NyxOS", ...extra } },
});

function fileEvents(): SessionEvent[] {
  const p = new ClaudeSessionParser(SID);
  return readFileSync(FILE, "utf8")
    .split("\n")
    .flatMap((l) => p.push(l));
}

describe("Komprimierung im Chat", () => {
  it("zeigt eine ruhige Zeile „Kontext komprimiert“ – keine Zusammenfassung, kein rohes „/compact“", async () => {
    const t = await setup();
    await uploadArchive(t, readFileSync(FILE));
    const res = await t.app.request(`/api/sessions/${SID}/transcript?direction=forward&limit=500`, { headers: { authorization: t.auth.authorization } });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as TranscriptResponse;
    const visible = items.filter((i) => !(i.role === "system" && i.internal));
    expect(visible.map((i) => [i.role, i.text])).toEqual([
      ["user", "Schreib mir bitte eine kurze Liste"],
      ["assistant", "Hier ist die Liste."],
      ["system", "Kontext komprimiert"],
    ]);
    const all = JSON.stringify(items);
    expect(all).not.toContain("This session is being continued");
    expect(all).not.toContain("Compacted");
  });
});

describe("Zustand nach „/compact“", () => {
  it("wartet, sobald Claude nach der Komprimierung wieder an der Eingabe steht (kein Stop-Hook)", async () => {
    const t = await setup();
    const key = sessionKey("claude", SID);
    // So kommt es live an: Start, erste Runde mit Stop, dann „/compact“ (UserPromptSubmit), die Datei-Zeilen,
    // nach der Komprimierung `SessionStart` mit `source: "compact"` – und KEIN Stop.
    const items: IngestItem[] = [
      hook("SessionStart", "2026-09-25T13:59:59.000Z", { source: "startup" }),
      hook("UserPromptSubmit", "2026-09-25T14:00:00.100Z", { prompt: "Schreib mir bitte eine kurze Liste" }),
      hook("Stop", "2026-09-25T14:00:10.500Z"),
      hook("UserPromptSubmit", "2026-09-25T14:00:54.900Z", { prompt: "/compact" }),
      ...fileEvents().map((event): IngestItem => ({ type: "event", event })),
      hook("SessionStart", "2026-09-25T14:01:28.900Z", { source: "compact" }),
    ];
    const res = await t.post("/ingest/events", { items });
    expect(res.status).toBe(200);
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");
  });

  it("automatische Komprimierung mitten in der Runde schließt sie NICHT", async () => {
    const t = await setup();
    const key = sessionKey("claude", SID);
    const now = Date.now();
    const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
    const items: IngestItem[] = [
      hook("SessionStart", at(0), { source: "startup" }),
      hook("UserPromptSubmit", at(1), { prompt: "Bau das Feature" }),
      hook("PreToolUse", at(2)),
      { type: "event", event: { id: `claude:${SID}:auto-1`, tool: "claude", sessionId: SID, ts: at(3), kind: "compaction", source: "file", data: { subtype: "compact_boundary", trigger: "auto" } } },
      hook("SessionStart", at(4), { source: "compact" }),
    ];
    await t.post("/ingest/events", { items });
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(s?.turnOpen).toBe(true);
    expect(s?.state).toBe("running");
  });
});
