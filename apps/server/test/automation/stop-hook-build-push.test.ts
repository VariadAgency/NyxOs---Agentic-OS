// End-zu-Ende: ein echter Stop-Hook durch /ingest/events löst einen Build aus, ein roter
// Build löst eine Push-Mitteilung aus — Build-Erkennung, Build-Lauf und Push im Zusammenspiel.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BuildQueue, type BuildJob, type BuildRunner } from "../../src/builds/queue.js";
import { buildRuns, pushLog, sessions } from "../../src/db/schema.js";
import { setup } from "../helpers.js";
import { FakeNtfySender } from "./fakes.js";

class ScriptedRunner implements BuildRunner {
  constructor(private readonly exitCode: number) {}
  async run(_job: BuildJob) {
    return { exitCode: this.exitCode, log: this.exitCode === 0 ? "OK" : "Fehler: irgendwas kaputt" };
  }
}

describe("Ende-zu-Ende: Stop-Hook -> Build -> Push", () => {
  it("ein Stop-Hook mit NyxOS-Arbeitsordner reiht einen Build ein; wird er rot, kommt eine Push-Mitteilung", async () => {
    const sender = new FakeNtfySender();
    const t = await setup({ pushSender: sender });
    await t.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1" });
    // eigene Queue mit demselben db, aber einem Fake-Runner (kein echtes `pnpm test` im Test).
    const runner = new ScriptedRunner(1); // "rot"
    let doneResolve: (() => void) | null = null;
    const done = new Promise<void>((r) => (doneResolve = r));
    const queue = new BuildQueue(t.db, runner, async (event) => {
      if (event.status === "red") {
        const { notify } = await import("../../src/push/dispatcher.js");
        const { loadOrInitSettings } = await import("../../src/push/settings.js");
        const settings = await loadOrInitSettings(t.db);
        // Feste Mittags-Uhrzeit statt der echten Wanduhr (sonst wackelt der Test in der Ruhezeit).
        await notify({ kind: "build_red", title: "Build rot", message: event.logExcerpt }, { db: t.db, sender, settings, now: new Date(2026, 0, 1, 12, 0) });
      }
      doneResolve?.();
    });
    // Zweite App-Instanz, die genau diese Queue nutzt (setup() baute ihre eigene) — wir testen hier
    // gezielt nur die watcher-Funktion + Queue zusammen, nicht die HTTP-Route erneut (die ist in
    // server.test.ts/builds.test.ts schon abgedeckt).
    const { queueBuildsForStopSignals, stopSignalsFromBatch } = await import("../../src/builds/watcher.js");
    const signals = stopSignalsFromBatch([
      { type: "event", event: { id: "e1", tool: "claude", sessionId: "s1", ts: new Date().toISOString(), kind: "hook", source: "hook", data: { event: "Stop", cwd: "/Users/alex/projects/tools/NyxOS" } } },
    ]);
    const ids = await queueBuildsForStopSignals(queue, "/builds", signals);
    expect(ids).toHaveLength(1);
    await done;

    const [row] = await t.db.select().from(buildRuns).where(eq(buildRuns.id, ids[0] as number));
    expect(row?.status).toBe("red");
    expect(row?.kind).toBe("nyxos");

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.title).toContain("Build rot");
    const log = await t.db.select().from(pushLog).where(eq(pushLog.kind, "build_red"));
    expect(log).toHaveLength(1);
  });
});
