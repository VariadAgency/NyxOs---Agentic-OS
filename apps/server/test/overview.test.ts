import { describe, expect, it } from "vitest";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { upsertGitSnapshot } from "../src/git/store.js";
import { createEntry } from "../src/entries/store.js";
import { entries } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { sessions } from "../src/db/schema.js";
import { setup } from "./helpers.js";

describe("Überblick-Dashboard", () => {
  it("echte Kacheln zeigen echte Zahlen, auch „Max-Fenster“ und „Haiku heute“ (keine Platzhalter-Kachel mehr)", async () => {
    const { db } = await setup();
    await db.insert(sessions).values([
      { id: "claude:a", tool: "claude", sessionId: "a", state: "running", closedAt: null },
      { id: "claude:b", tool: "claude", sessionId: "b", state: "waiting", closedAt: null },
    ]);
    const snap = await getOverviewSnapshot(db, "Alex");
    const open = snap.metrics.find((m) => m.key === "sessions_open");
    expect(open?.value).toBe(2);
    expect(open?.placeholder).toBe(false);
    const waiting = snap.metrics.find((m) => m.key === "sessions_waiting");
    expect(waiting?.value).toBe(1);

    const tile = snap.metrics.find((m) => m.key === "max_window");
    expect(tile?.placeholder).toBe(false);
    expect(tile?.value).toBe(0);
    expect(tile?.format).toBe("tokens");

    // „Haiku heute" ist keine Platzhalter-Kachel mehr (Aufrufe/Tag aus `haiku_calls`).
    const haiku = snap.metrics.find((m) => m.key === "haiku_briefing");
    expect(haiku?.placeholder).toBe(false);
    expect(haiku?.value).toBe(0); // kein Haiku-Aufruf in diesem Test
    expect(haiku?.href).toBe("/briefing");

    expect(snap.metrics.every((m) => !m.placeholder)).toBe(true);
    expect(snap.metrics).toHaveLength(12);
    expect(snap.greetingName).toBe("Alex");
    expect(snap.counts).toMatchObject({ running: 1, waiting: 1 });
  });

  it("Integration: offene Fragen und kritische Audits sind echte Zählungen, keine Platzhalter mehr", async () => {
    const { db } = await setup();
    await createEntry(db, { kind: "frage", title: "Offene Frage 1", source: "manual" });
    const erledigteFrage = await createEntry(db, { kind: "frage", title: "Beantwortete Frage", source: "manual" });
    await db.update(entries).set({ stage: "erledigt" }).where(eq(entries.id, erledigteFrage.id));
    await createEntry(db, { kind: "audit", title: "Kritischer Fund", priority: "p0", source: "manual" });
    await createEntry(db, { kind: "audit", title: "Kleinerer Fund", priority: "p2", source: "manual" });

    const snap = await getOverviewSnapshot(db);
    // „Offene Fragen“ = was nur der Nutzer entscheidet (Freigaben, Entscheidungs-Karten,
    // Konflikt-Fragen) — Aufgaben-Einträge der Art „Frage“ stehen im Aufgaben-Tab, nicht hier.
    const questions = snap.metrics.find((m) => m.key === "open_questions");
    expect(questions?.placeholder).toBe(false);
    expect(questions?.value).toBe(0);
    expect(questions?.caption).toBe("Nichts zu entscheiden");
    const audits = snap.metrics.find((m) => m.key === "audits_critical");
    expect(audits?.placeholder).toBe(false);
    expect(audits?.value).toBe(1);
  });

  it("Integration: Baustellen-Fortschritt ist die gewichtete Teilaufgaben-Summe der Aufgaben/Bugs/Audits dieser Baustelle", async () => {
    const { db } = await setup();
    await db.insert(sessions).values({ id: "claude:d", tool: "claude", sessionId: "d", state: "running", closedAt: null, categoryBaustelleSlug: "nyxos", categoryBaustelleLabel: "NyxOS" });
    const bug = await createEntry(db, { kind: "bug", title: "Halber Bug", source: "manual", baustelleSlug: "nyxos", baustelleLabel: "NyxOS", subtasks: ["a", "b"] });
    await db.update(entries).set({ progressDoneWeight: 1, progressTotalWeight: 2 }).where(eq(entries.id, bug.id));
    // Eine Idee zählt NICHT für den Fortschritt (nur Arbeits-Arten, s. PROGRESS_KINDS).
    await createEntry(db, { kind: "idee", title: "Eine Idee", source: "manual", baustelleSlug: "nyxos", baustelleLabel: "NyxOS" });

    const snap = await getOverviewSnapshot(db);
    const baustelle = snap.baustellen.find((b) => b.slug === "nyxos");
    expect(baustelle?.progressPct).toBe(50);
  });

  it("jede Kachel trägt eine Route zur Quelle (Klick öffnet Quelle)", async () => {
    const { db } = await setup();
    const snap = await getOverviewSnapshot(db);
    for (const tile of snap.metrics) expect(tile.href.startsWith("/")).toBe(true);
  });

  it("Commits-Reihe hat immer genau 14 lückenlose Kalendertage, Trend = diese Woche vs. Vorwoche", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, {
      collectedAt: new Date().toISOString(),
      repos: [
        {
          repoId: "app",
          label: "App",
          kind: "app",
          root: "/x",
          currentBranch: "main",
          headSha: "abc",
          branches: [],
          uncommitted: [],
          recentCommits: [{ sha: "abc", authorDate: new Date().toISOString(), subject: "x", branch: "main" }],
          probeMerges: [],
          tags: [],
          scannedAt: new Date().toISOString(),
        },
      ],
    });
    const snap = await getOverviewSnapshot(db);
    expect(snap.commits).toHaveLength(14);
    expect(snap.commits.reduce((a, d) => a + d.human, 0)).toBe(1);
    expect(snap.commits.at(-1)?.human).toBe(1);
    const commits = snap.metrics.find((m) => m.key === "commits_7d");
    expect(commits?.trend).toMatchObject({ current: 1, previous: 0, upIsGood: true });
    expect(commits?.sparkline).toHaveLength(14);
  });

  it("abgestürzte Sessions erscheinen als kritische Sessions mit Sprung-Link", async () => {
    const { db } = await setup();
    await db.insert(sessions).values({ id: "claude:c", tool: "claude", sessionId: "c", state: "crashed", title: "kaputt" });
    const snap = await getOverviewSnapshot(db);
    expect(snap.criticalSessions).toHaveLength(1);
    expect(snap.criticalSessions[0]?.href).toContain("c");
  });

  it("wartende Sessions stehen mit Wartezeit in den kritischen Sessions, Kachel nennt die längste", async () => {
    const { db } = await setup();
    const now = new Date("2026-09-25T08:00:00.000Z");
    await db.insert(sessions).values({ id: "claude:w", tool: "claude", sessionId: "w", state: "waiting", lastActivityAt: "2026-09-25T07:15:00.000Z" });
    const snap = await getOverviewSnapshot(db, "Alex", now);
    expect(snap.criticalSessions[0]?.reason).toBe("wartet seit 45 min");
    const waiting = snap.metrics.find((m) => m.key === "sessions_waiting");
    expect(waiting?.caption).toBe("am längsten seit 45 min");
    expect(waiting?.captionTone).toBe("wait");
  });

  it("Max-Fenster zählt Claude-Tokens der letzten 5 Stunden aus usage_events", async () => {
    const { db, post } = await setup();
    const now = new Date();
    const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
    const row = (ts: string, tool: string, input: number) => ({ ts, tool, model: "claude-opus-5", project: "andere", sessionKey: null, input, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, reasoning: 0 });
    const res = await post("/ingest/usage", { items: [row(at(1), "claude", 1000), row(at(4), "claude", 500), row(at(7), "claude", 9000), row(at(1), "codex", 70)] });
    expect(res.status).toBe(200);
    const snap = await getOverviewSnapshot(db, "Alex", now);
    const tile = snap.metrics.find((m) => m.key === "max_window");
    expect(tile?.value).toBe(1500);
    expect(tile?.sparkline).toHaveLength(24);
    expect(tile?.sparkline.reduce((a, b) => a + b, 0)).toBe(10_500);
  });
});
