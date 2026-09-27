import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { ClaudeSessionParser, type IngestItem, type SessionEvent } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { archive, machines, sessionEvents, sessionFiles, sessions } from "../src/db/schema.js";
import { applyRetickUpdate, selectRetickCandidates } from "../src/store.js";
import { brokenDb, setup } from "./helpers.js";

const FIX = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude");
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

function fixtureItems(): { events: SessionEvent[]; items: IngestItem[] } {
  const p = new ClaudeSessionParser(SID);
  const events = readFileSync(join(FIX, "sess-a.jsonl"), "utf8").split("\n").flatMap((l) => p.push(l));
  return { events, items: [...events.map((event) => ({ type: "event" as const, event })), { type: "summary" as const, summary: p.summary() }] };
}

const hook = (event: string, ts: string, sessionId = SID): IngestItem => ({
  type: "event",
  event: { id: `hook:${event}:${ts}`, tool: "claude", sessionId, ts, kind: "hook", source: "hook", data: { event } },
});

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

describe("Ingest", () => {
  it("weist Anfragen ohne oder mit falschem Token ab", async () => {
    const t = await setup();
    const { items } = fixtureItems();
    expect((await t.post("/ingest/events", { items }, {})).status).toBe(401);
    expect((await t.post("/ingest/events", { items }, { authorization: "Bearer falsch" })).status).toBe(401);
    expect(await t.db.select().from(sessions)).toHaveLength(0);
  });

  it("weist ungültige Pakete mit 400 ab und schreibt nichts", async () => {
    const t = await setup();
    expect((await t.post("/ingest/events", { items: [{ type: "event", event: { id: "x" } }] })).status).toBe(400);
    const bad = await t.app.request("/ingest/events", { method: "POST", body: "{kaputt", headers: { ...t.auth, "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(await t.db.select().from(sessionEvents)).toHaveLength(0);
  });

  it("speichert Events und Zusammenfassung; doppeltes Senden erzeugt keine Duplikate", async () => {
    const t = await setup();
    const { events, items } = fixtureItems();
    const first = await t.post("/ingest/events", { items });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: events.length, duplicates: 0 });

    const again = await t.post("/ingest/events", { items });
    expect(await again.json()).toEqual({ accepted: 0, duplicates: events.length });

    const rows = await t.db.select().from(sessionEvents);
    expect(rows).toHaveLength(events.length);
    const [s] = await t.db.select().from(sessions).where(eq(sessions.sessionId, SID));
    expect(s).toMatchObject({
      id: `claude:${SID}`,
      tool: "claude",
      title: "Session-Liste bauen",
      eventCount: events.length,
      parsedEventCount: events.length,
      tokensTotal: 32534,
      cwd: "/Users/alex/projects",
      machineId: "m1",
    });
    expect(new Date(s?.startedAt ?? "").toISOString()).toBe("2026-09-24T10:00:00.000Z");
    expect(new Date(s?.lastActivityAt ?? "").toISOString()).toBe("2026-09-24T10:05:04.000Z");
    const files = await t.db.select().from(sessionFiles).where(eq(sessionFiles.sessionKey, `claude:${SID}`));
    expect(files.filter((f) => f.mode === "write").map((f) => f.path).sort()).toEqual([
      "/Users/alex/projects/memory.md",
      "/Users/alex/projects/tools/NyxOS/a.ts",
    ]);
  });

  it("zählt Events korrekt, wenn ein Paket nur teilweise neu ist (Wiederholung nach Abbruch)", async () => {
    const t = await setup();
    const { items } = fixtureItems();
    await t.post("/ingest/events", { items: items.slice(0, 5) });
    const res = await t.post("/ingest/events", { items: items.slice(3, 10) });
    expect(await res.json()).toEqual({ accepted: 5, duplicates: 2 });
    const [s] = await t.db.select().from(sessions);
    expect(s?.eventCount).toBe(10);
  });

  it("legt eine Session schon beim ersten Hook an und setzt den Status über SessionStart/SessionEnd", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hook("SessionStart", "2026-09-24T09:59:59.000Z")] });
    let [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("running");
    expect(s?.endedAt).toBeNull();

    await t.post("/ingest/events", { items: [hook("SessionEnd", "2026-09-24T11:00:00.000Z")] });
    [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(new Date(s?.endedAt ?? "").toISOString()).toBe("2026-09-24T11:00:00.000Z");

    // Ein verspätet zugestellter, älterer Start darf die beendete Session nicht wiederbeleben.
    await t.post("/ingest/events", { items: [hook("SessionStart", "2026-09-24T10:30:00.000Z")] });
    [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");

    // Ein neuerer Start (resume) schon.
    await t.post("/ingest/events", { items: [hook("SessionStart", "2026-09-24T12:00:00.000Z")] });
    [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("running");
    expect(s?.endedAt).toBeNull();
  });

  it("setzt beim Lebenszeichen 'läuft nicht mehr' das Ende auf die letzte Aktivität", async () => {
    const t = await setup();
    const { items } = fixtureItems();
    await t.post("/ingest/events", { items });
    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: "2026-09-24T12:00:00.000Z" } }],
    });
    const [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(new Date(s?.endedAt ?? "").toISOString()).toBe("2026-09-24T10:05:04.000Z");
  });
});

describe("Archiv", () => {
  const raw = Buffer.from('{"a":1}\n{"b":2}\n');
  const sha = createHash("sha256").update(raw).digest("hex");
  const headers = (over: Record<string, string> = {}) => ({
    authorization: "Bearer test-token-123",
    "x-nyxos-tool": "claude",
    "x-nyxos-session": SID,
    "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${SID}.jsonl`),
    "x-nyxos-sha256": sha,
    "x-nyxos-size": String(raw.length),
    ...over,
  });

  it("speichert eine gültige Datei atomar und vermerkt Prüfsumme und Größe", async () => {
    const t = await setup();
    const res = await t.app.request("/ingest/archive", { method: "POST", body: gzipSync(raw), headers: headers() });
    expect(res.status).toBe(200);
    const stored = join(t.archiveDir, "claude", "-Users-alex-projects", `${SID}.jsonl.${sha.slice(0, 16)}.gz`);
    expect(gunzipSync(readFileSync(stored)).equals(raw)).toBe(true);
    const list = (await (await t.app.request("/api/archive")).json()) as { files: { sha256: string; size: number }[] };
    expect(list.files).toEqual([expect.objectContaining({ sha256: sha, size: raw.length })]);
    expect(readdirSync(join(t.archiveDir, ".tmp"))).toEqual([]);
  });

  it("hält Datei und DB-Zeile bei einer neuen Fassung immer stimmig und räumt die alte Fassung weg", async () => {
    const t = await setup();
    const v2 = Buffer.concat([raw, Buffer.from('{"c":3}\n')]);
    const sha2 = createHash("sha256").update(v2).digest("hex");
    await t.app.request("/ingest/archive", { method: "POST", body: gzipSync(raw), headers: headers() });
    const res = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gzipSync(v2),
      headers: headers({ "x-nyxos-sha256": sha2, "x-nyxos-size": String(v2.length) }),
    });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(archive);
    expect(row?.sha256).toBe(sha2);
    expect(createHash("sha256").update(gunzipSync(readFileSync(row?.storedPath ?? ""))).digest("hex")).toBe(sha2);
    const dir = join(t.archiveDir, "claude", "-Users-alex-projects");
    expect(readdirSync(dir)).toEqual([row?.storedPath.split("/").at(-1)]);
  });

  it("lehnt falsche Prüfsumme, falsche Größe und kaputtes gzip ab, ohne etwas abzulegen", async () => {
    const t = await setup();
    const cases = [
      { body: gzipSync(raw), headers: headers({ "x-nyxos-sha256": "b".repeat(64) }) },
      { body: gzipSync(raw), headers: headers({ "x-nyxos-size": "3" }) },
      { body: Buffer.from("kein gzip"), headers: headers() },
    ];
    for (const c of cases) {
      const res = await t.app.request("/ingest/archive", { method: "POST", body: c.body, headers: c.headers });
      expect(res.status).toBe(422);
    }
    expect(existsSync(join(t.archiveDir, "claude"))).toBe(false);
    expect(readdirSync(join(t.archiveDir, ".tmp"))).toEqual([]);
    expect((await (await t.app.request("/api/archive")).json()) as unknown).toEqual({ files: [] });
  });

  it("lehnt Pfade außerhalb des Archivs ab", async () => {
    const t = await setup();
    for (const path of ["../../etc/x", "/abs/x.jsonl", "a/../../b"]) {
      const res = await t.app.request("/ingest/archive", {
        method: "POST",
        body: gzipSync(raw),
        headers: headers({ "x-nyxos-path": encodeURIComponent(path) }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("verlangt ein Token", async () => {
    const t = await setup();
    const res = await t.app.request("/ingest/archive", { method: "POST", body: gzipSync(raw), headers: headers({ authorization: "" }) });
    expect(res.status).toBe(401);
  });
});

describe("Health", () => {
  it("meldet gesund, wenn DB und Archiv funktionieren", async () => {
    const t = await setup();
    const res = await t.app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: { database: { ok: boolean }; archive: { ok: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.archive.ok).toBe(true);
  });

  it("schlägt fehl (503), wenn die DB sofort einen Verbindungsfehler wirft", async () => {
    // `brokenDb` statt `t.client.close()` — ein geschlossener PGlite-Client hängt unter Last
    // (WASM), statt zu werfen, und blockiert dabei die Event-Loop, sodass selbst das Zeitlimit in
    // `checkHealth` nicht mehr greift (Livelock, s. helpers.ts). Die geteilte Instanz bleibt so
    // unangetastet — kein `isolated: true` mehr nötig.
    const t = await setup({ healthDb: brokenDb("reject") });
    const res = await t.app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { database: { ok: boolean; error?: string } } };
    expect(body.ok).toBe(false);
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.database.error).toBeTruthy();
  });

  it("schlägt fehl (503) mit 'Zeitüberschreitung', wenn die DB-Abfrage hängt", async () => {
    // hängende Abfrage (nie erfülltes Promise, blockiert NICHT die Event-Loop) statt eines
    // geschlossenen PGlite-Clients — bildet nach, wie ein Verbindungsverlust bei postgres-js in
    // Produktion ins eigene Zeitlimit läuft. Kurzes, per Option einstellbares Limit statt der echten
    // 3 s, damit der Test schnell bleibt.
    const t = await setup({ healthDb: brokenDb("hang"), healthCheckTimeoutMs: 50 });
    const start = Date.now();
    const res = await t.app.request("/health");
    expect(Date.now() - start).toBeLessThanOrEqual(3500);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { database: { ok: boolean; error?: string } } };
    expect(body.ok).toBe(false);
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.database.error).toContain("Zeitüberschreitung");
  });

  it("schlägt fehl (503), wenn das Archiv nicht beschreibbar ist", async () => {
    const t = await setup();
    chmodSync(t.archiveDir, 0o500);
    cleanup.push(() => chmodSync(t.archiveDir, 0o700));
    const res = await t.app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { archive: { ok: boolean }; database: { ok: boolean } } };
    expect(body.checks.archive.ok).toBe(false);
    expect(body.checks.database.ok).toBe(true);
  });

  it("schlägt fehl (503), wenn das Archiv-Volume fehlt und an seiner Stelle eine Datei liegt", async () => {
    const t = await setup();
    rmSync(t.archiveDir, { recursive: true });
    writeFileSync(t.archiveDir, "keine mappe");
    cleanup.push(() => rmSync(t.archiveDir, { force: true }));
    expect((await t.app.request("/health")).status).toBe(503);
  });

  it("schlägt fehl (503), wenn das Schema fehlt", async () => {
    // eigene Instanz — dropt Tabellen, ein `TRUNCATE` stellt sie nicht wieder her (s. helpers.ts).
    const t = await setup({ isolated: true });
    // `archive` hat jetzt abhängige Tabellen (archive_digests, session_change_ops) → cascade.
    await t.client.exec("drop table session_events; drop table session_files; drop table archive cascade; drop table sessions cascade;");
    expect((await t.app.request("/health")).status).toBe(503);
  });

  it("schlägt fehl (503) mit 'schema: Migration … fehlt', wenn eine einzelne additive Migration fehlt", async () => {
    // Simuliert genau den Fall, der `docs/BETRIEB.md` (fälschlich: "aktuell keine 0004") entlarvt
    // hätte: die Basistabellen/älteren Migrationen sind da, NUR die Spalte aus einer bestimmten
    // Migration fehlt (hier `0004_rules_dimension`: `category_manual_art`) — Ingest/`/api/sessions`
    // würden damit 500 werfen, aber `database`+`archive` allein melden weiter "ok".
    // eigene Instanz — ändert das Schema, ein `TRUNCATE` stellt eine gedropte Spalte nicht wieder
    // her (s. helpers.ts).
    const t = await setup({ isolated: true });
    await t.client.exec("alter table sessions drop column category_manual_art");
    const res = await t.app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { schema: { ok: boolean; error?: string }; database: { ok: boolean }; archive: { ok: boolean } } };
    expect(body.ok).toBe(false);
    expect(body.checks.database.ok).toBe(true); // DB an sich ist erreichbar — nur das Schema hinkt hinterher
    expect(body.checks.archive.ok).toBe(true);
    expect(body.checks.schema.ok).toBe(false);
    expect(body.checks.schema.error).toContain("0004_rules_dimension");
  });

  it("meldet 'schema.ok: true', wenn alle bekannten Migrationen angewendet sind (Regression, alle 6)", async () => {
    const t = await setup();
    const res = await t.app.request("/health");
    const body = (await res.json()) as { checks: { schema: { ok: boolean; error?: string } } };
    expect(body.checks.schema).toMatchObject({ ok: true });
  });
});

describe("Lesen und Live", () => {
  it("liefert Liste und Detail", async () => {
    const t = await setup();
    const { items, events } = fixtureItems();
    await t.post("/ingest/events", { items });
    const list = (await (await t.app.request("/api/sessions")).json()) as { sessions: { id: string; title: string }[] };
    expect(list.sessions.map((s) => s.title)).toEqual(["Session-Liste bauen"]);
    const detail = (await (await t.app.request(`/api/sessions/${SID}`)).json()) as { events: unknown[]; files: unknown[] };
    expect(detail.events).toHaveLength(events.length);
    expect(detail.files.length).toBe(3);
    expect((await t.app.request("/api/sessions/gibtsnicht")).status).toBe(404);
  });

  it("schickt eine neue Session sofort über /live", async () => {
    const t = await setup();
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
    t.injectWebSocket(server);
    cleanup.push(() => server.close());
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const messages: { type: string; session?: { sessionId: string; status: string } }[] = [];
    await new Promise<void>((resolve) => {
      ws.onmessage = (m) => {
        messages.push(JSON.parse(String(m.data)));
        resolve();
      };
    });
    const got = new Promise<number>((resolve) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        messages.push(msg);
        if (msg.type === "session") resolve(performance.now());
      };
    });
    const sent = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/ingest/events`, {
      method: "POST",
      headers: { ...t.auth, "content-type": "application/json" },
      body: JSON.stringify({ items: [hook("SessionStart", "2026-09-24T09:59:59.000Z", "neu-1")] }),
    });
    expect(res.status).toBe(200);
    const arrived = await got;
    ws.close();
    expect(messages[0]?.type).toBe("hello");
    expect(messages.at(-1)?.session).toMatchObject({ sessionId: "neu-1", status: "running" });
    expect(arrived - sent).toBeLessThan(1000);
  });
});

describe("API-Umzug (E7)", () => {
  it("liefert unbekannte /api/*-Pfade als JSON-404", async () => {
    const res = await (await setup()).app.request("/api/unbekannt");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("liefert für eine echte Web-App-URL ohne Datei index.html (SPA-Rückfall)", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "nyxos-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>NyxOS</title>");
    const t = await setup({ webDir });
    const res = await t.app.request("/sessions/coding/nyxos/abc-123");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>NyxOS</title>");
    rmSync(webDir, { recursive: true, force: true });
  });

  it("liefert ohne webDir trotzdem ein sauberes 404 statt eines Absturzes", async () => {
    const res = await (await setup()).app.request("/irgendwas");
    expect(res.status).toBe(404);
  });

  it("/api/machines liefert nie den Token-Hash", async () => {
    const t = await setup();
    await t.db.insert(machines).values({ id: "m2", name: "server", tokenHash: "geheim-hash", lastSeenAt: "2026-09-24T09:00:00.000Z" });
    const res = await t.app.request("/api/machines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; lastSeenAt: string | null }[];
    const sorted = body.sort((a, b) => a.name.localeCompare(b.name));
    expect(sorted.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(sorted[0]?.lastSeenAt).toBeNull();
    expect(new Date(sorted[1]?.lastSeenAt ?? "").toISOString()).toBe("2026-09-24T09:00:00.000Z");
    for (const m of body) expect(m).not.toHaveProperty("tokenHash");
  });
});

describe("Session-Zustände", () => {
  // Zeiten relativ zu "jetzt" (nicht fest verdrahtet 2026-09-24): der Ticker-Test simuliert
  // "30 Min später" bewusst über den `now`-Parameter, alle anderen Fälle bleiben nah an der
  // echten Ingest-Zeit, damit die 30-Minuten-Ruhe-Schwelle unterwegs nichts verfälscht.
  const base = Date.now();
  const at = (minutesOffset: number) => new Date(base + minutesOffset * 60_000).toISOString();

  const hookAt = (event: string, minutesOffset: number, sessionId = SID, tool: "claude" | "codex" = "claude"): IngestItem => ({
    type: "event",
    event: { id: `hook:${event}:${minutesOffset}:${sessionId}`, tool, sessionId, ts: at(minutesOffset), kind: "hook", source: "hook", data: { event } },
  });
  const turnEvent = (kind: "turn_start" | "turn_end" | "turn_aborted", minutesOffset: number, sessionId = SID): IngestItem => ({
    type: "event",
    event: { id: `${kind}:${minutesOffset}:${sessionId}`, tool: "codex", sessionId, ts: at(minutesOffset), kind, source: "file", data: {} },
  });
  /** Datei-Event OHNE Hook (Datei-Wächter-Erkennung, z. B. Brücke ohne Hook-Freigabe/`pnpm probe`). */
  const fileEventAt = (
    kind: "prompt" | "assistant" | "tool_call" | "tool_result" | "system",
    minutesOffset: number,
    sessionId = SID,
  ): IngestItem => ({
    type: "event",
    event: { id: `file:${kind}:${minutesOffset}:${sessionId}`, tool: "claude", sessionId, ts: at(minutesOffset), kind, source: "file", data: {} },
  });

  it("Claude-Stop-Hook setzt 'wartet', ein neuer Prompt danach setzt 'läuft'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    let [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("running");

    await t.post("/ingest/events", { items: [hookAt("Stop", 1)] });
    [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("waiting");
    expect(s?.turnOpen).toBe(false);

    await t.post("/ingest/events", { items: [hookAt("UserPromptSubmit", 2)] });
    [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("running");
    expect(s?.turnOpen).toBe(true);
  });

  it("Claude-Notification-Hook (Freigabe-Frage) setzt ebenfalls 'wartet'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    await t.post("/ingest/events", { items: [hookAt("Notification", 1)] });
    const [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("waiting");
  });

  it("Codex: task_complete (turn_end) setzt 'wartet', task_started (turn_start) danach setzt 'läuft'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, "codex-1", "codex")] });
    await t.post("/ingest/events", { items: [turnEvent("turn_end", 1, "codex-1")] });
    let [s] = await t.db.select().from(sessions).where(eq(sessions.id, "codex:codex-1"));
    expect(s?.state).toBe("waiting");

    await t.post("/ingest/events", { items: [turnEvent("turn_start", 2, "codex-1")] });
    [s] = await t.db.select().from(sessions).where(eq(sessions.id, "codex:codex-1"));
    expect(s?.state).toBe("running");
  });

  it("abgestürzt: Prozess weg ohne SessionEnd bei offener Runde", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: at(10) } }],
    });
    const [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(s?.state).toBe("crashed");
  });

  it("Live-Pfad: Session ganz ohne Runden-Signal (Brücke ohne Hooks) — letztes inhaltliches Datei-Event bestimmt, kein Absturz", async () => {
    const t = await setup();
    // Nur Datei-Events, nie ein Hook (Brücke ohne Hook-Freigabe / `pnpm probe`): turn_observed_at
    // bleibt ohne den Live-Fix für immer null, turn_open beim Vorgabewert `true` stehen.
    await t.post("/ingest/events", { items: [fileEventAt("prompt", 0)] });
    await t.post("/ingest/events", { items: [fileEventAt("assistant", 1)] });
    await t.post("/ingest/events", { items: [fileEventAt("system", 2)] }); // z. B. turn_duration — kein Runden-Signal
    let [s] = await t.db.select().from(sessions);
    expect(s?.turnOpen).toBe(false); // letztes inhaltliches Event war "assistant" → Runde zu

    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: at(10) } }],
    });
    [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(s?.state).toBeNull(); // sauber beendet — NICHT "crashed"
  });

  it("beendet MIT SessionEnd-Hook ist kein Absturz (kein Laufzeit-Zustand)", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 10)] });
    const [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(s?.state).toBeNull();
  });

  it("beendet MIT abgeschlossener Runde (Stop kam noch durch) ist kein Absturz", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 5)] });
    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: at(10) } }],
    });
    const [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(s?.state).toBeNull();
  });

  it("Wettlauf: ein gleichzeitiger Ingest beendet die Session zwischen Lesen und Schreiben — kein veraltetes 'ruht'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    const key = `claude:${SID}`;
    // So, wie der Ticker die Session vorfindet: "läuft", aber schon lange still (für "ruht" fällig).
    await t.db.update(sessions).set({ lastActivityAt: at(-31) }).where(eq(sessions.id, key));
    const [snapshot] = await selectRetickCandidates(t.db);
    if (!snapshot) throw new Error("Schnappschuss fehlt");
    expect(snapshot.state).toBe("running");

    // GENAU in der Lücke zwischen Lesen und Schreiben: ein gleichzeitiger Ingest beendet die Session sauber.
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 1)] });
    const [afterIngest] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(afterIngest?.state).toBeNull(); // sauber beendet laut Ingest

    // Der Ticker schreibt jetzt mit dem (inzwischen veralteten) Schnappschuss von oben — darf nicht mehr durchgehen.
    const wrote = await applyRetickUpdate(t.db, snapshot, "idle");
    expect(wrote).toBe(false);

    const [after] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(after?.state).toBeNull(); // weiterhin sauber beendet, NICHT von "idle" überschrieben
  });

  it("Wettlauf (lastActivityAt): 'lastActivityAt' rückt zwischen Lesen und Schreiben vor (z. B. durch einen lokalen Befehl), 'state' bleibt zufällig gleich — kein veraltetes 'ruht'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    const key = `claude:${SID}`;
    await t.db.update(sessions).set({ lastActivityAt: at(-31) }).where(eq(sessions.id, key));
    const [snapshot] = await selectRetickCandidates(t.db);
    if (!snapshot) throw new Error("Schnappschuss fehlt");
    expect(snapshot.state).toBe("running");

    // GENAU in der Lücke zwischen Lesen und Schreiben: ein Ereignis erneuert nur `lastActivityAt`
    // (simuliert einen lokalen Befehl, s. `parse/claude.ts` — zählt nicht als Runden-Inhalt,
    // ändert also weder `status` noch `state`, verschiebt aber die reine Aktivitätszeit nach vorn).
    await t.db.update(sessions).set({ lastActivityAt: at(0) }).where(eq(sessions.id, key));
    const [afterActivity] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(afterActivity?.state).toBe("running"); // `state` unverändert — der alte Vergleich allein sähe hier KEINEN Unterschied

    // Der Ticker schreibt jetzt mit dem (inzwischen bei `lastActivityAt` veralteten) Schnappschuss von
    // oben ein errechnetes "ruht" — darf nicht mehr durchgehen.
    const wrote = await applyRetickUpdate(t.db, snapshot, "idle");
    expect(wrote).toBe(false);

    const [after] = await t.db.select().from(sessions).where(eq(sessions.id, key));
    expect(after?.state).toBe("running"); // weiterhin "running", NICHT von "idle" überschrieben
  });

  it("ruht: der Server-Ticker erkennt 30 Min Stille ohne neues Ereignis und meldet den Wechsel live", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    let [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("running");

    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
    t.injectWebSocket(server);
    cleanup.push(() => server.close());
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    cleanup.push(() => ws.close());
    // FX: auf das „hello“ des Servers warten statt fester 20 ms — erst dann ist der Client im Live-Hub
    // eingetragen. Unter Last war die Verbindung nach 20 ms oft noch nicht so weit, der Wechsel ging ins
    // Leere und der Test lief ins Zeitlimit.
    let registered!: () => void;
    const hello = new Promise<void>((r) => (registered = r));
    const got = new Promise<{ type: string; session?: { state: string | null } }>((resolve) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; session?: { state: string | null } };
        if (msg.type === "hello") registered();
        if (msg.type === "session") resolve(msg);
      };
    });
    await hello;

    const changed = await t.tickStates(base + 30 * 60_000);
    expect(changed).toEqual([s?.id]);
    const msg = await got;
    expect(msg.session?.state).toBe("idle");

    [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("idle");
  });

  it("schließen hat Vorrang, egal welcher Zustand vorher galt; öffnen berechnet neu", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });
    await t.post("/ingest/events", { items: [hookAt("Stop", 1)] }); // wäre sonst "wartet"

    const close = await t.post(`/api/sessions/${SID}/close`, { by: "alex" });
    expect(close.status).toBe(200);
    let [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("closed");
    expect(s?.closedBy).toBe("alex");
    expect(s?.closedAt).toBeTruthy();

    const reopen = await t.post(`/api/sessions/${SID}/reopen`, {});
    expect(reopen.status).toBe(200);
    [s] = await t.db.select().from(sessions);
    expect(s?.closedAt).toBeNull();
    expect(s?.closedBy).toBeNull();
    expect(s?.state).toBe("waiting"); // Stop-Hook galt weiterhin als letztes Signal
  });

  it("schließen ohne 'by' ist 400, schließen/öffnen einer unbekannten Session ist 404", async () => {
    const t = await setup();
    expect((await t.post(`/api/sessions/${SID}/close`, {})).status).toBe(400);
    expect((await t.post(`/api/sessions/gibtsnicht/close`, { by: "alex" })).status).toBe(404);
    expect((await t.post(`/api/sessions/gibtsnicht/reopen`, {})).status).toBe(404);
  });

  it("Codex turn_aborted (Abbruch durch Alex) schließt die Runde wie task_complete", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0, "codex-2", "codex")] });
    let [s] = await t.db.select().from(sessions).where(eq(sessions.id, "codex:codex-2"));
    expect(s?.turnOpen).toBe(true);

    await t.post("/ingest/events", { items: [turnEvent("turn_aborted", 1, "codex-2")] });
    [s] = await t.db.select().from(sessions).where(eq(sessions.id, "codex:codex-2"));
    expect(s?.turnOpen).toBe(false);
    expect(s?.state).toBe("waiting");
  });

  // /exit → resume (SessionStart) → Prozess weg ohne neues SessionEnd bei
  // offener Runde muss "abgestürzt" ergeben, auch wenn VOR dem Resume schon ein sauberes SessionEnd kam.
  it("SessionStart nach SessionEnd (Resume) setzt session_end_received_at zurück — Absturz danach ohne neues SessionEnd wird erkannt", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] }); // /exit davor
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 1)] }); // sauber beendet
    let [s] = await t.db.select().from(sessions);
    expect(s?.state).toBeNull(); // kein Laufzeit-Zustand, sauber beendet

    await t.post("/ingest/events", { items: [hookAt("SessionStart", 2)] }); // Resume
    [s] = await t.db.select().from(sessions);
    expect(s?.sessionEndReceivedAt).toBeNull(); // zurückgesetzt

    // Prozess verschwindet (kill -9), ohne dass ein neues SessionEnd kommt.
    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: at(20) } }],
    });
    [s] = await t.db.select().from(sessions);
    expect(s?.status).toBe("ended");
    expect(s?.state).toBe("crashed"); // NICHT "beendet" (null) — das alte SessionEnd zählt nach dem Resume nicht mehr
  });

  // Ein SessionEnd, das verspätet ankommt (nachdem bereits ein "weg"-
  // Lebenszeichen der Brücke verarbeitet wurde), darf nicht vom Verspätungsschutz verschluckt werden.
  it("verspäteter SessionEnd nach 'weg'-Lebenszeichen setzt session_end_received_at trotzdem", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookAt("SessionStart", 0)] });

    // Die Brücke meldet zuerst (mit einer JÜNGEREN observedAt) den Prozess als weg — SessionEnd war
    // schon unterwegs, kam aber wegen Pufferung/Netz erst danach beim Server an.
    await t.post("/ingest/events", {
      items: [{ type: "state", state: { tool: "claude", sessionId: SID, running: false, observedAt: at(10) } }],
    });
    let [s] = await t.db.select().from(sessions);
    expect(s?.state).toBe("crashed"); // vorläufig: noch kein SessionEnd bekannt

    // Jetzt kommt das echte, aber ÄLTER datierte SessionEnd verspätet an.
    await t.post("/ingest/events", { items: [hookAt("SessionEnd", 5)] });
    [s] = await t.db.select().from(sessions);
    expect(s?.sessionEndReceivedAt).not.toBeNull();
    expect(s?.state).toBeNull(); // jetzt korrekt: sauber beendet, kein Absturz mehr
  });
});
