// Reiter „Dateien“ — alle Dateien, die Sessions angefasst haben, nach Bereich/Ordner, mit
// Sessions, letzter Berührung, Suche und Klick → Session.
import type { FileSessions, FilesOverview } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { sessionFiles, sessions } from "../src/db/schema.js";
import { classifyPath } from "../src/files/query.js";
import { setup } from "./helpers.js";

async function j<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const R = "/Users/alex/projects";

describe("classifyPath", () => {
  it("ordnet Bereiche zu: Projekte ab dem Repo-Namen, Worktrees mit ihrem Namen als erste Ebene, sonst außerhalb", () => {
    expect(classifyPath(`${R}/shop/backend/services/x/main.go`)).toEqual({ area: "projekte", rel: "shop/backend/services/x/main.go", folder: "shop/backend/services", name: "main.go" });
    expect(classifyPath(`${R}/shop/.worktrees/heatmap/ios/a.swift`)).toMatchObject({ area: "worktrees", folder: "heatmap/ios", name: "a.swift" });
    expect(classifyPath("/Users/alex/code/NyxOS/.claude/worktrees/agent-1/apps/x.ts")).toMatchObject({ area: "worktrees", folder: "agent-1/apps", name: "x.ts" });
    expect(classifyPath("/home/alex/NyxOS/apps/web/src/App.tsx")).toMatchObject({ area: "projekte", folder: "NyxOS/apps/web", name: "App.tsx" });
    expect(classifyPath("/Users/alex/.claude/settings.json")).toMatchObject({ area: "sonstiges", rel: "~/.claude/settings.json" });
    expect(classifyPath("/tmp/x.txt")).toMatchObject({ area: "sonstiges", rel: "tmp/x.txt" });
  });
});

describe("GET /api/files", () => {
  async function world() {
    const t = await setup();
    await t.db.insert(sessions).values([
      { id: "claude:a", tool: "claude", sessionId: "a", title: "Heatmap bauen", categoryArt: "coding", categoryBaustelleSlug: "heatmap", lastActivityAt: "2026-09-25T10:00:00Z" },
      { id: "codex:b", tool: "codex", sessionId: "b", title: "Review", lastActivityAt: "2026-09-25T11:00:00Z" },
    ]);
    await t.db.insert(sessionFiles).values([
      { sessionKey: "claude:a", path: `${R}/shop/ios/Heatmap.swift`, mode: "write", firstSeenAt: "2026-09-25T09:00:00Z" },
      { sessionKey: "codex:b", path: `${R}/shop/ios/Heatmap.swift`, mode: "read", firstSeenAt: "2026-09-25T11:00:00Z" },
      { sessionKey: "codex:b", path: `${R}/nyxos/.worktrees/docs/README.md`, mode: "read", firstSeenAt: "2026-09-25T08:00:00Z" },
    ]);
    return t;
  }

  it("liefert Dateien mit Sessions-Zahl, geändert/gelesen und letzter Berührung, neueste zuerst", async () => {
    const t = await world();
    const body = await j<FilesOverview>(await t.app.request("/api/files"));
    expect(body.total).toBe(2);
    expect(body.sessions).toBe(2);
    expect(body.files.map((f) => f.name)).toEqual(["Heatmap.swift", "README.md"]);
    expect(body.files[0]).toMatchObject({ area: "projekte", folder: "shop/ios", changed: true, read: true, sessions: 2, lastAt: "2026-09-25T11:00:00.000Z" });
    expect(body.areas.map((a) => [a.id, a.files, a.changed])).toEqual([
      ["projekte", 1, 1],
      ["worktrees", 1, 0],
    ]);
  });

  it("Suche, Art und Bereich filtern", async () => {
    const t = await world();
    expect((await j<FilesOverview>(await t.app.request("/api/files?q=heat"))).files.map((f) => f.name)).toEqual(["Heatmap.swift"]);
    expect((await j<FilesOverview>(await t.app.request("/api/files?mode=gelesen"))).files.map((f) => f.name)).toEqual(["README.md"]);
    expect((await j<FilesOverview>(await t.app.request("/api/files?mode=geaendert"))).sessions).toBe(1);
    const nyxos = await j<FilesOverview>(await t.app.request("/api/files?area=worktrees"));
    expect(nyxos.files.map((f) => f.name)).toEqual(["README.md"]);
    expect(nyxos.total).toBe(2); // Gesamtzahl über alle Bereiche, Bereich filtert nur die Liste
    expect((await j<FilesOverview>(await t.app.request("/api/files?q=%25"))).files).toHaveLength(0); // % ist kein Platzhalter
  });

  it("Sessions einer Datei mit Link zur Session", async () => {
    const t = await world();
    const body = await j<FileSessions>(await t.app.request(`/api/files/sessions?path=${encodeURIComponent(`${R}/shop/ios/Heatmap.swift`)}`));
    expect(body.sessions.map((s) => [s.key, s.modes, s.href])).toEqual([
      ["codex:b", ["read"], "/sessions/unsortiert/_/b"],
      ["claude:a", ["write"], "/sessions/coding/heatmap/a"],
    ]);
  });

  it("ohne Pfad 400 mit einfachem Satz (nicht 404 — die Route gibt es ja)", async () => {
    const t = await world();
    for (const q of ["", "?path=", `?path=${"x".repeat(2001)}`]) {
      const res = await t.app.request(`/api/files/sessions${q}`);
      expect(res.status, q.slice(0, 12)).toBe(400);
      const body = await j<{ error: string }>(res);
      expect(body.error).toMatch(/^Welche Datei\?/);
      expect(body.error).not.toMatch(/Query|path|nicht gefunden/i);
    }
  });

  it("unbekannte /api-Route → 404 mit Kennung route_unknown (unterscheidbar vom 404 einer Route)", async () => {
    const t = await world();
    const res = await t.app.request("/api/gibt-es-nicht");
    expect(res.status).toBe(404);
    expect(await j<{ code?: string }>(res)).toMatchObject({ code: "route_unknown" });
    const known = await t.app.request("/api/entries/999999");
    expect(known.status).toBe(404);
    expect((await j<{ code?: string }>(known)).code).toBeUndefined();
  });
});
