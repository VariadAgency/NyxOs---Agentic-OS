// Konflikte nur zwischen lebenden Sessions, „offene Fragen“ überall gleich, ehrliche Abzeichen.
import type { ConflictsSummary, OverviewSnapshot } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { approvals, sessionFiles, sessions } from "../src/db/schema.js";
import { createInboxItem } from "../src/haiku/inbox.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;

const ROOT = "/Users/alex/projects/App/docs/audit";
const DAY = 24 * 3600_000;

async function makeSession(t: App, id: string, extra: Partial<typeof sessions.$inferInsert>) {
  const [tool, sessionId] = id.split(":") as [string, string];
  await t.db.insert(sessions).values({ id, tool, sessionId, title: id, ...extra });
}

const alive = { status: "running", state: "running", turnOpen: true, lastActivityAt: new Date().toISOString() } as const;
/** Von selbst beendet (SessionEnd kam), vor 11 Tagen — nie „geschlossen“ (closedAt bleibt null). */
const ended = { status: "ended", state: null, turnOpen: false, lastActivityAt: new Date(Date.now() - 11 * DAY).toISOString() } as const;

async function writes(t: App, sessionKey: string, paths: string[]) {
  await t.db.insert(sessionFiles).values(paths.map((path) => ({ sessionKey, path, mode: "write" })));
}

async function summary(t: App): Promise<ConflictsSummary> {
  const res = await t.app.request("/api/conflicts/summary");
  expect(res.status).toBe(200);
  return (await res.json()) as ConflictsSummary;
}

async function overview(t: App): Promise<OverviewSnapshot> {
  const res = await t.app.request("/api/overview");
  expect(res.status).toBe(200);
  return (await res.json()) as OverviewSnapshot;
}

async function seedDeadAndLive(t: App) {
  // Zwei beendete Sessions (Boyle/Noether) haben vor Tagen dieselben 5 Dateien geändert …
  await makeSession(t, "codex:boyle", ended);
  await makeSession(t, "codex:noether", ended);
  const old = Array.from({ length: 5 }, (_, i) => `${ROOT}/alt/datei-${i}.md`);
  await writes(t, "codex:boyle", old);
  await writes(t, "codex:noether", old);
  // … zwei lebende schreiben gerade dieselben 2 Dateien, eine davon auch zusammen mit einer toten.
  await makeSession(t, "claude:live-a", alive);
  await makeSession(t, "claude:live-b", { ...alive, state: "waiting", turnOpen: false });
  const now = [`${ROOT}/neu/a.md`, `${ROOT}/neu/b.md`];
  await writes(t, "claude:live-a", now);
  await writes(t, "claude:live-b", now);
  await writes(t, "codex:boyle", [`${ROOT}/neu/a.md`]);
  // Nur eine Lebende + eine Tote an derselben Datei → Rückblick, keine Frage.
  await writes(t, "claude:live-a", [`${ROOT}/mix/c.md`]);
  await writes(t, "codex:noether", [`${ROOT}/mix/c.md`]);
}

describe("Konflikte nur zwischen lebenden Sessions", () => {
  it("beendete Sessions ergeben keine dringende Frage, sondern Rückblick", async () => {
    const t = await setup();
    await seedDeadAndLive(t);
    const s = await summary(t);
    expect(s.totals.conflicts).toBe(2); // nur neu/a.md + neu/b.md
    expect(s.totals.past).toBe(6); // 5× alt + mix/c.md
    expect(s.totals.openDecisions).toBe(1);
    expect(s.decisions).toHaveLength(1);
    // Die tote Boyle schreibt neu/a.md mit, wird aber nicht als Beteiligte gefragt.
    expect(s.decisions[0]?.sessions.map((x) => x.sessionKey)).toEqual(["claude:live-a", "claude:live-b"]);
  });

  it("die Überblick-Kachel „Konflikte“ zählt nur lebende Konflikte", async () => {
    const t = await setup();
    await seedDeadAndLive(t);
    const o = await overview(t);
    expect(o.metrics.find((m) => m.key === "conflicts")?.value).toBe(2);
  });

  it("endet eine Session, verschwindet die Frage (Zwischenspeicher erkennt den Zustandswechsel)", async () => {
    const t = await setup();
    await seedDeadAndLive(t);
    expect((await summary(t)).totals.openDecisions).toBe(1);
    const { eq } = await import("drizzle-orm");
    await t.db.update(sessions).set({ state: null, status: "ended" }).where(eq(sessions.id, "claude:live-b"));
    const after = await summary(t);
    expect(after.totals.openDecisions).toBe(0);
    expect(after.totals.conflicts).toBe(0);
  });
});

describe("„Offene Fragen“ — eine Zahl überall", () => {
  it("Überblick-Kachel = Entscheidungen (Freigaben + Inbox) + offene Konflikt-Fragen", async () => {
    const t = await setup();
    await seedDeadAndLive(t);
    await t.db.insert(approvals).values({ rule: "git_push", reason: "Push ist Alex vorbehalten", tool: "Bash", command: "git push", commandHash: "h1", sessionKey: "claude:live-a" });
    await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 umbenennen?", options: [{ id: "ja", label: "Ja" }], createdBy: "session", sessionKey: "claude:live-a" });
    await createInboxItem(t.db, { kind: "plan", title: "Heute Nacht A02", body: "startklar", options: [{ id: "freigeben", label: "Freigeben" }], createdBy: "haiku" });

    const [o, s, inboxRes, apprRes, oqRes] = await Promise.all([
      overview(t),
      summary(t),
      t.app.request("/api/inbox?status=open"),
      t.app.request("/api/approvals?status=pending"),
      t.app.request("/api/open-questions"),
    ]);
    const inbox = ((await inboxRes.json()) as { items: unknown[] }).items.length;
    const pending = ((await apprRes.json()) as { items?: unknown[]; approvals?: unknown[] } | unknown[]);
    const approvalsCount = Array.isArray(pending) ? pending.length : (pending.items ?? pending.approvals ?? []).length;
    expect(oqRes.status).toBe(200);
    const oq = (await oqRes.json()) as { approvals: number; inbox: number; conflicts: number; total: number };

    expect(oq).toEqual({ approvals: 1, inbox: 2, conflicts: 1, sorting: 0, total: 4 });
    // Entscheidungen-Tab zählt Freigaben + offene Inbox; Konflikte-Kopf zählt offene Konflikt-Fragen.
    expect(oq.approvals).toBe(approvalsCount);
    expect(oq.inbox).toBe(inbox);
    expect(oq.conflicts).toBe(s.totals.openDecisions);
    const tile = o.metrics.find((m) => m.key === "open_questions");
    expect(tile?.value).toBe(oq.total);
    expect(tile?.href).toBe("/inbox");
  });
});

describe("Abzeichen vergleichen dieselbe Größe", () => {
  it("„Sessions offen“ und „Konflikte“ tragen kein fremdes Abzeichen; jedes Abzeichen sagt, was es vergleicht", async () => {
    const t = await setup();
    await seedDeadAndLive(t);
    const o = await overview(t);
    expect(o.metrics.find((m) => m.key === "sessions_open")?.trend).toBeNull();
    expect(o.metrics.find((m) => m.key === "conflicts")?.trend).toBeNull();
    for (const m of o.metrics) {
      if (!m.trend) continue;
      // Der Zeitraum nennt die Größe selbst (z. B. „Tokens heute ggü. gestern“), nicht nur „ggü. Vortag“.
      expect(m.trend.period.startsWith("ggü.")).toBe(false);
      expect(m.trend.current).toBe(m.value);
    }
  });
});
