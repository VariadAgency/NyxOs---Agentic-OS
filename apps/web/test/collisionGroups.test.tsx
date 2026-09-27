import { describe, expect, it } from "vitest";
import { folderKey, sessionColor, sessionColorIndex, SESSION_PALETTE } from "../src/features/conflicts/collisionGroups";

describe("folderKey (Ordner-Gruppierung, 2–3 Ebenen)", () => {
  it("nimmt die ersten 3 Ordner-Ebenen, nie den Dateinamen", () => {
    expect(folderKey("apps/web/src/features/git/Git.tsx")).toBe("apps/web/src");
  });
  it("Datei in der Wurzel bekommt eine eigene Gruppe", () => {
    expect(folderKey("README.md")).toBe("(Repo-Wurzel)");
  });

  // `session_files.path` ist ABSOLUT. Ohne den Zuschnitt aufs Repo kollabierten alle Repos eines
  // Nutzers in eine einzige Gruppe "Users/<name>/…".
  it("schneidet den absoluten Home-Pfad ab dem Repo-Namen zurecht", () => {
    expect(folderKey("/Users/alex/projects/demo/apps/bridge/src/config.ts")).toBe("demo/apps/bridge");
    expect(folderKey("/home/alex/shop/backend/Sources/Foo.swift")).toBe("shop/backend/Sources");
  });

  it("jeder Worktree unter <repo>/.worktrees bekommt seine eigene Gruppe (nicht alle zusammen)", () => {
    expect(folderKey("/Users/alex/projects/demo/.worktrees/notifications/ios/Foo.swift")).toBe("Worktree:notifications/ios");
    expect(folderKey("/Users/alex/projects/demo/.worktrees/messenger/ios/Foo.swift")).not.toBe(folderKey("/Users/alex/projects/demo/.worktrees/notifications/ios/Foo.swift"));
  });

  it("ein schon repo-relativer Pfad bleibt unverändert (z. B. in Tests/Fixtures)", () => {
    expect(folderKey("apps/web/src/features/git/Git.tsx")).toBe("apps/web/src");
  });
});

describe("sessionColor (Session-Farbpunkte)", () => {
  it("ist stabil für dieselbe Session", () => {
    expect(sessionColor("claude:abc")).toBe(sessionColor("claude:abc"));
  });
  it("liegt in der kategorialen Palette", () => {
    expect(SESSION_PALETTE).toContain(sessionColor("claude:abc"));
  });
  it("Index bleibt innerhalb der Palettengröße", () => {
    for (const key of ["a", "claude:x", "codex:y-z-1"]) expect(sessionColorIndex(key)).toBeLessThan(SESSION_PALETTE.length);
  });
});
