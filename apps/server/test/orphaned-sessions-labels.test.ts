// Verwaiste Geister-Sessions zählen nicht zu „wartet auf dich“,
// Sessions heißen überall gleich (`sessionLabel`), gleiche Sortier-Vorschläge zählen einmal und nicht rot.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { createInboxItem } from "../src/haiku/inbox.js";
import { resolveSource } from "../src/haiku/sources.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
import { isOrphaned } from "../src/state.js";
import { setup } from "./helpers.js";

const NOW = new Date("2026-09-26T01:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
type Row = typeof sessions.$inferInsert;
const waiting = (id: string, over: Partial<Row> = {}): Row => ({
  id: `claude:${id}`,
  tool: "claude",
  sessionId: id,
  machineId: "m1",
  status: "running",
  state: "waiting",
  turnOpen: false,
  startedAt: hoursAgo(30),
  lastActivityAt: hoursAgo(30),
  ...over,
});

describe("verwaiste Sessions", () => {
  it("state.ts nutzt die gemeinsame Regel", () => {
    const ghost = {
      state: "waiting",
      parsedEventCount: 0,
      tokensTotal: 0,
      lastActivityAt: hoursAgo(30),
    };
    expect(isOrphaned(ghost, NOW.getTime())).toBe(true);
    expect(isOrphaned({ ...ghost, lastActivityAt: hoursAgo(2) }, NOW.getTime())).toBe(false);
  });

  it("Geister-Session (> 1 Tag, ohne Nachrichten) zählt nicht als „wartet“, steht aber unter `orphaned`", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      waiting("geist", {
        title: null,
        cwd: null,
        parsedEventCount: 0,
        tokensTotal: 0,
      }),
      waiting("echt", {
        title: "Echte Frage",
        cwd: "/Users/alex/projects",
        parsedEventCount: 12,
        tokensTotal: 5000,
      }),
      waiting("frisch", {
        title: null,
        parsedEventCount: 0,
        tokensTotal: 0,
        startedAt: hoursAgo(2),
        lastActivityAt: hoursAgo(2),
      }),
    ]);
    const snap = await takeSnapshot(t.db, NOW);
    expect(snap.waiting.map((s) => s.id).sort()).toEqual(["claude:echt", "claude:frisch"]);
    expect(snap.orphaned.map((s) => s.id)).toEqual(["claude:geist"]);
    expect(snap.counts.waiting).toBe(2);
    expect(snap.lage).toContain("2 warten auf dich");
    expect(JSON.stringify(snap.needsYou)).not.toContain("claude:geist");
  });

  it("Nyx-Prüfwahrheit und Überblick zählen „wartet“ gleich; Titel schützt vor „verwaist“", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      waiting("geist", { title: null, parsedEventCount: 0, tokensTotal: 0 }),
      waiting("ohne-archiv", { title: "Baue den Build-Wächter", parsedEventCount: 0, tokensTotal: 0 }),
      waiting("ohne-zeit", { title: null, parsedEventCount: 0, tokensTotal: 0, startedAt: null, lastActivityAt: null }),
    ]);
    const snap = await takeSnapshot(t.db, NOW);
    expect(snap.orphaned.map((s) => s.id)).toEqual(["claude:geist"]);
    const { computeBenchTruth } = await import("../src/haiku/benchTruth.js");
    const { truths } = await computeBenchTruth(t.db, NOW);
    expect(truths.find((x) => x.id === "q01")?.answer).toBe(snap.counts.waiting);
    expect(snap.counts.waiting).toBe(2);
  });
});

describe("ein Name je Session", () => {
  it("Überblick/Briefing und Nyx-Quellen nutzen denselben Namen (Ordner + Startzeit statt Kennung)", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      waiting("ohne-titel", {
        title: null,
        cwd: "/Users/alex/projects/tools/NyxOS/.claude/worktrees/agent-x",
        parsedEventCount: 3,
        tokensTotal: 10,
        startedAt: "2026-09-24T18:02:00.000Z",
      }),
    ]);
    const snap = await takeSnapshot(t.db, NOW);
    const need = snap.needsYou.find((n) => n.id === "session:claude:ohne-titel");
    expect(need?.title).toBe("Wartet: NyxOS · Session vom 24.09., 20:02");
    const src = await resolveSource(t.db, "session", "claude:ohne-titel");
    expect(src?.label).toBe("NyxOS · Session vom 24.09., 20:02");
  });
});

describe("Sortier-Vorschläge", () => {
  it("zwei gleiche Vorschläge = EIN Eintrag unter „Braucht dich“, nicht in der roten Fragen-Zahl", async () => {
    const t = await setup();
    const yesNo = [
      { id: "ja", label: "Ja" },
      { id: "nein", label: "Nein" },
    ];
    for (const [key, fp] of [
      ["claude:a", "sort:claude:a:server"],
      ["claude:b", "sort:claude:b:server"],
    ] as const) {
      await createInboxItem(t.db, {
        kind: "frage",
        title: "Sortier-Vorschlag von Haiku: „Wie steht der Build?“ → Server & Deploy?",
        body: null,
        options: yesNo,
        sessionKey: key,
        sources: [],
        createdBy: "haiku",
        estimateMinutes: 1,
        fingerprint: fp,
      });
    }
    await createInboxItem(t.db, {
      kind: "frage",
      title: "Soll ich deployen?",
      body: null,
      options: yesNo,
      sessionKey: null,
      sources: [],
      createdBy: "session",
      estimateMinutes: 1,
      fingerprint: "echt",
    });
    const snap = await takeSnapshot(t.db, NOW);
    expect(snap.openQuestions.inbox).toBe(1);
    expect(snap.openQuestions.sorting).toBe(1);
    expect(snap.openQuestions.total).toBe(1);
    const sortNeeds = snap.needsYou.filter((n) => n.title.includes("Server & Deploy"));
    expect(sortNeeds).toHaveLength(1);
    expect(sortNeeds[0]?.title).toBe("2 Sessions nach „Server & Deploy“ sortieren?");
  });
});
