// Passkeys verwalten (Einstellungen → Anmeldung). Liste + Entfernen, nur angemeldet, mit Token
// und nach frischer Touch-ID-Bestätigung (wie „Code erzeugen“, max. 5 Min). Der gerade benutzte Passkey
// und der letzte Passkey lassen sich nicht entfernen; mit einem Passkey verschwinden seine Anmeldungen.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authCredentials, authSessions } from "../src/db/schema.js";
import { CSRF_HEADER, SESSION_COOKIE, createAuthSession } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

type T = Awaited<ReturnType<typeof setup>>;

async function addCredential(t: T, id: string, name: string, opts: { createdAt?: string; lastUsedAt?: string | null } = {}) {
  await t.db.insert(authCredentials).values({
    id,
    publicKey: "pk",
    rpId: "localhost",
    name,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.lastUsedAt !== undefined ? { lastUsedAt: opts.lastUsedAt } : {}),
  });
}

/** Drei Passkeys, angemeldet (frisch) mit `current`. */
async function world() {
  const t = await setup({ signedIn: false });
  await addCredential(t, "cred-current", "MacBook", { createdAt: "2026-09-20T10:00:00.000Z", lastUsedAt: "2026-09-25T10:00:00.000Z" });
  await addCredential(t, "cred-old", "Test-Passkey 1", { createdAt: "2026-09-25T13:52:00.000Z", lastUsedAt: null });
  await addCredential(t, "cred-other", "iPhone", { createdAt: "2026-09-22T10:00:00.000Z" });
  const me = await createAuthSession(t.db, "cred-current");
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${me.token}`, [CSRF_HEADER]: me.csrf };
  return { ...t, me, headers };
}

type Listed = { id: string; name: string; createdAt: string; lastUsedAt: string | null; current: boolean };

describe("Passkeys verwalten", () => {
  it("ohne Anmeldung 401 (Liste und Entfernen)", async () => {
    const { app } = await world();
    expect((await app.request("/api/auth/credentials")).status).toBe(401);
    expect((await app.request("/api/auth/credentials/cred-old", { method: "DELETE", headers: { "content-type": "application/json" } })).status).toBe(401);
  });

  it("ohne Token 403 code csrf (Liste und Entfernen)", async () => {
    const { app, me } = await world();
    const cookie = `${SESSION_COOKIE}=${me.token}`;
    const list = await app.request("/api/auth/credentials", { headers: { cookie } });
    expect(list.status).toBe(403);
    expect(((await list.json()) as { code: string }).code).toBe("csrf");
    const del = await app.request("/api/auth/credentials/cred-old", { method: "DELETE", headers: { "content-type": "application/json", cookie } });
    expect(del.status).toBe(403);
  });

  it("ohne frische Bestätigung (Sitzung älter als 5 Min) → 403 code reauth, nichts gelöscht", async () => {
    const { app, db, me, headers } = await world();
    await db.update(authSessions).set({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }).where(eq(authSessions.csrf, me.csrf));
    const list = await app.request("/api/auth/credentials", { headers });
    expect(list.status).toBe(403);
    expect(((await list.json()) as { code: string }).code).toBe("reauth");
    const del = await app.request("/api/auth/credentials/cred-old", { method: "DELETE", headers });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { code: string }).code).toBe("reauth");
    expect((await db.select().from(authCredentials)).length).toBe(3);
  });

  it("Liste: Name, angelegt, zuletzt benutzt, der gerade benutzte ist markiert — nie der Schlüssel", async () => {
    const { app, headers } = await world();
    const res = await app.request("/api/auth/credentials", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { credentials: Listed[] };
    expect(body.credentials.map((c) => c.id).sort()).toEqual(["cred-current", "cred-old", "cred-other"]);
    const current = body.credentials.find((c) => c.id === "cred-current");
    expect(current).toMatchObject({ name: "MacBook", current: true });
    expect(Date.parse(current?.lastUsedAt ?? "")).toBe(Date.parse("2026-09-25T10:00:00.000Z"));
    expect(body.credentials.find((c) => c.id === "cred-old")).toMatchObject({ name: "Test-Passkey 1", current: false, lastUsedAt: null });
    expect(JSON.stringify(body)).not.toContain('"pk"');
  });

  it("der gerade benutzte Passkey lässt sich nicht entfernen (409)", async () => {
    const { app, db, headers } = await world();
    const res = await app.request("/api/auth/credentials/cred-current", { method: "DELETE", headers });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("current");
    expect((await db.select().from(authCredentials)).length).toBe(3);
  });

  it("Entfernen löscht den Passkey und alle seine Anmeldungen, andere bleiben", async () => {
    const { app, db, headers } = await world();
    const a = await createAuthSession(db, "cred-old");
    await createAuthSession(db, "cred-old");
    const other = await createAuthSession(db, "cred-other");
    const res = await app.request("/api/auth/credentials/cred-old", { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; sessions: number }).sessions).toBe(2);
    expect((await db.select().from(authCredentials)).map((c) => c.id).sort()).toEqual(["cred-current", "cred-other"]);
    const sessions = await db.select().from(authSessions);
    expect(sessions.some((s) => s.credentialId === "cred-old")).toBe(false);
    expect(sessions.some((s) => s.csrf === other.csrf)).toBe(true);
    // Die Anmeldung, die am entfernten Passkey hing, gilt nicht mehr.
    const st = (await (await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${a.token}` } })).json()) as { authenticated: boolean };
    expect(st.authenticated).toBe(false);
    // Die eigene Anmeldung bleibt.
    expect((await app.request("/api/auth/credentials", { headers })).status).toBe(200);
  });

  it("Liste zeigt eine kurze Kennung (erste 6 Zeichen), Umbenennen mit Anmeldung + Token + frischer Bestätigung", async () => {
    const { app, db, headers } = await world();
    const list = (await (await app.request("/api/auth/credentials", { headers })).json()) as { credentials: Array<Listed & { shortId: string }> };
    expect(list.credentials.find((c) => c.id === "cred-other")?.shortId).toBe("cred-o");
    // ohne Anmeldung / ohne Token: abgelehnt
    expect((await app.request("/api/auth/credentials/cred-other", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status).toBe(401);
    const noCsrf = { "content-type": "application/json", cookie: headers.cookie };
    expect((await app.request("/api/auth/credentials/cred-other", { method: "PATCH", headers: noCsrf, body: JSON.stringify({ name: "x" }) })).status).toBe(403);
    // leerer Name → 400, unbekannt → 404
    expect((await app.request("/api/auth/credentials/cred-other", { method: "PATCH", headers, body: JSON.stringify({ name: "  " }) })).status).toBe(400);
    expect((await app.request("/api/auth/credentials/gibt-es-nicht", { method: "PATCH", headers, body: JSON.stringify({ name: "a" }) })).status).toBe(404);
    const res = await app.request("/api/auth/credentials/cred-other", { method: "PATCH", headers, body: JSON.stringify({ name: "  iPhone von Alex  " }) });
    expect(res.status).toBe(200);
    const row = (await db.select().from(authCredentials).where(eq(authCredentials.id, "cred-other")))[0];
    expect(row?.name).toBe("iPhone von Alex");
  });

  it("unbekannter Passkey → 404", async () => {
    const { app, headers } = await world();
    expect((await app.request("/api/auth/credentials/gibt-es-nicht", { method: "DELETE", headers })).status).toBe(404);
  });

  it("der letzte Passkey bleibt immer (409), auch bei einer Anmeldung ohne Passkey-Bezug", async () => {
    const t = await setup({ signedIn: false });
    await addCredential(t, "cred-only", "MacBook");
    const res = await t.app.request("/api/auth/credentials/cred-only", { method: "DELETE", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${t.login.token}`, [CSRF_HEADER]: t.login.csrf } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("last");
    expect((await t.db.select().from(authCredentials)).length).toBe(1);
  });
});
