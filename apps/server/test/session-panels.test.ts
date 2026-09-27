// Session-Seitenpanels. Geprüft wird der ganze Weg wie in Produktion:
// Brücke schickt Zusammenfassung + Archiv → Server rechnet je Archiv-Datei einen Digest →
// `/changes`, `/agents`, `/agents/:id`, `/outcomes` liefern daraus die Panel-Daten.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ClaudeSessionParser,
  CodexSessionParser,
  emptyTokens,
  type IngestItem,
  type SessionAgentDetail,
  type SessionAgentsResponse,
  type SessionChangesResponse,
  type SessionFileChangesResponse,
  type SessionOutcomesResponse,
  type SessionSummary,
} from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { archive, archiveDigests, entries, links, sessionChangeOps, subtasks } from "../src/db/schema.js";
import { DigestService, digestArchiveLines, testSegment } from "../src/session-digest.js";
import { setup } from "./helpers.js";

// Im Test ohne Drosselung: jede neue Archiv-Fassung wird sofort im Hintergrund gerechnet.
process.env.NYXOS_DIGEST_MIN_INTERVAL_MS = "0";

const FIX = join(import.meta.dirname, "fixtures", "transcript-panels");
const SID = "bbbbbbbb-0000-4000-8000-000000000db1";
const KEY = `claude:${SID}`;
const AGENT = "b0000000000000001";
const CWD = "/Users/alex/projects/tools/NyxOS";
const MAIN_PATH = `-Users-alex-projects-08-Systeme-NyxOS/${SID}.jsonl`;
const SUB_PATH = `-Users-alex-projects-08-Systeme-NyxOS/${SID}/subagents/agent-${AGENT}.jsonl`;
const CODEX_CHILD = "01a0c424-0000-7000-8000-0000000dbc01";
const CODEX_PARENT = "01a0c424-0000-7000-8000-0000000dbc00";
const CODEX_FILE = `rollout-2026-09-24T09-00-00-${CODEX_CHILD}.jsonl`;

type App = Awaited<ReturnType<typeof setup>>;

const mainRaw = () => readFileSync(join(FIX, `${SID}.jsonl`));
const subRaw = () => readFileSync(join(FIX, SID, "subagents", `agent-${AGENT}.jsonl`));
const codexRaw = () => readFileSync(join(FIX, "codex", CODEX_FILE));

async function uploadArchive(t: App, opts: { tool: "claude" | "codex"; sessionId: string; path: string; raw: Buffer }) {
  const sha = createHash("sha256").update(opts.raw).digest("hex");
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(opts.raw),
    headers: {
      authorization: t.auth.authorization,
      "x-nyxos-tool": opts.tool,
      "x-nyxos-session": opts.sessionId,
      "x-nyxos-path": encodeURIComponent(opts.path),
      "x-nyxos-sha256": sha,
      "x-nyxos-size": String(opts.raw.length),
    },
  });
  expect(res.status).toBe(200);
}

/** Wie die Brücke: Haupt- und Sub-Agent-Zeilen durch denselben Parser, danach die Zusammenfassung. */
function claudeSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  const parser = new ClaudeSessionParser(SID);
  for (const line of mainRaw().toString("utf8").split("\n")) parser.push(line);
  for (const line of subRaw().toString("utf8").split("\n")) parser.push(line, { agentId: AGENT });
  return { ...parser.summary(), ...over };
}

async function seedClaude(t: App, over: Partial<SessionSummary> = {}) {
  const items: IngestItem[] = [{ type: "summary", summary: claudeSummary({ title: "Seitenpanels bauen", ...over }) }];
  await t.post("/ingest/events", { items });
  await uploadArchive(t, { tool: "claude", sessionId: SID, path: MAIN_PATH, raw: mainRaw() });
  await uploadArchive(t, { tool: "claude", sessionId: SID, path: SUB_PATH, raw: subRaw() });
}

async function getJson<T>(t: App, url: string): Promise<{ status: number; body: T }> {
  const res = await t.app.request(url);
  return { status: res.status, body: (await res.json()) as T };
}

describe("Digest einer Sub-Agent-Datei (Transkript-Fixture)", () => {
  it("liest Auftrag (ungekürzt), Ergebnis, Tokens, Werkzeuge, Dateien, Dauer und Urteil", async () => {
    const { digest, ops } = await digestArchiveLines("claude", SID, AGENT, subRaw().toString("utf8").split("\n"));
    expect(digest.prompt?.startsWith("Prüfe den Parser gründlich.")).toBe(true);
    expect(digest.prompt?.endsWith("ENDE-DES-AUFTRAGS")).toBe(true);
    expect(digest.prompt?.length).toBeGreaterThan(2000); // nicht auf EVENT_TEXT_MAX gekürzt
    expect(digest.result).toBe("Ergebnis: Parser ist korrekt. Zwei Randfälle ergänzt.\n\nPASS");
    // msg_S2 steht zweimal im Verlauf, zählt einmal.
    expect(digest.tokens).toEqual({ input: 120, output: 380, cacheRead: 4450, cacheCreation: 200, total: 5150 });
    expect(digest.tools).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(digest.toolErrors).toBe(1);
    expect(digest.models).toEqual(["claude-sonnet-5"]);
    expect(digest.startedAt).toBe("2026-09-24T09:00:12.000Z");
    expect(digest.endedAt).toBe("2026-09-24T09:00:30.000Z");
    expect(digest.verdict).toBe("PASS");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ filePath: `${CWD}/packages/shared/src/parse/claude.ts`, added: 3, removed: 1, tool: "Edit" });
    expect(ops[0]?.addedText).toContain("Randfall: kaputtes JSON");
    expect(ops[0]?.removedText).toContain("const tokenizer = old;");
  });

  it("Ergebnis = Abschlussbericht per SubagentHandback, wenn vorhanden (nicht der letzte Zwischentext)", async () => {
    const line = (uuid: string, content: unknown[]) =>
      JSON.stringify({ type: "assistant", uuid, timestamp: "2026-09-24T09:01:00.000Z", sessionId: SID, isSidechain: true, agentId: AGENT, message: { id: `msg_${uuid}`, role: "assistant", model: "claude-sonnet-5", content } });
    const lines = [
      ...subRaw().toString("utf8").split("\n"),
      line("h1", [{ type: "tool_use", id: "toolu_H", name: "SubagentHandback", input: { message: "Bericht: alles erledigt. BLOCK wegen fehlendem Test." } }]),
      line("h2", [{ type: "text", text: "Übergeben." }]),
    ];
    const { digest } = await digestArchiveLines("claude", SID, AGENT, lines);
    expect(digest.result).toBe("Bericht: alles erledigt. BLOCK wegen fehlendem Test.");
    expect(digest.verdict).toBe("BLOCK");
  });

  it("Haupt-Verlauf: Todos (letzter Stand), Commits mit Kennung, Test rot → grün, Write ohne Patch", async () => {
    const { digest, ops } = await digestArchiveLines("claude", SID, null, mainRaw().toString("utf8").split("\n"));
    expect(digest.todos).toEqual([
      { content: "Tests schreiben", status: "completed" },
      { content: "UI bauen", status: "completed" },
      { content: "Doku nachziehen", status: "pending" },
    ]);
    expect(digest.commits.map((c) => [c.sha, c.subject])).toEqual([
      ["abc1234", "fix: Zähler zählt doppelt"],
      ["def5678", "D4: Dateien ausklappbar"],
    ]);
    expect(digest.tests.map((r) => r.ok)).toEqual([false, true]);
    expect(new Set(digest.tests.map((r) => r.key)).size).toBe(1);
    const write = ops.find((o) => o.filePath.endsWith("Panel.tsx"));
    expect(write).toMatchObject({ tool: "Write", added: 3, removed: 0 });
    const edit = ops.find((o) => o.filePath.endsWith("zaehler.ts"));
    expect(edit).toMatchObject({ tool: "Edit", added: 2, removed: 1 });
  });

  it("Test-Läufe nur, wenn ein Test-Runner wirklich ausgeführt wird (nicht bloß im Text vorkommt)", () => {
    expect(testSegment("cd /x && npx vitest run apps/server/test/a.test.ts 2>&1 | tail -5")).toBe("npx vitest run apps/server/test/a.test.ts 2>&1");
    expect(testSegment("E2E_BASE_URL=http://127.0.0.1:1 pnpm --filter @nyxos/web exec playwright test e2e/x.spec.ts")).toContain("playwright test");
    expect(testSegment("pnpm -r test")).toBe("pnpm -r test");
    expect(testSegment(`sed -i '' 's/vitest run/x/' test/a.test.ts`)).toBeNull();
    expect(testSegment("grep -rn vitest apps")).toBeNull();
    expect(testSegment("test -f package.json && echo ok")).toBeNull();
  });

  it("kaputter Zeitstempel, fremde Session und doppelte Zeile brechen nichts und zählen nicht", async () => {
    const lines = subRaw().toString("utf8").split("\n");
    const dup = lines[3] ?? ""; // Edit-Aufruf (msg_S2) noch einmal
    const foreign = JSON.stringify({ ...JSON.parse(lines[3] ?? "{}"), uuid: "fremd", sessionId: "andere-session" });
    const broken = JSON.stringify({ ...JSON.parse(lines[1] ?? "{}"), uuid: "kaputt", timestamp: "2026-99-99Tkaputt" });
    const { ops, digest } = await digestArchiveLines("claude", SID, AGENT, [...lines, dup, foreign, broken]);
    expect(ops).toHaveLength(1);
    expect(digest.prompt?.endsWith("ENDE-DES-AUFTRAGS")).toBe(true);
  });

  it("Aufgabenliste auch aus TaskCreate/TaskUpdate (neuere Claude-Code-Fassungen)", async () => {
    const at = (n: number) => `2026-09-24T09:10:0${n}.000Z`;
    const row = (uuid: string, type: "user" | "assistant", content: unknown, extra: object = {}) =>
      JSON.stringify({ type, uuid, timestamp: at(Number(uuid.slice(1))), sessionId: SID, message: { id: `msg_${uuid}`, role: type, content }, ...extra });
    const lines = [
      row("t1", "assistant", [{ type: "tool_use", id: "tc1", name: "TaskCreate", input: { subject: "Suche bauen", description: "…" } }]),
      row("t2", "user", [{ type: "tool_result", tool_use_id: "tc1", content: "Task #1 created successfully: Suche bauen" }]),
      row("t3", "assistant", [{ type: "tool_use", id: "tc2", name: "TaskCreate", input: { subject: "Screenshots" } }]),
      row("t4", "user", [{ type: "tool_result", tool_use_id: "tc2", content: "Task #2 created successfully: Screenshots" }]),
      row("t5", "assistant", [{ type: "tool_use", id: "tu1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }]),
    ];
    const { digest } = await digestArchiveLines("claude", SID, null, lines);
    expect(digest.todos).toEqual([
      { content: "Suche bauen", status: "completed" },
      { content: "Screenshots", status: "pending" },
    ]);
  });

  it("Codex-Diff: „---“ im Inhalt ist eine entfernte Zeile, keine Kopfzeile", async () => {
    const line = JSON.stringify({
      timestamp: "2026-09-24T09:00:10.000Z",
      type: "event_msg",
      payload: { type: "item_completed", thread_id: CODEX_CHILD, item: { type: "FileChange", id: "f9", changes: { "/x.sql": { type: "update", unified_diff: "--- a/x.sql\n+++ b/x.sql\n@@ -1,2 +1,1 @@\n--- alter Kommentar\n select 1;\n" } } } },
    });
    const { ops } = await digestArchiveLines("codex", CODEX_CHILD, null, [line]);
    expect(ops[0]).toMatchObject({ added: 0, removed: 1, removedText: "-- alter Kommentar" });
  });

  it("Codex: Auftrag, Ergebnis, Tokens, apply_patch mit +/−, Commit", async () => {
    const { digest, ops } = await digestArchiveLines("codex", CODEX_CHILD, null, codexRaw().toString("utf8").split("\n"));
    expect(digest.prompt).toBe("Prüfe den Feed auf stille Fehler.");
    expect(digest.result).toBe("Drei stille Fehler gefunden und dokumentiert.");
    expect(digest.tokens?.total).toBe(5700);
    expect(digest.tools).toMatchObject({ apply_patch: 1, exec_command: 1 });
    expect(ops).toEqual([expect.objectContaining({ filePath: "/Users/alex/projects/App/docs/feed.md", added: 2, removed: 1, tool: "apply_patch" })]);
    expect(digest.commits.map((c) => c.sha)).toEqual(["1112223"]);
  });
});

describe("GET /api/sessions/:id/agents (+ /:agentId)", () => {
  it("Kachel-Liste: Name, Typ, Tokens, Dauer, Werkzeuge, Dateien aus dem Sub-Agent-Transkript", async () => {
    const t = await setup();
    await seedClaude(t);
    const { status, body } = await getJson<SessionAgentsResponse>(t, `/api/sessions/${KEY}/agents`);
    expect(status).toBe(200);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      id: AGENT,
      tool: "claude",
      name: "Parser prüfen",
      type: "general-purpose",
      model: "claude-sonnet-5",
      toolCalls: 3,
      filesWritten: 1,
      verdict: "PASS",
      durationMs: 18_000,
      hasTranscript: true,
    });
    expect(body.agents[0]?.tokens?.total).toBe(5150);
  });

  it("große Kachel: Auftrag ungekürzt, Ergebnis, Werkzeuge je Anzahl, geänderte Dateien mit +/−", async () => {
    const t = await setup();
    await seedClaude(t);
    const { status, body } = await getJson<SessionAgentDetail>(t, `/api/sessions/${KEY}/agents/${AGENT}`);
    expect(status).toBe(200);
    expect(body.prompt?.endsWith("ENDE-DES-AUFTRAGS")).toBe(true);
    expect(body.result).toContain("Zwei Randfälle ergänzt");
    expect(body.tools).toEqual([
      { name: "Bash", count: 1 },
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
    ]);
    expect(body.toolErrors).toBe(1);
    expect(body.files).toEqual([expect.objectContaining({ path: `${CWD}/packages/shared/src/parse/claude.ts`, edits: 1, added: 3, removed: 1 })]);
    expect(body.tokens).toEqual({ input: 120, output: 380, cacheRead: 4450, cacheCreation: 200, total: 5150 });
  });

  it("unbekannter Agent → 404, unbekannte Session → 404", async () => {
    const t = await setup();
    await seedClaude(t);
    expect((await t.app.request(`/api/sessions/${KEY}/agents/gibtsnicht`)).status).toBe(404);
    expect((await t.app.request(`/api/sessions/claude:gibtsnicht/agents`)).status).toBe(404);
  });

  it("Agent ohne archivierten Verlauf erscheint trotzdem (nur Name/Typ, hasTranscript=false)", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [{ type: "summary", summary: claudeSummary({ subagents: [{ id: "nochnichtda", name: "Läuft an", type: "Explore" }] }) }] });
    const { body } = await getJson<SessionAgentsResponse>(t, `/api/sessions/${KEY}/agents`);
    expect(body.agents).toEqual([expect.objectContaining({ id: "nochnichtda", name: "Läuft an", type: "Explore", hasTranscript: false, tokens: null })]);
  });

  it("Codex: Kind-Sessions sind die Agenten, mit Daten aus deren eigenem Verlauf", async () => {
    const t = await setup();
    const parser = new CodexSessionParser(CODEX_CHILD);
    for (const line of codexRaw().toString("utf8").split("\n")) parser.push(line);
    const child = parser.summary();
    const parent: SessionSummary = { ...child, sessionId: CODEX_PARENT, parentSessionId: null, title: "Audit Feed", tokens: emptyTokens(), subagents: [] };
    await t.post("/ingest/events", { items: [{ type: "summary", summary: parent }, { type: "summary", summary: child }] });
    await uploadArchive(t, { tool: "codex", sessionId: CODEX_CHILD, path: `2026/09/24/${CODEX_FILE}`, raw: codexRaw() });
    const { body } = await getJson<SessionAgentsResponse>(t, `/api/sessions/codex:${CODEX_PARENT}/agents`);
    expect(body.agents).toEqual([expect.objectContaining({ id: `codex:${CODEX_CHILD}`, tool: "codex", sessionKey: `codex:${CODEX_CHILD}`, hasTranscript: true, filesWritten: 1 })]);
    const detail = await getJson<SessionAgentDetail>(t, `/api/sessions/codex:${CODEX_PARENT}/agents/${encodeURIComponent(`codex:${CODEX_CHILD}`)}`);
    expect(detail.body.prompt).toBe("Prüfe den Feed auf stille Fehler.");
    expect(detail.body.result).toBe("Drei stille Fehler gefunden und dokumentiert.");
  });
});

describe("GET /api/sessions/:id/changes", () => {
  it("jede geschriebene Datei mit Anzahl Änderungen und +/−, zuletzt geänderte zuerst", async () => {
    const t = await setup();
    await seedClaude(t);
    const { status, body } = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes`);
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.files.map((f) => [f.path.replace(`${CWD}/`, ""), f.edits, f.added, f.removed])).toEqual([
      ["apps/web/src/Panel.tsx", 1, 3, 0],
      ["apps/server/src/zaehler.ts", 1, 2, 1],
      ["packages/shared/src/parse/claude.ts", 1, 3, 1],
    ]);
    expect(body.files[2]?.agentIds).toEqual([AGENT]);
  });

  it("Suche filtert nach Datei und nach Inhalt, mit Beispiel-Zeilen", async () => {
    const t = await setup();
    await seedClaude(t);
    const byPath = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes?q=panel.tsx`);
    expect(byPath.body.files.map((f) => f.path.split("/").pop())).toEqual(["Panel.tsx"]);
    expect(byPath.body.files[0]?.matchedPath).toBe(true);
    expect(byPath.body.total).toBe(3);

    const byContent = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes?q=${encodeURIComponent("zaehler nur")}`);
    expect(byContent.body.files.map((f) => f.path.split("/").pop())).toEqual(["zaehler.ts"]);
    expect(byContent.body.files[0]).toMatchObject({ contentMatches: 1, snippets: [{ kind: "+", text: "  // Zaehler nur einmal erhöhen" }] });

    const removed = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes?q=tokenizer`);
    expect(removed.body.files[0]?.snippets.map((s) => s.kind)).toEqual(["-", "+"]);

    const none = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes?q=${encodeURIComponent("100%_")}`);
    expect(none.body.files).toEqual([]); // % und _ sind keine Platzhalter
  });

  it("Klick auf eine Datei: einzelne Änderungen mit geänderten Zeilen (entfernt zuerst)", async () => {
    const t = await setup();
    await seedClaude(t);
    const path = `${CWD}/apps/server/src/zaehler.ts`;
    const { status, body } = await getJson<SessionFileChangesResponse>(t, `/api/sessions/${KEY}/changes/file?path=${encodeURIComponent(path)}`);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.ops[0]).toMatchObject({ tool: "Edit", agentId: null, added: 2, removed: 1, truncated: false });
    expect(body.ops[0]?.lines).toEqual([
      { kind: "-", text: "  count += 2;" },
      { kind: "+", text: "  // Zaehler nur einmal erhöhen" },
      { kind: "+", text: "  count += 1;" },
    ]);
    expect((await t.app.request(`/api/sessions/${KEY}/changes/file`)).status).toBe(400);

    // Nur ein Agent bzw. nur die Haupt-Session (große Agenten-Kachel).
    const sub = `${CWD}/packages/shared/src/parse/claude.ts`;
    const onlyAgent = await getJson<SessionFileChangesResponse>(t, `/api/sessions/${KEY}/changes/file?path=${encodeURIComponent(sub)}&agent=${AGENT}`);
    expect(onlyAgent.body.total).toBe(1);
    const onlyMain = await getJson<SessionFileChangesResponse>(t, `/api/sessions/${KEY}/changes/file?path=${encodeURIComponent(sub)}&agent=main`);
    expect(onlyMain.body.total).toBe(0);
  });

  it("Datei nur aus session_files (ohne Archiv) erscheint mit „keine Angabe“ statt erfundener Zahlen", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [{ type: "summary", summary: claudeSummary({ filesWritten: ["/nur/bekannt.ts"] }) }] });
    const { body } = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes`);
    expect(body.files).toEqual([expect.objectContaining({ path: "/nur/bekannt.ts", edits: null, added: null, removed: null })]);
  });

  it("Digest wird gespeichert und bei neuer Archiv-Fassung neu gerechnet", async () => {
    const t = await setup();
    await seedClaude(t);
    await t.app.request(`/api/sessions/${KEY}/changes`);
    const rows = await t.db.select().from(archiveDigests).where(eq(archiveDigests.sessionKey, KEY));
    expect(rows).toHaveLength(2);
    const extra = JSON.stringify({
      parentUuid: null, isSidechain: false, type: "assistant", uuid: "m-extra", timestamp: "2026-09-24T09:05:00.000Z", sessionId: SID,
      message: { id: "msg_X", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_X", name: "Write", input: { file_path: "/neu.md", content: "a\nb" } }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    await uploadArchive(t, { tool: "claude", sessionId: SID, path: MAIN_PATH, raw: Buffer.concat([mainRaw(), Buffer.from(extra + "\n")]) });
    // Die neue Fassung wird im Hintergrund gerechnet; bis dahin kommt sofort der letzte Stand.
    await expect
      .poll(async () => (await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes`)).body.files.map((f) => f.path), { timeout: 5000 })
      .toContain("/neu.md");
    const ops = await t.db.select().from(sessionChangeOps).where(eq(sessionChangeOps.sessionKey, KEY));
    expect(ops.filter((o) => o.filePath.endsWith("zaehler.ts"))).toHaveLength(1); // alte Zeilen ersetzt, nicht verdoppelt
  });

  it("Hintergrund-Neurechnung ist je Datei gedrosselt (laufende Session nicht alle 30 s komplett neu)", async () => {
    const t = await setup();
    await seedClaude(t);
    await t.app.request(`/api/sessions/${KEY}/changes`);
    const service = new DigestService(t.db, undefined, { minIntervalMs: 60_000 });
    const shaOf = async () => (await t.db.select({ sha: archiveDigests.sha256 }).from(archiveDigests).innerJoin(archive, eq(archive.id, archiveDigests.archiveId)).where(eq(archive.path, MAIN_PATH)))[0]?.sha;
    await t.db.update(archive).set({ sha256: "a".repeat(64) }).where(eq(archive.path, MAIN_PATH));
    await service.refreshPath("claude", MAIN_PATH);
    await expect.poll(shaOf, { timeout: 5000 }).toBe("a".repeat(64));
    await t.db.update(archive).set({ sha256: "b".repeat(64) }).where(eq(archive.path, MAIN_PATH));
    await service.refreshPath("claude", MAIN_PATH);
    await new Promise((r) => setTimeout(r, 300));
    expect(await shaOf()).toBe("a".repeat(64)); // zweite Fassung wartet auf das Intervall
  });

  it("veralteter Digest wird sofort geliefert (kein Warten), der neue im Hintergrund gerechnet", async () => {
    const t = await setup();
    await seedClaude(t);
    await t.app.request(`/api/sessions/${KEY}/changes`);
    // Archiv-Fassung „wächst", ohne dass der Upload-Hintergrund schon fertig ist: Prüfsumme direkt ändern.
    await t.db.update(archive).set({ sha256: "e".repeat(64) }).where(eq(archive.path, MAIN_PATH));
    const { body } = await getJson<SessionChangesResponse>(t, `/api/sessions/${KEY}/changes`);
    expect(body.total).toBe(3); // letzter Stand, sofort
    await expect.poll(async () => (await t.db.select().from(archiveDigests).where(eq(archiveDigests.sha256, "e".repeat(64)))).length, { timeout: 5000 }).toBe(1);
  });
});

describe("GET /api/sessions/:id/outcomes", () => {
  it("erledigt: Todos (completed), fertige Sub-Agenten, Commits, erledigte verknüpfte Einträge", async () => {
    const t = await setup();
    await seedClaude(t);
    const [task] = await t.db.insert(entries).values({ kind: "aufgabe", title: "Panels bauen", stage: "erledigt" }).returning();
    await t.db.insert(links).values({ fromType: "entry", fromId: String(task?.id), toType: "session", toId: KEY, relation: "session" });
    const [open] = await t.db.insert(entries).values({ kind: "aufgabe", title: "Doku ergänzen", stage: "laeuft" }).returning();
    await t.db.insert(links).values({ fromType: "entry", fromId: String(open?.id), toType: "session", toId: KEY, relation: "session" });
    await t.db.insert(subtasks).values({ entryId: open?.id ?? 0, title: "Screenshot", done: true, doneBySessionKey: KEY, doneAt: "2026-09-24T09:02:00.000Z" });

    const { status, body } = await getJson<SessionOutcomesResponse>(t, `/api/sessions/${KEY}/outcomes`);
    expect(status).toBe(200);
    const done = body.done.map((d) => [d.kind, d.title]);
    expect(done).toEqual(
      expect.arrayContaining([
        ["todo", "Tests schreiben"],
        ["todo", "UI bauen"],
        ["agent", "Parser prüfen"],
        ["commit", "fix: Zähler zählt doppelt"],
        ["commit", "D4: Dateien ausklappbar"],
        ["entry", "Panels bauen"],
        ["subtask", "Screenshot"],
      ]),
    );
    expect(body.done.find((d) => d.kind === "agent")?.link).toEqual({ type: "agent", id: AGENT });
    expect(body.done.find((d) => d.kind === "entry")?.link).toEqual({ type: "entry", id: task?.id });
    expect(body.open.map((o) => [o.kind, o.title])).toEqual(expect.arrayContaining([["todo", "Doku nachziehen"], ["entry", "Doku ergänzen"]]));
    expect(body.stats).toEqual({ commits: 2, testRuns: 2, agentsFinished: 1, agentsTotal: 1 });
  });

  it("erfolgreich behoben: Bug-Eintrag erledigt (sicher), fix-Commit (wahrscheinlich), Test rot → grün (möglich)", async () => {
    const t = await setup();
    await seedClaude(t);
    const [bug] = await t.db.insert(entries).values({ kind: "bug", title: "Zähler doppelt", stage: "erledigt" }).returning();
    await t.db.insert(links).values({ fromType: "entry", fromId: String(bug?.id), toType: "session", toId: KEY, relation: "session" });
    const { body } = await getJson<SessionOutcomesResponse>(t, `/api/sessions/${KEY}/outcomes`);
    const fixed = body.fixed.map((f) => [f.kind, f.confidence]);
    expect(fixed).toEqual([
      ["entry", "sicher"],
      ["commit", "wahrscheinlich"],
      ["test", "moeglich"],
    ]);
    expect(body.fixed[2]?.detail).toContain("zaehler.test.ts");
    // Nicht-Fix-Commit gehört nicht zu „behoben".
    expect(body.fixed.some((f) => f.title.includes("D4"))).toBe(false);
  });

  it("vergleichbare Sessions: gemeinsame Dateien (gewichtet), gleiche Baustelle, ähnlicher Titel — mit Grund", async () => {
    const t = await setup();
    await seedClaude(t, { title: "Seitenpanels für Sessions bauen" });
    const other = (sessionId: string, over: Partial<SessionSummary>): IngestItem => ({
      type: "summary",
      summary: { ...claudeSummary(), sessionId, subagents: [], filesWritten: [], title: null, ...over },
    });
    await t.post("/ingest/events", {
      items: [
        other("cccccccc-0000-4000-8000-000000000001", { title: "Zähler reparieren", filesWritten: [`${CWD}/apps/server/src/zaehler.ts`, `${CWD}/apps/web/src/Panel.tsx`] }),
        other("cccccccc-0000-4000-8000-000000000002", { title: "Etwas ganz anderes", filesWritten: [`${CWD}/apps/web/src/Panel.tsx`] }),
        other("cccccccc-0000-4000-8000-000000000003", { title: "Seitenpanels polieren", filesWritten: ["/woanders.ts"] }),
        other("cccccccc-0000-4000-8000-000000000004", { title: "Unbeteiligt", filesWritten: ["/x.ts"], cwd: "/tmp" }),
      ],
    });
    const { body } = await getJson<SessionOutcomesResponse>(t, `/api/sessions/${KEY}/outcomes`);
    const ids = body.similar.map((s) => s.sessionId);
    expect(ids[0]).toBe("cccccccc-0000-4000-8000-000000000001");
    expect(ids).toContain("cccccccc-0000-4000-8000-000000000003");
    expect(ids).not.toContain(SID);
    const first = body.similar[0];
    expect(first?.reasons).toContain("2 gemeinsame Dateien");
    const titled = body.similar.find((s) => s.sessionId === "cccccccc-0000-4000-8000-000000000003");
    expect(titled?.reasons.some((r) => r.startsWith("ähnlicher Titel"))).toBe(true);
  });
});
