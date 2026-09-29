import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IngestItem, SearchResponse, SessionSummary, TranscriptItem, TranscriptResponse } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { searchDocs } from "../src/db/schema.js";
import { indexChatDocs, reindexSearch, sortSessionKeysForLocking } from "../src/search.js";
import { TranscriptCache } from "../src/transcript.js";
import { setup } from "./helpers.js";

/** Wirft beim Zwischenspeichern immer einen Fehler — simuliert einen Fehler bei der Such-Indizierung,
 * ohne dass Archiv-Ablage oder Ingest selbst betroffen sind. */
class ThrowingTranscriptCache extends TranscriptCache {
  override set(_key: string, _sha256: string, _items: TranscriptItem[]): void {
    throw new Error("absichtlicher Testfehler: Such-Indizierung");
  }
}

/**
 * Suche: Titel, erster Prompt, Dateipfade und Chat-Text, gegen den
 * Server aufgebaut — jeder Fall spielt echte `/ingest/events`-Items bzw. echte Archiv-Uploads ein,
 * damit dieselbe Indizierung geprüft wird, die auch beim echten Ingest läuft (kein direktes
 * Schreiben in `search_docs`, außer für die reine Dubletten-/Idempotenz-Kontrolle unten).
 */

type App = Awaited<ReturnType<typeof setup>>;

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: null,
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T10:00:00.000Z",
  models: [],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: null,
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});

const summaryItem = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });

const promptEvent = (sessionId: string, text: string, minutesOffset = 0, tool: "claude" | "codex" = "claude"): IngestItem => ({
  type: "event",
  event: { id: `prompt:${sessionId}:${minutesOffset}`, tool, sessionId, ts: new Date(Date.UTC(2026, 8, 24, 10, minutesOffset)).toISOString(), kind: "prompt", source: "file", data: { text } },
});

/** Lädt eine Datei als Archiv-Fassung hoch, wie es die Brücke tut (s. transcript.test.ts). */
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

function claudeLine(over: Record<string, unknown>) {
  return { type: "user", uuid: "u", timestamp: "2026-09-24T10:00:00.000Z", sessionId: "x", cwd: "/x", message: { role: "user", content: "…" }, ...over };
}

/** Baut eine minimale Claude-Hauptdatei: abwechselnd user/assistant, Text nach Vorgabe. */
function buildClaudeTranscript(sessionId: string, texts: { role: "user" | "assistant"; text: string }[]): Buffer {
  const lines = texts.map((t, i) =>
    t.role === "user"
      ? claudeLine({ uuid: `u${i}`, timestamp: `2026-09-24T10:00:${String(i).padStart(2, "0")}.000Z`, sessionId, message: { role: "user", content: t.text } })
      : {
          type: "assistant",
          uuid: `u${i}`,
          timestamp: `2026-09-24T10:00:${String(i).padStart(2, "0")}.000Z`,
          sessionId,
          message: { model: "claude-opus-5-5", id: `m${i}`, role: "assistant", content: [{ type: "text", text: t.text }] },
        },
  );
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function uploadClaudeChat(t: App, sessionId: string, texts: { role: "user" | "assistant"; text: string }[]) {
  await uploadArchive(t, { tool: "claude", sessionId, path: `-Users-alex-projects/${sessionId}.jsonl`, raw: buildClaudeTranscript(sessionId, texts) });
}

/** Baut eine minimale Codex-Rollout-Datei mit user/assistant-Nachrichten — über `event_msg` /
 * `item_completed` wie der echte Rollout (nicht über `response_item`, der wird vom Parser nur für
 * `fallbackPrompt` gelesen und erzeugt kein `SessionEvent`, s. `packages/shared/src/parse/codex.ts`). */
function buildCodexTranscript(texts: { role: "user" | "assistant"; text: string }[]): Buffer {
  const lines = texts.map((t, i) => ({
    timestamp: `2026-09-24T10:00:${String(i).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { id: `item-${i}`, type: t.role === "user" ? "UserMessage" : "AgentMessage", content: [{ type: "text", text: t.text }] },
    },
  }));
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function search(t: App, q: string, limit?: number): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q });
  if (limit !== undefined) qs.set("limit", String(limit));
  const res = await t.app.request(`/api/search?${qs.toString()}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

describe("Suche", () => {
  it("q unter 2 Zeichen (auch leer/nur Leerraum) liefert eine leere Liste, keinen Fehler", async () => {
    const t = await setup();
    expect((await search(t, "")).hits).toEqual([]);
    expect((await search(t, "a")).hits).toEqual([]);
    expect((await search(t, "  ")).hits).toEqual([]);
  });

  it("Titel-Treffer", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-titel", title: "Postgres 18 Migration" }))] });
    const { hits } = await search(t, "Migration");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ field: "title", sessionId: "s-titel", position: null });
    expect(hits[0]?.snippet).toContain("<mark>Migration</mark>");
  });

  it("Dateipfad-Treffer: exakter Teilpfad und Präfix treffen denselben Pfad", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-datei", filesWritten: ["apps/server/src/categorize.ts"] }))],
    });
    const exact = await search(t, "categorize.ts");
    expect(exact.hits).toHaveLength(1);
    expect(exact.hits[0]).toMatchObject({ field: "file", sessionId: "s-datei" });

    const prefix = await search(t, "categ");
    expect(prefix.hits).toHaveLength(1);
    expect(prefix.hits[0]).toMatchObject({ field: "file", sessionId: "s-datei" });

    // Ein unverwandter Pfad ohne dieses Segment trifft nicht.
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-anders", filesWritten: ["apps/web/src/App.tsx"] }))] });
    const noMatch = await search(t, "categorize.ts");
    expect(noMatch.hits.map((h) => h.sessionId)).toEqual(["s-datei"]);
  });

  it("Chat-Text-Treffer: korrekte position, Sprung per around trifft denselben Eintrag", async () => {
    const t = await setup();
    await uploadClaudeChat(t, "s-chat", [
      { role: "user", text: "Bitte prüfe die Konfiguration" },
      { role: "assistant", text: "Mache ich." },
      { role: "user", text: "Und bitte das Wort Frobnicator einbauen" },
      { role: "assistant", text: "Erledigt." },
    ]);
    const { hits } = await search(t, "Frobnicator");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ field: "chat", sessionId: "s-chat", position: 2 });
    expect(hits[0]?.snippet).toContain("<mark>Frobnicator</mark>");

    const around = await t.app.request(`/api/sessions/s-chat/transcript?around=${hits[0]?.position}&limit=2`);
    expect(around.status).toBe(200);
    const body = (await around.json()) as TranscriptResponse;
    expect(body.anchorIndex).toBeDefined();
    expect(body.items[body.anchorIndex as number]?.text).toContain("Frobnicator");
  });

  it("Codex-Session-Treffer", async () => {
    const t = await setup();
    const sessionId = "01a0c424-0000-7000-8000-00000000c0de";
    await uploadArchive(t, {
      tool: "codex",
      sessionId,
      path: `2026/09/24/rollout-2026-09-24T10-00-00-${sessionId}.jsonl`,
      raw: buildCodexTranscript([
        { role: "user", text: "Bitte den Reticulator prüfen" },
        { role: "assistant", text: "Reticulator geprüft, alles gut." },
      ]),
    });
    const { hits } = await search(t, "Reticulator");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.tool === "codex")).toBe(true);
    expect(hits.some((h) => h.field === "chat" && h.sessionId === sessionId)).toBe(true);
  });

  it("geschlossene Sessions sind eingeschlossen (closed: true)", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-zu", title: "Ruhender Ordnerbestand" }))] });
    const close = await t.post("/api/sessions/claude:s-zu/close", { by: "alex" });
    expect(close.status).toBe(200);
    const { hits } = await search(t, "Ordnerbestand");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.closed).toBe(true);
  });

  it("deutscher Wortstamm: 'Sortierung' findet Text mit 'sortiert'", async () => {
    const t = await setup();
    await uploadClaudeChat(t, "s-stamm", [
      { role: "user", text: "Wie ist der Stand?" },
      { role: "assistant", text: "Die Liste ist jetzt sortiert." },
    ]);
    const { hits } = await search(t, "Sortierung");
    expect(hits.some((h) => h.sessionId === "s-stamm" && h.field === "chat")).toBe(true);
  });

  it("Ranking: Titel > Prompt > Datei > Chat, bei Gleichstand jüngere Session zuerst", async () => {
    const t = await setup();
    // Eine Session mit dem Suchwort in allen vier Feldern.
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-rang", title: "Leuchtturm-Projekt", filesWritten: ["apps/server/leuchtturm.ts"], lastActivityAt: "2026-09-24T12:00:00.000Z" })),
        promptEvent("s-rang", "Bitte das Leuchtturm-Feature bauen"),
      ],
    });
    await uploadClaudeChat(t, "s-rang", [{ role: "user", text: "Reicht das Leuchtturm-Feature schon?" }]);

    const { hits } = await search(t, "Leuchtturm");
    expect(hits.length).toBeGreaterThanOrEqual(4);
    const fields = hits.filter((h) => h.sessionId === "s-rang").map((h) => h.field);
    expect(fields).toEqual(["title", "prompt", "file", "chat"]);
  });

  it("höchstens 3 Chat-Treffer je Session", async () => {
    const t = await setup();
    await uploadClaudeChat(t, "s-viele", [
      { role: "user", text: "Ginkgo eins" },
      { role: "assistant", text: "Ginkgo zwei" },
      { role: "user", text: "Ginkgo drei" },
      { role: "assistant", text: "Ginkgo vier" },
      { role: "user", text: "Ginkgo fünf" },
    ]);
    const { hits } = await search(t, "Ginkgo");
    const chatHits = hits.filter((h) => h.sessionId === "s-viele" && h.field === "chat");
    expect(chatHits).toHaveLength(3);
  });

  it("XSS-sicher: rohes HTML im Chat-Text landet nie ungeschützt im Snippet", async () => {
    const t = await setup();
    await uploadClaudeChat(t, "s-xss", [{ role: "user", text: "Payload <script>alert(1)</script> beschreibt den Sicherheitsfehler" }]);
    const { hits } = await search(t, "Sicherheitsfehler");
    expect(hits).toHaveLength(1);
    const snippet = hits[0]?.snippet ?? "";
    expect(snippet).not.toContain("<script>");
    expect(snippet).not.toContain("</script>");
    // Jedes '<' im Snippet gehört zu <mark> oder </mark> — sonst wäre rohes HTML durchgerutscht.
    const tags = snippet.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) expect(["<mark>", "</mark>"]).toContain(tag);
  });

  it("HTML-Escaping wirkt auch für Zeichen, die Postgres' ts_headline NICHT selbst als Tag erkennt und entfernt ('&', ungültige spitze Klammern)", async () => {
    // Regression/Härtungs-Check: `ts_headline` erkennt und entfernt wohlgeformte HTML-Tags wie
    // '<script>...</script>' schon von sich aus (Postgres-Eigenheit des Standard-Text-Parsers) — das
    // allein reicht aber NICHT als Beweis für die eigene `escapeHtml`-Absicherung in `markify`. Ein
    // rohes '&' bzw. eine spitze Klammer ohne gültige Tag-Form ('< 5', kein Tag-Muster) lässt
    // `ts_headline` unangetastet durch — hier MUSS die eigene Escaping-Funktion greifen.
    const t = await setup();
    await uploadClaudeChat(t, "s-amp", [{ role: "user", text: "Sicherheitsfehler gefunden: Cafés & Bars, dazu gilt 3 < 5 in der Regel" }]);
    const { hits } = await search(t, "Sicherheitsfehler");
    expect(hits).toHaveLength(1);
    const snippet = hits[0]?.snippet ?? "";
    expect(snippet).toContain("&amp;");
    expect(snippet).not.toContain("Cafés & Bars"); // rohes '&' wäre ein unescapter Treffer
    expect(snippet).toContain("&lt;");
    expect(snippet).not.toContain("3 < 5"); // rohes '<' wäre ein unescapter Treffer
  });

  it("inkrementelle Chat-Indizierung: neue Archiv-Fassung fügt nur die neuen Einträge hinzu, keine Dubletten", async () => {
    const t = await setup();
    await uploadArchive(t, {
      tool: "claude",
      sessionId: "s-wachsend",
      path: "-Users-alex-projects/s-wachsend.jsonl",
      raw: buildClaudeTranscript("s-wachsend", [
        { role: "user", text: "Marmelade eins" },
        { role: "assistant", text: "Marmelade zwei" },
      ]),
    });
    await uploadArchive(t, {
      tool: "claude",
      sessionId: "s-wachsend",
      path: "-Users-alex-projects/s-wachsend.jsonl",
      raw: buildClaudeTranscript("s-wachsend", [
        { role: "user", text: "Marmelade eins" },
        { role: "assistant", text: "Marmelade zwei" },
        { role: "user", text: "Marmelade drei" },
        { role: "assistant", text: "Marmelade vier" },
      ]),
    });
    const { hits } = await search(t, "Marmelade", 50);
    const chatHits = hits.filter((h) => h.sessionId === "s-wachsend" && h.field === "chat");
    expect(chatHits).toHaveLength(3); // Kappung auf 3 je Session — die Dublettenfreiheit prüfen wir unten direkt in der DB.
    const positions = chatHits.map((h) => h.position).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(new Set(positions).size).toBe(positions.length);

    const rows = await t.db.select().from(searchDocs).where(and(eq(searchDocs.sessionKey, "claude:s-wachsend"), eq(searchDocs.field, "chat")));
    expect(rows).toHaveLength(4); // vier Text-Einträge (Denken/Werkzeuge gibt es hier keine), keine Dublette
    expect(new Set(rows.map((r) => r.position)).size).toBe(4);
  });

  it("indexChatDocs läuft unter dem Advisory-Lock, mehrfache Aufrufe bleiben dublettenfrei (Regression)", async () => {
    // PGlite ist eine einzelne In-Prozess-Verbindung — ein echter Wettlauf zweier ECHTER Postgres-
    // Verbindungen lässt sich damit nicht herstellen (jeder Versuch mit `Promise.all` serialisiert
    // PGlite intern ohnehin, s. Bericht). Diese Regression prüft stattdessen, dass Lock+Transaktion
    // die normale, wiederholte Indizierung nicht kaputt machen: dreimal hintereinander derselbe Inhalt
    // → immer genau die erwarteten Zeilen, nie mehr.
    const t = await setup();
    await uploadArchive(t, {
      tool: "claude",
      sessionId: "s-wiederholt",
      path: "-Users-alex-projects/s-wiederholt.jsonl",
      raw: buildClaudeTranscript("s-wiederholt", [
        { role: "user", text: "Zylinderkopf eins" },
        { role: "assistant", text: "Zylinderkopf zwei" },
      ]),
    });
    const key = "claude:s-wiederholt";
    const cache = new TranscriptCache();
    await indexChatDocs(t.db, cache, key);
    await indexChatDocs(t.db, cache, key);
    await indexChatDocs(t.db, cache, key);

    const rows = await t.db.select().from(searchDocs).where(and(eq(searchDocs.sessionKey, key), eq(searchDocs.field, "chat")));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.position)).size).toBe(2);
  });

  it("ein Fehler bei der Such-Indizierung lässt den Archiv-Upload nicht scheitern (200, Fehler nur geloggt)", async () => {
    const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
    const t = await setup({ transcriptCache: new ThrowingTranscriptCache(), log: (msg, extra) => logs.push({ msg, extra }) });

    // uploadArchive() erwartet selbst schon Status 200 — das IST die Kernaussage dieses Tests: der
    // Upload (Datei + DB-Zeile) gelingt, obwohl die anschließende Such-Indizierung absichtlich wirft.
    await uploadArchive(t, {
      tool: "claude",
      sessionId: "s-index-fehler",
      path: "-Users-alex-projects/s-index-fehler.jsonl",
      raw: buildClaudeTranscript("s-index-fehler", [{ role: "user", text: "Hallo" }]),
    });

    expect(logs.some((l) => l.msg === "such-indizierung-fehlgeschlagen")).toBe(true);
    // Die Transaktion in indexChatDocs ist komplett zurückgerollt — kein halb geschriebener Chat-Index.
    const rows = await t.db.select().from(searchDocs).where(and(eq(searchDocs.sessionKey, "claude:s-index-fehler"), eq(searchDocs.field, "chat")));
    expect(rows).toHaveLength(0);
  });

  it("reindex-search ist idempotent und baut denselben Bestand erneut auf", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-re", title: "Kompass-Titel", filesWritten: ["a/kompass.ts"] }))] });
    await uploadClaudeChat(t, "s-re", [{ role: "user", text: "Kompass im Chat erwähnt" }]);

    const cache = new TranscriptCache();
    const first = await reindexSearch(t.db, cache);
    const second = await reindexSearch(t.db, cache);
    expect(second.byField).toEqual(first.byField);
    expect(first.byField.title).toBeGreaterThanOrEqual(1);
    expect(first.byField.file).toBeGreaterThanOrEqual(1);
    expect(first.byField.chat).toBeGreaterThanOrEqual(1);

    const { hits } = await search(t, "Kompass");
    expect(hits.some((h) => h.field === "title")).toBe(true);
    expect(hits.some((h) => h.field === "file")).toBe(true);
    expect(hits.some((h) => h.field === "chat")).toBe(true);
  });

  it("around zentriert die Seite um die Position und liefert einen gültigen anchorIndex auch am Rand", async () => {
    const t = await setup();
    await uploadClaudeChat(
      t,
      "s-rand",
      Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `Zeile ${i}` })),
    );
    // Anfang: position 0 mit limit 4 kann nicht 2 Einträge davor zeigen, muss aber trotzdem 0 enthalten.
    const start = await t.app.request("/api/sessions/s-rand/transcript?around=0&limit=4");
    const startBody = (await start.json()) as TranscriptResponse;
    expect(startBody.items[startBody.anchorIndex as number]?.text).toBe("Zeile 0");

    // Ende: die letzte Position (5) muss ebenfalls enthalten sein.
    const end = await t.app.request("/api/sessions/s-rand/transcript?around=5&limit=4");
    const endBody = (await end.json()) as TranscriptResponse;
    expect(endBody.items[endBody.anchorIndex as number]?.text).toBe("Zeile 5");

    // Position außerhalb des Verlaufs ist ein Fehler.
    const bad = await t.app.request("/api/sessions/s-rand/transcript?around=999");
    expect(bad.status).toBe(400);
  });
});

describe("Advisory-Locks in derselben Reihenfolge sperren (Deadlock-Schutz)", () => {
  // PGlite ist eine einzelne In-Prozess-Verbindung — ein echter Deadlock zweier ECHTER, gleichzeitiger
  // Postgres-Transaktionen lässt sich damit nicht herstellen (s. Kommentar oben). Geprüft wird
  // deshalb die Eigenschaft, die einen Deadlock unmöglich macht: JEDER Aufrufer sperrt dieselbe Menge von
  // Sessions IMMER in derselben (hier: lexikalischen) Reihenfolge — unabhängig davon, in welcher
  // Reihenfolge sie im Ingest-Batch vorkamen. Zwei Ingests mit vertauschter Session-Reihenfolge können
  // sich dann nie mehr über Kreuz sperren.
  it("liefert für dieselbe Menge IMMER dieselbe Reihenfolge, egal in welcher Reihenfolge die Schlüssel hereinkommen", () => {
    const a = sortSessionKeysForLocking(["claude:s-2", "claude:s-1", "codex:s-3"]);
    const b = sortSessionKeysForLocking(["codex:s-3", "claude:s-1", "claude:s-2"]); // dieselbe Menge, vertauscht
    expect(a).toEqual(b);
    expect(a).toEqual(["claude:s-1", "claude:s-2", "codex:s-3"]); // lexikalisch sortiert
  });

  it("entfernt Dubletten (ein Schlüssel wird nie zweimal in derselben Transaktion gesperrt)", () => {
    expect(sortSessionKeysForLocking(["claude:s-1", "claude:s-1", "claude:s-2"])).toEqual(["claude:s-1", "claude:s-2"]);
  });

  it("Ingest, das zwei Sessions in vertauschter Reihenfolge berührt, indiziert trotzdem beide vollständig", async () => {
    // Regression: die Sortierung selbst darf keine Session verlieren oder auslassen — ein Ingest mit
    // Events für s-b VOR s-a muss beide trotzdem (in sortierter Sperr-Reihenfolge: s-a vor s-b) fertig
    // indizieren.
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-b", title: "Zweite Session zuerst im Batch" })),
        summaryItem(summary({ sessionId: "s-a", title: "Erste Session zuletzt im Batch" })),
      ],
    });
    const { hits } = await search(t, "Session");
    const titles = new Set(hits.filter((h) => h.field === "title").map((h) => h.title));
    expect(titles).toEqual(new Set(["Zweite Session zuerst im Batch", "Erste Session zuletzt im Batch"]));
  });
});
