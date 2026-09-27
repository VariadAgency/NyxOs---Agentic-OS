// „Session zusammenfassen & prüfen“ startet einen Haiku-Lauf über den Verlauf der Session.
// Das Ergebnis hängt an der Session (Tabelle `session_audits`) und ist über die API abrufbar. Ohne
// Token: ehrlicher Zustand „wartet auf Token“, kein Lauf.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SessionAudit, SessionAuditView } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessionAudits, sessions } from "../src/db/schema.js";
import type { EngineRequest } from "../src/haiku/engine.js";
import { RemoteEngine } from "../src/haiku/remoteEngine.js";
import { answer, FakeEngine, setupAssistant, TOKEN } from "./assistant/assistant-helpers.js";

const SID = "aaaaaaaa-0000-4000-8000-00000000a0d1";
const KEY = `claude:${SID}`;
const TECH = /tmux|CSRF|ENOENT|nicht gefunden|CLI/;

const AUDIT_JSON = JSON.stringify({
  zusammenfassung: "Die Session hat die Chat-Eingabe gebaut und getestet.",
  gemacht: ["Route zum Senden gebaut", "Tests geschrieben"],
  erledigt: ["Senden mit Anhang"],
  offen: ["Codex noch nicht geprüft"],
  qualitaet: { note: "gut", text: "Tests zuerst, saubere Fehlertexte." },
  risiken: ["Große Anhänge über den Tunnel"],
});

type T = Awaited<ReturnType<typeof setupAssistant>>;

async function seedSession(t: T) {
  const base = { isSidechain: false, cwd: "/Users/alex/projects", sessionId: SID, version: "2.1.282" };
  const raw = Buffer.from(
    [
      JSON.stringify({ ...base, type: "user", uuid: "u-1", timestamp: "2026-09-25T10:00:00.000Z", message: { role: "user", content: "Bau bitte die Chat-Eingabe mit Anhang" } }),
      JSON.stringify({ ...base, type: "assistant", uuid: "u-2", timestamp: "2026-09-25T10:00:03.000Z", message: { model: "claude-opus-5-5", id: "m1", role: "assistant", content: [{ type: "text", text: "Ich baue die Route und schreibe Tests zuerst." }] } }),
    ].join("\n") + "\n",
  );
  const sha = createHash("sha256").update(raw).digest("hex");
  const res = await t.app.request("/ingest/archive", {
    method: "POST",
    body: gzipSync(raw),
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": SID,
      "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${SID}.jsonl`),
      "x-nyxos-sha256": sha,
      "x-nyxos-size": String(raw.length),
    },
  });
  expect(res.status).toBe(200);
  await t.db.update(sessions).set({ title: "Chat-Eingabe bauen" }).where(eq(sessions.id, KEY));
}

async function view(t: T): Promise<SessionAuditView> {
  const res = await t.app.request(`/api/sessions/${KEY}/audits`);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionAuditView;
}

async function waitDone(t: T): Promise<SessionAudit> {
  for (let i = 0; i < 50; i++) {
    const v = await view(t);
    const a = v.audits[0];
    if (a && a.status !== "running") return a;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Prüfung wurde nicht fertig: ${JSON.stringify((await view(t)).audits)}`);
}

// Großzügige Zeit: die erste PGlite-Migration je Datei dauert auf einem ausgelasteten Mac > 10 s.
describe("Session zusammenfassen & prüfen", { timeout: 60_000 }, () => {
  it("Motor bereit: Lauf startet, liest den Verlauf, Ergebnis hängt an der Session", async () => {
    const engine = new FakeEngine(answer(AUDIT_JSON));
    const t = await setupAssistant({ engine });
    await seedSession(t);
    expect((await view(t)).engine).toMatchObject({ ready: true, state: "ready" });

    const start = await t.json(`/api/sessions/${KEY}/audits`, {});
    expect(start.status).toBe(202);
    const audit = await waitDone(t);
    expect(audit.status).toBe("done");
    expect(audit.sessionKey).toBe(KEY);
    expect(audit.result).toMatchObject({ gemacht: ["Route zum Senden gebaut", "Tests geschrieben"], offen: ["Codex noch nicht geprüft"], qualitaet: { note: "gut" } });
    expect(audit.itemsRead).toBe(2);

    // Haiku hat wirklich den Verlauf dieser Session gelesen (nicht nur den Titel).
    const req = engine.requests[0] as EngineRequest;
    expect(req.prompt).toContain("Bau bitte die Chat-Eingabe mit Anhang");
    expect(req.prompt).toContain("Ich baue die Route und schreibe Tests zuerst.");
    expect(req.prompt).toContain("Chat-Eingabe bauen");

    // Gespeichert in der DB, mit Verknüpfung zur Session.
    const rows = await t.db.select().from(sessionAudits).where(eq(sessionAudits.sessionKey, KEY));
    expect(rows).toHaveLength(1);
  });

  it("ohne Haiku-Token: ehrlicher Zustand „wartet auf Token“, Start wird abgelehnt, nichts gespeichert", async () => {
    const t = await setupAssistant({ engine: new RemoteEngine({ tokenConfigured: false }) });
    await seedSession(t);
    const v = await view(t);
    expect(v.engine).toMatchObject({ ready: false, state: "waiting_token" });
    expect(v.engine.reason).toBeTruthy();
    expect(v.engine.reason).not.toMatch(TECH);
    const start = await t.json(`/api/sessions/${KEY}/audits`, {});
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).not.toMatch(TECH);
    expect(await t.db.select().from(sessionAudits)).toHaveLength(0);
  });

  it("unbrauchbare Antwort → Fehler-Eintrag mit einfachem Satz, kein Absturz", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Das kann ich leider nicht.")) });
    await seedSession(t);
    expect((await t.json(`/api/sessions/${KEY}/audits`, {})).status).toBe(202);
    const audit = await waitDone(t);
    expect(audit.status).toBe("error");
    expect(audit.error).toBeTruthy();
    expect(audit.error).not.toMatch(TECH);
  });

  it("läuft schon eine Prüfung, startet keine zweite", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const engine = new FakeEngine(async function* (req) {
      await gate;
      yield* answer(AUDIT_JSON)(req);
    });
    const t = await setupAssistant({ engine });
    await seedSession(t);
    expect((await t.json(`/api/sessions/${KEY}/audits`, {})).status).toBe(202);
    const second = await t.json(`/api/sessions/${KEY}/audits`, {});
    expect(second.status).toBe(409);
    release();
    expect((await waitDone(t)).status).toBe("done");
  });

  it("zwei gleichzeitige Klicks starten nur einen Lauf (der zweite bekommt 409 mit Satz)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const engine = new FakeEngine(async function* (req) {
      await gate;
      yield* answer(AUDIT_JSON)(req);
    });
    const t = await setupAssistant({ engine });
    await seedSession(t);
    const [a, b] = await Promise.all([t.json(`/api/sessions/${KEY}/audits`, {}), t.json(`/api/sessions/${KEY}/audits`, {})]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const refused = (await (a.status === 409 ? a : b).json()) as { error: string };
    expect(refused.error).toMatch(/läuft schon/);
    expect(await t.db.select().from(sessionAudits).where(eq(sessionAudits.sessionKey, KEY))).toHaveLength(1);
    release();
    expect((await waitDone(t)).status).toBe("done");
  });

  it("eine hängengebliebene Prüfung (Server-Neustart) wird nach 15 Min ehrlich als nicht fertig gezeigt", async () => {
    const t = await setupAssistant();
    await seedSession(t);
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await t.db.insert(sessionAudits).values({ sessionKey: KEY, status: "running", createdAt: old });
    const v = await view(t);
    expect(v.audits[0]?.status).toBe("error");
    expect(v.audits[0]?.error).toMatch(/nicht fertig/);
  });

  it("unbekannte Session → 404", async () => {
    const t = await setupAssistant();
    expect((await t.app.request("/api/sessions/claude:gibtsnicht/audits")).status).toBe(404);
  });
});
