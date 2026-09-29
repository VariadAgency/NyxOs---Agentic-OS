// Build-Wächter: fehlende Werkzeuge (früher „spawn pnpm ENOENT“, 4× derselbe Eintrag) und gebündelte Dubletten.
// - Werkzeug/Ordner fehlt → kein Rot, sondern „nicht eingerichtet“ mit einem Satz.
// - Der Server startet nie selbst einen Build-Prozess: die Prüfung läuft über die Brücke (`run_build`).
// - Gleicher Fehler = ein Eintrag mit Zähler: API „Letzte Builds“, „Braucht dich“, Briefing, Push.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRunRow, BuildGroup, PushNotifyInput, ServerToBridge } from "@nyxos/shared";
import { BRIDGE_CAP_RUN_BUILD, formatBuildCount } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { notifyBuildDone } from "../src/builds/notify.js";
import { BuildQueue, ProcessBuildRunner, type BuildJob, type BuildRunner } from "../src/builds/queue.js";
import { buildRuns, pushLog, sessions } from "../src/db/schema.js";
import { buildItems, collectFacts } from "../src/haiku/report.js";
import { notify } from "../src/push/dispatcher.js";
import { loadOrInitSettings } from "../src/push/settings.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const NYXOS_CWD = "/Users/alex/code/nyxos";

function fakeBridge(hub: BridgeHub, opts: { caps?: string[]; reply?: (msg: ServerToBridge) => unknown }) {
  const sent: ServerToBridge[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        sent.push(msg);
        const answer = opts.reply?.(msg);
        if (answer !== undefined) queueMicrotask(() => hub.handle(JSON.stringify(answer)));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket: "nyxos", ...(opts.caps ? { caps: opts.caps } : {}) }));
  return sent;
}

async function waitForFinal(db: Awaited<ReturnType<typeof setup>>["db"], n = 1) {
  for (let i = 0; i < 200; i++) {
    const rows = await db.select().from(buildRuns);
    if (rows.length >= n && rows.every((r) => r.status !== "queued" && r.status !== "running")) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Build-Lauf wurde nicht fertig");
}

const stopEvent = (id: string, cwd = NYXOS_CWD) => ({
  type: "event",
  event: { id, tool: "claude", sessionId: "s1", ts: new Date().toISOString(), kind: "hook", source: "hook", data: { event: "Stop", cwd } },
});

describe("Werkzeug fehlt → kein Rot", () => {
  it("ProcessBuildRunner: fehlendes Programm ergibt „nicht eingerichtet“ mit Satz, keinen roten Lauf und keine Push", async () => {
    const { db } = await setup();
    const onDone = vi.fn();
    const queue = new BuildQueue(db, new ProcessBuildRunner(), onDone);
    const id = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["nyxos-werkzeug-gibt-es-nicht"], cwd: tmpdir(), trigger: "manual" });
    await queue.waitFor(id);
    const [row] = await db.select().from(buildRuns).where(eq(buildRuns.id, id));
    expect(row?.status).toBe("unavailable");
    const [sentence, ...rest] = (row?.logExcerpt ?? "").split("\n");
    expect(sentence).toContain("„nyxos-werkzeug-gibt-es-nicht“");
    expect(sentence).not.toMatch(/ENOENT|spawn/);
    expect(rest.join("\n")).toContain("ENOENT"); // Rohmeldung bleibt für „Details“
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id, status: "unavailable" }));
  });

  it("ProcessBuildRunner: fehlender Arbeitsordner ist ebenfalls „nicht eingerichtet“ (nicht „Werkzeug fehlt“)", async () => {
    const { db } = await setup();
    const queue = new BuildQueue(db, new ProcessBuildRunner());
    const id = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["true"], cwd: "/Users/niemand/gibt-es-nicht", trigger: "manual" });
    await queue.waitFor(id);
    const [row] = await db.select().from(buildRuns).where(eq(buildRuns.id, id));
    expect(row?.status).toBe("unavailable");
    expect(row?.logExcerpt?.split("\n")[0]).toContain("Arbeitsordner");
  });
});

describe("Build läuft auf dem Rechner (Brücke), nie im Server-Container", () => {
  it("Stop-Hook bei getrennter Brücke → „nicht eingerichtet“ statt „spawn pnpm ENOENT“", async () => {
    const t = await setup();
    const res = await t.post("/ingest/events", { items: [stopEvent("e1")] });
    expect(res.status).toBe(200);
    const [row] = await waitForFinal(t.db);
    expect(row?.status).toBe("unavailable");
    expect(row?.logExcerpt).not.toContain("ENOENT");
    expect(row?.logExcerpt?.split("\n")[0]).toContain("Brücke");
  });

  it("ältere Brücke ohne `run_build` → sofort „nicht eingerichtet“, keine hängende Anfrage", async () => {
    const bridgeHub = new BridgeHub();
    const sent = fakeBridge(bridgeHub, {});
    const t = await setup({ bridgeHub });
    await t.post("/ingest/events", { items: [stopEvent("e1")] });
    const [row] = await waitForFinal(t.db);
    expect(row?.status).toBe("unavailable");
    expect(row?.logExcerpt?.split("\n")[0]).toContain("altem Stand");
    expect(sent.filter((m) => m.op === "rpc")).toHaveLength(0);
  });

  it("Brücke mit `run_build` führt den Typen-Check im NyxOS-Hauptordner aus → grün", async () => {
    const bridgeHub = new BridgeHub();
    const sent = fakeBridge(bridgeHub, {
      caps: [BRIDGE_CAP_RUN_BUILD],
      reply: (m) => (m.op === "rpc" && m.method === "run_build" ? { op: "rpc_result", id: m.id, ok: true, result: { outcome: "done", exitCode: 0, log: "Done" } } : undefined),
    });
    const t = await setup({ bridgeHub });
    await t.post("/ingest/events", { items: [stopEvent("e1", `${NYXOS_CWD}/apps/server`)] });
    const [row] = await waitForFinal(t.db);
    expect(row?.status).toBe("green");
    const rpc = sent.find((m) => m.op === "rpc");
    expect(rpc).toMatchObject({ method: "run_build", params: { command: ["pnpm", "-r", "typecheck"], cwd: NYXOS_CWD } });
  });

  it("Brücke meldet „Werkzeug fehlt“ → „nicht eingerichtet“ mit Satz, Rohmeldung unter Details", async () => {
    const bridgeHub = new BridgeHub();
    fakeBridge(bridgeHub, {
      caps: [BRIDGE_CAP_RUN_BUILD],
      reply: (m) => (m.op === "rpc" ? { op: "rpc_result", id: m.id, ok: true, result: { outcome: "unavailable", reason: "tool_missing", tool: "pnpm", log: "pnpm nicht im Suchpfad" } } : undefined),
    });
    const t = await setup({ bridgeHub });
    await t.post("/ingest/events", { items: [stopEvent("e1")] });
    const [row] = await waitForFinal(t.db);
    expect(row?.status).toBe("unavailable");
    expect(row?.logExcerpt).toBe("Auf dem Rechner fehlt das Werkzeug „pnpm“ – die Brücke findet es nicht.\npnpm nicht im Suchpfad");
  });
});

// Die 7 Zeilen aus einem echten Betrieb + 3 echte, gleiche Typen-Fehler aus zwei Worktrees.
async function seedDuplicates(db: Awaited<ReturnType<typeof setup>>["db"]) {
  await db.insert(sessions).values([
    { id: "claude:a", tool: "claude", sessionId: "a" },
    { id: "claude:b", tool: "claude", sessionId: "b" },
  ]);
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  for (const m of [60, 50, 40, 30]) {
    await db.insert(buildRuns).values({ sessionKey: "claude:a", kind: "nyxos", command: "pnpm test", status: "red", exitCode: -1, logExcerpt: "\nFehler beim Starten: spawn pnpm ENOENT", trigger: "stop_hook", startedAt: at(m), endedAt: at(m) });
  }
  for (const [m, wt, line] of [
    [20, "a", 12],
    [10, "b", 14],
    [5, "a", 12],
  ] as const) {
    await db.insert(buildRuns).values({
      sessionKey: `claude:${wt}`,
      kind: "nyxos",
      command: "pnpm -r typecheck",
      status: "red",
      exitCode: 2,
      logExcerpt: `/Users/alex/wt/${wt}/apps/server/src/x.ts(${line},3): error TS2322: Type 'string' is not assignable to type 'number'.\n ELIFECYCLE Command failed with exit code 2.`,
      trigger: "stop_hook",
      startedAt: at(m),
      endedAt: at(m),
    });
  }
}

describe("Dubletten bündeln (serverseitig, beim Lesen)", () => {
  it("GET /api/builds/summary liefert Gruppen mit Zähler — alte Zeilen bleiben in der DB", async () => {
    const t = await setup();
    await seedDuplicates(t.db);
    const body = (await (await t.app.request("/api/builds/summary")).json()) as { recent: BuildRunRow[]; groups: BuildGroup[] };
    expect(body.recent).toHaveLength(7); // nichts gelöscht
    expect(body.groups.map((g) => [g.state, g.count])).toEqual([
      ["red", 3],
      ["unavailable", 4],
    ]);
    expect(body.groups[0]?.sentence).toBe("Der Typen-Check von NyxOS meldet Fehler.");
    expect(body.groups[1]?.sentence).not.toMatch(/ENOENT|spawn/);
    expect(body.groups[1]?.details).toContain("spawn pnpm ENOENT");
  });

  it("„Braucht dich“: ein Build-Eintrag mit Zähler, ohne Technik-Meldung; alte ENOENT-Läufe gar nicht", async () => {
    const t = await setup();
    await seedDuplicates(t.db);
    const { needsYou } = await buildItems(t.db);
    const builds = needsYou.filter((i) => i.kind === "build");
    expect(builds).toHaveLength(1);
    const item = builds[0];
    expect(item?.title).toBe("Build rot: NyxOS");
    expect(item?.detail).toMatch(/^Der Typen-Check von NyxOS meldet Fehler\. · 3× seit \d\d:\d\d$/);
    expect(item?.detail).not.toMatch(/ENOENT|TS2322/);
    expect(item?.rawDetail).toContain("TS2322");
    expect(item?.count).toBe(3);
  });

  it("Briefing „Was ist kaputt“ zählt Fehler, nicht Läufe", async () => {
    const t = await setup();
    await seedDuplicates(t.db);
    const facts = await collectFacts(t.db, "briefing", new Date());
    const bad = facts.filter((f) => f.section === "Was ist kaputt").map((f) => f.text);
    expect(bad).toEqual(["1 Build-Fehler ist offen: NyxOS (3× in Folge)."]);
  });

  it("nur alte ENOENT-Läufe → Briefing sagt „keine roten Builds“", async () => {
    const t = await setup();
    const at = new Date().toISOString();
    for (let i = 0; i < 4; i++) await t.db.insert(buildRuns).values({ kind: "nyxos", command: "pnpm test", status: "red", exitCode: -1, logExcerpt: "\nFehler beim Starten: spawn pnpm ENOENT", trigger: "stop_hook", startedAt: at });
    const facts = await collectFacts(t.db, "briefing", new Date());
    expect(facts.find((f) => f.section === "Was ist kaputt")?.text).toBe("Keine Abstürze und keine offenen Build-Fehler.");
    expect((await buildItems(t.db)).needsYou.filter((i) => i.kind === "build")).toHaveLength(0);
  });

  it("Push: 4× derselbe rote Build → EINE Mitteilung, im Push-Protokoll ein Eintrag mit Zähler 4", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    // Ruhezeit aus (Start = Ende), damit der Test zu jeder Uhrzeit wirklich sendet.
    const settings = { ...(await loadOrInitSettings(t.db)), quietStart: "00:00", quietEnd: "00:00" };
    const send = async (input: PushNotifyInput) => notify(input, { db: t.db, sender, settings });
    const runner: BuildRunner = { run: async (_job: BuildJob) => ({ exitCode: 2, log: "src/x.ts(1,1): error TS2322: kaputt" }) };
    const queue = new BuildQueue(t.db, runner, (e) => notifyBuildDone(t.db, e, send));
    for (let i = 0; i < 4; i++) {
      const id = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["pnpm", "-r", "typecheck"], cwd: mkdtempSync(join(tmpdir(), "wt-")), trigger: "manual" });
      await queue.waitFor(id);
    }
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.title).toBe("Build rot: NyxOS");
    expect(sender.sent[0]?.message).not.toMatch(/TS2322/);
    const log = await t.db.select().from(pushLog).where(eq(pushLog.kind, "build_red"));
    expect(log).toHaveLength(1);
    expect(log[0]?.bundledCount).toBe(4);
    expect(log[0]?.message).toContain("4× seit");
  });

  it("Push: „nicht eingerichtet“ löst keine Mitteilung aus", async () => {
    const t = await setup();
    const send = vi.fn();
    const runner: BuildRunner = { run: async () => ({ exitCode: null, log: "x", unavailable: "Auf dem Rechner fehlt das Werkzeug „pnpm“." }) };
    const queue = new BuildQueue(t.db, runner, (e) => notifyBuildDone(t.db, e, send));
    const id = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["pnpm"], cwd: "/tmp", trigger: "manual" });
    await queue.waitFor(id);
    expect(send).not.toHaveBeenCalled();
  });

  it("formatBuildCount nutzt Berliner Zeit", () => {
    expect(formatBuildCount({ count: 4, firstAt: "2026-09-25T07:12:00Z", lastAt: "2026-09-25T08:00:00Z" })).toBe("4× seit 09:12");
  });
});
