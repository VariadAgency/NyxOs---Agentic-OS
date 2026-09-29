// „Nyx fasst zusammen“ – Nyx liest den Verlauf einer Session und schreibt eine ausführliche, gegliederte
// Zusammenfassung. Gespeichert je Session mit Stand (bis zu welcher Nachricht); `GET` liefert die letzte und zählt
// neue Nachrichten seitdem. Budget/Zeitlimit/Fehler → ehrliche Meldung. Lange Verläufe: Anfang + Ende + Werkzeug-Übersicht.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { NyxSessionSummary, NyxSessionSummaryView, TranscriptItem } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { haikuCalls, sessions, sessionSummaries } from "../src/db/schema.js";
import { EngineTimeoutError, type EngineRequest } from "../src/haiku/engine.js";
import { RemoteEngine } from "../src/haiku/remoteEngine.js";
import { patchHaikuSettings } from "../src/haiku/settings.js";
import { ROUTE_PURPOSES } from "../src/nyx/appApi/catalog.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { checkSummaryFacts, summaryDigest } from "../src/session-summary/summary.js";
import { answer, FakeEngine, setupAssistant, TOKEN } from "./assistant/assistant-helpers.js";

const SID = "aaaaaaaa-0000-4000-8000-00000000a5a1";
const KEY = `claude:${SID}`;
const TECH = /tmux|CSRF|ENOENT|CLI|undefined|stack/i;

const SUMMARY_MD = [
  "## Ziel der Session",
  "Alex wollte die Chat-Eingabe mit Anhang.",
  "## Was erledigt wurde",
  "- Route in `apps/server/src/routes/session-chat.ts` gebaut",
  "- Tests zuerst geschrieben",
  "## Was gerade läuft",
  "Nichts – die Session wartet.",
  "## Offene Punkte und Fragen an Alex",
  "- Codex noch nicht geprüft",
  "## Nächster sinnvoller Schritt",
  "Codex-Sessions ausprobieren.",
].join("\n");

type T = Awaited<ReturnType<typeof setupAssistant>>;
const base = { isSidechain: false, cwd: "/home/alex/projects/atlas", sessionId: SID, version: "2.1.282" };
const userLine = (uuid: string, ts: string, text: string) => JSON.stringify({ ...base, type: "user", uuid, timestamp: ts, message: { role: "user", content: text } });
const botLine = (uuid: string, ts: string, text: string) =>
  JSON.stringify({ ...base, type: "assistant", uuid, timestamp: ts, message: { model: "claude-opus-5-5", id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text }] } });

const FIRST = [
  userLine("u-1", "2026-09-29T10:00:00.000Z", "Bau bitte die Chat-Eingabe mit Anhang in apps/server/src/routes/session-chat.ts"),
  botLine("u-2", "2026-09-29T10:00:03.000Z", "Ich baue die Route und schreibe Tests zuerst."),
];

async function ingest(t: T, lines: string[]) {
  const raw = Buffer.from(lines.join("\n") + "\n");
  const sha = createHash("sha256").update(raw).digest("hex");
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": SID,
      "x-nyxos-path": encodeURIComponent(`-Users-alex-projekt/${SID}.jsonl`),
      "x-nyxos-sha256": sha,
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
  await t.db.update(sessions).set({ title: "Chat-Eingabe bauen" }).where(eq(sessions.id, KEY));
}

async function view(t: T): Promise<NyxSessionSummaryView> {
  const res = await t.app.request(`/api/sessions/${KEY}/summary`);
  expect(res.status).toBe(200);
  return (await res.json()) as NyxSessionSummaryView;
}

async function waitDone(t: T): Promise<NyxSessionSummary> {
  for (let i = 0; i < 100; i++) {
    const s = (await view(t)).summary;
    if (s && s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zusammenfassung wurde nicht fertig: ${JSON.stringify((await view(t)).summary)}`);
}

describe("Nyx fasst zusammen (Route)", { timeout: 60_000 }, () => {
  it("erstellt, speichert mit Stand und zählt danach neue Nachrichten", async () => {
    const engine = new FakeEngine(answer(SUMMARY_MD));
    const t = await setupAssistant({ engine });
    await ingest(t, FIRST);
    const empty = await view(t);
    expect(empty.summary).toBeNull();
    expect(empty.engine.ready).toBe(true);

    const start = await t.json(`/api/sessions/${KEY}/summary`, {});
    expect(start.status).toBe(202);
    const s = await waitDone(t);
    expect(s.status).toBe("done");
    expect(s.text).toContain("## Ziel der Session");
    expect(s.text).toContain("`apps/server/src/routes/session-chat.ts`");
    expect(s.messagesCovered).toBe(2);
    expect(s.coveredUntil).toBeTruthy();
    expect(s.dropped).toBe(0);

    // Nyx hat wirklich den Verlauf gelesen und kennt die gewünschte Gliederung.
    const req = engine.requests[0] as EngineRequest;
    expect(req.prompt).toContain("Bau bitte die Chat-Eingabe mit Anhang");
    expect(req.prompt).toContain("Chat-Eingabe bauen");
    expect(req.systemPrompt).toMatch(/Nächster sinnvoller Schritt/);

    expect((await view(t)).newMessages).toBe(0);
    await ingest(t, [...FIRST, userLine("u-3", "2026-09-29T10:05:00.000Z", "Und jetzt Codex?"), botLine("u-4", "2026-09-29T10:05:04.000Z", "Ich schaue mir Codex an."), botLine("u-5", "2026-09-29T10:05:09.000Z", "Codex geht auch.")]);
    expect((await view(t)).newMessages).toBe(3);

    // Neu erstellen: neue Zeile, die alte bleibt (Verlauf), Stand wandert mit.
    expect((await t.json(`/api/sessions/${KEY}/summary`, {})).status).toBe(202);
    const again = await waitDone(t);
    expect(again.id).not.toBe(s.id);
    expect(again.messagesCovered).toBe(5);
    expect((await view(t)).newMessages).toBe(0);
    expect(await t.db.select().from(sessionSummaries).where(eq(sessionSummaries.sessionKey, KEY))).toHaveLength(2);
  });

  it("Tages-Budget erreicht → ehrlicher Satz mit Budget, kein Motor-Aufruf", async () => {
    const engine = new FakeEngine(answer(SUMMARY_MD));
    const t = await setupAssistant({ engine });
    await ingest(t, FIRST);
    await patchHaikuSettings(t.db, { dailyBudgetUsd: 0.01 });
    await t.db.insert(haikuCalls).values({ kind: "chat", engine: "claude-cli", status: "ok", costUsd: 0.02 });
    expect((await t.json(`/api/sessions/${KEY}/summary`, {})).status).toBe(202);
    const s = await waitDone(t);
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/Budget/);
    expect(s.error).not.toMatch(TECH);
    expect(engine.requests).toHaveLength(0);
  });

  it("Zeitlimit → ehrliche Meldung, dass es zu lange gedauert hat", async () => {
    const engine = new FakeEngine(async function* () {
      yield { type: "delta", text: "## Ziel" };
      throw new EngineTimeoutError(180_000);
    });
    const t = await setupAssistant({ engine });
    await ingest(t, FIRST);
    expect((await t.json(`/api/sessions/${KEY}/summary`, {})).status).toBe(202);
    const s = await waitDone(t);
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/zu lange/);
    expect(s.error).not.toMatch(TECH);
  });

  it("Motor nicht bereit → 409 mit Grund, nichts gespeichert", async () => {
    const t = await setupAssistant({ engine: new RemoteEngine({ tokenConfigured: false }) });
    await ingest(t, FIRST);
    const res = await t.json(`/api/sessions/${KEY}/summary`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).not.toMatch(TECH);
    expect(await t.db.select().from(sessionSummaries)).toHaveLength(0);
  });

  it("zu kurze/leere Antwort → Fehler mit einfachem Satz", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Kann ich nicht.")) });
    await ingest(t, FIRST);
    expect((await t.json(`/api/sessions/${KEY}/summary`, {})).status).toBe(202);
    const s = await waitDone(t);
    expect(s.status).toBe("error");
    expect(s.error).toBeTruthy();
    expect(s.error).not.toMatch(TECH);
  });

  it("zwei schnelle Klicks → nur ein Lauf", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const engine = new FakeEngine(async function* (req) {
      await gate;
      yield* answer(SUMMARY_MD)(req);
    });
    const t = await setupAssistant({ engine });
    await ingest(t, FIRST);
    const [a, b] = await Promise.all([t.json(`/api/sessions/${KEY}/summary`, {}), t.json(`/api/sessions/${KEY}/summary`, {})]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    release();
    expect((await waitDone(t)).status).toBe("done");
  });

  it("unbekannte Session → 404", async () => {
    const t = await setupAssistant();
    expect((await t.app.request("/api/sessions/claude:gibtsnicht/summary")).status).toBe(404);
  });
});

const item = (i: number, role: TranscriptItem["role"], extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id: `x:${i}`, ts: `2026-09-29T10:${String(i % 60).padStart(2, "0")}:00.000Z`, role, thinking: false, ...extra });

describe("Kürzung langer Verläufe", () => {
  it("kurz: alles drin, nichts ausgelassen", () => {
    const d = summaryDigest([item(1, "user", { text: "Hallo" }), item(2, "assistant", { text: "Hi" })], "Claude");
    expect(d.text).toContain("Hallo");
    expect(d.itemsRead).toBe(d.itemsTotal);
    expect(d.text).not.toMatch(/ausgelassen/);
  });

  it("lang: Anfang (Auftrag) + letzte Runden, Mitte sichtbar ausgelassen, Werkzeuge aus dem GANZEN Verlauf gezählt", () => {
    const items: TranscriptItem[] = [item(0, "user", { text: "AUFTRAG: Baue die Zusammenfassung" })];
    for (let i = 1; i < 400; i++) {
      items.push(item(i, "assistant", { text: `Schritt ${i}: ${"x".repeat(400)}` }));
      items.push(item(i, "tool", { tool: { name: i < 200 ? "Edit" : "Bash", target: i === 150 ? "git commit -m \"Mitte\"" : `datei-${i}.ts`, status: "ok" } }));
    }
    items.push(item(999, "assistant", { text: "LETZTE RUNDE: fertig" }));
    const d = summaryDigest(items, "Claude");
    expect(d.text).toContain("AUFTRAG: Baue die Zusammenfassung");
    expect(d.text).toContain("LETZTE RUNDE: fertig");
    expect(d.text).toMatch(/Einträge in der Mitte ausgelassen/);
    expect(d.itemsRead).toBeLessThan(d.itemsTotal);
    expect(d.text.length).toBeLessThan(60_000);
    // Werkzeug-Übersicht deckt auch die ausgelassene Mitte ab (Edit 199×, Commit aus der Mitte).
    expect(d.overview).toMatch(/Edit ×199/);
    expect(d.overview).toMatch(/Bash ×200/);
    expect(d.overview).toContain("Mitte");
  });
});

describe("Faktenprüfung", () => {
  const source = "Bau apps/server/src/routes/session-chat.ts · Commit 1a2b3c4 · 12 Tests grün";
  it("behält belegte Pfade/Commits/Zahlen, lässt erfundene Zeilen weg", () => {
    const md = ["## Erledigt", "- `apps/server/src/routes/session-chat.ts` gebaut", "- Commit 1a2b3c4, 12 Tests grün", "- `apps/web/src/Erfunden.tsx` angepasst", "- Commit deadbee9 gepusht", "- 4711 Zeilen geändert", "Das Ziel war die Chat-Eingabe (3 Schritte)."].join("\n");
    const r = checkSummaryFacts(md, source);
    expect(r.text).toContain("session-chat.ts` gebaut");
    expect(r.text).toContain("1a2b3c4");
    expect(r.text).toContain("(3 Schritte)");
    expect(r.text).not.toContain("Erfunden.tsx");
    expect(r.text).not.toContain("deadbee9");
    expect(r.text).not.toContain("4711");
    expect(r.dropped).toBe(3);
  });
});

describe("Nyx darf Zusammenfassungen erstellen und lesen (app_api)", () => {
  it("GET und POST sind direkt erlaubt und stehen im Katalog", () => {
    expect(classifyApiRequest("GET", "/api/sessions/claude:abc/summary").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/sessions/claude:abc/summary").access).toBe("direkt");
    expect(ROUTE_PURPOSES["POST /api/sessions/:id/summary"]).toBeTruthy();
    expect(ROUTE_PURPOSES["GET /api/sessions/:id/summary"]).toBeTruthy();
  });
});
