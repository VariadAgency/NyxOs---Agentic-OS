import { describe, expect, it, vi } from "vitest";
import { derivedDataPathFor, detectBuild, type BuildFs } from "../../src/builds/detect.js";
import { BuildQueue, type BuildJob, type BuildRunner } from "../../src/builds/queue.js";
import { queueBuildsForStopSignals, stopSignalsFromBatch } from "../../src/builds/watcher.js";
import { buildRuns, sessions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { IngestItem } from "@nyxos/shared";
import { setup } from "../helpers.js";

/** Kleines Dateisystem für die Erkennung: Ordner → Einträge (Ordner enden auf „/“). */
function fakeFs(tree: Record<string, string[]>): BuildFs {
  return {
    isDir: (p) => p in tree,
    list: (p) => (tree[p] ?? []).map((n) => n.replace(/\/$/, "")),
    exists: (p) => {
      const cut = p.lastIndexOf("/");
      return (tree[p.slice(0, cut)] ?? []).includes(p.slice(cut + 1));
    },
  };
}

describe("builds/detect", () => {
  it("erkennt Xcode-Projekt, Swift-Paket und NyxOS am Arbeitsordner", () => {
    const fs = fakeFs({
      "/Users/alex/projects/shop": ["Shop.xcodeproj/", "Shop/", "README.md"],
      "/Users/alex/projects/shop/Shop": ["Views/"],
      "/Users/alex/projects/shop/Shop/Views": ["Home.swift"],
      "/Users/alex/projects/api": ["Package.swift", "Sources/"],
      "/Users/alex/projects/api/Sources": ["App/"],
      "/Users/alex/projects/notes": ["README.md"],
    });
    const ios = detectBuild("/Users/alex/projects/shop/Shop/Views", "/builds", fs);
    expect(ios?.kind).toBe("ios");
    expect(ios?.cwd).toBe("/Users/alex/projects/shop");
    expect(ios?.command.slice(0, 5)).toEqual(["xcodebuild", "build", "-project", "Shop.xcodeproj", "-scheme"]);
    expect(ios?.command[5]).toBe("Shop");
    expect(detectBuild("/Users/alex/projects/api/Sources", "/builds", fs)).toMatchObject({ kind: "backend", cwd: "/Users/alex/projects/api", command: ["swift", "test"] });
    expect(detectBuild("/Users/alex/code/nyxos/.worktrees/agent-1", "/builds", fs)).toMatchObject({ kind: "nyxos", cwd: "/Users/alex/code/nyxos/.worktrees/agent-1" });
    expect(detectBuild("/Users/alex/projects/notes", "/builds", fs)).toBeNull();
    expect(detectBuild(null, "/builds", fs)).toBeNull();
  });

  it("findet das Projekt auch eine Ebene unter dem Arbeitsordner (z. B. ios/)", () => {
    const fs = fakeFs({
      "/Users/alex/projects/app": ["ios/", "android/", "node_modules/"],
      "/Users/alex/projects/app/ios": ["App.xcodeproj/", "App/"],
      "/Users/alex/projects/app/android": [],
    });
    expect(detectBuild("/Users/alex/projects/app", "/builds", fs)).toMatchObject({ kind: "ios", cwd: "/Users/alex/projects/app/ios" });
  });

  it("ohne sichtbare Ordner (Server-Modus) gelten nur Pfad-Regeln", () => {
    const none = fakeFs({});
    expect(detectBuild("/home/alex/shop/backend/billing", "/builds", none)).toMatchObject({ kind: "backend", command: ["swift", "test"] });
    expect(detectBuild("/home/alex/shop/ios", "/builds", none)).toBeNull();
  });

  it("baut je Worktree einen eigenen DerivedData-Pfad — nie denselben für zwei Worktrees", () => {
    const a = derivedDataPathFor("/wt/a", "/builds");
    const b = derivedDataPathFor("/wt/b", "/builds");
    expect(a).not.toBe(b);
    expect(a.startsWith("/builds/derived-data/")).toBe(true);
    // NIE des Nutzers echter Xcode-Pfad.
    expect(a).not.toContain("Library/Developer/Xcode/DerivedData");
    // Derselbe Worktree bekommt immer denselben Pfad (inkrementeller Build).
    expect(derivedDataPathFor("/wt/a", "/builds")).toBe(a);
  });

  it("iOS bekommt -derivedDataPath, NyxOS den Typen-Check im Hauptordner", () => {
    const fs = fakeFs({ "/wt/a": ["A.xcodeproj/"] });
    const ios = detectBuild("/wt/a", "/builds", fs);
    expect(ios?.command).toContain("-derivedDataPath");
    expect(ios?.command[(ios?.command.indexOf("-derivedDataPath") ?? 0) + 1]).toBe(ios?.derivedDataPath);
    const nyxos = detectBuild("/Users/alex/code/NyxOS/.claude/worktrees/agent-1/apps/web", "/builds", fakeFs({}));
    expect(nyxos?.command).toEqual(["pnpm", "-r", "typecheck"]);
    expect(nyxos?.cwd).toBe("/Users/alex/code/NyxOS/.claude/worktrees/agent-1");
    expect(detectBuild("/Users/alex/code/NyxOS/apps/server", "/builds", fakeFs({}))?.cwd).toBe("/Users/alex/code/NyxOS");
  });
});

describe("builds/watcher stopSignalsFromBatch", () => {
  it("findet Stop- und task_complete-Hook-Ereignisse, ignoriert andere", () => {
    const items: IngestItem[] = [
      { type: "event", event: { id: "1", tool: "claude", sessionId: "abc", ts: new Date().toISOString(), kind: "hook", source: "hook", data: { event: "Stop", cwd: "/wt/a" } } },
      { type: "event", event: { id: "2", tool: "codex", sessionId: "xyz", ts: new Date().toISOString(), kind: "hook", source: "hook", data: { event: "task_complete", cwd: "/wt/b" } } },
      { type: "event", event: { id: "3", tool: "claude", sessionId: "abc", ts: new Date().toISOString(), kind: "hook", source: "hook", data: { event: "PreToolUse", cwd: "/wt/a" } } },
    ];
    const signals = stopSignalsFromBatch(items);
    expect(signals).toEqual([
      { sessionKey: "claude:abc", cwd: "/wt/a" },
      { sessionKey: "codex:xyz", cwd: "/wt/b" },
    ]);
  });
});

describe("builds/queue BuildQueue", () => {
  class ScriptedRunner implements BuildRunner {
    calls: BuildJob[] = [];
    active = 0;
    maxObservedActive = 0;
    constructor(public readonly exitCodes: number[]) {}
    async run(job: BuildJob) {
      this.calls.push(job);
      this.active++;
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active);
      await new Promise((r) => setTimeout(r, 30));
      this.active--;
      const exitCode = this.exitCodes.shift() ?? 0;
      return { exitCode, log: exitCode === 0 ? "alles grün\nOK" : "Fehler: Zeile kaputt\nExit 1" };
    }
  }

  it("höchstens ein iOS-Build gleichzeitig (Warteschlange), Backend darf parallel laufen", async () => {
    const { db } = await setup();
    const runner = new ScriptedRunner([0, 0, 0, 0]);
    const queue = new BuildQueue(db, runner);
    const iosJob = (n: number): BuildJob => ({ sessionKey: null, kind: "ios", command: ["true"], cwd: "/tmp", trigger: "manual" as const, derivedDataPath: `/tmp/dd-${n}` });
    const id1 = await queue.submit(iosJob(1));
    const id2 = await queue.submit(iosJob(2));
    await queue.waitFor(id1);
    await queue.waitFor(id2);
    expect(runner.maxObservedActive).toBe(1); // nie zwei gleichzeitig

    runner.maxObservedActive = 0;
    const backendJob = (): BuildJob => ({ sessionKey: null, kind: "backend", command: ["true"], cwd: "/tmp", trigger: "manual" as const });
    const b1 = await queue.submit(backendJob());
    const b2 = await queue.submit(backendJob());
    await queue.waitFor(b1);
    await queue.waitFor(b2);
    expect(runner.maxObservedActive).toBe(2); // Backend darf parallel
  });

  it("schreibt grün/rot + Log-Auszug in build_runs, ruft onDone bei rot", async () => {
    const { db } = await setup();
    const runner = new ScriptedRunner([0, 1]);
    const onDone = vi.fn();
    const queue = new BuildQueue(db, runner, onDone);
    const greenId = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["true"], cwd: "/tmp", trigger: "manual" });
    await queue.waitFor(greenId);
    const [greenRow] = await db.select().from(buildRuns).where(eq(buildRuns.id, greenId));
    expect(greenRow?.status).toBe("green");
    expect(greenRow?.exitCode).toBe(0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: greenId, status: "green" }));

    const redId = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["false"], cwd: "/tmp", trigger: "manual" });
    await queue.waitFor(redId);
    const [redRow] = await db.select().from(buildRuns).where(eq(buildRuns.id, redId));
    expect(redRow?.status).toBe("red");
    expect(redRow?.logExcerpt).toContain("Fehler");
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: redId, status: "red", kind: "nyxos" }));
  });

  it("eine absichtlich kaputte Prüfung wird rot gemeldet, nach Reparatur grün", async () => {
    const { db } = await setup();
    const runner = new ScriptedRunner([1]); // "kaputt"
    const queue = new BuildQueue(db, runner);
    const brokenId = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["false"], cwd: "/tmp", trigger: "stop_hook" });
    await queue.waitFor(brokenId);
    const [broken] = await db.select().from(buildRuns).where(eq(buildRuns.id, brokenId));
    expect(broken?.status).toBe("red");

    runner.exitCodes.push(0); // "repariert"
    const fixedId = await queue.submit({ sessionKey: null, kind: "nyxos", command: ["true"], cwd: "/tmp", trigger: "stop_hook" });
    await queue.waitFor(fixedId);
    const [fixed] = await db.select().from(buildRuns).where(eq(buildRuns.id, fixedId));
    expect(fixed?.status).toBe("green");
  });
});

describe("builds/watcher queueBuildsForStopSignals + Session-Zeile", () => {
  it("reiht nur Signale mit erkennbarem Ordner ein, ignoriert unbekannte Ordner", async () => {
    const { db } = await setup();
    await db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1" });
    class NoopRunner implements BuildRunner {
      async run() {
        return { exitCode: 0, log: "ok" };
      }
    }
    const queue = new BuildQueue(db, new NoopRunner());
    const ids = await queueBuildsForStopSignals(queue, "/builds", [
      { sessionKey: "claude:s1", cwd: "/Users/alex/code/nyxos" },
      { sessionKey: "claude:s1", cwd: "/Users/alex/docs-only-folder-that-does-not-exist" },
    ]);
    expect(ids).toHaveLength(1);
    const [row] = await db.select().from(buildRuns).where(eq(buildRuns.id, ids[0] as number));
    expect(row?.kind).toBe("nyxos");
    expect(row?.trigger).toBe("stop_hook");
  });
});
