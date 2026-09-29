// Build-Wächter — Routen. Registrierung in app.ts eine Zeile.
import { groupBuildRuns, type BuildRunRow, t } from "@nyxos/shared";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { buildRuns } from "../db/schema.js";
import { detectBuild } from "../builds/detect.js";
import type { BuildQueue } from "../builds/queue.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";

export interface BuildsRouteDeps {
  db: Db;
  queue: BuildQueue;
  buildsDir: string;
}

export function registerBuildsRoutes(app: Hono<Env>, deps: BuildsRouteDeps): void {
  const { db, queue, buildsDir } = deps;

  // Letzter Lauf je Session (Session-Panel) oder insgesamt (Überblick-Einzeiler, P5 bindet das ein).
  app.get("/api/builds", async (c) => {
    const sessionKey = c.req.query("sessionKey");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
    const rows = sessionKey
      ? await db.select().from(buildRuns).where(eq(buildRuns.sessionKey, sessionKey)).orderBy(desc(buildRuns.startedAt)).limit(limit)
      : await db.select().from(buildRuns).orderBy(desc(buildRuns.startedAt)).limit(limit);
    return c.json({ runs: rows });
  });

  // "auf Knopfdruck" — Body `{ sessionKey, cwd }`, `cwd` z. B. der Worktree-Pfad
  // aus der Session-Zeile; ohne erkennbare Art (kein iOS/Backend/NyxOS-Ordner) → 422.
  app.post("/api/builds/run", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const cwd = typeof b.cwd === "string" ? b.cwd : null;
    const sessionKey = typeof b.sessionKey === "string" ? b.sessionKey : null;
    const plan = detectBuild(cwd, buildsDir);
    if (!plan) return c.json({ error: t("Kein bekannter Build-Ordner (Xcode-Projekt, Swift-Paket oder NyxOS)") }, 422);
    const id = await queue.submit({ sessionKey, kind: plan.kind, command: plan.command, cwd: plan.cwd, derivedDataPath: plan.derivedDataPath, trigger: "manual" });
    return c.json({ id, kind: plan.kind, command: plan.command });
  });

  // Rohdaten für den Überblick-Einzeiler/Sparkline (P5 baut die Anzeige) — die letzten Läufe insgesamt.
  // MUSS vor `/api/builds/:id` registriert sein — sonst matcht Hono "summary" als `:id` (→ 400
  // "Ungültige ID", beobachtet beim ersten echten Einbau von RecentBuilds/P8-sichtbar).
  // `groups` = gleiche Fehler zu einem Eintrag gebündelt (Zähler, erste/letzte Zeit, Satz in
  // einfacher Sprache, Rohmeldung unter `details`). Alte Dubletten bleiben in der DB, gebündelt wird hier.
  app.get("/api/builds/summary", async (c) => {
    const rows = await db.select().from(buildRuns).orderBy(desc(buildRuns.startedAt)).limit(60);
    return c.json({ recent: rows, groups: groupBuildRuns(rows as BuildRunRow[]) });
  });

  app.get("/api/builds/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const [row] = await db.select().from(buildRuns).where(eq(buildRuns.id, id)).limit(1);
    if (!row) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(row);
  });
}
