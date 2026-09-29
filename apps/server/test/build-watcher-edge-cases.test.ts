// Build-Wächter, Grenzfälle:
// - Push: gleichzeitig fertige gleiche Fehler → genau EINE Mitteilung; der Zähler landet am richtigen Eintrag.
// - Planung: iOS-Projekt/Worktree-Wurzel stimmt auch, wenn die Session in einem Unterordner arbeitet.
// - Neustart: Läufe, die beim Neustart noch liefen, bleiben nicht ewig „läuft“.
import type { PushNotifyInput } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { detectBuild } from "../src/builds/detect.js";
import { notifyBuildDone } from "../src/builds/notify.js";
import { BuildQueue, type BuildJob, type BuildRunner } from "../src/builds/queue.js";
import { buildRuns, pushLog } from "../src/db/schema.js";
import { notify } from "../src/push/dispatcher.js";
import { loadOrInitSettings } from "../src/push/settings.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

async function pushSetup() {
  const t = await setup();
  const sender = new FakeNtfySender();
  // Ruhezeit aus; die allgemeine Push-Bündelung (Fenster je Art) aus, damit hier nur die Build-Drossel wirkt.
  const settings = { ...(await loadOrInitSettings(t.db)), quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 };
  const send = async (input: PushNotifyInput) => notify(input, { db: t.db, sender, settings });
  return { ...t, sender, send };
}

const job = (cwd: string): BuildJob => ({ sessionKey: null, kind: "nyxos", command: ["pnpm", "-r", "typecheck"], cwd, trigger: "manual" });

describe("Push-Drossel", () => {
  it("drei gleiche Fehler werden gleichzeitig fertig → genau EINE Mitteilung", async () => {
    const t = await pushSetup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner: BuildRunner = {
      run: async () => {
        await gate;
        return { exitCode: 2, log: "src/x.ts(1,1): error TS2322: kaputt" };
      },
    };
    const queue = new BuildQueue(t.db, runner, (e) => notifyBuildDone(t.db, e, t.send));
    const ids = await Promise.all(["/wt/a", "/wt/b", "/wt/c"].map((cwd) => queue.submit(job(cwd))));
    release();
    for (const id of ids) await queue.waitFor(id);
    // onDone läuft nach dem Status-Update — kurz warten, bis alle drei Mitteilungs-Entscheidungen durch sind.
    await new Promise((r) => setTimeout(r, 200));
    expect(t.sender.sent).toHaveLength(1);
    const log = await t.db.select().from(pushLog).where(eq(pushLog.kind, "build_red"));
    expect(log).toHaveLength(1);
    expect(log[0]?.bundledCount).toBe(3);
  });

  it("zwei verschiedene Fehler: der Zähler des ersten landet an SEINEM Eintrag, nicht am jüngsten", async () => {
    const t = await pushSetup();
    const logs = ["src/x.ts(1,1): error TS2322: kaputt", "error: Die iOS-Signatur fehlt", "src/x.ts(9,9): error TS2322: kaputt"];
    const commands = [["pnpm", "-r", "typecheck"], ["pnpm", "test"], ["pnpm", "-r", "typecheck"]];
    let i = 0;
    const runner: BuildRunner = { run: async () => ({ exitCode: 2, log: logs[i++] ?? "" }) };
    const queue = new BuildQueue(t.db, runner, (e) => notifyBuildDone(t.db, e, t.send));
    for (const command of commands) {
      const id = await queue.submit({ ...job(`/wt/${command.length}`), command });
      await queue.waitFor(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(t.sender.sent).toHaveLength(2);
    const rows = await t.db.select().from(pushLog).where(eq(pushLog.kind, "build_red")).orderBy(pushLog.id);
    expect(rows.map((r) => r.bundledCount)).toEqual([2, 1]);
    expect(rows[0]?.message).toMatch(/^Der Typen-Check von NyxOS meldet Fehler\. · 2× seit/);
    expect(rows[1]?.message).toBe("Tests von NyxOS sind fehlgeschlagen.");
  });
});

describe("Planung", () => {
  it("NyxOS: Hauptordner = das ERSTE „/nyxos“ im Pfad (auch wenn ein Unterordner so heißt)", () => {
    expect(detectBuild("/Users/alex/code/NyxOS/apps/web/src/nyxos", "/builds")?.cwd).toBe("/Users/alex/code/NyxOS");
  });
});

describe("Neustart", () => {
  it("Läufe, die beim Neustart noch warteten/liefen, gelten danach als unterbrochen (nicht ewig „läuft“)", async () => {
    const t = await setup();
    const old = new Date(Date.now() - 60_000).toISOString();
    await t.db.insert(buildRuns).values([
      { kind: "nyxos", command: "pnpm -r typecheck", status: "running", trigger: "stop_hook", startedAt: old },
      { kind: "ios", command: "xcodebuild build", status: "queued", trigger: "stop_hook", startedAt: old },
    ]);
    const queue = new BuildQueue(t.db, { run: async () => ({ exitCode: 0, log: "" }) });
    await queue.recoverInterrupted();
    const rows = await t.db.select().from(buildRuns);
    expect(rows.map((r) => r.status)).toEqual(["unavailable", "unavailable"]);
    expect(rows[0]?.logExcerpt?.split("\n")[0]).toMatch(/unterbrochen/);
    expect(rows[0]?.endedAt).not.toBeNull();
  });
});
