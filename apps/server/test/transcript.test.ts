import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { TranscriptItem, TranscriptResponse } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archive } from "../src/db/schema.js";
import { setup } from "./helpers.js";

// Für den Neuversuch-Test unten (Live-Absturz-Fund): lässt genau den NÄCHSTEN `createReadStream`-
// Aufruf eine nicht existierende Datei öffnen (simuliert den ersten, fehlschlagenden Lesevorgang
// deterministisch statt über echtes Timing), jeder andere Aufruf verhält sich normal. `vi.hoisted`,
// weil `vi.mock`-Fabriken vor allen Importen laufen.
const fsFailControl = vi.hoisted(() => ({ failNextRead: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (fsFailControl.failNextRead) {
        fsFailControl.failNextRead = false;
        return actual.createReadStream("/nyxos-test-datei-existiert-nicht.gz");
      }
      return actual.createReadStream(...args);
    },
  };
});

const FIX = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "claude");
const CODEX_FIX = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures", "codex");
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const CODEX_SID = "01a0c424-0000-7000-8000-00000000c0de";
const AGENT_ID = "a0000000000000001";

type App = Awaited<ReturnType<typeof setup>>;

/** Lädt eine Datei als Archiv-Fassung hoch, wie es die Brücke tut (s. server.test.ts). */
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
  return sha;
}

async function uploadClaudeSession(t: App) {
  const raw = readFileSync(join(FIX, "sess-a.jsonl"));
  await uploadArchive(t, { tool: "claude", sessionId: SID, path: `-Users-alex-projects/${SID}.jsonl`, raw });
  const subRaw = readFileSync(join(FIX, "sess-a", "subagents", `agent-${AGENT_ID}.jsonl`));
  await uploadArchive(t, { tool: "claude", sessionId: SID, path: `-Users-alex-projects/${SID}/subagents/agent-${AGENT_ID}.jsonl`, raw: subRaw });
}

async function uploadCodexSession(t: App) {
  const raw = readFileSync(join(CODEX_FIX, "rollout-2026-09-21T15-25-10-01a0c424-0000-7000-8000-00000000c0de.jsonl"));
  await uploadArchive(t, { tool: "codex", sessionId: CODEX_SID, path: `2026/09/21/rollout-2026-09-21T15-25-10-${CODEX_SID}.jsonl`, raw });
}

async function transcript(t: App, id: string, qs = ""): Promise<{ status: number; body: TranscriptResponse | { error: string } }> {
  const res = await t.app.request(`/api/sessions/${id}/transcript${qs}`);
  return { status: res.status, body: (await res.json()) as never };
}

describe("Chat-Verlauf", () => {
  it("404 bei unbekannter Session oder fehlendem Archiv", async () => {
    const t = await setup();
    expect((await transcript(t, "gibtsnicht")).status).toBe(404);

    // Session existiert (z. B. nur über Events bekannt), aber kein Archiv hochgeladen.
    await t.post("/ingest/events", {
      items: [{ type: "event", event: { id: "e1", tool: "claude", sessionId: "ohne-archiv", ts: "2026-09-24T10:00:00.000Z", kind: "hook", source: "hook", data: { event: "SessionStart" } } }],
    });
    expect((await transcript(t, "ohne-archiv")).status).toBe(404);
  });

  it("400 bei kaputtem Cursor, ungültiger direction und ungültigem limit", async () => {
    const t = await setup();
    await uploadClaudeSession(t);
    expect((await transcript(t, SID, "?cursor=nicht-base64!!!")).status).toBe(400);
    expect((await transcript(t, SID, "?direction=seitwaerts")).status).toBe(400);
    expect((await transcript(t, SID, "?limit=0")).status).toBe(400);
    expect((await transcript(t, SID, "?limit=abc")).status).toBe(400);
  });

  it("liefert per sessionId ODER tool:sessionId denselben Verlauf", async () => {
    const t = await setup();
    await uploadClaudeSession(t);
    const byBare = await transcript(t, SID, "?direction=forward&limit=500");
    const byKey = await transcript(t, `claude:${SID}`, "?direction=forward&limit=500");
    expect(byBare.status).toBe(200);
    expect(byBare.body).toEqual(byKey.body);
  });

  it("baut den Claude-Hauptverlauf: Denken fehlt, Werkzeug-Ergebnis als Status, Sub-Agent als Block", async () => {
    const t = await setup();
    await uploadClaudeSession(t);
    const { status, body } = await transcript(t, SID, "?direction=forward&limit=500");
    expect(status).toBe(200);
    const { items } = body as TranscriptResponse;

    // Kein Eintrag ist ein Denk-Block (kind "thinking" existiert im Rohmaterial: u-0003).
    expect(items.some((i) => i.role !== "user" && i.role !== "assistant" && i.role !== "tool" && i.role !== "subagent" && i.role !== "system")).toBe(false);
    for (const i of items) expect(i.thinking).toBe(false);

    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({ role: "user", text: "Baue bitte die Liste der Sessions und prüfe die Tests" });

    const read = items.find((i) => i.tool?.name === "Read");
    expect(read).toMatchObject({ role: "tool", tool: { name: "Read", target: "/Users/alex/projects/CLAUDE.md", status: "ok" } });
    // Das Werkzeug-Ergebnis (u-0005) ist KEIN eigener Eintrag.
    expect(items.filter((i) => i.tool?.name === "Read")).toHaveLength(1);

    const write = items.find((i) => i.tool?.name === "Write");
    expect(write?.tool?.status).toBe("ok");

    const sub = items.find((i) => i.role === "subagent");
    expect(sub?.subagent).toMatchObject({ id: AGENT_ID, title: "Parser prüfen", count: 2 });
    // Der Agent-Werkzeug-Aufruf selbst taucht nicht mehr als "tool"-Eintrag auf.
    expect(items.some((i) => i.tool?.name === "Agent")).toBe(false);

    expect(items.at(-1)).toMatchObject({ role: "assistant", text: "Zusammenfassung: …" });
  });

  it("kürzt das Werkzeug-Ziel auf 200 Zeichen, auch wenn der Parser 300 erlaubt", async () => {
    const t = await setup();
    const longPath = "/Users/alex/projects/" + "x".repeat(250) + ".ts";
    expect(longPath.length).toBeGreaterThan(200);
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-09-24T10:00:00.000Z", sessionId: "lang-1", cwd: "/x", message: { role: "user", content: "Start" } },
      {
        type: "assistant",
        uuid: "u2",
        timestamp: "2026-09-24T10:00:01.000Z",
        sessionId: "lang-1",
        message: { model: "claude-opus-5-5", id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: longPath } }] },
      },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await uploadArchive(t, { tool: "claude", sessionId: "lang-1", path: "-Users-alex-projects/lang-1.jsonl", raw });
    const { body } = await transcript(t, "lang-1", "?direction=forward");
    const { items } = body as TranscriptResponse;
    const tool = items.find((i) => i.role === "tool");
    expect(tool?.tool?.target?.length).toBeLessThanOrEqual(200);
    expect(tool?.tool?.status).toBeUndefined(); // kein Ergebnis in diesem Beispiel → kein Status
  });

  it("markiert ein fehlgeschlagenes Werkzeug-Ergebnis als status: 'error'", async () => {
    const t = await setup();
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-09-24T10:00:00.000Z", sessionId: "fehler-1", cwd: "/x", message: { role: "user", content: "Lösche bitte x" } },
      {
        type: "assistant",
        uuid: "u2",
        timestamp: "2026-09-24T10:00:01.000Z",
        sessionId: "fehler-1",
        message: { model: "claude-opus-5-5", id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/x/a.ts" } }] },
      },
      {
        type: "user",
        uuid: "u3",
        timestamp: "2026-09-24T10:00:02.000Z",
        sessionId: "fehler-1",
        message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: "Datei nicht gefunden", is_error: true }] },
      },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await uploadArchive(t, { tool: "claude", sessionId: "fehler-1", path: "-Users-alex-projects/fehler-1.jsonl", raw });
    const { body } = await transcript(t, "fehler-1", "?direction=forward");
    const { items } = body as TranscriptResponse;
    const tool = items.find((i) => i.role === "tool");
    expect(tool?.tool?.status).toBe("error");
    expect(items.filter((i) => i.role === "tool")).toHaveLength(1); // Ergebnis ist kein eigener Eintrag
  });

  it("baut den Codex-Verlauf: Denken fehlt, exitCode wird zu Status, Sub-Agent-Aktivität wird gezählt", async () => {
    const t = await setup();
    await uploadCodexSession(t);
    const { status, body } = await transcript(t, CODEX_SID, "?direction=forward&limit=500");
    expect(status).toBe(200);
    const { items } = body as TranscriptResponse;
    for (const i of items) expect(i.thinking).toBe(false);

    expect(items[0]).toMatchObject({ role: "user", text: "Prüfe bitte die Sitzungsdateien auf dem Mac" });
    expect(items[1]).toMatchObject({ role: "assistant", text: "Ich prüfe den Bestand." });

    const exec = items.find((i) => i.tool?.name === "exec_command");
    expect(exec?.tool).toMatchObject({ status: "ok", target: "sed -n '1,80p' memory.md" });

    const sub = items.find((i) => i.role === "subagent");
    expect(sub?.subagent).toMatchObject({ title: "audit_recovery", count: 1 });

    const compaction = items.find((i) => i.text === "Kontext komprimiert");
    expect(compaction).toBeTruthy();
    // "Kontext komprimiert" ist inhaltlich, kein Plumbing — bleibt sichtbar.
    expect(compaction?.internal).toBeFalsy();
    // task_started/task_complete/turn_aborted sind keine Chat-Inhalte.
    expect(items.some((i) => i.text?.includes("turn"))).toBe(false);
  });

  it("markiert reine Plumbing-Systemzeilen als `internal`, „Kontext komprimiert“ bleibt sichtbar", async () => {
    const t = await setup();
    const sid = "bbbbbbbb-0000-4000-8000-000000000002";
    const lines = [
      { type: "user", uuid: "u-1", timestamp: "2026-09-24T10:00:00.000Z", sessionId: sid, message: { role: "user", content: "Frage" } },
      { type: "assistant", uuid: "u-2", timestamp: "2026-09-24T10:00:01.000Z", sessionId: sid, message: { role: "assistant", content: "Antwort" } },
      { type: "system", uuid: "u-3", timestamp: "2026-09-24T10:00:02.000Z", sessionId: sid, subtype: "stop_hook_summary" },
      { type: "attachment", uuid: "u-4", timestamp: "2026-09-24T10:00:03.000Z", sessionId: sid, attachment: { type: "total_tokens_reminder" } },
      { type: "system", uuid: "u-5", timestamp: "2026-09-24T10:00:04.000Z", sessionId: sid, subtype: "compact_boundary" },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await uploadArchive(t, { tool: "claude", sessionId: sid, path: `-Users-alex-projects/${sid}.jsonl`, raw });

    const { status, body } = await transcript(t, sid, "?direction=forward&limit=500");
    expect(status).toBe(200);
    const { items } = body as TranscriptResponse;

    const stopHook = items.find((i) => i.text === "System: stop_hook_summary");
    expect(stopHook?.internal).toBe(true);
    const anhang = items.find((i) => i.text === "Anhang: total_tokens_reminder");
    expect(anhang?.internal).toBe(true);
    const kompaktiert = items.find((i) => i.text === "Kontext komprimiert");
    expect(kompaktiert?.internal).toBeFalsy();
    // Echte Nachrichten sind unberührt.
    expect(items.find((i) => i.role === "user")).toMatchObject({ text: "Frage" });
    expect(items.find((i) => i.role === "assistant")).toMatchObject({ text: "Antwort" });
  });

  it("?subagent=<id> liefert nur den Verlauf dieses Sub-Agenten", async () => {
    const t = await setup();
    await uploadClaudeSession(t);
    const { status, body } = await transcript(t, SID, `?subagent=${AGENT_ID}&direction=forward&limit=500`);
    expect(status).toBe(200);
    const { items } = body as TranscriptResponse;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ role: "user", text: "Prüfe die Parser-Tests" });
    expect(items[1]).toMatchObject({ role: "tool", tool: { name: "Write", status: "ok" } });

    expect((await transcript(t, SID, "?subagent=gibtsnicht")).status).toBe(404);
  });

  it("Seiten vor/zurück ergeben lückenlos alle Einträge genau einmal", async () => {
    const t = await setup();
    await uploadClaudeSession(t);
    const all = ((await transcript(t, SID, "?direction=forward&limit=500")).body as TranscriptResponse).items;
    expect(all.length).toBeGreaterThan(4);

    // Vorwärts in kleinen Seiten.
    const forwardPages: TranscriptItem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const qs = cursor ? `?direction=forward&limit=3&cursor=${encodeURIComponent(cursor)}` : "?direction=forward&limit=3";
      const page = ((await transcript(t, SID, qs)).body as TranscriptResponse);
      forwardPages.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(forwardPages.map((i) => i.id)).toEqual(all.map((i) => i.id));

    // Rückwärts ab dem Ende (Standard: kein cursor, direction=backward → Chat öffnet unten).
    const backwardPages: TranscriptItem[] = [];
    cursor = null;
    for (;;) {
      const qs = cursor ? `?direction=backward&limit=3&cursor=${encodeURIComponent(cursor)}` : "?direction=backward&limit=3";
      const page = ((await transcript(t, SID, qs)).body as TranscriptResponse);
      backwardPages.unshift(...page.items);
      if (!page.prevCursor) break;
      cursor = page.prevCursor;
    }
    expect(backwardPages.map((i) => i.id)).toEqual(all.map((i) => i.id));

    // Ohne cursor + direction=backward: die letzten n Einträge.
    const tail = ((await transcript(t, SID, "?direction=backward&limit=3")).body as TranscriptResponse).items;
    expect(tail.map((i) => i.id)).toEqual(all.slice(-3).map((i) => i.id));
  });

  it("Cursor bleibt gültig, wenn das Archiv seitdem gewachsen ist (laufende Session)", async () => {
    const t = await setup();
    const line = (i: number) => ({ type: "user", uuid: `u${i}`, timestamp: `2026-09-24T10:00:${String(i).padStart(2, "0")}.000Z`, sessionId: "wachsend-1", cwd: "/x", message: { role: "user", content: `Nachricht ${i}` } });
    const v1 = Buffer.from([line(1), line(2)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    await uploadArchive(t, { tool: "claude", sessionId: "wachsend-1", path: "-Users-alex-projects/wachsend-1.jsonl", raw: v1 });

    const first = ((await transcript(t, "wachsend-1", "?direction=forward&limit=1")).body as TranscriptResponse);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    // Neue Fassung: dieselbe Datei, zwei weitere Zeilen angehängt (neue Prüfsumme).
    const v2 = Buffer.from([line(1), line(2), line(3), line(4)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    await uploadArchive(t, { tool: "claude", sessionId: "wachsend-1", path: "-Users-alex-projects/wachsend-1.jsonl", raw: v2 });

    const next = ((await transcript(t, "wachsend-1", `?direction=forward&limit=500&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).body as TranscriptResponse);
    expect(next.items.map((i) => i.text)).toEqual(["Nachricht 2", "Nachricht 3", "Nachricht 4"]);
  });
});

// Echter Absturz: `readGzLines` (Streamend-Lesen) reichte einen
// Stream-Fehler (z. B. ENOENT, weil `recordArchive` die alte Datei-Fassung gelöscht hat, während
// eine Anfrage noch den alten `storedPath` aus der DB hielt) NICHT sauber weiter — `.pipe()` leitet
// Quell-Fehler nicht automatisch ans Ziel weiter, das unbehandelte `error`-Event riss den ganzen
// Node-Prozess mit. Diese Tests ersetzen die Datei zwischen DB-Lesen und Öffnen absichtlich (statt
// auf eine echte Zeitrennen-Bedingung zu hoffen) und prüfen: der Prozess bleibt am Leben, die
// Antwort ist entweder die neue Fassung (Neuversuch erfolgreich) oder ein sauberer 409 (beide
// Fassungen unlesbar) — nie ein Absturz.
describe("Robustheit: Archiv-Datei verschwindet/wird ersetzt während des Lesens (Live-Absturz-Fund)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function storedPathOf(t: App, sessionKey: string): Promise<string> {
    const [row] = await t.db.select({ storedPath: archive.storedPath }).from(archive).where(eq(archive.sessionKey, sessionKey));
    if (!row) throw new Error("kein Archiv-Eintrag");
    return row.storedPath;
  }

  /** Erzwingt einen Cache-Miss beim nächsten `/transcript`-Aufruf: das Hochladen selbst hat den
   * Verlauf schon (unter der echten Prüfsumme) im Cache abgelegt — ohne diese "fremde" Prüfsumme in
   * der DB würde die Anfrage nie wirklich von der Platte lesen, die Race also gar nicht erst prüfen. */
  async function forceCacheMiss(t: App, sessionKey: string): Promise<void> {
    await t.db.update(archive).set({ sha256: "f".repeat(64) }).where(eq(archive.sessionKey, sessionKey));
  }

  it("Datei verschwindet spurlos (auch der Neuversuch findet nichts Lesbares) → sauberer 409, kein Absturz, Server bleibt bedienbar", async () => {
    const t = await setup();
    const raw = Buffer.from('{"type":"user","uuid":"u1","timestamp":"2026-09-24T10:00:00.000Z","sessionId":"weg-1","cwd":"/x","message":{"role":"user","content":"Hallo"}}\n');
    await uploadArchive(t, { tool: "claude", sessionId: "weg-1", path: "-Users-alex-projects/weg-1.jsonl", raw });
    await forceCacheMiss(t, "claude:weg-1");

    const storedPath = await storedPathOf(t, "claude:weg-1");
    rmSync(storedPath, { force: true }); // simuliert: Datei zwischen DB-Lesen und Öffnen gelöscht

    const res = await t.app.request("/api/sessions/weg-1/transcript?direction=forward&limit=500");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });

    // Prozess lebt: eine ganz normale Folgeanfrage (andere Session) funktioniert weiterhin.
    const health = await t.app.request("/health");
    expect(health.status).toBe(200);
  });

  it("erster Lesevorgang schlägt fehl (alte Fassung weg), der Neuversuch mit der frischen DB-Zeile liefert den Verlauf — kein Absturz", async () => {
    const t = await setup();
    const raw = Buffer.from('{"type":"user","uuid":"u1","timestamp":"2026-09-24T10:00:00.000Z","sessionId":"retry-1","cwd":"/x","message":{"role":"user","content":"Klappt beim zweiten Mal"}}\n');
    await uploadArchive(t, { tool: "claude", sessionId: "retry-1", path: "-Users-alex-projects/retry-1.jsonl", raw });
    await forceCacheMiss(t, "claude:retry-1");

    // Simuliert die eigentliche Race deterministisch (statt auf echtes Timing zu hoffen, s.
    // Auftrag): der ERSTE `createReadStream`-Aufruf liest eine Datei, die es nicht gibt (wie die
    // gerade gelöschte alte Archiv-Fassung), der zweite (der Neuversuch) verhält sich normal.
    fsFailControl.failNextRead = true;

    const res = await t.app.request("/api/sessions/retry-1/transcript?direction=forward&limit=500");
    expect(res.status).toBe(200);
    expect(fsFailControl.failNextRead).toBe(false); // der präparierte erste Fehlschlag wurde auch verbraucht
    const body = (await res.json()) as TranscriptResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ role: "user", text: "Klappt beim zweiten Mal" });

    const health = await t.app.request("/health");
    expect(health.status).toBe(200);
  });

  it("kaputtes gzip (mitten im Schreiben gelesen) crasht nicht — sauberer 409 statt Absturz", async () => {
    const t = await setup();
    const raw = Buffer.from('{"type":"user","uuid":"u1","timestamp":"2026-09-24T10:00:00.000Z","sessionId":"kaputt-1","cwd":"/x","message":{"role":"user","content":"Hallo"}}\n');
    await uploadArchive(t, { tool: "claude", sessionId: "kaputt-1", path: "-Users-alex-projects/kaputt-1.jsonl", raw });
    await forceCacheMiss(t, "claude:kaputt-1");

    const storedPath = await storedPathOf(t, "claude:kaputt-1");
    writeFileSync(storedPath, Buffer.from("das ist kein gzip mehr")); // Inhalt kaputt, Prüfsumme in der DB unverändert

    const res = await t.app.request("/api/sessions/kaputt-1/transcript?direction=forward&limit=500");
    expect(res.status).toBe(409);

    const health = await t.app.request("/health");
    expect(health.status).toBe(200);
  });
});
