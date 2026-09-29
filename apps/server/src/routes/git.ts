// Routen des Git-Tabs (Registrierung hier, Logik in ../git/*.ts).
import { GitScanProgressSchema, GitSnapshotPayloadSchema, type GitScanProgress, t } from "@nyxos/shared";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BridgePresence } from "../bridge/presence.js";
import type { Db } from "../db/client.js";
import type { GraphService } from "../graph/service.js";
import { getBranchDetail, getCommitDetail, getCommitsOfDay, getGitDashboard, getWorktreeDetail, sessionCwds } from "../git/dashboard.js";
import { getCatchupHistory, getGitSnapshot, upsertGitSnapshot } from "../git/store.js";

type Env = { Variables: { machineId: string } };

export function registerGitRoutes(app: Hono<Env>, ctx: { db: Db; auth: MiddlewareHandler<Env>; graph?: GraphService; presence?: BridgePresence }): void {
  const { db, auth, graph, presence } = ctx;
  /** letzter Fortschritt der Brücke („Brücke scannt gerade … 3 von 12“). Nur im Speicher —
   * nach einem Server-Neustart meldet die Brücke beim nächsten Lauf neu. */
  let progress: GitScanProgress | null = null;

  // Die Brücke schickt hier ihre Momentaufnahme (Token-Auth wie /ingest/events). Beim ersten Lauf
  // ist das die 90-Tage-Historie aller Repos (~1 MB), danach nur Neues.
  app.post("/ingest/git", auth, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = GitSnapshotPayloadSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Momentaufnahme"), issues: parsed.error.issues.slice(0, 5) }, 400);
    await upsertGitSnapshot(db, parsed.data);
    // PG-Zusammenbau: jede Git-Momentaufnahme kann neue Commits/Zweige liefern → Graph-Quelle
    // "git" neu einlesen (nur diese, s. GraphService.markDirty).
    graph?.markDirty(["git"]);
    return c.json({ ok: true, repos: parsed.data.repos.length });
  });

  // Fortschritt eines Brücken-Laufs.
  app.post("/ingest/git/progress", auth, async (c) => {
    const parsed = GitScanProgressSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("Ungültiger Fortschritt") }, 400);
    progress = parsed.data;
    return c.json({ ok: true });
  });

  // Ordner, in denen Sessions gearbeitet haben — die Brücke findet darüber weitere Repos.
  app.get("/ingest/git/roots", auth, async (c) => c.json({ cwds: await sessionCwds(db) }));

  app.get("/api/git", async (c) => {
    return c.json(await getGitSnapshot(db));
  });

  // alles für die neue Git-Seite in einer Antwort.
  app.get("/api/git/dashboard", async (c) => {
    const view = presence?.view();
    return c.json(await getGitDashboard(db, { progress, bridge: view ? { state: view.state, reason: view.reason } : undefined }));
  });

  // Großansichten (Commit → Dateien + Session, Zweig → Commits, Worktree → Sessions).
  app.get("/api/git/commit/:repoId/:sha", async (c) => {
    const detail = await getCommitDetail(db, c.req.param("repoId"), c.req.param("sha"));
    return detail ? c.json(detail) : c.json({ error: t("Diesen Commit kennt NyxOS (noch) nicht.") }, 404);
  });
  app.get("/api/git/commits", async (c) => {
    const rows = await getCommitsOfDay(db, c.req.query("day") ?? "");
    return rows ? c.json({ commits: rows }) : c.json({ error: t("Ungültiger Tag") }, 400);
  });
  app.get("/api/git/branch/:repoId", async (c) => {
    const detail = await getBranchDetail(db, c.req.param("repoId"), c.req.query("name") ?? "");
    return detail ? c.json(detail) : c.json({ error: t("Diesen Zweig gibt es nicht mehr.") }, 404);
  });
  app.get("/api/git/worktree/:repoId", async (c) => {
    const detail = await getWorktreeDetail(db, c.req.param("repoId"));
    return detail ? c.json(detail) : c.json({ error: t("Diese Worktree gibt es nicht mehr.") }, 404);
  });

  // Verlauf fürs Konflikte-Tab.
  app.get("/api/git/catchups", async (c) => {
    return c.json({ catchups: await getCatchupHistory(db, c.req.query("repoId") ?? undefined) });
  });
}
