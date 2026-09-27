// Build-Wächter: Einordnung (klarer Satz statt Technik-Meldung) und Bündelung gleicher Fehler.
import { describe, expect, it } from "vitest";
import { describeBuildRun, formatBuildCount, groupBuildRuns, type BuildRunRow } from "../src/builds.js";

let nextId = 1;
function row(p: Partial<BuildRunRow> & Pick<BuildRunRow, "status" | "startedAt">): BuildRunRow {
  return {
    id: nextId++,
    sessionKey: "claude:s1",
    kind: "nyxos",
    command: "pnpm -r typecheck",
    exitCode: p.status === "green" ? 0 : p.status === "red" ? 2 : null,
    logExcerpt: null,
    derivedDataPath: null,
    trigger: "stop_hook",
    endedAt: p.startedAt,
    ...p,
  };
}

// Zeilen im Format echter Altdaten aus der Produktion (wie GET /api/builds/summary sie liefert).
const legacyEnoent = (startedAt: string, sessionKey = "claude:00903b73") =>
  row({ status: "red", command: "pnpm test", exitCode: -1, logExcerpt: "\nFehler beim Starten: spawn pnpm ENOENT", startedAt, sessionKey });

describe("describeBuildRun", () => {
  it("alte Server-Läufe mit „spawn pnpm ENOENT“ sind KEIN roter Build, sondern „nicht eingerichtet“ in einfacher Sprache", () => {
    const v = describeBuildRun(legacyEnoent("2026-09-25T08:27:30.368Z"));
    expect(v.state).toBe("unavailable");
    expect(v.headline).toBe("Build-Prüfung nicht eingerichtet: NyxOS");
    expect(v.sentence).not.toMatch(/ENOENT|spawn/);
    // Die Rohmeldung bleibt für „Details“ erhalten.
    expect(v.details).toContain("spawn pnpm ENOENT");
  });

  it("neue „nicht eingerichtet“-Läufe tragen ihren Satz in der ersten Zeile", () => {
    const v = describeBuildRun(row({ status: "unavailable", logExcerpt: "Auf dem Rechner fehlt das Werkzeug „pnpm“.\nspawn pnpm ENOENT", startedAt: "2026-09-25T09:00:00Z" }));
    expect(v.state).toBe("unavailable");
    expect(v.sentence).toBe("Auf dem Rechner fehlt das Werkzeug „pnpm“.");
    expect(v.details).toBe("spawn pnpm ENOENT");
  });

  it("ein echter roter Lauf, dessen Log irgendwo „spawn … ENOENT“ enthält, bleibt ROT", () => {
    const v = describeBuildRun(row({ status: "red", command: "pnpm test", logExcerpt: "FAIL test/x.test.ts\nError: spawn git ENOENT\n Tests  1 failed", startedAt: "2026-09-25T09:00:00Z" }));
    expect(v.state).toBe("red");
  });

  it("ein echter roter Typen-Check bekommt einen verständlichen Satz, das Log liegt unter Details", () => {
    const v = describeBuildRun(row({ status: "red", logExcerpt: "src/a.ts(3,1): error TS2322: Type 'string' is not assignable\n ELIFECYCLE Command failed with exit code 2.", startedAt: "2026-09-25T09:00:00Z" }));
    expect(v.state).toBe("red");
    expect(v.headline).toBe("Build rot: NyxOS");
    expect(v.sentence).toBe("Der Typen-Check von NyxOS meldet Fehler.");
    expect(v.details).toContain("TS2322");
  });
});

describe("groupBuildRuns (Bündelung)", () => {
  it("4× derselbe Fehler (gleiches Projekt, gleiche Signatur) = EIN Eintrag mit Zähler, erster und letzter Zeit", () => {
    const rows = [
      legacyEnoent("2026-09-25T09:20:06.413Z"),
      legacyEnoent("2026-09-25T09:19:36.464Z"),
      legacyEnoent("2026-09-25T09:13:27.827Z", "claude:2b9bdaed"),
      legacyEnoent("2026-09-25T09:12:47.633Z"),
    ];
    const groups = groupBuildRuns(rows);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g?.count).toBe(4);
    expect(g?.state).toBe("unavailable");
    expect(g?.firstAt).toBe("2026-09-25T09:12:47.633Z");
    expect(g?.lastAt).toBe("2026-09-25T09:20:06.413Z");
    expect(g?.lastId).toBe(rows[0]?.id);
    expect(g?.sessionKeys.sort()).toEqual(["claude:00903b73", "claude:2b9bdaed"]);
    if (!g) throw new Error("Gruppe fehlt");
    expect(formatBuildCount(g)).toBe("4× seit 11:12");
  });

  it("gleicher Fehler in zwei Worktrees (nur Pfad/Zeilennummer anders) wird gebündelt, ein anderer Fehler nicht", () => {
    const a = row({ status: "red", logExcerpt: "/Users/alex/wt/a/apps/server/src/x.ts(12,3): error TS2322: kaputt", startedAt: "2026-09-25T09:00:00Z" });
    const b = row({ status: "red", logExcerpt: "/Users/alex/wt/b/apps/server/src/x.ts(14,3): error TS2322: kaputt", startedAt: "2026-09-25T09:05:00Z" });
    const c = row({ status: "red", logExcerpt: "error TS2304: Cannot find name 'foo'", startedAt: "2026-09-25T09:06:00Z" });
    const d = row({ status: "red", kind: "ios", command: "xcodebuild build", logExcerpt: "error TS2322: kaputt", startedAt: "2026-09-25T09:07:00Z" });
    const groups = groupBuildRuns([a, b, c, d]);
    expect(groups.map((g) => [g.kind, g.count])).toEqual([
      ["ios", 1],
      ["nyxos", 1],
      ["nyxos", 2],
    ]);
  });

  it("gleicher iOS-Fehler in zwei Worktrees wird gebündelt (Pfade im Befehl zählen nicht)", () => {
    const cmd = (wt: string) => `xcodebuild build -project /Users/c/.worktrees/${wt}/Xcode/Shop MVP App/Shop MVP App.xcodeproj -scheme Shop MVP App -destination generic/platform=iOS Simulator -derivedDataPath /builds/derived-data/${wt}`;
    const a = row({ status: "red", kind: "ios", command: cmd("a"), logExcerpt: "/Users/c/a/X.swift:3:1: error: cannot find 'foo' in scope", startedAt: "2026-09-25T09:00:00Z" });
    const b = row({ status: "red", kind: "ios", command: cmd("b"), logExcerpt: "/Users/c/b/X.swift:3:1: error: cannot find 'foo' in scope", startedAt: "2026-09-25T09:05:00Z" });
    expect(groupBuildRuns([a, b]).map((g) => g.count)).toEqual([2]);
  });

  it("grüne Läufe desselben Projekts werden ebenfalls zusammengefasst, laufende nie", () => {
    const groups = groupBuildRuns([
      row({ status: "running", startedAt: "2026-09-25T09:10:00Z" }),
      row({ status: "green", startedAt: "2026-09-25T09:09:00Z" }),
      row({ status: "green", startedAt: "2026-09-25T09:08:00Z" }),
      row({ status: "running", startedAt: "2026-09-25T09:07:00Z" }),
    ]);
    expect(groups.map((g) => [g.state, g.count])).toEqual([
      ["running", 1],
      ["green", 2],
      ["running", 1],
    ]);
    const [running, green] = groups;
    if (!running || !green) throw new Error("Gruppen fehlen");
    expect(formatBuildCount(green)).toBe("2× seit 11:08");
    expect(formatBuildCount(running)).toBe("um 11:10");
  });
});
