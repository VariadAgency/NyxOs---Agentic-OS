// Start-Kette (Reife → Worktree → Opus + Leitplanken), Antwort aus Regeln mit geprüftem Zitat,
// unbelegte Frage → Inbox, Ideen-Ablage über die Einträge, offene Eintrags-Fragen in der Inbox, Sortier-Vorschlag.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entries, inboxItems, sessions } from "../../src/db/schema.js";
import { createEntry } from "../../src/entries/store.js";
import { handleQuestion, isYesNoQuestion, startAuftrag, suggestSorting, type AuftragDeps } from "../../src/haiku/auftrag.js";
import { EntriesIdeaRepo, syncEntryQuestions } from "../../src/haiku/entriesBridge.js";
import type { BridgeHub } from "../../src/terminal/bridgeHub.js";
import { answer, FakeEngine, setupAssistant } from "./assistant-helpers.js";
import type { WorktreeAddResult } from "@nyxos/shared";
import type { StartPlan } from "../../src/entries/start.js";

class FakeBridge {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  async rpc(method: string, params: unknown) {
    this.calls.push({ method, params: params as Record<string, unknown> });
    if (method === "start") return { ok: true, result: { tmuxName: "zc-claude-abcd1234", tool: "claude", sessionId: "11111111-2222-4333-8444-555555555555", startedMs: 12 } };
    return { ok: true, result: { sent: true } };
  }
}

async function deps(t: Awaited<ReturnType<typeof setupAssistant>>, bridge: FakeBridge, extra: Partial<AuftragDeps> = {}): Promise<AuftragDeps> {
  // Worktree in einem Temp-Ordner – wie die Brücke unter `<repo>/.worktrees/<slug>`.
  const repo = mkdtempSync(join(tmpdir(), "assistant-home-"));
  const addWorktree = (plan: StartPlan): WorktreeAddResult => {
    const worktreePath = join(repo, ".worktrees", plan.slug);
    mkdirSync(worktreePath, { recursive: true });
    return { repoRoot: repo, worktreePath, branch: plan.branch };
  };
  return { db: t.db, runtime: t.runtime, bridgeHub: bridge as unknown as BridgeHub, notify: () => {}, addWorktree, ...extra };
}

describe("Start-Kette „Starte T-01“", () => {
  it("nicht startklar → kein Start, Grund genannt; startklar → Worktree + Opus mit /goal + Leitplanken, Stufe „Läuft“", async () => {
    const t = await setupAssistant();
    const bridge = new FakeBridge();
    const d = await deps(t, bridge);
    const unready = await createEntry(t.db, { kind: "aufgabe", title: "Ohne Bereich", description: "x", source: "api" });
    const r0 = await startAuftrag(d, unready.id);
    expect(r0.ok).toBe(false);
    expect(r0.steps[0]).toMatchObject({ step: "reife", ok: false });
    expect(r0.steps[0]?.detail).toMatch(/Dateibereich/);
    expect(bridge.calls).toHaveLength(0);

    const e = await createEntry(t.db, { kind: "aufgabe", title: "T-01 Testauftrag", description: "Ziel und Abnahme: Datei anlegen.", fileScope: ["docs/t01/"], source: "api" });
    const { eq } = await import("drizzle-orm");
    await t.db.update(entries).set({ estimate: "30 Min" }).where(eq(entries.id, e.id));
    const r = await startAuftrag(d, e.id);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["reife", "reservierung", "worktree", "worktree", "start", "eintrag"]);
    expect(r.worktree).toContain("assistant-home-");
    expect(readFileSync(join(r.worktree ?? "", `.nyxos/tasks/E${e.id}/GOAL.md`), "utf8")).toContain("Ziel und Abnahme");
    const start = bridge.calls.find((c) => c.method === "start")?.params ?? {};
    expect(start).toMatchObject({ tool: "claude", model: "claude-opus-5-5", auftrag: { id: `E${e.id}` } });
    expect(String(start.prompt)).toMatch(/^\/goal /);
    expect(r.sessionKey).toBe("claude:11111111-2222-4333-8444-555555555555");
    const [row] = await t.db.select().from(entries).where((await import("drizzle-orm")).eq(entries.id, e.id));
    expect(row).toMatchObject({ stage: "laeuft", tmuxName: "zc-claude-abcd1234" });
  });

  it("Dateibereich mit aktiver Reservierung überlappt → kein Start, Grund genannt", async () => {
    const t = await setupAssistant();
    const bridge = new FakeBridge();
    const d = await deps(t, bridge);
    const { reserveArea } = await import("../../src/conflicts/store.js");
    await reserveArea(t.db, { pathGlob: "docs/t01/*", label: "Fremde Session" });
    const e = await createEntry(t.db, { kind: "aufgabe", title: "T-01 Testauftrag", description: "Ziel und Abnahme: Datei anlegen.", fileScope: ["docs/t01/"], source: "api" });
    const { eq } = await import("drizzle-orm");
    await t.db.update(entries).set({ estimate: "30 Min" }).where(eq(entries.id, e.id));
    const r = await startAuftrag(d, e.id);
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(["reife", "reservierung"]);
    expect(r.steps[1]).toMatchObject({ step: "reservierung", ok: false });
    expect(r.steps[1]?.detail).toMatch(/Fremde Session/);
    expect(bridge.calls).toHaveLength(0);
  });
});

describe("Frage aus Regeln", () => {
  function worktree() {
    const wt = mkdtempSync(join(tmpdir(), "assistant-wt-"));
    mkdirSync(join(wt, "auftraege", "T-01"), { recursive: true });
    writeFileSync(join(wt, "auftraege", "T-01", "GOAL.md"), "# T-01\n## ZIEL\nDatei anlegen\n## ABNAHME\n1. Datei da\n");
    writeFileSync(join(wt, "auftraege", "T-01", "ENTSCHEIDUNGEN.md"), "# Entscheidungen\n\n## E1 · Dateiname\nDie Testdatei heißt immer docs/t01/ergebnis.txt und enthält genau eine Zeile.\n");
    return wt;
  }

  it("belegte Antwort (Zitat steht wörtlich in ENTSCHEIDUNGEN.md) → in die Session geschrieben, mit Quelle", async () => {
    const engine = new FakeEngine(answer(JSON.stringify({ belegt: true, antwort: "docs/t01/ergebnis.txt", datei: "auftraege/T-01/ENTSCHEIDUNGEN.md", zitat: "Die Testdatei heißt immer docs/t01/ergebnis.txt", eskalation: null })));
    const t = await setupAssistant({ engine });
    const bridge = new FakeBridge();
    const e = await createEntry(t.db, { kind: "aufgabe", title: "T-01", description: "x", source: "api" });
    // Zustellung über die Warteschlange — die Arbeiter-Session wartet (hat ja gefragt).
    await t.db.insert(sessions).values({ id: "claude:w", tool: "claude", sessionId: "w", status: "running", state: "waiting", attachable: true, tmuxName: "zc-claude-abcd1234", models: ["opus"] });
    const r = await handleQuestion(await deps(t, bridge), { entryId: e.id, sessionKey: "claude:w", tmuxName: "zc-claude-abcd1234", worktree: worktree(), goal: "auftraege/T-01/GOAL.md", phase: "arbeiter" }, "Wie soll die Testdatei heißen?");
    expect(r).toMatchObject({ answered: true, inboxId: null, source: "auftraege/T-01/ENTSCHEIDUNGEN.md" });
    const sent = bridge.calls.find((c) => c.method === "send_text")?.params;
    expect(sent).toMatchObject({ onlyWhenWaiting: true, hookWaiting: true });
    expect(String(sent?.text)).toContain("belegt in auftraege/T-01/ENTSCHEIDUNGEN.md");
    expect(sent?.tmuxName).toBe("zc-claude-abcd1234");
  });

  it("erfundenes Zitat oder nicht belegt → Inbox (mit ENTSCHEIDUNGEN.md als Ziel), nichts an die Session", async () => {
    const engine = new FakeEngine(answer(JSON.stringify({ belegt: true, antwort: "blau", datei: "auftraege/T-01/ENTSCHEIDUNGEN.md", zitat: "Die Farbe des Knopfes ist immer blau", eskalation: null })));
    const t = await setupAssistant({ engine });
    const bridge = new FakeBridge();
    const e = await createEntry(t.db, { kind: "aufgabe", title: "T-01", description: "x", source: "api" });
    const wt = worktree();
    const r = await handleQuestion(await deps(t, bridge, { projectRoot: tmpdir() }), { entryId: e.id, sessionKey: "claude:w", tmuxName: "zc-claude-abcd1234", worktree: wt, goal: "auftraege/T-01/GOAL.md", phase: "arbeiter" }, "Welche Farbe soll der Knopf haben?");
    expect(r.answered).toBe(false);
    expect(bridge.calls.filter((c) => c.method === "send_text")).toHaveLength(0);
    const [item] = await t.db.select().from(inboxItems);
    expect(item).toMatchObject({ kind: "frage", sessionKey: "claude:w", entryId: e.id });
    expect(item?.decisionFile).toMatch(/auftraege\/T-01\/ENTSCHEIDUNGEN\.md$/);
  });

  it("Eskalationsfall geht immer an Alex, auch wenn belegt", async () => {
    const engine = new FakeEngine(answer(JSON.stringify({ belegt: true, antwort: "ja", datei: "auftraege/T-01/ENTSCHEIDUNGEN.md", zitat: "Die Testdatei heißt immer docs/t01/ergebnis.txt", eskalation: "datenverlust" })));
    const t = await setupAssistant({ engine });
    const e = await createEntry(t.db, { kind: "aufgabe", title: "T-01", description: "x", source: "api" });
    const r = await handleQuestion(await deps(t, new FakeBridge()), { entryId: e.id, sessionKey: "claude:w", tmuxName: "zc-x", worktree: worktree(), goal: "auftraege/T-01/GOAL.md", phase: "arbeiter" }, "Darf ich die Tabelle löschen?");
    expect(r.answered).toBe(false);
    const [item] = await t.db.select().from(inboxItems);
    expect(item).toMatchObject({ kind: "eskalation", escalation: "datenverlust" });
  });
});

describe("Ja/Nein-Erkennung", () => {
  it("nur echte Entscheidungsfragen bekommen Ja/Nein", () => {
    expect(isYesNoQuestion("Welche Farbe soll das Logo der NyxOS bekommen?")).toBe(false);
    expect(isYesNoQuestion("Frage 1: Welchen Text soll die erste Zeile enthalten?")).toBe(false);
    expect(isYesNoQuestion("Soll ich die Tabelle umbenennen?")).toBe(true);
    expect(isYesNoQuestion("Darf T-01 englische Bezeichner nutzen?")).toBe(true);
  });
});

describe("Anschluss an die Einträge (Ideen, Fragen)", () => {
  it("Ideen-Ablage: suchen liefert nur Titel/Stand, anlegen mit Herkunft, doppelt → einmal", async () => {
    const t = await setupAssistant();
    const repo = new EntriesIdeaRepo(t.db);
    await createEntry(t.db, { kind: "idee", title: "Warteliste für volle Kurse", description: "geheime Details", source: "api" });
    const hits = await repo.search("Eine Warteliste wäre toll", 5);
    expect(hits).toEqual([{ title: "Warteliste für volle Kurse", stage: "Eingang", createdAt: expect.any(String) }]);
    // Rohe LIKE-Muster liefern nichts, die Beschreibung wird nicht durchsucht.
    expect(await repo.search("%%", 8)).toEqual([]);
    expect(await repo.search("__ %", 8)).toEqual([]);
    expect(await repo.search("geheime Details", 8)).toEqual([]);
    const a = await repo.create({ title: "Taxi-Knopf", description: "Taxi rufen", origin: "Link: Lena", sourceKey: "1:c:taxi" });
    const b = await repo.create({ title: "Taxi-Knopf", description: "Taxi rufen", origin: "Link: Lena", sourceKey: "1:c:taxi" });
    expect(a.id).toBe(b.id);
    const [row] = await t.db.select().from(entries).where((await import("drizzle-orm")).eq(entries.id, a.id));
    // Fremdtext ist sichtbar als „extern“ markiert, danach die Herkunft.
    expect(row?.description).toMatch(/^⚠ Extern \(Ideen-Link\).*\nHerkunft: Link: Lena/);
    expect(row?.stage).toBe("eingang");
  });

  it("offene Eintrags-Fragen erscheinen einmal in der Inbox; Sortier-Vorschlag als gekennzeichnete Ja/Nein-Karte", async () => {
    const engine = new FakeEngine(answer(JSON.stringify({ art: "recherche", grund: "Titel nennt Recherche" })));
    const t = await setupAssistant({ engine });
    await createEntry(t.db, { kind: "frage", title: "Soll T-01 englische Bezeichner nutzen?", description: "aus Session", source: "mcp" });
    expect(await syncEntryQuestions(t.db)).toBe(1);
    expect(await syncEntryQuestions(t.db)).toBe(0);
    await t.db.insert(sessions).values({ id: "claude:u1", tool: "claude", sessionId: "u1", title: "Recherche Tools für Nachtmodus", categoryArt: "unsortiert", lastActivityAt: new Date().toISOString() });
    const made = await suggestSorting(await deps(t, new FakeBridge()), [{ key: "recherche", label: "Recherche" }, { key: "coding", label: "Coding" }], 2);
    expect(made).toBe(1);
    const items = await t.db.select().from(inboxItems);
    const sort = items.find((i) => i.title.startsWith("Sortier-Vorschlag von Nyx"));
    expect(sort).toMatchObject({ yesNo: true, sessionKey: "claude:u1", createdBy: "haiku" });
    expect(sort?.body).toMatch(/Vorschlag von Nyx \(nicht aus Regeln\)/);
    // zweiter Rundgang: kein zweiter Vorschlag, kein zweiter Haiku-Aufruf
    expect(await suggestSorting(await deps(t, new FakeBridge()), [{ key: "recherche", label: "Recherche" }], 2)).toBe(0);
    expect(engine.requests).toHaveLength(1);
  });
});
