// Briefing/Recap (nur belegte Sätze), Leichter Tag, Entscheidungs-Inbox (ENTSCHEIDUNGEN.md + Session), Takt.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvals, haikuNotes, haikuReports, inboxItems, sessions } from "../../src/db/schema.js";
import { createInboxItem, YES_NO } from "../../src/haiku/inbox.js";
import { collectFacts, generateReport, validateStatement } from "../../src/haiku/report.js";
import { HaikuScheduler } from "../../src/haiku/scheduler.js";
import { patchHaikuSettings } from "../../src/haiku/settings.js";
import { answer, FakeEngine, setupAssistant } from "./assistant-helpers.js";

type T = Awaited<ReturnType<typeof setupAssistant>>;
const now = new Date("2026-09-25T05:30:00Z"); // 07:30 Berlin

async function seed(t: T) {
  const recent = new Date(now.getTime() - 3600_000).toISOString();
  await t.db.insert(sessions).values([
    { id: "claude:w1", tool: "claude", sessionId: "w1", title: "Login reparieren", state: "waiting", categoryArt: "coding", categoryBaustelleSlug: "app", lastActivityAt: recent },
    { id: "claude:r1", tool: "claude", sessionId: "r1", title: "Karte bauen", state: "running", categoryArt: "coding", categoryBaustelleSlug: "app", lastActivityAt: recent },
    { id: "claude:c1", tool: "claude", sessionId: "c1", title: "Import", state: "crashed", categoryArt: "coding", lastActivityAt: recent },
  ]);
  await t.db.insert(approvals).values({ rule: "git_push", reason: "Push ist Alex vorbehalten", tool: "Bash", command: "git push origin auftrag/t-01", commandHash: "h1", sessionKey: "claude:r1" });
  await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 die Tabelle umbenennen?", options: YES_NO, createdBy: "session", sessionKey: "claude:w1" });
  await createInboxItem(t.db, { kind: "frage", title: "Welche Farbe für Buttons?", options: [{ id: "o1", label: "Türkis" }, { id: "o2", label: "Weiß" }, { id: "o3", label: "Grau" }], createdBy: "haiku" });
  await createInboxItem(t.db, { kind: "plan", title: "Heute Nacht A02 starten", body: "A02 ist startklar", options: [{ id: "freigeben", label: "Freigeben" }, { id: "aendern", label: "Ändern" }], createdBy: "haiku" });
}

describe("Briefing/Recap", () => {
  it("Fakten tragen echte Zahlen und Quellen", async () => {
    const t = await setupAssistant();
    await seed(t);
    const facts = await collectFacts(t.db, "briefing", now);
    const waiting = facts.find((f) => /warten? auf dich|wartet auf dich/.test(f.text));
    expect(waiting?.text).toBe("1 Session wartet auf dich: „Login reparieren“.");
    expect(waiting?.sources[0]).toMatchObject({ kind: "session", id: "claude:w1", href: "/sessions/coding/app/w1" });
    expect(facts.find((f) => f.text.includes("abgestürzt"))?.sources[0]?.id).toBe("claude:c1");
  });

  it("Haiku-Sätze nur mit gültigen Fakten und nur deren Zahlen; Rest als Regel-Satz", async () => {
    expect(validateStatement("2 Sessions warten", ["f1"], [{ id: "f1", section: "x", text: "1 Sessions warten", sources: [] }]).ok).toBe(false);
    expect(validateStatement("Eine Session wartet", ["f9"], [{ id: "f1", section: "x", text: "1", sources: [] }]).ok).toBe(false);
    // Fall „Gestern liefen 30“: Zeitwort muss in den Fakten stehen.
    const f = [{ id: "f1", section: "x", text: "30 Sessions waren seit gestern 0 Uhr aktiv.", sources: [] }];
    expect(validateStatement("Gestern liefen 30 Sessions.", ["f1"], [{ id: "f1", section: "x", text: "30 Sessions waren heute aktiv.", sources: [] }]).ok).toBe(false);
    expect(validateStatement("Seit gestern 0 Uhr waren 30 Sessions aktiv.", ["f1"], f).ok).toBe(true);
    const t = await setupAssistant({
      engine: new FakeEngine(async function* (req) {
        const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
        const w = facts.find((f) => /warten? auf dich|wartet auf dich/.test(f.text));
        const json = JSON.stringify({
          saetze: [
            { abschnitt: "Was wartet", text: "Eine Session braucht dich: Login reparieren (1 wartet).", fakten: [w?.id] },
            { abschnitt: "Was wartet", text: "Es warten 5 Sessions.", fakten: [w?.id] },
            { abschnitt: "Was lief", text: "Alles super gelaufen.", fakten: [] },
          ],
          vorschlag: { text: "Beantworte zuerst die Frage von Login reparieren.", fakten: [w?.id] },
        });
        yield* answer(json)(req);
      }),
    });
    await seed(t);
    const r = await generateReport(t.runtime, "briefing", now);
    expect(r.mode).toBe("ok");
    expect(r.greeting).toBe("Guten Morgen");
    const all = r.sections.flatMap((s) => s.statements);
    expect(all.some((s) => s.author === "haiku" && s.text.includes("Login reparieren") && s.sources[0]?.id === "claude:w1")).toBe(true);
    expect(all.some((s) => s.text.includes("5 Sessions"))).toBe(false);
    expect(all.some((s) => s.text === "Alles super gelaufen.")).toBe(false);
    // Jeder Fakt kommt vor (von Haiku abgedeckt oder als Regel-Satz).
    expect(all.some((s) => s.author === "regeln" && s.text.includes("abgestürzt"))).toBe(true);
    expect(r.sections.find((s) => s.title === "Vorschlag für heute")?.statements[0]?.sources[0]?.id).toBe("claude:w1");
    // Blöcke: Plan läuft ohne dich, Freigabe + Ja/Nein null Energie zuerst.
    expect(r.runsWithoutYou.map((i) => i.kind)).toEqual(["plan"]);
    expect(r.needsYou.slice(0, 2).every((i) => i.zeroEnergy)).toBe(true);
    expect(r.needsYou.map((i) => i.kind)).toEqual(expect.arrayContaining(["approval", "question", "session", "crashed"]));
    const saved = await t.db.select().from(haikuReports);
    expect(saved).toHaveLength(1);
  });

  it("Motor aus → nur-daten, alle Sätze aus Regeln, keine erfundenen Haiku-Sätze", async () => {
    const engine = new FakeEngine(answer("x"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    await seed(t);
    const r = await generateReport(t.runtime, "recap", new Date("2026-09-25T19:40:00Z"));
    expect(r.mode).toBe("nur-daten");
    expect(r.greeting).toBe("Guten Abend");
    expect(r.sections.flatMap((s) => s.statements).every((s) => s.author === "regeln")).toBe(true);
    expect(r.sections.map((s) => s.title)).toEqual(expect.arrayContaining(["Geschafft", "Offen", "Neue Probleme", "Nutzung"]));
  });

  it("Leichter Tag: nur Freigaben + höchstens 2 Ja/Nein-Fragen, Rest verschoben", async () => {
    const t = await setupAssistant();
    await seed(t);
    await createInboxItem(t.db, { kind: "frage", title: "Ja/Nein 2", options: YES_NO, createdBy: "haiku" });
    await createInboxItem(t.db, { kind: "frage", title: "Ja/Nein 3", options: YES_NO, createdBy: "haiku" });
    const res = (await (await t.app.request("/api/haiku/light-day")).json()) as { items: { kind: string; zeroEnergy: boolean }[]; deferred: number };
    expect(res.items.map((i) => i.kind)).toEqual(["approval", "question", "question"]);
    expect(res.items.every((i) => i.zeroEnergy)).toBe(true);
    expect(res.deferred).toBeGreaterThanOrEqual(4);
  });
});

describe("Entscheidungs-Inbox", () => {
  it("Antwort → ENTSCHEIDUNGEN.md als Commit (ohne Push) + an die wartende Session; zweite Antwort 409", async () => {
    const repo = mkdtempSync(join(tmpdir(), "assistant-decisions-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "start"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const sent: [string, string][] = [];
    const t = await setupAssistant({ delivery: { decisionsRoot: repo, sendToSession: async (k, text) => (sent.push([k, text]), "sent") } });
    const { item } = await createInboxItem(t.db, { kind: "frage", title: "Tabelle umbenennen?", options: YES_NO, createdBy: "session", sessionKey: "claude:w1", decisionFile: "auftraege/T-01/ENTSCHEIDUNGEN.md" });
    const res = await t.json(`/api/inbox/${item.id}/answer`, { optionId: "nein", text: "erst nach der Migration" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { status: string; delivery: { toSession: string; decisionCommit: string } } };
    expect(body.item.status).toBe("answered");
    expect(body.item.delivery.toSession).toBe("sent");
    expect(body.item.delivery.decisionCommit).toMatch(/^[0-9a-f]{7,}$/);
    expect(sent[0]).toEqual(["claude:w1", "Antwort vom Nutzer (Entscheidungs-Inbox): Nein – erst nach der Migration"]);
    const md = readFileSync(join(repo, "auftraege/T-01/ENTSCHEIDUNGEN.md"), "utf8");
    expect(md).toContain("Tabelle umbenennen?");
    expect(md).toContain("**Antwort:** Nein – erst nach der Migration");
    expect(execFileSync("git", ["-C", repo, "log", "--oneline"]).toString()).toContain("Entscheidung aus der NyxOS-Inbox");
    expect((await t.json(`/api/inbox/${item.id}/answer`, { optionId: "ja" })).status).toBe(409);
  });

  it("ENTSCHEIDUNGEN.md außerhalb der erlaubten Wurzel wird nicht geschrieben", async () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-root-"));
    const t = await setupAssistant({ delivery: { decisionsRoot: root } });
    const { item } = await createInboxItem(t.db, { kind: "frage", title: "x?", options: YES_NO, createdBy: "haiku", decisionFile: "../../etc/ENTSCHEIDUNGEN.md" });
    const body = (await (await t.json(`/api/inbox/${item.id}/answer`, { optionId: "ja" })).json()) as { item: { delivery: { decisionCommit: string | null; note: string } } };
    expect(body.item.delivery.decisionCommit).toBeNull();
    expect(body.item.delivery.note).toMatch(/außerhalb/);
  });

  it("Plan freigeben über release-all; Verwerfen; Liste", async () => {
    const t = await setupAssistant();
    await seed(t);
    const plan = (await t.db.select().from(inboxItems)).find((i) => i.kind === "plan");
    const rel = (await (await t.json("/api/haiku/release-all", { ids: [`inbox:${plan?.id}`] })).json()) as { released: number };
    expect(rel.released).toBe(1);
    const open = (await (await t.app.request("/api/inbox")).json()) as { items: { id: number; kind: string }[] };
    expect(open.items.some((i) => i.kind === "plan")).toBe(false);
    const q = open.items[0];
    expect((await t.json(`/api/inbox/${q?.id}/dismiss`, {})).status).toBe(200);
  });
});

describe("Takt", () => {
  it("Briefing einmal nach 07:00, Recap nach 21:30, Rundgang meldet nur Neues", async () => {
    const t = await setupAssistant();
    await seed(t);
    await patchHaikuSettings(t.db, { briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15 });
    const notes: string[] = [];
    const waitingCalls: string[] = [];
    const s = new HaikuScheduler({ runtime: t.runtime, notify: (w) => notes.push(w), onWaitingSession: async (k) => (waitingCalls.push(k), true) });
    const early = await s.tick(new Date("2026-09-25T04:50:00Z")); // 06:50
    expect(early.briefing).toBe(false);
    expect(early.rundgang).toBe(true);
    expect(waitingCalls).toEqual(["claude:w1"]);
    const first = await s.tick(new Date("2026-09-25T05:01:00Z")); // 07:01
    expect(first.briefing).toBe(true);
    expect(first.rundgang).toBe(false);
    const again = await s.tick(new Date("2026-09-25T05:20:00Z"));
    expect(again.briefing).toBe(false);
    expect(again.rundgang).toBe(true);
    expect(waitingCalls).toHaveLength(1); // nichts Neues → kein zweiter Haiku-Anlass
    const evening = await s.tick(new Date("2026-09-25T19:31:00Z")); // 21:31
    expect(evening.recap).toBe(true);
    const n = (await t.db.select().from(haikuNotes)).filter((x) => x.kind === "rundgang");
    expect(n.map((x) => (x.data as { kind: string }).kind).sort()).toEqual(["approval", "crashed", "waiting"]); // je genau einmal
    expect(t.runtime.lastRundgang?.findings).toBe(0);
  });
});
