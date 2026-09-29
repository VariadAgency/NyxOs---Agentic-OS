import { describe, expect, it } from "vitest";
import { branchInfoFrom, parseAheadBehindCount, parseForEachRefBranches, parseLog, parseStatusPorcelainV2, parseTags, parseWorktreeListPorcelain } from "../src/git/parse.js";

describe("Git-Parser (reine Funktionen, ohne echtes git)", () => {
  it("parseStatusPorcelainV2: gruppiert Doku/Projekt/Code/Verschoben + erkennt untracked", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feature/messenger-e2ee",
      "# branch.upstream origin/feature/messenger-e2ee",
      "# branch.ab +1 -0",
      "1 .M N... 100644 100644 100644 h h AGENTS.md",
      "1 .M N... 100644 100644 100644 h h backend/BACKEND_STATUS.md",
      "1 .M N... 100644 100644 100644 h h Xcode/App.xcodeproj/project.pbxproj",
      "1 .M N... 100644 100644 100644 h h apps/server/src/app.ts",
      "2 R. N... 100644 100644 100644 h h R100 new/path.ts\told/path.ts",
      "? untracked-note.md",
    ].join("\n");
    const { currentBranch, files } = parseStatusPorcelainV2(out);
    expect(currentBranch).toBe("feature/messenger-e2ee");
    expect(files.find((f) => f.path === "AGENTS.md")?.group).toBe("doku");
    expect(files.find((f) => f.path === "backend/BACKEND_STATUS.md")?.group).toBe("doku");
    expect(files.find((f) => f.path.endsWith(".pbxproj"))?.group).toBe("projekt");
    expect(files.find((f) => f.path === "apps/server/src/app.ts")?.group).toBe("code");
    const renamed = files.find((f) => f.path === "new/path.ts");
    expect(renamed?.group).toBe("verschoben");
    expect(renamed?.fromPath).toBe("old/path.ts");
    expect(files.find((f) => f.path === "untracked-note.md")?.group).toBe("doku");
  });

  it("parseStatusPorcelainV2: detached HEAD → currentBranch null", () => {
    const { currentBranch } = parseStatusPorcelainV2("# branch.oid abc\n# branch.head (detached)\n");
    expect(currentBranch).toBeNull();
  });

  it("parseForEachRefBranches + branchInfoFrom", () => {
    const refs = parseForEachRefBranches(["main|2026-09-20T10:00:00+02:00|origin/main|", "feature/x|2026-09-24T08:00:00+02:00|origin/feature/x|*"].join("\n"));
    expect(refs).toHaveLength(2);
    const [, second] = refs;
    expect(second).toEqual({ name: "feature/x", lastCommitAt: "2026-09-24T08:00:00+02:00", upstream: "origin/feature/x", isCurrent: true });
    if (!second) throw new Error("zweiter Zweig fehlt");
    const info = branchInfoFrom(second, { ahead: 3, behind: 1 });
    expect(info).toEqual({ name: "feature/x", ahead: 3, behind: 1, isCurrent: true, lastCommitAt: "2026-09-24T08:00:00+02:00", upstream: "origin/feature/x" });
  });

  it("parseAheadBehindCount: links=behind, rechts=ahead", () => {
    expect(parseAheadBehindCount("3\t7\n")).toEqual({ behind: 3, ahead: 7 });
    expect(parseAheadBehindCount("0\t0")).toEqual({ behind: 0, ahead: 0 });
  });

  it("parseLog: Feld-Trenner \\x01, auch bei Commit-Nachrichten mit '|'", () => {
    const line = `abc123\x012026-09-24T10:00:00+02:00\x01feat: A | B geht`;
    const rows = parseLog(line, "main");
    expect(rows).toEqual([{ sha: "abc123", authorDate: "2026-09-24T10:00:00+02:00", subject: "feat: A | B geht", branch: "main" }]);
  });

  it("parseWorktreeListPorcelain: mehrere Blöcke, Haupt-Repo + Worktrees", () => {
    const out = [
      "worktree /Users/alex/code/app",
      "HEAD a389274d",
      "branch refs/heads/feature/messenger-e2ee",
      "",
      "worktree /Users/alex/code/app/.worktrees/notifications",
      "HEAD ed3e7ad0",
      "branch refs/heads/feat/notification-service",
      "",
      "worktree /Users/alex/code/app/.worktrees/locked-one",
      "HEAD deadbeef",
      "detached",
      "locked irgendein Grund",
      "",
    ].join("\n");
    const wts = parseWorktreeListPorcelain(out);
    expect(wts).toHaveLength(3);
    expect(wts[1]).toEqual({ path: "/Users/alex/code/app/.worktrees/notifications", branch: "feat/notification-service", headSha: "ed3e7ad0", locked: false });
    expect(wts[2]?.locked).toBe(true);
    expect(wts[2]?.branch).toBeNull();
  });

  it("parseTags: filtert Leerzeilen", () => {
    expect(parseTags("v1.2\nv1.1\n\n")).toEqual(["v1.2", "v1.1"]);
  });
});
