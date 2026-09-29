// reine Logik der Konflikte-Seite (Gruppen, Entscheidungen, Seiten) und der Diffs.
import { describe, expect, it } from "vitest";
import type { CollisionEntry, Reservation } from "../src/conflicts.js";
import { areaGlobFor, buildConflictModel, folderKey, matchesConflictQuery, queryConflictEntries } from "../src/conflicts-model.js";
import { lineDiff, parseUnifiedDiff, structuredPatchToLines, toSplitRows } from "../src/diff.js";

function entry(path: string, state: CollisionEntry["state"], writers: string[] = [], reservation: Reservation | null = null): CollisionEntry {
  return { path, state, reason: null, reservation, writers: writers.map((k) => ({ sessionKey: k, title: `T-${k}`, firstSeenAt: "2026-09-25T05:00:00.000Z" })), readers: [] };
}

const base = { reservations: [], dismissals: new Map(), sessions: new Map(), version: "v1", generatedAt: "2026-09-25T08:00:00.000Z", bridgeOnline: true };

describe("folderKey", () => {
  it("3 Ebenen, repo-relativ, Worktrees eigene Gruppen", () => {
    expect(folderKey("apps/web/src/features/git/Git.tsx")).toBe("apps/web/src");
    expect(folderKey("README.md")).toBe("(Repo-Wurzel)");
    expect(folderKey("/Users/alex/projects/NyxOS/apps/bridge/src/config.ts")).toBe("NyxOS/apps/bridge");
    expect(folderKey("/Users/alex/code/shop/.worktrees/messenger/ios/Views/Foo.swift")).toBe("Worktree:messenger/ios/Views");
    expect(folderKey("/home/alex/shop/.claude/worktrees/agent-1/src/a.ts")).toBe("Worktree:agent-1/src");
  });
});

describe("areaGlobFor", () => {
  it("eine Datei → genau die Datei; mehrere → gemeinsamer Ordner", () => {
    expect(areaGlobFor(["/Users/c/projects/App/a.md"])).toBe("/Users/c/projects/App/a.md");
    expect(areaGlobFor(["/Users/c/projects/App/docs/x/a.md", "/Users/c/projects/App/docs/y/b.md"])).toBe("/Users/c/projects/App/docs/**");
    expect(areaGlobFor(["apps/web/a.ts", "apps/web/b/c.ts"])).toBe("apps/web/**");
  });
  it("nie der ganze projects-Ordner oder höher", () => {
    expect(areaGlobFor(["/Users/c/projects/memory.md", "/Users/c/projects/App/x.md"])).toBeNull();
    expect(areaGlobFor(["/Users/c/a.md", "/Users/d/b.md"])).toBeNull();
    expect(areaGlobFor(["a.md", "b/c.md"])).toBeNull();
  });
  it("nie ein ganzes Repo oder einen ganzen Worktree", () => {
    expect(areaGlobFor(["/Users/c/projects/App/a.md", "/Users/c/projects/App/b.md"])).toBeNull();
    expect(areaGlobFor(["/Users/c/projects/App/.worktrees/wt/a.md", "/Users/c/projects/App/.worktrees/wt/x/b.md"])).toBeNull();
    expect(areaGlobFor(["/Users/c/projects/NyxOS/a.md", "/Users/c/projects/NyxOS/b/c.md"])).toBeNull();
    expect(areaGlobFor(["/Users/c/projects/NyxOS/apps/a.md", "/Users/c/projects/NyxOS/apps/b/c.md"])).toBe("/Users/c/projects/NyxOS/apps/**");
    expect(areaGlobFor(["/Users/c/projects/App/.worktrees/wt/x/a.md", "/Users/c/projects/App/.worktrees/wt/x/b.md"])).toBe("/Users/c/projects/App/.worktrees/wt/x/**");
  });
});

describe("buildConflictModel", () => {
  const map = [
    entry("apps/web/src/features/git/Git.tsx", "conflict", ["claude:a", "claude:b"]),
    entry("apps/web/src/features/git/Server.tsx", "conflict", ["claude:b", "claude:a"]),
    entry("apps/web/src/App.tsx", "ok", ["claude:a"]),
    entry("apps/server/src/x.ts", "shared-read", ["claude:c"]),
  ];

  it("Konflikt-Gruppen zuerst, Entscheidung je (Ordner, Sessions)", () => {
    const m = buildConflictModel({ ...base, map });
    expect(m.summary.groups.map((g) => [g.key, g.conflictCount, g.fileCount])).toEqual([
      ["apps/web/src", 2, 3],
      ["apps/server/src", 0, 1],
    ]);
    expect(m.summary.decisions).toHaveLength(1);
    expect(m.summary.decisions[0]).toMatchObject({ key: "apps/web/src|claude:a+claude:b", fileCount: 2, areaGlob: "apps/web/src/features/git/**", status: "open", severity: "low" });
    expect(m.summary.totals).toEqual({ files: 4, conflicts: 2, sharedRead: 1, groups: 2, openDecisions: 1, past: 0 });
  });

  it("„past“ (nur noch höchstens eine Beteiligte lebt) zählt eigen – kein Konflikt, keine Entscheidung", () => {
    const m = buildConflictModel({ ...base, map: [...map, entry("apps/web/src/old.ts", "past", ["claude:a", "claude:d"])] });
    expect(m.summary.totals).toEqual({ files: 5, conflicts: 2, sharedRead: 1, groups: 2, openDecisions: 1, past: 1 });
    expect(m.summary.groups.find((g) => g.key === "apps/web/src")).toMatchObject({ conflictCount: 2, pastCount: 1, fileCount: 4 });
    expect(m.summary.decisions).toHaveLength(1);
  });

  it("Ignoriert/Erledigt und Reservierung ändern nur den Status, nicht die Karte", () => {
    const ignored = buildConflictModel({ ...base, map, dismissals: new Map([["apps/web/src|claude:a+claude:b", "ignored" as const]]) });
    expect(ignored.summary.decisions[0]?.status).toBe("ignored");
    expect(ignored.summary.totals.openDecisions).toBe(0);
    const res: Reservation = { id: 1, pathGlob: "apps/web/src/features/**", label: "Vorrang", sessionKey: "claude:a", createdAt: "", until: null };
    const reserved = buildConflictModel({ ...base, map, reservations: [res] });
    expect(reserved.summary.decisions[0]).toMatchObject({ status: "reserved", reservation: { id: 1 } });
    // Vorrang für eine DRITTE Session klärt die Frage zwischen A und B nicht.
    const third = buildConflictModel({ ...base, map, reservations: [{ ...res, sessionKey: "claude:zzz" }] });
    expect(third.summary.decisions[0]?.status).toBe("open");
  });

  it("Buchstaben A/B bleiben stabil, auch wenn sich die Dateizahlen ändern", () => {
    const one = buildConflictModel({ ...base, map: [entry("x/y/a.md", "conflict", ["claude:z", "claude:a"])] });
    const two = buildConflictModel({ ...base, map: [entry("x/y/a.md", "conflict", ["claude:z", "claude:a"]), entry("x/y/b.md", "conflict", ["claude:a", "claude:z"]), entry("x/y/c.md", "conflict", ["claude:z", "claude:a"])] });
    expect(one.summary.decisions[0]?.sessions.map((s) => s.sessionKey)).toEqual(["claude:a", "claude:z"]);
    expect(two.summary.decisions[0]?.sessions.map((s) => s.sessionKey)).toEqual(["claude:a", "claude:z"]);
  });

  it("fremdes Schreiben in reservierten Bereich ist eine eigene Entscheidung", () => {
    const res: Reservation = { id: 7, pathGlob: "apps/server/**", label: "P5", sessionKey: "claude:a", createdAt: "", until: null };
    const m = buildConflictModel({ ...base, map: [entry("apps/server/src/y.ts", "conflict", ["claude:z"], res)] });
    expect(m.summary.decisions[0]).toMatchObject({ kind: "reserved-area", key: "res7|claude:z", status: "open", reservation: { id: 7 } });
  });

  it("Seiten: Gruppe, Suche, Pfad, Obergrenze", () => {
    const m = buildConflictModel({ ...base, map });
    expect(queryConflictEntries(m, { group: "apps/web/src", offset: 1, limit: 1 })).toMatchObject({ total: 3, entries: [{ path: "apps/web/src/features/git/Server.tsx" }] });
    expect(queryConflictEntries(m, { q: "T-claude:c" }).total).toBe(1);
    expect(queryConflictEntries(m, { path: "apps/web/src/App.tsx" }).entries).toHaveLength(1);
    expect(queryConflictEntries(m, { limit: 10_000 }).limit).toBe(200);
    expect(matchesConflictQuery(map[0] as CollisionEntry, "features/git")).toBe(true);
  });

  it("3.500 Konflikte in unter 250 ms", () => {
    const many = Array.from({ length: 3500 }, (_, i) => entry(`/Users/c/projects/App/a-${i % 40}/s/f-${i}.md`, "conflict", ["claude:x", "claude:y"]));
    const t0 = performance.now();
    const m = buildConflictModel({ ...base, map: many });
    expect(performance.now() - t0).toBeLessThan(250);
    expect(m.summary.decisions).toHaveLength(40);
  });
});

describe("Diffs", () => {
  it("git diff → Zeilen mit Nummern", () => {
    const [f] = parseUnifiedDiff("diff --git a/x.md b/x.md\nindex 1..2 100644\n--- a/x.md\n+++ b/x.md\n@@ -3,3 +3,3 @@ kopf\n a\n-b\n+B\n c\n");
    expect(f?.newPath).toBe("x.md");
    expect(f?.lines.filter((l) => l.kind !== "hunk")).toEqual([
      { kind: "ctx", oldNo: 3, newNo: 3, text: "a" },
      { kind: "del", oldNo: 4, newNo: null, text: "b" },
      { kind: "add", oldNo: null, newNo: 4, text: "B" },
      { kind: "ctx", oldNo: 5, newNo: 5, text: "c" },
    ]);
  });

  it("mehrere Dateien und Binärdateien", () => {
    const files = parseUnifiedDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ\n");
    expect(files.map((f) => [f.newPath, f.binary])).toEqual([
      ["a", false],
      ["b.png", true],
    ]);
  });

  it("structuredPatch (Claude) behält echte Zeilennummern", () => {
    const lines = structuredPatchToLines([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [" a", "-b", "+c"] }]);
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["hunk", null, null],
      ["ctx", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
    ]);
  });

  it("lineDiff: Entfernen vor Hinzufügen, gemeinsame Zeilen bleiben", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n").map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
  });

  it("nebeneinander: Entfernen links, Hinzufügen rechts in einer Zeile", () => {
    const rows = toSplitRows(lineDiff("a\nb\n", "a\nB\nC\n"));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      [null, "C"],
    ]);
  });
});
