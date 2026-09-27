import { appendFileSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IngestItem } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { classify } from "../src/tracker.js";
import { Tracker } from "../src/tracker.js";
import { CODEX_MAIN, CODEX_SUB, ROOT, ROOT_DIR, SHARED_FIX, SID_A, newOutbox, noLog, sandbox } from "./helpers.js";

const cfg = { claudeDir: "/h/.claude", codexDir: "/h/.codex", projectRoots: [ROOT] };

describe("Zuordnung von Dateien", () => {
  it.each([
    [`/h/.claude/projects/${ROOT_DIR}/${SID_A}.jsonl`, { tool: "claude", kind: "main", sessionId: SID_A }],
    [`/h/.claude/projects/${ROOT_DIR}-app-nyxos/${SID_A}.jsonl`, { tool: "claude", kind: "main", sessionId: SID_A }],
    [`/h/.claude/projects/${ROOT_DIR}/${SID_A}/subagents/agent-a1.jsonl`, { tool: "claude", kind: "subagent", sessionId: SID_A, agentId: "a1" }],
    [`/h/.claude/projects/${ROOT_DIR}/${SID_A}/subagents/agent-a1.meta.json`, { tool: "claude", kind: "submeta", sessionId: SID_A, agentId: "a1" }],
    [`/h/.claude/projects/${ROOT_DIR}/${SID_A}/tool-results/x.txt`, { tool: "claude", kind: "extra", sessionId: SID_A }],
    [`/h/.codex/sessions/2026/09/21/rollout-2026-09-21T15-25-10-${CODEX_MAIN}.jsonl`, { tool: "codex", kind: "rollout", sessionId: CODEX_MAIN }],
    ["/h/.codex/session_index.jsonl", { tool: "codex", kind: "index" }],
  ])("%s", (path, expected) => {
    expect(classify(path, cfg)).toEqual(expected);
  });

  it.each([
    `/h/.claude/projects/-home-alex-anderes/${SID_A}.jsonl`,
    `/h/.claude/projects/${ROOT_DIR}X/${SID_A}.jsonl`,
    `/h/.claude/projects/${ROOT_DIR}/memory/notiz.md`,
    `/h/.claude/projects/${ROOT_DIR}/bridge-pointer.json`,
    `/h/.claude/projects/${ROOT_DIR}/kein-uuid.jsonl`,
    `/h/.claude/projects/${ROOT_DIR}/${SID_A}/.DS_Store`,
    "/h/.codex/sessions/2026/09/21/notiz.txt",
    "/h/.codex/config.toml",
    "/etc/passwd",
  ])("ignoriert %s", (path) => {
    expect(classify(path, cfg)).toBeNull();
  });

  it("Groß-/Kleinschreibung: auf macOS derselbe Ordner, auf Linux ein anderer", () => {
    const lower = `/h/.claude/projects/${ROOT_DIR.toLowerCase()}/${SID_A}.jsonl`;
    const got = classify(lower, cfg);
    if (process.platform === "darwin") expect(got).toEqual({ tool: "claude", kind: "main", sessionId: SID_A });
    else if (ROOT_DIR.toLowerCase() !== ROOT_DIR) expect(got).toBeNull();
  });

  it("ohne Projektordner gehört jede Claude-Session dazu", () => {
    expect(classify(`/h/.claude/projects/-home-alex-anderes/${SID_A}.jsonl`, { ...cfg, projectRoots: [] })).toEqual({ tool: "claude", kind: "main", sessionId: SID_A });
  });
});

const events = (items: { item: IngestItem }[]) => items.filter((r) => r.item.type === "event");
const summaries = (items: { item: IngestItem }[]) => items.flatMap((r) => (r.item.type === "summary" ? [r.item.summary] : []));

describe("Tracker", () => {
  it("ohne Projektordner: Verlauf mit beliebigem Arbeitsordner und altem Zeitstempel landet im Puffer", async () => {
    const sb = sandbox();
    sb.cfg.projectRoots = [];
    const dir = join(sb.cfg.claudeDir, "projects", "-home-test-demo");
    // Unveränderte Fixture: Arbeitsordner /Users/alex/projects, Zeitstempel von vor Tagen.
    sb.variant(join(dir, `${SID_A}.jsonl`), join(SHARED_FIX, "claude", "sess-a.jsonl"), [ROOT, "/Users/alex/projects"]);
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    expect(await t.scanAll()).toBe(1);
    expect(events(outbox.peek(1000)).length).toBe(15);
    expect(summaries(outbox.peek(1000))[0]?.cwd).toBe("/Users/alex/projects");
  });

  it("Datei, deren Zeilen alle zu einer ANDEREN Session gehören: nichts senden, aber einmal laut melden statt still zu schlucken", async () => {
    const sb = sandbox();
    const other = "11111111-2222-4333-8444-555555555555";
    // Wie `cp sess-a.jsonl <andere-uuid>.jsonl`: Dateiname ≠ sessionId in den Zeilen. Die Zeilen gehören der
    // Ursprungs-Session (übernommener Verlauf) und kämen sonst doppelt — darum verworfen, aber nicht still.
    const file = join(sb.proj, `${other}.jsonl`);
    sb.variant(file, join(SHARED_FIX, "claude", "sess-a.jsonl"));
    const outbox = await newOutbox(sb.home);
    const logs: [string, Record<string, unknown> | undefined][] = [];
    const t = new Tracker(sb.cfg, outbox, (msg, extra) => logs.push([msg, extra]));
    await t.scanAll();
    await t.handle(file);
    expect(outbox.peek(1000)).toEqual([]);
    const hits = logs.filter(([m]) => m === "fremde-session");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.[1]).toMatchObject({ session: `claude:${other}`, zeilenVon: SID_A });
  });

  it("liest beim Nachimport Haupt- und Sub-Agent-Datei ein und legt alles in den Puffer", async () => {
    const sb = sandbox();
    sb.claudeMain();
    sb.claudeSub();
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    const n = await t.scanAll();
    expect(n).toBe(3);
    const rows = outbox.peek(1000);
    expect(events(rows)).toHaveLength(18);
    const [summary] = summaries(rows);
    expect(summary).toMatchObject({ sessionId: SID_A, title: "Session-Liste bauen", eventCount: 18 });
    expect(summary?.subagents).toEqual([{ id: "a0000000000000001", name: "Parser prüfen", type: "test-coverage-critic" }]);
    expect(t.isAllowed("claude", SID_A)).toBe(true);
  });

  it("hält eine halb geschriebene Zeile zurück und sendet sie genau einmal, wenn sie fertig ist", async () => {
    const sb = sandbox();
    const main = sb.claudeMain();
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    await t.scanAll();
    outbox.ack(outbox.peek(1000).map((r) => r.seq));

    const line = JSON.stringify({
      type: "user",
      uuid: "u-neu",
      timestamp: "2026-09-24T10:06:00.000Z",
      sessionId: SID_A,
      cwd: ROOT,
      message: { role: "user", content: "Noch eine Frage mit Umlauten: äöü ß €" },
    });
    const bytes = Buffer.from(line + "\n");
    const cut = bytes.indexOf(Buffer.from("ä")) + 1; // mitten im UTF-8-Zeichen
    appendFileSync(main, bytes.subarray(0, cut));
    await t.handle(main);
    expect(events(outbox.peek(1000))).toHaveLength(0);

    appendFileSync(main, bytes.subarray(cut));
    await t.handle(main);
    await t.handle(main);
    const ev = events(outbox.peek(1000));
    expect(ev).toHaveLength(1);
    const item = ev[0]?.item;
    expect(item?.type === "event" && item.event.data.text).toBe("Noch eine Frage mit Umlauten: äöü ß €");
  });

  it("schickt nach einem Neustart keine bereits gepufferten Events erneut", async () => {
    const sb = sandbox();
    sb.claudeMain();
    sb.codexMain();
    const outbox = await newOutbox(sb.home);
    await new Tracker(sb.cfg, outbox, noLog).scanAll();
    const first = events(outbox.peek(1000)).length;
    expect(first).toBe(15 + 14);
    outbox.ack(outbox.peek(1000).map((r) => r.seq));

    const again = new Tracker(sb.cfg, outbox, noLog);
    await again.scanAll();
    const rows = outbox.peek(1000);
    expect(events(rows)).toHaveLength(0);
    expect(summaries(rows)).toHaveLength(2);
  });

  it("verwirft Sessions, deren Arbeitsordner nicht im Projekt liegt (Claude und Codex)", async () => {
    const sb = sandbox();
    const other = "bbbbbbbb-0000-4000-8000-00000000dddd";
    sb.variant(
      join(sb.cfg.claudeDir, "projects", `${ROOT_DIR}-Kopie`, `${other}.jsonl`),
      join(SHARED_FIX, "claude", "sess-a.jsonl"),
      [`"cwd":"${ROOT}"`, `"cwd":"${ROOT}-Kopie"`],
      [SID_A, other],
    );
    const otherCodex = "01a0c424-0000-7000-8000-0000000fffff";
    sb.variant(
      join(sb.cfg.codexDir, "sessions", "2026", "09", "21", `rollout-2026-09-21T15-25-10-${otherCodex}.jsonl`),
      join(SHARED_FIX, "codex", `rollout-2026-09-21T15-25-10-${CODEX_MAIN}.jsonl`),
      [ROOT, "/home/alex/privat"],
      [CODEX_MAIN, otherCodex],
    );
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    await t.scanAll();
    expect(outbox.peek(1000)).toEqual([]);
    expect(outbox.files().map((f) => f.ignored)).toEqual([1, 1]);
    expect(t.isAllowed("claude", other)).toBe(false);
    expect(t.isAllowed("codex", otherCodex)).toBe(false);
  });

  it("übernimmt Codex-Titel aus dem Index, verknüpft Sub-Agenten und aktualisiert bei Index-Änderung", async () => {
    const sb = sandbox();
    sb.codexMain();
    sb.codexSub();
    const idx = sb.codexIndex();
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    await t.scanAll();
    const byId = new Map(summaries(outbox.peek(1000)).map((s) => [s.sessionId, s]));
    expect(byId.get(CODEX_MAIN)?.title).toBe("Codex-Sitzungen prüfen");
    expect(byId.get(CODEX_SUB)?.parentSessionId).toBe(CODEX_MAIN);
    outbox.ack(outbox.peek(1000).map((r) => r.seq));

    appendFileSync(idx, JSON.stringify({ id: CODEX_MAIN, thread_name: "Umbenannt", updated_at: "2026-09-22T00:00:00Z" }) + "\n");
    await t.handle(idx);
    const after = summaries(outbox.peek(1000));
    expect(after.map((s) => [s.sessionId, s.title])).toEqual([[CODEX_MAIN, "Umbenannt"]]);
  });

  it("liest eine Datei, die kürzer geworden ist, komplett neu ein", async () => {
    const sb = sandbox();
    const main = sb.claudeMain();
    const outbox = await newOutbox(sb.home);
    const t = new Tracker(sb.cfg, outbox, noLog);
    await t.scanAll();
    outbox.ack(outbox.peek(1000).map((r) => r.seq));
    const firstTwo = readFileSync(main, "utf8").split("\n").slice(0, 2).join("\n") + "\n";
    truncateSync(main, 0);
    writeFileSync(main, firstTwo);
    await t.handle(main);
    const rows = outbox.peek(1000);
    expect(events(rows).length).toBe(1);
    expect(summaries(rows)[0]?.eventCount).toBe(1);
  });

  it("stürzt bei kaputten Zeilen nicht ab und zählt sie", async () => {
    const sb = sandbox();
    const main = sb.claudeMain();
    appendFileSync(main, "{kaputt\n\n" + '{"type":"user","uuid":"u-x","timestamp":"nie"}\n');
    const outbox = await newOutbox(sb.home);
    await new Tracker(sb.cfg, outbox, noLog).scanAll();
    const [s] = summaries(outbox.peek(1000));
    expect(s?.parseErrors).toBe(2);
    expect(events(outbox.peek(1000))).toHaveLength(15);
  });
});
