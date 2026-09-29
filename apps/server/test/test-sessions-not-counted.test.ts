// Automatisch als Test erkannte temporäre Sessions (Selbsttest, Probe-Ordner, Probe-tmux,
// Haiku-Lauf im NyxOS-Repo) zählen NIE in Überblick, Briefing, „Zuletzt fertig“ und Zählern — auch nicht
// bis zum Ablauf ihrer Frist. Von der Nutzer bewusst temporär gestartete Sessions (Grund „manual“) bleiben
// sichtbar, solange sie laufen.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { collectFacts } from "../src/haiku/report.js";
import { applyTemporaryMarks } from "../src/temporary.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
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

async function seed() {
  const t = await setup();
  const temp = { temporarySince: minsAgo(20) };
  await t.db.insert(sessions).values([
    row("echt"),
    row("selbsttest", { ...temp, temporaryReason: "selftest", title: "Antworte nur mit OK" }),
    row("probe", { ...temp, temporaryReason: "probe_folder", cwd: "/x/.probe/new-session-test" }),
    row("bewusst", { ...temp, temporaryReason: "manual", title: "Bewusst temporär" }),
    // fertig geworden: echte, Test und bewusst temporäre
    row("echt-fertig", { status: "ended", state: "ended", turnOpen: false, sessionEndReceivedAt: minsAgo(3), endedAt: minsAgo(3), title: "Echte Arbeit fertig" }),
    row("test-fertig", { ...temp, temporaryReason: "probe_tmux", status: "ended", state: "ended", turnOpen: false, sessionEndReceivedAt: minsAgo(2), endedAt: minsAgo(2), title: "Bereit" }),
  ]);
  return t;
}

describe("Test-Sessions zählen nirgends mit", () => {
  it("Schnappschuss (eine Quelle für Überblick + Briefing): nur echte und bewusst temporäre laufen", async () => {
    const t = await seed();
    const snap = await takeSnapshot(t.db, NOW);
    const ids = snap.running.map((s) => s.id).sort();
    expect(ids).toEqual(["claude:bewusst", "claude:echt"]);
  });

  it("Überblick „Zuletzt fertig“ zeigt keine Test-Session", async () => {
    const t = await seed();
    const o = await getOverviewSnapshot(t.db, "Alex", NOW);
    const titles = JSON.stringify(o);
    expect(titles).toContain("Echte Arbeit fertig");
    expect(titles).not.toContain("\"Bereit\"");
    // Zahl „Sessions offen“ aus demselben Schnappschuss: nur echte + bewusst temporäre, aufgeschlüsselt.
    const tile = o.metrics.find((m) => m.key === "sessions_open");
    expect(tile?.value).toBe(2);
    expect(tile?.caption).toBe("2 arbeiten · 0 warten · 0 ruhen");
  });

  it("Briefing „Was lief“ nennt keine Test-Session", async () => {
    const t = await seed();
    const facts = await collectFacts(t.db, "briefing", NOW);
    const text = JSON.stringify(facts);
    expect(text).toContain("Titel echt");
    expect(text).not.toContain("Antworte nur mit OK");
    expect(text).not.toContain("Titel probe");
  });
});

// Beispiele: „Bereit“, „Bild-Farbe bestimmen“, „Zahlen von 1 bis 60“ (Haiku-Selbsttests in NyxOS-
// Worktrees) blieben ungekennzeichnet — die Regel „Haiku-Lauf“ kannte nur den SessionStart-Hook, aus dem
// Verlauf eingelesene Sessions haben keinen. Das Modell der Session ist die zweite Quelle.
describe("Auto-Regel „Haiku-Lauf“ auch ohne SessionStart-Hook", () => {
  it("nur Haiku im NyxOS-Repo/Worktree → Test; Haiku im Shop-Ordner, gemischte Modelle, kein Modell → nicht", async () => {
    const t = await setup();
    const wt = "/Users/alex/projects/tools/NyxOS/.claude/worktrees/agent-x";
    await t.db.insert(sessions).values([
      row("bereit", { cwd: wt, title: "Bereit", models: ["claude-haiku-4-5-20251001"] }),
      row("recherche", { cwd: "/Users/alex/projects", title: "Bar-Systeme Recherche", models: ["claude-haiku-4-5-20251001"] }),
      row("gemischt", { cwd: wt, title: "Echte Arbeit", models: ["claude-haiku-4-5-20251001", "claude-opus-5-5"] }),
      row("ohne-modell", { cwd: wt, title: "Noch leer", models: [] }),
    ]);
    const marked = await applyTemporaryMarks(t.db, { probeSocket: false });
    expect(marked.sort()).toEqual(["claude:bereit"]);
  });
});
