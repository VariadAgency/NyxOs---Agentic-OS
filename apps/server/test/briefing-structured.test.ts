// Briefing wie ein Artefakt.
// - Das Modell liefert nur Text + Struktur (festes Schema: Kernaussage, Sätze, Vorschlag, Hervorhebungen, Graphen).
// - ALLE Zahlen und Diagramm-Reihen (`figures`) kommen aus dem Schnappschuss bzw. vorhandenen Tabellen — nie
//   aus dem Modelltext; eigene Zahlenfelder des Modells fallen weg, falsche Zahlen in der Kernaussage auch.
// - Ohne Modell (Rückfall) sind Kernaussage, Kennzahlen, Diagramme und „Als Nächstes“ genauso da.
import { parseBriefingModel } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { entries, gitCommits, gitRepos, sessions, usageDaily, usageEvents } from "../src/db/schema.js";
import { createInboxItem, YES_NO } from "../src/haiku/inbox.js";
import { generateReport, latestReport } from "../src/haiku/report.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { localDay, addDays } from "../src/usage/periods.js";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

type T = Awaited<ReturnType<typeof setupAssistant>>;
const now = new Date("2026-09-25T12:30:00Z"); // 14:30 Berlin
const MIN = 60_000;
const H = 60 * MIN;
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const today = localDay(now);

async function seed(t: T) {
  await t.db.insert(sessions).values([
    { id: "claude:r1", tool: "claude", sessionId: "r1", title: "Karte bauen", status: "running", turnOpen: true, state: "running", categoryArt: "coding", lastActivityAt: ago(2 * MIN), startedAt: ago(3 * H) },
    { id: "codex:r2", tool: "codex", sessionId: "r2", title: "Tests schreiben", status: "running", turnOpen: true, state: "running", categoryArt: "coding", lastActivityAt: ago(4 * MIN), startedAt: ago(2 * H) },
    { id: "claude:w1", tool: "claude", sessionId: "w1", title: "Dashboard", status: "running", turnOpen: false, state: "waiting", categoryArt: "coding", lastActivityAt: ago(5 * MIN) },
    { id: "claude:w1-sub", tool: "claude", sessionId: "w1-sub", parentId: "claude:w1", title: "Sub-Agent", status: "running", turnOpen: false, state: "waiting", lastActivityAt: ago(5 * MIN) },
  ]);
  // Nutzung: heute Claude 3 Mio + Codex 1 Mio; gestern Claude 2 Mio; vor 10 Tagen Codex 5 Mio (Vorwoche).
  await t.db.insert(usageDaily).values([
    { day: today, tool: "claude", model: "opus", project: "shop", totalTokens: 3_000_000 },
    { day: today, tool: "codex", model: "gpt", project: "shop", totalTokens: 1_000_000 },
    { day: addDays(today, -1), tool: "claude", model: "opus", project: "shop", totalTokens: 2_000_000 },
    { day: addDays(today, -10), tool: "codex", model: "gpt", project: "andere", totalTokens: 5_000_000 },
  ]);
  // Aktivität je Stunde: r1 + Sub-Agent von w1 (zählt für w1) in der laufenden Stunde, r2 vor 3 Stunden.
  await t.db.insert(usageEvents).values([
    { id: "u1", ts: ago(10 * MIN), tool: "claude", project: "shop", sessionKey: "claude:r1" },
    { id: "u2", ts: ago(12 * MIN), tool: "claude", project: "shop", sessionKey: "claude:r1" },
    { id: "u3", ts: ago(15 * MIN), tool: "claude", project: "shop", sessionKey: "claude:w1-sub" },
    { id: "u4", ts: ago(3 * H), tool: "codex", project: "shop", sessionKey: "codex:r2" },
  ]);
  // Commits: App 3 heute (einer davon auch im Worktree → zählt einmal), NyxOS 1 gestern.
  await t.db.insert(gitRepos).values([
    { id: "app", label: "Shop", kind: "app", root: "/app" },
    { id: "worktree:x", label: "App · x", kind: "worktree", root: "/wt/x", parentId: "app" },
    { id: "nyxos", label: "NyxOS", kind: "nyxos", root: "/z" },
  ]);
  await t.db.insert(gitCommits).values([
    { repoId: "app", sha: "a1", authorDate: ago(1 * H), subject: "a", branch: "main" },
    { repoId: "app", sha: "a2", authorDate: ago(2 * H), subject: "b", branch: "main" },
    { repoId: "worktree:x", sha: "a2", authorDate: ago(2 * H), subject: "b", branch: "x" },
    { repoId: "worktree:x", sha: "a3", authorDate: ago(3 * H), subject: "c", branch: "x" },
    { repoId: "nyxos", sha: "z1", authorDate: ago(26 * H), subject: "z", branch: "main" },
  ]);
  await t.db.insert(entries).values([
    { kind: "aufgabe", title: "A", stage: "startklar" },
    { kind: "bug", title: "B", stage: "laeuft" },
    { kind: "aufgabe", title: "C", stage: "erledigt" },
    { kind: "idee", title: "Idee zählt nicht", stage: "eingang" },
    // wie der Aufgaben-Kopf — Audit-Befunde (eigener Tab) und entfernte Quellen zählen nicht.
    { kind: "audit", title: "Befund zählt nicht", stage: "geplant" },
    { kind: "aufgabe", title: "Quelle entfernt zählt nicht", stage: "geplant", sourceRemovedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 die Tabelle umbenennen?", options: YES_NO, createdBy: "session", sessionKey: "claude:w1" });
}

describe("Schema der Modell-Antwort", () => {
  it("nur Objekt mit Satz-Liste; ungültige Sätze und unbekannte Schlüssel fallen weg; Zahlenfelder werden nie übernommen", () => {
    expect(parseBriefingModel(null)).toBeNull();
    expect(parseBriefingModel("5 Sessions")).toBeNull();
    expect(parseBriefingModel({ kernaussage: { text: "x", fakten: ["f1"] } })).toBeNull();
    const p = parseBriefingModel({
      kernaussage: { text: "Heute ist ruhig.", fakten: ["f1"] },
      saetze: [{ abschnitt: "Was lief", text: "Gut.", fakten: ["f1"] }, { text: "", fakten: [] }, { text: "ohne Fakten-Liste" }, 7],
      vorschlag: { text: "Starte A." },
      hervorhebungen: ["commits", "erfunden", "commits", "usage_today", "server", "conflicts"],
      graphen: ["tasks_progress", "kaputt", "usage_7d"],
      kennzahlen: { commits: 999 },
    });
    expect(p).not.toBeNull();
    expect(p?.saetze).toEqual([{ abschnitt: "Was lief", text: "Gut.", fakten: ["f1"] }]);
    expect(p?.vorschlag).toEqual({ text: "Starte A.", fakten: [] });
    expect(p?.hervorhebungen).toEqual(["commits", "usage_today", "server"]);
    expect(p?.graphen).toEqual(["tasks_progress", "usage_7d"]);
    expect(JSON.stringify(p)).not.toContain("999");
    expect(parseBriefingModel({ saetze: [], kernaussage: { text: 5 } })?.kernaussage).toBeNull();
  });
});

describe("Kennzahlen und Graphen aus echten Daten", () => {
  it("figures stimmen mit Schnappschuss/Tabellen überein — Modellzahlen (Kernaussage, eigene Felder) kommen nie durch", async () => {
    const engine = new FakeEngine(async function* (req) {
      const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
      const w = facts.find((f) => /wartet auf dich|warten auf dich/.test(f.text));
      yield* answer(
        JSON.stringify({
          kernaussage: { text: "42 Sessions warten auf dich.", fakten: [w?.id] },
          saetze: [],
          hervorhebungen: ["commits", "usage_today"],
          graphen: ["commits_daily", "usage_7d"],
          kennzahlen: { commits: 999, tokens: 123456789 },
        }),
      )(req);
    });
    const t = await setupAssistant({ engine });
    await seed(t);
    const r = await generateReport(t.runtime, "briefing", now);
    const f = r.figures;
    expect(f).toBeTruthy();
    if (!f) return;
    // Jetzt-Werte = Schnappschuss (Sub-Agent zählt nicht).
    expect(f.at).toBe(r.snapshot?.at);
    expect(f.sessions).toMatchObject({ running: 2, waiting: 1, idle: 0, crashed: 0 });
    expect(f.needsYou).toBe(r.needsYou.length);
    expect(f.openQuestions.total).toBe(1);
    // Nutzung je Anbieter.
    expect(f.usage.today).toEqual({ claude: 3_000_000, codex: 1_000_000 });
    expect(f.usage.week).toEqual({ claude: 5_000_000, codex: 1_000_000 });
    expect(f.usage.prevWeek).toEqual({ claude: 0, codex: 5_000_000 });
    expect(f.charts.usage7d).toHaveLength(7);
    expect(f.charts.usage7d.at(-1)).toEqual({ day: today, claude: 3_000_000, codex: 1_000_000 });
    // Sessions je Stunde: 24 Stunden, laufende Stunde = r1 + w1 (über Sub-Agent) bei Claude.
    expect(f.charts.sessionsHourly).toHaveLength(24);
    expect(f.charts.sessionsHourly.at(-1)).toMatchObject({ hour: 14, claude: 2, codex: 0 });
    expect(f.charts.sessionsHourly.reduce((a, h) => a + h.codex, 0)).toBe(1);
    // Commits: dieselbe Zahl wie die Überblick-Kachel, je Ordner ohne Worktree-Doppel.
    const ov = await getOverviewSnapshot(t.db, "Alex", now);
    expect(f.commits.week).toBe(ov.metrics.find((m) => m.key === "commits_7d")?.value);
    expect(f.commits).toMatchObject({ today: 3, week: 4 });
    expect(f.charts.commitRepos.map((r) => r.label)).toEqual(["Shop", "NyxOS"]);
    expect(f.charts.commitsDaily).toHaveLength(14);
    expect(f.charts.commitsDaily.at(-1)?.repos).toEqual({ app: 3, nyxos: 0 });
    // Aufträge je Stufe (Ideen zählen nicht).
    expect(f.tasks.open).toBe(2);
    expect(f.tasks.byStage.find((s) => s.stage === "erledigt")?.count).toBe(1);

    // Modell: Struktur ja, Zahlen nein.
    expect(JSON.stringify(r)).not.toContain("999");
    expect(JSON.stringify(r)).not.toContain("123456789");
    expect(r.headline?.text).not.toContain("42");
    expect(r.headline?.author).toBe("regeln");
    expect(r.highlights).toEqual(["commits", "usage_today"]);
    expect(r.chartOrder?.slice(0, 2)).toEqual(["commits_daily", "usage_7d"]);
    expect(r.chartOrder).toHaveLength(4);

    // Gespeichert und wieder geladen: gleiche Zahlen.
    const again = await latestReport(t.db, "briefing", now);
    expect(again?.figures).toEqual(f);
  });

  it("gültige Kernaussage von Nyx wird übernommen (Zahl aus den Fakten)", async () => {
    const engine = new FakeEngine(async function* (req) {
      const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
      const w = facts.find((f) => /wartet auf dich|warten auf dich/.test(f.text));
      yield* answer(JSON.stringify({ kernaussage: { text: "1 Session wartet auf dich, sonst läuft alles.", fakten: [w?.id] }, saetze: [] }))(req);
    });
    const t = await setupAssistant({ engine });
    await seed(t);
    const r = await generateReport(t.runtime, "briefing", now);
    expect(r.headline).toMatchObject({ text: "1 Session wartet auf dich, sonst läuft alles.", author: "haiku" });
    expect(engine.requests[0]?.systemPrompt).toContain("kernaussage");
  });

  it("Fakten-Marken „[f1]“ in der Kernaussage stehen nie im Kopf", async () => {
    const engine = new FakeEngine(async function* (req) {
      const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
      const w = facts.find((f) => /wartet auf dich|warten auf dich/.test(f.text));
      yield* answer(JSON.stringify({ kernaussage: { text: `Eine Session wartet auf dich [${w?.id}].`, fakten: [w?.id] }, saetze: [] }))(req);
    });
    const t = await setupAssistant({ engine });
    await seed(t);
    const r = await generateReport(t.runtime, "briefing", now);
    expect(r.headline).toMatchObject({ text: "Eine Session wartet auf dich.", author: "haiku" });
  });

  it("ohne Modell: Kernaussage, Kennzahlen, Graphen und „Als Nächstes“ aus Regeln", async () => {
    const engine = new FakeEngine(answer("x"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    await seed(t);
    const r = await generateReport(t.runtime, "briefing", now);
    expect(r.mode).toBe("nur-daten");
    expect(r.headline?.author).toBe("regeln");
    expect(r.headline?.text.length).toBeGreaterThan(10);
    expect(r.figures?.charts.usage7d).toHaveLength(7);
    expect(r.chartOrder).toEqual(["usage_7d", "sessions_hourly", "commits_daily", "tasks_progress"]);
    const next = r.sections.find((s) => s.title === "Als Nächstes");
    expect(next?.statements[0]?.text).toContain("Darf T-01 die Tabelle umbenennen?");
    expect(next?.statements[0]?.sources[0]?.href).toBe(r.needsYou[0]?.href);
  });
});
