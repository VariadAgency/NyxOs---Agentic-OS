// „Anmeldung bleibt": Die Passkey-Sitzung liegt in der DB (nur SHA-256 des Cookie-Werts)
// und überlebt darum einen Neustart; sie gilt 30 Tage und verlängert sich gleitend; Abmelden und
// „Überall abmelden" widerrufen sie; ein angemeldetes Gerät kann nach frischer Passkey-Bestätigung
// einen Einrichtungs-Code für ein weiteres Gerät erzeugen.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authSessions } from "../src/db/schema.js";
import { CSRF_HEADER, SESSION_COOKIE, SESSION_TTL_MS, createAuthSession, createSetupCode, sessionCookieName } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const json = { "content-type": "application/json" };

/** Liest `Name=Wert` und `Max-Age` aus einem Set-Cookie-Kopf. */
function parseSetCookie(res: Response): { name: string; value: string; maxAge: number | null }[] {
  return res.headers.getSetCookie().map((line) => {
    const [pair = ""] = line.split(";");
    const eqAt = pair.indexOf("=");
    const m = /max-age=(\d+)/i.exec(line);
    return { name: pair.slice(0, eqAt).trim(), value: pair.slice(eqAt + 1).trim(), maxAge: m ? Number(m[1]) : null };
  });
}

describe("Anmelde-Sitzung überlebt Neustart, Ablauf, gleitende Verlängerung (A2)", () => {
  it("Sitzung überlebt einen Neustart: neue App-Instanz, gleiche DB → weiter angemeldet, Schreiben klappt", async () => {
    const { db, login } = await setup({ signedIn: false });
    // „Neustart": die erste App ist weg (nichts im Speicher übernommen), eine zweite startet auf derselben DB.
    const restarted = createApp({ db, archiveDir: mkdtempSync(join(tmpdir(), "nyxos-archiv-")) });
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    const st = (await (await restarted.app.request("/api/auth/status", { headers: { cookie } })).json()) as { authenticated: boolean; csrf: string };
    expect(st.authenticated).toBe(true);
    expect(st.csrf).toBe(login.csrf);
    const res = await restarted.app.request("/api/sessions/claude:x/close", { method: "POST", headers: { ...json, cookie, [CSRF_HEADER]: st.csrf }, body: '{"by":"x"}' });
    expect(res.status).toBe(404); // durch die Anmeldung durch, die Session gibt es nur nicht
  });

  it("in der DB steht nur der Hash des Cookie-Werts, nie der Wert selbst", async () => {
    const { db, login } = await setup({ signedIn: false });
    const rows = await db.select().from(authSessions);
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(login.token);
  });

  it("abgelaufen → 401 mit code auth_required (Client zeigt „Bitte anmelden“)", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await app.request("/api/terminal/start", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("auth_required");
  });

  it("gleitende Verlängerung: nach Tagen Nutzung gilt die Sitzung wieder volle 30 Tage, Cookie mit neuem Max-Age", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    // Sitzung wurde vor 25 Tagen angelegt → nur noch 5 Tage übrig.
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 5 * DAY).toISOString() });
    const res = await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const [row] = await db.select().from(authSessions);
    expect(Date.parse(row?.expiresAt ?? "") - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    const set = parseSetCookie(res).find((c) => c.name === SESSION_COOKIE);
    expect(set?.value).toBe(login.token);
    expect(set?.maxAge).toBe(SESSION_TTL_MS / 1000);
  });

  it("frische Sitzung wird nicht bei jeder Anfrage neu geschrieben (höchstens einmal am Tag)", async () => {
    const { app, login } = await setup({ signedIn: false });
    const res = await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
    expect(parseSetCookie(res).length).toBe(0);
  });

  it("Status-Antwort wird nie zwischengespeichert (no-store)", async () => {
    const { app } = await setup({ signedIn: false });
    const res = await app.request("/api/auth/status");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("Cookie je Port (localhost teilt Cookies über alle Ports)", () => {
  it("Name hängt am Port des Hosts; ohne Port bleibt der alte Name", () => {
    expect(sessionCookieName("localhost:47801")).toBe(`${SESSION_COOKIE}_47801`);
    expect(sessionCookieName("[::1]:47912")).toBe(`${SESSION_COOKIE}_47912`);
    expect(sessionCookieName("nyxos.tail.ts.net")).toBe(SESSION_COOKIE);
    expect(sessionCookieName(undefined)).toBe(SESSION_COOKIE);
  });

  it("alter Cookie-Name gilt weiter und wird auf den Port-Namen umgeschrieben (kein Abmelden beim Deploy)", async () => {
    const { app, login } = await setup({ signedIn: false });
    const host = "localhost:47801";
    const res = await app.request("/api/auth/status", { headers: { host, cookie: `${SESSION_COOKIE}=${login.token}` } });
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const set = parseSetCookie(res).find((c) => c.name === `${SESSION_COOKIE}_47801`);
    expect(set?.value).toBe(login.token);
    // Mit dem neuen Namen geht es weiter.
    const w = await app.request("/api/sessions/claude:x/close", {
      method: "POST",
      headers: { ...json, host, cookie: `${SESSION_COOKIE}_47801=${login.token}`, [CSRF_HEADER]: login.csrf },
      body: '{"by":"x"}',
    });
    expect(w.status).toBe(404);
  });

  it("ein Cookie für einen anderen Port zählt nicht (Probe überschreibt nie die echte Anmeldung)", async () => {
    const { app, login } = await setup({ signedIn: false });
    const res = await app.request("/api/auth/status", { headers: { host: "localhost:47801", cookie: `${SESSION_COOKIE}_47912=${login.token}` } });
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});

describe("CSRF-Wiederholung", () => {
  it("fehlendes Token → 403 code csrf; Status liefert das Token der Sitzung; Wiederholung klappt", async () => {
    const { app, login } = await setup({ signedIn: false });
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    const first = await app.request("/api/sessions/claude:x/close", { method: "POST", headers: { ...json, cookie }, body: '{"by":"x"}' });
    expect(first.status).toBe(403);
    const body = (await first.json()) as { code: string; error: string };
    expect(body.code).toBe("csrf");
    expect(body.error).not.toMatch(/csrf/i); // keine Technik-Meldung für den Nutzer
    const st = (await (await app.request("/api/auth/status", { headers: { cookie } })).json()) as { csrf: string };
    const retry = await app.request("/api/sessions/claude:x/close", { method: "POST", headers: { ...json, cookie, [CSRF_HEADER]: st.csrf }, body: '{"by":"x"}' });
    expect(retry.status).toBe(404);
  });
});

describe("Auth-Protokoll (belegbar, ohne Geheimnisse)", () => {
  it("401 und 403 landen knapp im Log: Grund, Weg, ob Cookie/Token dabei waren — nie deren Werte", async () => {
    const lines: { msg: string; extra?: Record<string, unknown> }[] = [];
    const { app, login } = await setup({ signedIn: false, log: (msg, extra) => lines.push({ msg, extra }) });
    await app.request("/api/terminal/start", { method: "POST", headers: json, body: "{}" });
    await app.request("/api/terminal/start", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}` }, body: "{}" });
    const auth = lines.filter((l) => l.msg === "auth-abgelehnt");
    expect(auth.map((l) => l.extra)).toEqual([
      expect.objectContaining({ status: 401, code: "auth_required", method: "POST", path: "/api/terminal/start", cookie: false, csrf: false }),
      expect.objectContaining({ status: 403, code: "csrf", method: "POST", path: "/api/terminal/start", cookie: true, csrf: false }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(login.token);
    expect(JSON.stringify(lines)).not.toContain(login.csrf);
  });
});

describe("Abmelden und Widerruf", () => {
  it("Abmelden löscht nur diese Sitzung und das Cookie", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    const other = await createAuthSession(db, null);
    const res = await app.request("/api/auth/logout", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(res.status).toBe(200);
    const st = (await (await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${login.token}` } })).json()) as { authenticated: boolean };
    expect(st.authenticated).toBe(false);
    const st2 = (await (await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${other.token}` } })).json()) as { authenticated: boolean };
    expect(st2.authenticated).toBe(true);
  });

  it("„Überall abmelden“ widerruft alle Sitzungen — nur angemeldet und mit Token", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    const other = await createAuthSession(db, null);
    expect((await app.request("/api/auth/logout-all", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
    expect((await app.request("/api/auth/logout-all", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}` }, body: "{}" })).status).toBe(403);
    const ok = await app.request("/api/auth/logout-all", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { revoked: number }).revoked).toBe(2);
    for (const t of [login.token, other.token]) {
      const st = (await (await app.request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${t}` } })).json()) as { authenticated: boolean };
      expect(st.authenticated).toBe(false);
    }
  });
});

describe("Einrichtungs-Code per Knopf (nur angemeldetes Gerät, frisch bestätigt)", () => {
  it("ohne Anmeldung 401, ohne Token 403", async () => {
    const { app, login } = await setup({ signedIn: false });
    expect((await app.request("/api/auth/setup-code", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
    expect((await app.request("/api/auth/setup-code", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}` }, body: "{}" })).status).toBe(403);
  });

  it("frisch mit Passkey bestätigt → Code, der die Passkey-Einrichtung freischaltet", async () => {
    const { app, login } = await setup({ signedIn: false });
    const res = await app.request("/api/auth/setup-code", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code.length).toBeGreaterThanOrEqual(8);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const opt = await app.request("/api/auth/register/options", { method: "POST", headers: { ...json, host: "localhost:47801" }, body: JSON.stringify({ setupCode: body.code }) });
    expect(opt.status).toBe(200);
  });

  it("Sitzung älter als 5 Min → 403 code reauth (erst noch einmal Touch ID, dann Code)", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    await db.update(authSessions).set({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }).where(eq(authSessions.csrf, login.csrf));
    const res = await app.request("/api/auth/setup-code", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("reauth");
  });

  it("immer nur ein offener Code: ein neuer macht ältere (auch per CLI erzeugte) ungültig", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    const cliCode = await createSetupCode(db);
    const call = async () =>
      ((await (await app.request("/api/auth/setup-code", { method: "POST", headers: { ...json, cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf }, body: "{}" })).json()) as { code: string }).code;
    const first = await call();
    const second = await call();
    const opts = (code: string) => app.request("/api/auth/register/options", { method: "POST", headers: { ...json, host: "localhost:47801" }, body: JSON.stringify({ setupCode: code }) });
    expect((await opts(cliCode)).status).toBe(403);
    expect((await opts(first)).status).toBe(403);
    expect((await opts(second)).status).toBe(200);
  });
});
