// „Seit du weg warst“: `GET /api/changes?since=` sammelt nur lesend, was sich seit einem Zeitpunkt getan hat.
// Geprüft: Zeitgrenze, leere Gruppen fallen weg, 7-Tage-Kappe, ungültiges `since` → 400,
// jede Zahl = Länge von `items`, Commit + beendete Session erscheinen mit Link, Anmeldung wie andere Lese-Wege.
import type { ChangesResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { getChanges, resolveSince } from "../src/changes.js";
import { approvals, deploys, entries, gitCommits, gitRepos, inboxItems, sessions, usageEvents } from "../src/db/schema.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { registerNyxTools } from "../src/nyx/tools.js";
import { needsAuth } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

const now = new Date("2026-09-25T20:00:00Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

async function seed(db: Awaited<ReturnType<typeof setup>>["db"], base = now) {
  const ago = (ms: number) => new Date(base.getTime() - ms).toISOString();
  await db.insert(gitRepos).values([
    { id: "nyxos", label: "NyxOS", kind: "nyxos", root: "/z" },
    { id: "worktree:t1", label: "T1-Worktree", kind: "worktree", root: "/z/wt", parentId: "nyxos" },
    { id: "app", label: "App", kind: "app", root: "/a" },
  ]);
  await db.insert(gitCommits).values([
    { repoId: "nyxos", sha: "aaa1111", authorDate: ago(2 * H), subject: "T1: Karte", branch: "main" },
    // derselbe Commit auch im Worktree → nur EINMAL (wie „Commits · 7 Tage“: distinct sha), beim Haupt-Repo
    { repoId: "worktree:t1", sha: "aaa1111", authorDate: ago(2 * H), subject: "T1: Karte", branch: "r2-t1" },
    { repoId: "app", sha: "bbb2222", authorDate: ago(3 * H), subject: "App: Heatmap", branch: "main" },
    // vor der Grenze → nicht dabei
    { repoId: "app", sha: "ccc3333", authorDate: ago(30 * H), subject: "alt", branch: "main" },
  ]);
  await db.insert(sessions).values([
    // sauber beendet vor 1 Std, mit Titel → „fertig“
    { id: "claude:done", tool: "claude", sessionId: "done", title: "Test-Session fertig", status: "ended", state: null, turnOpen: false, sessionEndReceivedAt: ago(H), endedAt: ago(H), lastActivityAt: ago(H), startedAt: ago(5 * H), categoryArt: "coding" },
    // beendet vor 30 Std → nicht dabei
    { id: "claude:olddone", tool: "claude", sessionId: "olddone", title: "Alte Session", status: "ended", turnOpen: false, sessionEndReceivedAt: ago(30 * H), endedAt: ago(30 * H), lastActivityAt: ago(30 * H), startedAt: ago(40 * H) },
    // wartet gerade
    { id: "claude:wait", tool: "claude", sessionId: "wait", title: "Wartet auf Antwort", status: "running", state: "waiting", lastActivityAt: ago(2 * H), startedAt: ago(4 * H) },
    // Sub-Agent → nie
    { id: "claude:sub", tool: "claude", sessionId: "sub", parentId: "claude:wait", title: "Sub", status: "ended", turnOpen: false, sessionEndReceivedAt: ago(H), endedAt: ago(H), startedAt: ago(2 * H) },
  ]);
  await db.insert(entries).values([
    { kind: "aufgabe", title: "Auftrag neu", createdAt: ago(H), updatedAt: ago(H) },
    { kind: "bug", title: "Bug erledigt", stage: "erledigt", createdAt: ago(50 * H), updatedAt: ago(2 * H) },
    { kind: "idee", title: "Idee Heatmap", sourceType: "idea", sourceId: "11111111-2222-3333-4444-555555555555", createdAt: ago(3 * H), updatedAt: ago(3 * H) },
    { kind: "aufgabe", title: "Alter Auftrag", createdAt: ago(50 * H), updatedAt: ago(50 * H) },
  ]);
  await db.insert(approvals).values({ rule: "push", reason: "Push braucht dich", tool: "Bash", command: "git push origin main", commandHash: "h", createdAt: ago(H) });
  await db.insert(inboxItems).values({ kind: "question", title: "Soll Nyx X tun?", createdAt: ago(4 * H) });
  await db.insert(deploys).values({ project: "nyxos", containerName: "nyxos-server", imageId: "img", createdAt: ago(5 * H), source: "deploy.sh" });
  await db.insert(usageEvents).values([
    { id: "u1", ts: ago(H), tool: "claude", project: "shop", inputTokens: 1000, outputTokens: 500 },
    { id: "u2", ts: ago(2 * H), tool: "codex", project: "andere", inputTokens: 200, outputTokens: 0 },
    { id: "u3", ts: ago(40 * H), tool: "claude", project: "shop", inputTokens: 99_999 },
  ]);
}

const group = (r: ChangesResponse, kind: string) => r.groups.find((g) => g.kind === kind);
const groups = (r: ChangesResponse, kind: string) => r.groups.filter((g) => g.kind === kind);

describe("resolveSince", () => {
  it("Standard 24 h, relative Angaben, gestern, ISO; Zukunft → jetzt; ungültig → null", () => {
    expect(resolveSince(undefined, now)?.since.toISOString()).toBe(ago(24 * H));
    expect(resolveSince("8h", now)?.since.toISOString()).toBe(ago(8 * H));
    expect(resolveSince("7d", now)?.since.toISOString()).toBe(ago(7 * 24 * H));
    // gestern 0 Uhr Berliner Zeit (25.09. 22:00 Berlin → 24.09. 00:00 Berlin = 23.09. 22:00 UTC)
    expect(resolveSince("gestern", now)?.since.toISOString()).toBe("2026-09-23T22:00:00.000Z");
    expect(resolveSince("2026-09-25T10:00:00Z", now)?.since.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    expect(resolveSince("2026-09-26T10:00:00Z", now)?.since.toISOString()).toBe(now.toISOString());
    expect(resolveSince("quatsch", now)).toBeNull();
    expect(resolveSince("12", now)).toBeNull();
  });

  it("Datum/Uhrzeit ohne Zeitzone gilt als Berliner Zeit (Nyx schreibt „2026-09-24“ oder „2026-09-25T08:00“)", () => {
    // 24.09. 00:00 Berlin (Sommerzeit) = 23.09. 22:00 UTC
    expect(resolveSince("2026-09-24", now)?.since.toISOString()).toBe("2026-09-23T22:00:00.000Z");
    expect(resolveSince("2026-09-25T08:00", now)?.since.toISOString()).toBe("2026-09-25T06:00:00.000Z");
    // mit Zone bleibt es wörtlich
    expect(resolveSince("2026-09-25T08:00:00+02:00", now)?.since.toISOString()).toBe("2026-09-25T06:00:00.000Z");
    // Winterzeit: 01.02. 00:00 Berlin = 31.01. 23:00 UTC
    const winter = new Date("2026-02-02T12:00:00Z");
    expect(resolveSince("2026-02-01", winter)?.since.toISOString()).toBe("2026-01-31T23:00:00.000Z");
  });

  it("7-Tage-Kappe", () => {
    const r = resolveSince("2026-09-01T00:00:00Z", now);
    expect(r?.capped).toBe(true);
    expect(r?.since.toISOString()).toBe(ago(7 * 24 * H));
    expect(resolveSince("30d", now)?.capped).toBe(true);
  });
});

describe("getChanges", () => {
  it("Zeitgrenze: nur, was seit `since` passiert ist; Commit + beendete Session mit Link; jede Zahl = Länge von items", async () => {
    const { db } = await setup();
    await seed(db);
    const r = await getChanges(db, { since: new Date(ago(24 * H)), now });

    expect(r.since).toBe(ago(24 * H));
    expect(r.until).toBe(now.toISOString());
    for (const g of r.groups) {
      expect(g.count).toBe(g.items.length);
      expect(g.items.length).toBeGreaterThan(0);
      for (const it of g.items) expect(it.path.startsWith("/")).toBe(true);
    }

    const done = group(r, "sessions_done");
    expect(done?.items.map((i) => i.label)).toEqual(["Test-Session fertig"]);
    expect(done?.items[0]?.path).toBe("/sessions/coding/_/done");

    // Commits je Repo, doppelter SHA nur einmal, der alte fehlt
    const commits = groups(r, "commits");
    expect(commits.map((g) => g.title).sort()).toEqual(["Commits · App", "Commits · NyxOS"]);
    const all = commits.flatMap((g) => g.items);
    expect(all.map((i) => i.label).sort()).toEqual(["App: Heatmap", "T1: Karte"]);
    expect(all.find((i) => i.label === "T1: Karte")?.path).toBe("/git?g=commit&r=nyxos&k=aaa1111");

    expect(group(r, "sessions_waiting")?.items.map((i) => i.label)).toEqual(["Wartet auf Antwort"]);
    const tasks = group(r, "tasks");
    expect(tasks?.items.map((i) => i.label).sort()).toEqual(["Auftrag neu", "Bug erledigt"]);
    expect(tasks?.items.find((i) => i.label === "Bug erledigt")?.detail).toBe("Bug erledigt");
    expect(tasks?.items.find((i) => i.label === "Auftrag neu")?.path).toMatch(/^\/tasks\?e=\d+$/);
    const ideas = group(r, "ideas");
    expect(ideas?.items[0]?.path).toMatch(/^\/tasks\?e=\d+$/);
    const decisions = group(r, "decisions");
    expect(decisions?.items).toHaveLength(2);
    expect(decisions?.items.find((i) => i.path.startsWith("/inbox#approval-"))?.detail).toBe("wartet auf dich");
    expect(group(r, "deploys")?.items[0]?.label).toBe("nyxos-server");

    // Nutzung: je Werkzeug, Summe wie „Nutzung“ (input+output+cache), nur seit `since`
    const usage = group(r, "usage");
    expect(usage?.items.map((i) => i.label)).toEqual(["Claude", "Codex"]);
    expect(usage?.items[0]?.detail).toContain("1.500");
    expect(usage?.items[0]?.path).toBe("/usage");

    // Sub-Agent nie, neue Sessions nur Haupt-Sessions
    expect(JSON.stringify(r)).not.toContain("\"Sub\"");
    expect(group(r, "sessions_new")?.items.map((i) => i.label).sort()).toEqual(["Test-Session fertig", "Wartet auf Antwort"]);
  });

  it("Worktree-Commits zählen zu ihrem Repo (wie das Briefing), Link zeigt auf den Worktree", async () => {
    const { db } = await setup();
    await seed(db);
    await db.insert(gitCommits).values({ repoId: "worktree:t1", sha: "ddd4444", authorDate: ago(H), subject: "nur im Worktree", branch: "r2-t1" });
    const r = await getChanges(db, { since: new Date(ago(24 * H)), now });
    const commits = groups(r, "commits");
    expect(commits.map((g) => g.title).sort()).toEqual(["Commits · App", "Commits · NyxOS"]);
    const z = commits.find((g) => g.title === "Commits · NyxOS");
    expect(z?.items.map((i) => i.label)).toEqual(["nur im Worktree", "T1: Karte"]);
    expect(z?.items[0]?.path).toBe("/git?g=commit&r=worktree%3At1&k=ddd4444");
  });

  it("viele Commits (554 in 24 h) – höchstens 50 je Repo geladen, Rest ehrlich als `more`", async () => {
    const { db } = await setup();
    await db.insert(gitRepos).values({ id: "nyxos", label: "NyxOS", kind: "nyxos", root: "/z" });
    await db.insert(gitCommits).values(
      Array.from({ length: 554 }, (_, i) => ({ repoId: "nyxos", sha: `sha${String(i).padStart(4, "0")}`, authorDate: ago((i + 1) * 60_000), subject: `Commit ${i}`, branch: "main" })),
    );
    const r = await getChanges(db, { since: new Date(ago(24 * H)), now });
    const g = group(r, "commits");
    expect(g?.count).toBe(50);
    expect(g?.items).toHaveLength(50);
    expect(g?.more).toBe(504);
    expect(g?.items[0]?.label).toBe("Commit 0");
  });

  it("leere Gruppen fallen weg; ohne Änderungen gar keine Gruppe", async () => {
    const { db } = await setup();
    const r = await getChanges(db, { since: new Date(ago(24 * H)), now });
    expect(r.groups).toEqual([]);
    await seed(db);
    const short = await getChanges(db, { since: new Date(ago(30 * 60_000)), now });
    // in der letzten halben Stunde passierte nichts – nur die wartende Session (Zustand jetzt) bleibt
    expect(short.groups.map((g) => g.kind)).toEqual(["sessions_waiting"]);
  });
});

describe("Route GET /api/changes", () => {
  it("ungültiges since → 400 mit deutschem Satz; gültig → Antwort; 7-Tage-Kappe gemeldet", async () => {
    const t = await setup();
    await seed(t.db);
    const bad = await t.app.request("/api/changes?since=quatsch");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Zeitpunkt/);

    const ok = await t.app.request("/api/changes?since=8h");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as ChangesResponse;
    expect(body.capped).toBe(false);
    expect(Array.isArray(body.groups)).toBe(true);

    const capped = (await (await t.app.request("/api/changes?since=2020-01-01T00:00:00Z")).json()) as ChangesResponse;
    expect(capped.capped).toBe(true);
    expect(Date.parse(capped.until) - Date.parse(capped.since)).toBe(7 * 24 * H);
  });

  it("Anmeldung genau wie der Überblick (Lese-Schalter `NYXOS_AUTH_READS`)", () => {
    for (const authReads of [false, true]) expect(needsAuth("GET", "/api/changes", authReads)).toBe(needsAuth("GET", "/api/overview", authReads));
    expect(needsAuth("GET", "/api/changes", true)).toBe(true);
  });
});

describe("Nyx-Werkzeug „was_ist_neu“", () => {
  it("ist im Nyx-Kasten und liefert dieselben Gruppen wie die Route", async () => {
    const { db } = await setup();
    await seed(db, new Date());
    const reg = buildDefaultRegistry();
    registerNyxTools(reg, { hub: { broadcast: () => {} } as never, bridgeHub: null, archiveDir: null, runner: () => null, serverSnapshot: () => null });
    expect(reg.namesFor("full")).toContain("was_ist_neu");
    const res = (await reg.call("full", "was_ist_neu", { seit: "24h" }, { db, scope: "full", ideaLink: null, ideas: null })) as {
      gruppen: { art: string; anzahl: number; gezeigt: number; eintraege: { ref?: string }[] }[];
      seit: string;
    };
    expect(res.gruppen.some((g) => g.art === "sessions_done")).toBe(true);
    for (const g of res.gruppen) expect(g.gezeigt).toBe(g.eintraege.length);
    // Belege für Nyx: Sessions/Freigaben/Fragen tragen den `ref`-Marker wie die anderen Werkzeuge
    expect(res.gruppen.find((g) => g.art === "sessions_done")?.eintraege[0]?.ref).toBe("[[session:claude:done]]");
    expect(res.gruppen.find((g) => g.art === "decisions")?.eintraege.every((e) => /^\[\[(approval|inbox):\d+\]\]$/.test(e.ref ?? ""))).toBe(true);
    await db.insert(gitRepos).values({ id: "viel", label: "Viel", kind: "app", root: "/v" });
    await db.insert(gitCommits).values(Array.from({ length: 80 }, (_, i) => ({ repoId: "viel", sha: `v${i}`, authorDate: new Date(Date.now() - (i + 1) * 60_000).toISOString(), subject: `V ${i}`, branch: "main" })));
    const many = (await reg.call("full", "was_ist_neu", { seit: "24h" }, { db, scope: "full", ideaLink: null, ideas: null })) as { gruppen: { titel: string; anzahl: number; gezeigt: number }[] };
    // `anzahl` ist die ECHTE Zahl (nicht die gekürzte Liste), damit Nyx „80 Commits“ sagt und nicht „10“
    const viel = many.gruppen.find((g) => g.titel === "Commits · Viel");
    expect(viel?.anzahl).toBe(80);
    expect(viel?.gezeigt).toBeLessThan(80);
    const bad = (await reg.call("full", "was_ist_neu", { seit: "quatsch" }, { db, scope: "full", ideaLink: null, ideas: null })) as { fehler?: string };
    expect(bad.fehler).toBeTruthy();
  });
});
