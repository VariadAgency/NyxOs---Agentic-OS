import { describe, expect, it } from "vitest";
import { listDeploys, recordDeploy, toHealthSnapshot } from "../src/server/store.js";
import { setup } from "./helpers.js";

describe("Server-Tab", () => {
  it("deploy.sh meldet einen Deploy über POST /api/server/deploys", async () => {
    const { post } = await setup();
    const res = await post("/api/server/deploys", { gitRev: "abc1234", imageId: "sha256:xyz" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: { project: string; gitRev: string } };
    expect(body.deploy.project).toBe("nyxos");
    expect(body.deploy.gitRev).toBe("abc1234");
  });

  it("GET /api/server zeigt Docker-Zugriff explizit als blockiert (ESKALATION), keine erfundenen Container", async () => {
    const { app } = await setup();
    const res = await app.request("/api/server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docker: { available: boolean; reason: string | null }; containers: unknown[] };
    expect(body.docker.available).toBe(false);
    expect(body.docker.reason).toMatch(/Socket-Proxy/);
    expect(body.containers).toEqual([]);
  });

  it("die letzten 3 NyxOS-Deploys stimmen mit dem, was recordDeploy gespeichert hat, überein", async () => {
    const { db } = await setup();
    await recordDeploy(db, { project: "nyxos", containerName: "nyxos-api", imageId: "i1", gitRev: "r1", source: "deploy.sh" });
    await recordDeploy(db, { project: "nyxos", containerName: "nyxos-api", imageId: "i2", gitRev: "r2", source: "deploy.sh" });
    await recordDeploy(db, { project: "nyxos", containerName: "nyxos-api", imageId: "i3", gitRev: "r3", source: "deploy.sh" });
    const rows = await listDeploys(db, "nyxos", 3);
    expect(rows.map((r) => r.gitRev)).toEqual(["r3", "r2", "r1"]);
  });

  it("GET /api/server liefert dieselbe Gesundheitsprüfung wie /health, mit Grund je Teil (UX-B BLOCK 3)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/server");
    const body = (await res.json()) as { health: { ok: boolean; checks: Record<string, { ok: boolean; ms: number; error?: string }> } };
    expect(body.health.ok).toBe(true);
    expect(body.health.checks.database?.ok).toBe(true);
    expect(body.health.checks.schema?.ok).toBe(true);
    expect(body.health.checks.archive?.ok).toBe(true);
  });

  it("toHealthSnapshot übernimmt den Fehlergrund eines gestörten Teils (UX-B BLOCK 3: 'Server-Teil X gestört: <Grund>')", () => {
    const snap = toHealthSnapshot({
      ok: false,
      checks: { database: { ok: true, ms: 1 }, schema: { ok: false, ms: 2, error: "Migration 0010_usage_agents fehlt" }, archive: { ok: true, ms: 3 } },
    });
    expect(snap.ok).toBe(false);
    expect(snap.checks.schema.error).toBe("Migration 0010_usage_agents fehlt");
    expect(snap.checks.database.error).toBeUndefined();
  });

});
