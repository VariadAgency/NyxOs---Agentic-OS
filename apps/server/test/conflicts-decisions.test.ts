// Konflikte: Zusammenfassung statt ganzer Karte, Details seitenweise, ETag,
// Entscheidungs-Knöpfe (Ignorieren, „A zuerst“, Pausieren) und Vergleich (Verlauf + Git).
import { createHash } from "node:crypto";
import type { ConflictEntriesPage, ConflictsSummary, FileChangesResponse, GitCompareResponse, ServerToBridge } from "@nyxos/shared";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { reservations, sessionFiles, sessions } from "../src/db/schema.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;

async function makeSession(t: App, id: string, title: string, extra: Partial<typeof sessions.$inferInsert> = {}) {
  const [tool, sessionId] = id.split(":") as [string, string];
  // Konflikte zählen nur zwischen lebenden Sessions — Test-Sessions laufen darum standardmäßig.
  await t.db.insert(sessions).values({ id, tool, sessionId, title, state: "running", ...extra });
}

async function writes(t: App, sessionKey: string, paths: string[]) {
  await t.db.insert(sessionFiles).values(paths.map((path) => ({ sessionKey, path, mode: "write" })));
}

/** Brücke im selben Prozess (wie in terminal.test.ts): antwortet auf RPCs, merkt sich alles. */
function fakeBridge(hub: BridgeHub, reply: (msg: Extract<ServerToBridge, { op: "rpc" }>) => unknown) {
  const sent: Extract<ServerToBridge, { op: "rpc" }>[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        sent.push(msg);
        const result = reply(msg);
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ...(result as object) })));
      },
      close() {},
    },
    "m1",
  );
  return sent;
}

const ROOT = "/Users/alex/projects/App/docs/audit";

async function upload(t: App, tool: "claude" | "codex", sessionId: string, path: string, raw: Buffer) {
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: t.auth.authorization,
      "x-nyxos-tool": tool,
      "x-nyxos-session": sessionId,
      "x-nyxos-path": encodeURIComponent(path),
      "x-nyxos-sha256": createHash("sha256").update(raw).digest("hex"),
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
}

async function seedPair(t: App) {
  await makeSession(t, "claude:a", "Audit A", { tmuxName: "zc-claude-aaaa1111", attachable: true });
  await makeSession(t, "claude:b", "Audit B");
  const paths = Array.from({ length: 12 }, (_, i) => `${ROOT}/teil/datei-${i}.md`);
  await writes(t, "claude:a", paths);
  await writes(t, "claude:b", paths);
  await writes(t, "claude:a", [`${ROOT}/nur-a.md`]);
  return paths;
}

async function summary(t: App, headers: Record<string, string> = {}) {
  const res = await t.app.request("/api/conflicts/summary", { headers });
  return { res, body: res.status === 200 ? ((await res.json()) as ConflictsSummary) : null };
}

describe("Zusammenfassung statt ganzer Karte", () => {
  it("liefert Gruppen + Entscheidungen, keine Einzelzeilen, und zählt richtig", async () => {
    const t = await setup();
    await seedPair(t);
    const { body } = await summary(t);
    expect(body?.totals).toMatchObject({ files: 13, conflicts: 12, groups: 1, openDecisions: 1 });
    expect(body?.groups[0]).toMatchObject({ key: "App/docs/audit", conflictCount: 12, fileCount: 13, writerCount: 2, severity: "high" });
    const [d] = body?.decisions ?? [];
    expect(d).toMatchObject({ kind: "together", fileCount: 12, status: "open", areaGlob: `${ROOT}/teil/**` });
    expect(d?.sessions.map((s) => [s.sessionKey, s.inNyxOS])).toEqual([
      ["claude:a", true],
      ["claude:b", false],
    ]);
    expect(JSON.stringify(body)).not.toContain("datei-11.md"); // höchstens 3 Beispiel-Pfade
  });

  it("ETag: unveränderte Daten → 304, nach einer Änderung wieder 200", async () => {
    const t = await setup();
    await seedPair(t);
    const first = await summary(t);
    const etag = first.res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await summary(t, { "if-none-match": etag ?? "" });
    expect(again.res.status).toBe(304);
    await writes(t, "claude:b", [`${ROOT}/neu.md`]);
    const after = await summary(t, { "if-none-match": etag ?? "" });
    expect(after.res.status).toBe(200);
  });

  it("Details seitenweise je Gruppe, Suche und genau ein Pfad", async () => {
    const t = await setup();
    const paths = await seedPair(t);
    const page = (await (await t.app.request("/api/conflicts/entries?group=App%2Fdocs%2Faudit&offset=5&limit=5")).json()) as ConflictEntriesPage;
    expect(page.total).toBe(13);
    expect(page.entries).toHaveLength(5);
    expect(page.offset).toBe(5);
    const byPath = (await (await t.app.request(`/api/conflicts/entries?path=${encodeURIComponent(paths[3] ?? "")}`)).json()) as ConflictEntriesPage;
    expect(byPath.entries.map((e) => e.path)).toEqual([paths[3]]);
    const search = (await (await t.app.request("/api/conflicts/entries?q=nur-a")).json()) as ConflictEntriesPage;
    expect(search.total).toBe(1);
    const tooMany = (await (await t.app.request("/api/conflicts/entries?limit=100000")).json()) as ConflictEntriesPage;
    expect(tooMany.limit).toBe(200);
  });

  it("3.500 Konflikte: Zusammenfassung bleibt klein", async () => {
    const t = await setup();
    await makeSession(t, "claude:x", "X");
    await makeSession(t, "claude:y", "Y");
    const many = Array.from({ length: 3500 }, (_, i) => `/Users/alex/projects/App/area-${i % 40}/sub/f-${i}.md`);
    await writes(t, "claude:x", many);
    await writes(t, "claude:y", many);
    const { body } = await summary(t);
    expect(body?.totals.conflicts).toBe(3500);
    expect(JSON.stringify(body).length).toBeLessThan(100_000);
  });
});

describe("Entscheidungs-Knöpfe tun wirklich etwas", () => {
  it("Ignorieren und wieder öffnen (additiver Zustand)", async () => {
    const t = await setup();
    await seedPair(t);
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    const r = await t.post("/api/conflicts/decisions/dismiss", { key, status: "ignored" }, {});
    expect(r.status).toBe(200);
    expect((await summary(t)).body?.decisions[0]).toMatchObject({ key, status: "ignored" });
    expect((await summary(t)).body?.totals.openDecisions).toBe(0);
    const back = await t.post("/api/conflicts/decisions/reopen", { key }, {});
    expect(back.status).toBe(200);
    expect((await summary(t)).body?.decisions[0]?.status).toBe("open");
  });

  it("„A zuerst“: reserviert den Bereich für A und schickt B einen Hinweis, wenn B in der NyxOS läuft", async () => {
    const t = await setup();
    await seedPair(t);
    await t.db.insert(sessions).values({ id: "claude:c", tool: "claude", sessionId: "c", title: "C", state: "running", tmuxName: "zc-claude-cccc3333", attachable: true });
    await writes(t, "claude:c", [`${ROOT}/teil/datei-0.md`]);
    const sent = fakeBridge(t.bridgeHub, () => ({ ok: true, result: { sent: true } }));
    const key = (await summary(t)).body?.decisions.find((d) => d.sessions.length === 2)?.key ?? "";
    const res = await t.post("/api/conflicts/decisions/prefer", { key, sessionKey: "claude:b" }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reservation: { pathGlob: string; sessionKey: string }; notified: { sessionKey: string; sent: boolean }[] };
    expect(body.reservation).toMatchObject({ pathGlob: `${ROOT}/teil/**`, sessionKey: "claude:b" });
    // A läuft in der NyxOS → Hinweis per send_text; B ist die bevorzugte Session → kein Hinweis.
    expect(body.notified).toEqual([{ sessionKey: "claude:a", sent: true, reason: null }]);
    expect(sent.map((m) => m.method)).toEqual(["send_text"]);
    expect((sent[0]?.params as { tmuxName: string; text: string }).tmuxName).toBe("zc-claude-aaaa1111");
    expect((sent[0]?.params as { text: string }).text).toContain("Audit B");
    // Hook-Zustand geht als zweite Quelle mit (die Brücke sendet nur, wenn beide „wartet“ sagen).
    expect(sent[0]?.params).toHaveProperty("hookWaiting");
    const rows = await t.db.select().from(reservations);
    expect(rows).toHaveLength(1);
    expect((await summary(t)).body?.decisions.find((d) => d.key === key)?.status).toBe("reserved");
  });

  it("Hinweis nur, wenn B gerade wartet (nie in eine offene Rückfrage tippen); Steuerzeichen raus; {sent:false} ehrlich melden", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      { id: "claude:a", tool: "claude", sessionId: "a", title: "Böse\nZeile\u001b[31m", state: "running", tmuxName: "zc-claude-aaaa1111", attachable: true },
      { id: "claude:b", tool: "claude", sessionId: "b", title: "B", state: "running", tmuxName: "zc-claude-bbbb2222", attachable: true },
    ]);
    const paths = [`${ROOT}/teil/x.md`, `${ROOT}/teil/y.md`];
    await writes(t, "claude:a", paths);
    await writes(t, "claude:b", paths);
    const sent = fakeBridge(t.bridgeHub, () => ({ ok: true, result: { sent: false, reason: "Session arbeitet gerade" } }));
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    const body = (await (await t.post("/api/conflicts/decisions/prefer", { key, sessionKey: "claude:a" }, {})).json()) as { notified: { sessionKey: string; sent: boolean; reason: string | null }[] };
    const params = sent[0]?.params as { onlyWhenWaiting: boolean; text: string };
    expect(params.onlyWhenWaiting).toBe(true);
    // eslint-disable-next-line no-control-regex -- prüft gezielt auf Steuerzeichen
    expect(params.text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(body.notified).toEqual([{ sessionKey: "claude:b", sent: false, reason: "busy" }]);
  });

  it("„A zuerst“ ohne NyxOS-Session: Reservierung ja, Hinweis ehrlich nicht zugestellt", async () => {
    const t = await setup();
    await seedPair(t);
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    const res = await t.post("/api/conflicts/decisions/prefer", { key, sessionKey: "claude:a" }, {});
    const body = (await res.json()) as { notified: { sessionKey: string; sent: boolean; reason: string | null }[] };
    expect(body.notified).toEqual([{ sessionKey: "claude:b", sent: false, reason: "not_in_nyxos" }]);
  });

  it("„Bereich reservieren“: sperrt den Bereich des Konflikts — auch wenn das Lernbuch dort schon „nur eine Session“ gelernt hat", async () => {
    const t = await setup();
    await seedPair(t);
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    // Die Karte hat 12 Konflikte im selben Ordner protokolliert → gelernte Regel für diesen Ordner.
    const check = await t.app.request(`/api/reservations/check?pathGlob=${encodeURIComponent(`${ROOT}/teil/**`)}`);
    expect((await check.json()) as { blocked: boolean }).toMatchObject({ blocked: true });
    const res = await t.post("/api/conflicts/decisions/reserve", { key }, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reservation: { pathGlob: string; sessionKey: string | null } }).reservation).toMatchObject({ pathGlob: `${ROOT}/teil/**`, sessionKey: null });
    expect((await summary(t)).body?.decisions[0]?.status).toBe("reserved");
  });

  it("nach „Bereich reservieren“ werden ältere Schreibvorgänge nicht plötzlich zu neuen Fragen; neue fremde Schreibvorgänge schon", async () => {
    const t = await setup();
    await seedPair(t); // + „nur-a.md“ (eine Session, ein Schreiber)
    await t.db.insert(sessionFiles).values({ sessionKey: "claude:a", path: `${ROOT}/teil/alt-nur-a.md`, mode: "write" });
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    expect((await t.post("/api/conflicts/decisions/reserve", { key }, {})).status).toBe(200);
    const after = (await summary(t)).body;
    expect(after?.decisions.map((d) => [d.kind, d.status])).toEqual([["together", "reserved"]]);
    expect(after?.totals.openDecisions).toBe(0);
    // Später schreibt B eine NEUE Datei im gesperrten Bereich → das ist ein echtes Unterlaufen.
    await t.db.insert(sessionFiles).values({ sessionKey: "claude:b", path: `${ROOT}/teil/neu.md`, mode: "write", firstSeenAt: new Date(Date.now() + 60_000).toISOString() });
    const later = (await summary(t)).body;
    expect(later?.decisions.find((d) => d.kind === "reserved-area")).toMatchObject({ status: "open", fileCount: 1 });
  });

  it("nach einem Klick zeigt die nächste Abfrage sofort den neuen Stand (kein alter Zwischenspeicher)", async () => {
    const t = await setup();
    await seedPair(t);
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    // Zwei parallele Abfragen + Klick direkt danach.
    const [, , click] = await Promise.all([summary(t), summary(t), t.post("/api/conflicts/decisions/dismiss", { key, status: "done" }, {})]);
    expect(click.status).toBe(200);
    expect((await summary(t)).body?.decisions[0]?.status).toBe("done");
  });

  it("„A zuerst“ mit fremder Session → 400; überlappende Reservierung → 409", async () => {
    const t = await setup();
    await seedPair(t);
    const key = (await summary(t)).body?.decisions[0]?.key ?? "";
    expect((await t.post("/api/conflicts/decisions/prefer", { key, sessionKey: "claude:zzz" }, {})).status).toBe(400);
    await t.db.insert(reservations).values({ pathGlob: `${ROOT}/**`, label: "schon da" });
    expect((await t.post("/api/conflicts/decisions/prefer", { key, sessionKey: "claude:a" }, {})).status).toBe(409);
  });

  it("Pausieren: Esc nur an Sessions in der NyxOS, die anderen ehrlich übersprungen", async () => {
    const t = await setup();
    await seedPair(t);
    const sent = fakeBridge(t.bridgeHub, () => ({ ok: true, result: { interrupted: true } }));
    const res = await t.post("/api/conflicts/pause", { sessionKeys: ["claude:a", "claude:b"] }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { sessionKey: string; paused: boolean; reason: string | null }[] };
    expect(body.results).toEqual([
      { sessionKey: "claude:a", paused: true, reason: null },
      { sessionKey: "claude:b", paused: false, reason: "not_in_nyxos" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "interrupt", params: { tmuxName: "zc-claude-aaaa1111" } });
  });

  it("Pausieren mit alter Brücke (kennt den Befehl nicht) → ehrliche Meldung", async () => {
    const t = await setup();
    await seedPair(t);
    fakeBridge(t.bridgeHub, () => ({ ok: false, error: "Unbekannter Befehl interrupt", code: "failed" }));
    const body = (await (await t.post("/api/conflicts/pause", { sessionKeys: ["claude:a"] }, {})).json()) as { results: { reason: string | null }[] };
    expect(body.results[0]?.reason).toBe("bridge_outdated");
  });
});

describe("Vergleichen", () => {
  it("Änderungen je Session an einer Datei aus dem Verlauf (Edit mit echten Zeilennummern, Write, Codex-Patch)", async () => {
    const t = await setup();
    const file = "/Users/alex/projects/App/x.md";
    const claudeSid = "aaaaaaaa-0000-4000-8000-00000000c001";
    const lines = [
      { type: "assistant", timestamp: "2026-09-25T08:00:00.000Z", uuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: file, old_string: "alt", new_string: "neu" } }] } },
      {
        type: "user",
        timestamp: "2026-09-25T08:00:01.000Z",
        uuid: "u2",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        toolUseResult: { filePath: file, oldString: "alt", newString: "neu", structuredPatch: [{ oldStart: 41, oldLines: 3, newStart: 41, newLines: 3, lines: [" davor", "-alt", "+neu", " danach"] }] },
      },
      { type: "assistant", timestamp: "2026-09-25T08:01:00.000Z", uuid: "u3", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/anders.md", old_string: "a", new_string: "b" } }] } },
      { type: "assistant", timestamp: "2026-09-25T08:02:00.000Z", uuid: "u4", message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: file, content: "eins\nzwei\n" } }] } },
      { type: "user", timestamp: "2026-09-25T08:02:01.000Z", uuid: "u5", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] }, toolUseResult: { type: "update", filePath: file, content: "eins\nzwei\n", structuredPatch: [] } },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await t.db.insert(sessions).values({ id: `claude:${claudeSid}`, tool: "claude", sessionId: claudeSid, title: "Claude-Session" });
    const up = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gzipSync(raw),
      headers: {
        authorization: t.auth.authorization,
        "x-nyxos-tool": "claude",
        "x-nyxos-session": claudeSid,
        "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${claudeSid}.jsonl`),
        "x-nyxos-sha256": createHash("sha256").update(raw).digest("hex"),
        "x-nyxos-size": String(raw.length),
      },
    });
    expect(up.status).toBe(200);

    const codexSid = "01a0c424-0000-7000-8000-0000000c0de9";
    const codexRaw = Buffer.from(
      JSON.stringify({
        timestamp: "2026-09-25T08:03:00.000Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "FileChange", id: "fc", changes: { [file]: { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n eins\n-zwei\n+drei\n" } } } },
      }) + "\n",
    );
    await t.db.insert(sessions).values({ id: `codex:${codexSid}`, tool: "codex", sessionId: codexSid, title: "Codex-Session" });
    const up2 = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gzipSync(codexRaw),
      headers: {
        authorization: t.auth.authorization,
        "x-nyxos-tool": "codex",
        "x-nyxos-session": codexSid,
        "x-nyxos-path": encodeURIComponent(`2026/09/25/rollout-2026-09-25T08-00-00-${codexSid}.jsonl`),
        "x-nyxos-sha256": createHash("sha256").update(codexRaw).digest("hex"),
        "x-nyxos-size": String(codexRaw.length),
      },
    });
    expect(up2.status).toBe(200);

    const res = await t.app.request(`/api/conflicts/file-changes?path=${encodeURIComponent(file)}&sessions=${encodeURIComponent(`claude:${claudeSid},codex:${codexSid},claude:fehlt`)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileChangesResponse;
    const claude = body.sessions[0];
    expect(claude?.edits.map((e) => e.kind)).toEqual(["edit", "write"]);
    expect(claude?.edits[0]).toMatchObject({ exactLines: true });
    expect(claude?.edits[0]?.lines.filter((l) => l.kind !== "hunk")).toEqual([
      { kind: "ctx", oldNo: 41, newNo: 41, text: "davor" },
      { kind: "del", oldNo: 42, newNo: null, text: "alt" },
      { kind: "add", oldNo: null, newNo: 42, text: "neu" },
      { kind: "ctx", oldNo: 43, newNo: 43, text: "danach" },
    ]);
    expect(claude?.edits[1]?.lines.map((l) => l.text)).toEqual(["eins", "zwei"]);
    const codex = body.sessions[1];
    expect(codex?.edits[0]).toMatchObject({ kind: "patch", exactLines: true });
    expect(codex?.edits[0]?.lines.filter((l) => l.kind === "add").map((l) => [l.newNo, l.text])).toEqual([[2, "drei"]]);
    expect(body.sessions[2]).toMatchObject({ sessionKey: "claude:fehlt", missingArchive: true, edits: [] });
  });

  it("abgelehnte/gescheiterte Edits zählen nicht; Umlaute (NFD/escaped) und Codex-Umbenennung werden gefunden", async () => {
    const t = await setup();
    const file = "/Users/alex/projects/App/Übersicht.md";
    const sid = "aaaaaaaa-0000-4000-8000-00000000c0f5";
    const lines = [
      { type: "assistant", timestamp: "2026-09-25T08:00:00.000Z", message: { content: [{ type: "tool_use", id: "r1", name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] } },
      { type: "user", timestamp: "2026-09-25T08:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "r1", is_error: true, content: "The user doesn't want to proceed" }] }, toolUseResult: "User rejected tool use" },
      { type: "assistant", timestamp: "2026-09-25T08:01:00.000Z", message: { content: [{ type: "tool_use", id: "r2", name: "Edit", input: { file_path: file.normalize("NFD"), old_string: "x", new_string: "y" } }] } },
      { type: "user", timestamp: "2026-09-25T08:01:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "r2", content: "ok" }] }, toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }] } },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("\n") + "\n");
    await t.db.insert(sessions).values({ id: `claude:${sid}`, tool: "claude", sessionId: sid, title: "C" });
    await upload(t, "claude", sid, `-Users-alex-projects/${sid}.jsonl`, raw);
    const codexSid = "01a0c424-0000-7000-8000-0000000c0dea";
    const codexRaw = Buffer.from(
      JSON.stringify({ timestamp: "2026-09-25T08:03:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: { "/Users/alex/projects/App/alt.md": { type: "update", unified_diff: "@@ -1 +1 @@\n-q\n+r\n", move_path: file } } } } }) + "\n",
    );
    await t.db.insert(sessions).values({ id: `codex:${codexSid}`, tool: "codex", sessionId: codexSid, title: "X" });
    await upload(t, "codex", codexSid, `2026/09/25/rollout-2026-09-25T08-00-00-${codexSid}.jsonl`, codexRaw);
    const body = (await (await t.app.request(`/api/conflicts/file-changes?path=${encodeURIComponent(file)}&sessions=${encodeURIComponent(`claude:${sid},codex:${codexSid}`)}`)).json()) as FileChangesResponse;
    expect(body.sessions[0]?.edits.map((e) => e.lines.filter((l) => l.kind === "add").map((l) => l.text))).toEqual([["y"]]);
    expect(body.sessions[1]?.edits.map((e) => e.kind)).toEqual(["patch"]);
  });

  it("Git-Vergleich über die Brücke (nur lesend), Ergebnis als Diff-Zeilen", async () => {
    const t = await setup();
    const sent = fakeBridge(t.bridgeHub, () => ({
      ok: true,
      result: {
        repoRoot: "/Users/alex/projects/App",
        relPath: "x.md",
        commits: [{ sha: "a".repeat(40), short: "aaaaaaa", author: "Alex", at: "2026-09-25T08:00:00+02:00", subject: "Test" }],
        diff: "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-alt\n+neu\n",
        truncated: false,
      },
    }));
    const res = await t.app.request(`/api/conflicts/compare?path=${encodeURIComponent("/Users/alex/projects/App/x.md")}&from=HEAD~1&to=HEAD`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GitCompareResponse;
    expect(sent[0]).toMatchObject({ method: "git_compare", params: { path: "/Users/alex/projects/App/x.md", from: "HEAD~1", to: "HEAD" } });
    expect(body.files[0]?.lines.map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
    expect(body.commits).toHaveLength(1);
  });

  it("Git-Vergleich: ungültiger Stand → 400, Brücke weg → 503 mit verständlicher Meldung", async () => {
    const t = await setup();
    expect((await t.app.request(`/api/conflicts/compare?path=${encodeURIComponent("/x/y.md")}&from=--output=/tmp/x`)).status).toBe(400);
    const res = await t.app.request(`/api/conflicts/compare?path=${encodeURIComponent("/x/y.md")}`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Rechner/);
  });
});
