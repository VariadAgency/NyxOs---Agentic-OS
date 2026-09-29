// Beendete temporäre Sessions: von Hand über „Neue Session“ mit „⏳ Temporär“ gestartete Test-Sessions
// („Bestätigung bereit“, „Bereit“) standen nach dem Ende in „Zuletzt fertig“ und im Briefing unter „Was lief“.
// Regel: temporäre Sessions (jeder Grund) erscheinen dort NIE, sobald sie beendet sind. Solange sie laufen, zählen
// sie weiter (echte Prozesse). Eine Quelle: `db/visible.ts`.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { collectFacts } from "../src/haiku/report.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { setup } from "./helpers.js";

const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
type Row = typeof sessions.$inferInsert;
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id: `claude:${id}`,
  tool: "claude",
  sessionId: id,
  machineId: "m1",
  status: "running",
  state: "running",
  turnOpen: true,
  cwd: "/Users/alex/projects",
  title: `Titel ${id}`,
  titleSource: "ai",
  startedAt: minsAgo(30),
  lastActivityAt: minsAgo(5),
  ...over,
});
const ended = (m: number): Partial<Row> => ({ status: "ended", state: null, turnOpen: false, sessionEndReceivedAt: minsAgo(m), endedAt: minsAgo(m), lastActivityAt: minsAgo(m) });
const manual = { temporarySince: minsAgo(20), temporaryReason: "manual" };

async function seed() {
  const t = await setup();
  await t.db.insert(sessions).values([
    row("echt-fertig", { ...ended(4), title: "Echte Arbeit fertig" }),
    row("temp-laeuft", { ...manual, title: "Temporär läuft noch" }),
    // von Hand temporär gestartet, per „Prozess beenden“ (kill) beendet – ohne SessionEnd, Runde zu
    row("temp-kill", { ...manual, ...ended(3), sessionEndReceivedAt: null, title: "Bestätigung bereit" }),
    row("temp-ende", { ...manual, ...ended(2), title: "Bereit" }),
    row("temp-zu", { ...manual, status: "ended", state: "closed", turnOpen: false, closedAt: minsAgo(1), endedAt: minsAgo(1), lastActivityAt: minsAgo(1), title: "Geschlossen temporär" }),
  ]);
  return t;
}

describe("beendete temporäre Sessions", () => {
  it("stehen nie in „Zuletzt fertig“", async () => {
    const t = await seed();
    const o = await getOverviewSnapshot(t.db, "Alex", NOW);
    const titles = o.recentDone.map((d) => d.title);
    expect(titles).toContain("Echte Arbeit fertig");
    expect(titles).not.toContain("Bestätigung bereit");
    expect(titles).not.toContain("Bereit");
    expect(titles).not.toContain("Geschlossen temporär");
  });

  it("stehen nie im Briefing unter „Was lief“ – laufende temporäre zählen weiter", async () => {
    const t = await seed();
    const facts = await collectFacts(t.db, "briefing", NOW);
    const lief = JSON.stringify(facts.filter((f) => f.section === "Was lief"));
    expect(lief).toContain("Echte Arbeit fertig");
    expect(lief).toContain("Temporär läuft noch");
    expect(lief).not.toContain("Bestätigung bereit");
    expect(lief).not.toContain("\"Bereit\"");
    expect(lief).not.toContain("Geschlossen temporär");
  });

  it("die laufende temporäre zählt weiter bei „Sessions offen“", async () => {
    const t = await seed();
    const o = await getOverviewSnapshot(t.db, "Alex", NOW);
    expect(o.metrics.find((m) => m.key === "sessions_open")?.value).toBe(1);
  });
});
