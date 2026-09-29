// Leitplanken: Freigabe-Anfragen (Hook → Server) und Entscheidung (Web → Server).
import type { Approval, GuardCheck, GuardCheckResult } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { approveAllPending, commandHash } from "../../src/approvals/store.js";
import { approvals, pushLog } from "../../src/db/schema.js";
import { setup } from "../helpers.js";
import { FakeNtfySender } from "../automation/fakes.js";

const check = (over: Partial<GuardCheck> = {}): GuardCheck => ({
  tool: "Bash",
  command: "git push origin HEAD",
  cwd: "/tmp/wt-t01",
  sessionId: "sess-1",
  auftrag: "T-01",
  worktree: "/tmp/wt-t01",
  rule: "git_push",
  reason: "git push lädt Commits hoch",
  ...over,
});

async function world() {
  const sender = new FakeNtfySender();
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const t = await setup({ pushSender: sender, log: (msg, extra) => logs.push({ msg, extra }) });
  const live: unknown[] = [];
  t.hub.add({ send: (d) => live.push(JSON.parse(d)) });
  const guard = async (body: GuardCheck) => {
    const res = await t.post("/guard/check", body);
    expect(res.status).toBe(200);
    return (await res.json()) as GuardCheckResult;
  };
  const decide = (id: number, decision: "approve" | "deny") => t.post(`/api/approvals/${id}/decide`, { decision }, {});
  const list = async (status = "pending") => ((await (await t.app.request(`/api/approvals?status=${status}`)).json()) as { approvals: Approval[] }).approvals;
  return { ...t, sender, live, logs, guard, decide, list };
}

describe("POST /guard/check", () => {
  it("401 ohne bzw. mit falschem Token", async () => {
    const t = await world();
    expect((await t.post("/guard/check", check(), {})).status).toBe(401);
    expect((await t.post("/guard/check", check(), { authorization: "Bearer falsch" })).status).toBe(401);
    expect(await t.list("all")).toHaveLength(0);
  });

  it("400 bei ungültigem Körper", async () => {
    const t = await world();
    expect((await t.post("/guard/check", { tool: "Bash" })).status).toBe(400);
    expect((await t.post("/guard/check", check({ rule: "gibt_es_nicht" as never }))).status).toBe(400);
  });

  it("legt eine offene Anfrage an, meldet sie live + per Push und verweigert", async () => {
    const t = await world();
    const r = await t.guard(check());
    expect(r.decision).toBe("deny");
    expect(r.approvalId).toBeTypeOf("number");
    const [a] = await t.list();
    expect(a).toMatchObject({ id: r.approvalId, status: "pending", rule: "git_push", command: "git push origin HEAD", sessionKey: "claude:sess-1", auftrag: "T-01", attempts: 1 });
    expect(t.live).toContainEqual({ type: "haiku", what: "approval" });
    // The push runs after the answer to the hook (which waits at most 1.5 s) – so poll instead of checking at once.
    await expect.poll(async () => (await t.db.select().from(pushLog)).map((p) => p.kind), { timeout: 5000 }).toContain("approval_needed");
  });

  it("Wiederholung desselben Befehls: gleiche Anfrage, Versuche +1", async () => {
    const t = await world();
    const a = await t.guard(check());
    const b = await t.guard(check());
    expect(b.decision).toBe("deny");
    expect(b.approvalId).toBe(a.approvalId);
    const all = await t.list("all");
    expect(all).toHaveLength(1);
    expect(all[0]?.attempts).toBe(2);
  });

  it("anderer Befehl, anderes cwd oder andere Session → eigene Anfrage", async () => {
    const t = await world();
    const a = await t.guard(check());
    const b = await t.guard(check({ command: "git push --force" }));
    const c = await t.guard(check({ cwd: "/tmp/anders" }));
    const d = await t.guard(check({ sessionId: "sess-2" }));
    expect(new Set([a.approvalId, b.approvalId, c.approvalId, d.approvalId]).size).toBe(4);
  });

  it("nach Freigabe genau EIN Durchlauf, der nächste Versuch ist wieder eine neue Anfrage", async () => {
    const t = await world();
    const a = await t.guard(check());
    const res = await t.decide(a.approvalId as number, "approve");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: Approval }).approval).toMatchObject({ status: "approved", decidedBy: "user" });

    const first = await t.guard(check());
    expect(first).toMatchObject({ decision: "allow", approvalId: a.approvalId });
    const [row] = await t.db.select().from(approvals).where(eq(approvals.id, a.approvalId as number));
    expect(row?.status).toBe("consumed");
    expect(row?.consumedAt).not.toBeNull();

    const second = await t.guard(check());
    expect(second.decision).toBe("deny");
    expect(second.approvalId).not.toBe(a.approvalId);
  });

  it("gleichzeitiger Verbrauch: von zwei parallelen Anfragen darf nur eine durch", async () => {
    const t = await world();
    const a = await t.guard(check());
    await t.decide(a.approvalId as number, "approve");
    const results = await Promise.all([t.guard(check()), t.guard(check()), t.guard(check())]);
    expect(results.filter((r) => r.decision === "allow")).toHaveLength(1);
    const consumed = (await t.list("all")).filter((x) => x.status === "consumed");
    expect(consumed).toHaveLength(1);
  });

  it("Freigabe für Session A gilt nicht für Session B", async () => {
    const t = await world();
    const a = await t.guard(check());
    await t.decide(a.approvalId as number, "approve");
    expect((await t.guard(check({ sessionId: "sess-andere" }))).decision).toBe("deny");
    expect((await t.guard(check())).decision).toBe("allow");
  });

  it("abgelehnt → bleibt verweigert, ein neuer Versuch legt eine neue Anfrage an", async () => {
    const t = await world();
    const a = await t.guard(check());
    const res = await t.decide(a.approvalId as number, "deny");
    expect(res.status).toBe(200);
    const again = await t.guard(check());
    expect(again.decision).toBe("deny");
    expect(again.approvalId).not.toBe(a.approvalId);
    const all = await t.list("all");
    expect(all.find((x) => x.id === a.approvalId)?.status).toBe("denied");
  });

  it("Freigaben verfallen nach 24 h (offen und erteilt)", async () => {
    const t = await world();
    const a = await t.guard(check());
    const b = await t.guard(check({ command: "git push --force" }));
    await t.decide(b.approvalId as number, "approve");
    await t.db.execute(sql`update approvals set created_at = now() - interval '25 hours', decided_at = now() - interval '25 hours'`);
    // erteilte, aber abgelaufene Freigabe lässt nichts mehr durch
    const r = await t.guard(check({ command: "git push --force" }));
    expect(r.decision).toBe("deny");
    expect(r.approvalId).not.toBe(b.approvalId);
    const all = await t.list("all");
    expect(all.find((x) => x.id === a.approvalId)?.status).toBe("expired");
    expect(all.find((x) => x.id === b.approvalId)?.status).toBe("expired");
    expect((await t.decide(a.approvalId as number, "approve")).status).toBe(409);
  });

  it("Push-Fehler bricht die Anfrage nicht ab", async () => {
    const t = await world();
    t.sender.nextOk = false;
    const r = await t.guard(check());
    expect(r.decision).toBe("deny");
    expect(r.approvalId).toBeTypeOf("number");
  });

  it("commandHash normalisiert das cwd (Schrägstrich am Ende egal)", () => {
    expect(commandHash("git push", "/a/b/", "claude:x")).toBe(commandHash("git push", "/a/b", "claude:x"));
    expect(commandHash("git push", "/a/b", "claude:x")).not.toBe(commandHash("git push", "/a/b", "claude:y"));
  });
});

describe("/api/approvals", () => {
  it("listet offene (Standard) oder alle, neueste zuerst", async () => {
    const t = await world();
    const a = await t.guard(check());
    const b = await t.guard(check({ command: "git push -f" }));
    await t.decide(a.approvalId as number, "deny");
    expect((await t.list("pending")).map((x) => x.id)).toEqual([b.approvalId]);
    expect((await t.list("all")).map((x) => x.id)).toEqual([b.approvalId, a.approvalId]);
    const def = (await (await t.app.request("/api/approvals")).json()) as { approvals: Approval[] };
    expect(def.approvals.map((x) => x.id)).toEqual([b.approvalId]);
  });

  it("decide: 404 unbekannt oder unbrauchbare ID, 409 schon entschieden, 400 falsche Eingabe, Live-Meldung", async () => {
    const t = await world();
    const a = await t.guard(check());
    expect((await t.decide(9999, "approve")).status).toBe(404);
    expect((await t.post(`/api/approvals/${a.approvalId}/decide`, { decision: "vielleicht" }, {})).status).toBe(400);
    expect((await t.post(`/api/approvals/abc/decide`, { decision: "approve" }, {})).status).toBe(404); // unbrauchbare ID = gibt es nicht
    t.live.length = 0;
    expect((await t.decide(a.approvalId as number, "approve")).status).toBe(200);
    expect(t.live).toContainEqual({ type: "haiku", what: "approval" });
    expect((await t.decide(a.approvalId as number, "deny")).status).toBe(409);
  });

  it("approveAllPending gibt nur offene Anfragen frei", async () => {
    const t = await world();
    const a = await t.guard(check());
    const b = await t.guard(check({ command: "git push -f" }));
    const c = await t.guard(check({ command: "git push --tags" }));
    await t.decide(c.approvalId as number, "deny");
    const done = await approveAllPending(t.db, [a.approvalId as number, b.approvalId as number, c.approvalId as number]);
    expect(done.map((x) => x.id).sort()).toEqual([a.approvalId, b.approvalId].sort());
    expect(done.every((x) => x.status === "approved" && x.decidedBy === "user")).toBe(true);
    expect((await t.guard(check({ command: "git push -f" }))).decision).toBe("allow");
  });
});
