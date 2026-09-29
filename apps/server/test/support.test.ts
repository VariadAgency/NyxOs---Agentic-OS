// Feedback & Unterstützen: Postausgang, Weiterleitung an die Meldestelle (Attrappe), Spende, Nyx-Regeln, Bereinigung.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupportSendResult, SupportState } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { supportOutbox } from "../src/db/schema.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { checkSupportUrl } from "../src/support/config.js";
import { RecentErrors } from "../src/support/recent-errors.js";
import { SupportService } from "../src/support/service.js";
import { needsAuth } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

const BASE = "https://support.example.org/api/";
const ORIGIN = "https://support.example.org";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Attrappe der Meldestelle: antwortet je Weg mit dem, was der Test vorgibt, und merkt sich jede Anfrage. */
function fakeService(answer: (path: string, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call = { url, headers, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return answer(new URL(url).pathname, call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const resolve = async () => ["93.184.215.14"];

async function app(opts: { answer?: Parameters<typeof fakeService>[0]; env?: NodeJS.ProcessEnv; defaultUrl?: string; webDir?: string } = {}) {
  let clock = Date.parse("2026-09-28T10:00:00.000Z");
  const fake = fakeService(opts.answer ?? (() => json({ id: "BUG-1", message: "Danke!" }, 201)));
  const t = await setup({
    ...(opts.webDir ? { webDir: opts.webDir } : {}),
    support: { fetch: fake.fetchImpl, env: opts.env ?? {}, resolve, now: () => clock, defaultUrl: opts.defaultUrl ?? "" },
  });
  const req = (method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const state = async () => (await (await req("GET", "/api/support/state")).json()) as SupportState;
  return { t, fake, req, state, advance: (ms: number) => (clock += ms) };
}

const BUG = {
  what: "Der Knopf „Speichern“ reagiert nicht",
  before: "Einstellungen geöffnet",
  expected: "Gespeichert",
  email: "tester@example.com",
  diagnostics: {
    version: "0.1.0",
    mode: "local",
    os: "macOS",
    browser: "Chrome 140",
    page: "/sessions/coding/secret-project/abc",
    language: "de",
    errors: [{ source: "browser", at: "2026-09-28T09:59:00.000Z", message: "TypeError at /Users/alex-example/app/x.ts token=abcdefgh12345 mail alex@example.com" }],
  },
  screenshot: { name: "bild.png", type: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" },
};

describe("Feedback & Unterstützen · ohne Meldestelle", () => {
  it("Fehlermeldung landet im Postausgang (wartet auf Verbindung), Spende ehrlich gesperrt", async () => {
    const { req, state, fake } = await app();
    const res = await req("POST", "/api/support/bug", BUG);
    expect(res.status).toBe(202);
    const body = (await res.json()) as SupportSendResult;
    expect(body.status).toBe("queued");
    expect(body.item).toMatchObject({ kind: "bug", status: "waiting", title: "Der Knopf „Speichern“ reagiert nicht" });
    expect(body.message).toMatch(/Postausgang/);

    const idea = await req("POST", "/api/support/idea", { title: "Heller Modus", description: "Für draußen", importance: "nice" });
    expect(idea.status).toBe(202);

    const s = await state();
    expect(s.configured).toBe(false);
    expect(s.source).toBe("none");
    expect(s.outbox.waiting).toBe(2);
    expect(s.outbox.items.map((i) => i.status)).toEqual(["waiting", "waiting"]);
    expect(s.outbox.items[0]?.lastError).toMatch(/noch nicht eingerichtet/);

    const donate = await req("POST", "/api/support/donate", { amountCents: 500, interval: "once" });
    expect(donate.status).toBe(409);
    expect(await donate.json()).toMatchObject({ code: "not_configured", error: expect.stringMatching(/Bezahlen wird gerade eingerichtet/) });
    expect(fake.calls).toHaveLength(0);
  });

  it("ungültige Eingaben: 400 mit Hinweis", async () => {
    const { req } = await app();
    expect((await req("POST", "/api/support/bug", { what: "" })).status).toBe(400);
    expect((await req("POST", "/api/support/idea", { title: "ab", description: "x", importance: "egal" })).status).toBe(400);
    expect((await req("POST", "/api/support/donate", { amountCents: 10, interval: "once" })).status).toBe(400);
  });

  it("zu großes Bildschirmfoto: 413", async () => {
    const { req } = await app();
    const big = { ...BUG, screenshot: { ...BUG.screenshot, dataBase64: "A".repeat(4.5 * 1024 * 1024) } };
    expect((await req("POST", "/api/support/bug", big)).status).toBe(413);
  });

  it("später eingerichtete Meldestelle: Wartendes geht von selbst raus (Takt), mit Idempotenz-Schlüssel und bereinigter Diagnose", async () => {
    const { t, req, state, fake } = await app();
    await req("POST", "/api/support/bug", BUG);
    await t.tickStates();
    expect(fake.calls).toHaveLength(0); // ohne Adresse passiert nichts

    const saved = await req("PUT", "/api/support/settings", { url: BASE });
    expect(saved.status).toBe(200);
    await t.background.idle();
    await t.tickStates();

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(`${BASE}v1/bug`);
    expect(call?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.headers["user-agent"]).toMatch(/^NyxOS\//);
    expect(call?.body).toMatchObject({ what: BUG.what, email: "tester@example.com", client: { app: "nyxos" } });
    const diag = JSON.stringify(call?.body.diagnostics);
    expect(diag).not.toMatch(/Users|alex-example|alex@example|abcdefgh12345|secret-project/);
    expect((call?.body.diagnostics as { page: string }).page).toBe("/sessions/…");

    const s = await state();
    expect(s.configured).toBe(true);
    expect(s.origin).toBe(ORIGIN);
    expect(s.outbox.waiting).toBe(0);
    expect(s.outbox.items[0]).toMatchObject({ status: "sent", reference: "BUG-1" });
    // Das Bildschirmfoto selbst wird nach dem Senden nicht aufbewahrt.
    const [row] = await t.db.select().from(supportOutbox).where(eq(supportOutbox.status, "sent"));
    expect(JSON.stringify(row?.payload)).not.toContain("iVBORw0KGgo");

    await t.tickStates();
    expect(fake.calls).toHaveLength(1); // nie doppelt
  });
});

describe("Feedback & Unterstützen · mit Meldestelle (Attrappe)", () => {
  it("gesendet: Antwort der Meldestelle ehrlich zeigen", async () => {
    const { req, fake } = await app({ defaultUrl: BASE });
    const res = await req("POST", "/api/support/idea", { title: "Heller Modus", description: "Für draußen", importance: "essential", email: "" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SupportSendResult;
    expect(body).toMatchObject({ status: "sent", message: "Danke!", item: { status: "sent", reference: "BUG-1" } });
    expect(fake.calls[0]?.url).toBe(`${BASE}v1/idea`);
    expect(fake.calls[0]?.body).toMatchObject({ title: "Heller Modus", importance: "essential", email: null });
  });

  it("nicht erreichbar / 503: wartet, nächster Versuch nach Pause, dann gesendet", async () => {
    let up = false;
    const { t, req, state, fake, advance } = await app({ defaultUrl: BASE, answer: () => (up ? json({ id: "B-9" }) : json({ error: { code: "unavailable", message: "Wartung" } }, 503)) });
    const res = await req("POST", "/api/support/bug", { what: "Absturz beim Öffnen" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as SupportSendResult).message).toMatch(/Wartung.*Postausgang/);
    expect((await state()).outbox.items[0]).toMatchObject({ status: "waiting", attempts: 1, lastError: "Wartung" });

    up = true;
    await t.tickStates(); // noch in der Pause (1 Min)
    expect(fake.calls).toHaveLength(1);
    advance(61_000);
    await t.tickStates();
    expect(fake.calls).toHaveLength(2);
    expect((await state()).outbox.items[0]).toMatchObject({ status: "sent", reference: "B-9", attempts: 2 });
    // derselbe Idempotenz-Schlüssel bei jedem Versuch
    expect(fake.calls[0]?.headers["idempotency-key"]).toBe(fake.calls[1]?.headers["idempotency-key"]);
  });

  it("Netzfehler: wartet; „Jetzt senden“ schickt sofort", async () => {
    let fail = true;
    const { req, state, fake } = await app({
      defaultUrl: BASE,
      answer: () => {
        if (fail) throw new TypeError("fetch failed");
        return json({ id: "B-2" });
      },
    });
    expect((await req("POST", "/api/support/bug", { what: "Offline gemeldet" })).status).toBe(202);
    expect((await state()).outbox.items[0]?.lastError).toMatch(/nicht erreichbar/);
    fail = false;
    const flushed = await req("POST", "/api/support/flush", {});
    expect(await flushed.json()).toEqual({ sent: 1 });
    expect(fake.calls).toHaveLength(2);
  });

  it("abgelehnt (400): kein neuer Versuch, Satz der Meldestelle", async () => {
    const { t, req, state, fake, advance } = await app({ defaultUrl: BASE, answer: () => json({ error: { code: "invalid_request", message: "Bitte mehr beschreiben." } }, 422) });
    const res = await req("POST", "/api/support/bug", { what: "kaputt" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "Bitte mehr beschreiben.", code: "rejected" });
    advance(24 * 3600_000);
    await t.tickStates();
    expect(fake.calls).toHaveLength(1);
    expect((await state()).outbox.items[0]?.status).toBe("rejected");
  });

  it("Umleitungen werden nicht verfolgt", async () => {
    const { req, fake } = await app({ defaultUrl: BASE, answer: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/" } }) });
    expect((await req("POST", "/api/support/bug", { what: "Umleitung" })).status).toBe(502);
    expect(fake.calls).toHaveLength(1);
  });

  it("Entwurf (Nyx) wird beim Senden ersetzt", async () => {
    const { req, state } = await app({ defaultUrl: BASE });
    const draft = await req("PUT", "/api/support/draft", { kind: "bug", what: "Nyx-Entwurf" });
    const { id } = (await draft.json()) as { id: number };
    expect((await state()).drafts.bug).toMatchObject({ id, draft: { kind: "bug", what: "Nyx-Entwurf" } });
    // derselbe Entwurf wird überschrieben, nicht verdoppelt
    await req("PUT", "/api/support/draft", { kind: "bug", what: "Nyx-Entwurf 2" });
    expect((await state()).drafts.bug?.id).toBe(id);
    await req("POST", "/api/support/bug", { what: "Nyx-Entwurf 2", draftId: id });
    expect((await state()).drafts.bug).toBeNull();
  });

  it("Spende: eingebettete Bezahlseite nur von der Support-Herkunft", async () => {
    let embedUrl = `${ORIGIN}/embed/donate?s=cs_example`;
    const { req, fake } = await app({ defaultUrl: BASE, answer: () => json({ embedUrl }) });
    const ok = await req("POST", "/api/support/donate", { amountCents: 1000, interval: "monthly", name: "Kim", message: "Weiter so", publicThanks: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ embedUrl, origin: ORIGIN });
    expect(fake.calls[0]?.url).toBe(`${BASE}v1/donate/session`);
    expect(fake.calls[0]?.body).toMatchObject({ amountCents: 1000, currency: "EUR", interval: "monthly", name: "Kim", publicThanks: true });

    embedUrl = "https://pay.evil.example.net/checkout";
    const bad = await req("POST", "/api/support/donate", { amountCents: 500, interval: "once" });
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ code: "bad_embed_url" });
  });

  it("Umgebungsvariable geht vor und sperrt die Einstellung", async () => {
    const { req, state } = await app({ env: { NYXOS_SUPPORT_URL: "https://env-support.example.org" } });
    await req("PUT", "/api/support/settings", { url: BASE });
    const s = await state();
    expect(s).toMatchObject({ configured: true, source: "env", envLocked: true, origin: "https://env-support.example.org", settingUrl: BASE });
  });

  it("CSP der Seite erlaubt als Rahmen nur NyxOS selbst und die Support-Herkunft", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "nyxos-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>NyxOS</title>");
    const { t, req } = await app({ defaultUrl: BASE, webDir });
    await t.background.idle();
    const page = await req("GET", "/overview");
    expect(page.headers.get("content-security-policy")).toBe(`frame-ancestors 'self'; frame-src 'self' ${ORIGIN}`);
    const api = await req("GET", "/api/support/state");
    expect(api.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});

describe("Feedback & Unterstützen · Adresse, Anmeldung, Nyx", () => {
  it("nur https; http nur für localhost in der Entwicklung", () => {
    expect(checkSupportUrl("https://support.example.org", {}).ok).toBe(true);
    expect(checkSupportUrl("http://support.example.org", { NYXOS_ALLOW_PRIVATE_URLS: "1" }).ok).toBe(false);
    expect(checkSupportUrl("http://127.0.0.1:47896", {}).ok).toBe(false);
    expect(checkSupportUrl("http://127.0.0.1:47896", { NYXOS_ALLOW_PRIVATE_URLS: "1" }).ok).toBe(true);
    expect(checkSupportUrl("https://user:pw@support.example.org", {}).ok).toBe(false);
    expect(checkSupportUrl("ftp://support.example.org", {}).ok).toBe(false);
  });

  it("Einstellung mit unsicherer Adresse: 400", async () => {
    const { req } = await app();
    const res = await req("PUT", "/api/support/settings", { url: "http://support.example.org" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_url" });
  });

  it("alles unter /api/support/ braucht immer eine Anmeldung", () => {
    expect(needsAuth("GET", "/api/support/state", false)).toBe(true);
    expect(needsAuth("POST", "/api/support/bug", false)).toBe(true);
  });

  it("Nyx: Entwurf ja, Senden nur mit Bestätigung, Spenden und Adresse nie", () => {
    expect(classifyApiRequest("PUT", "/api/support/draft").access).toBe("direkt");
    expect(classifyApiRequest("GET", "/api/support/state").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/support/bug").access).toBe("bestaetigung");
    expect(classifyApiRequest("POST", "/api/support/idea").access).toBe("bestaetigung");
    expect(classifyApiRequest("POST", "/api/support/donate").access).toBe("gesperrt");
    expect(classifyApiRequest("PUT", "/api/support/settings").access).toBe("gesperrt");
    expect(classifyApiRequest("DELETE", "/api/support/outbox/3").access).toBe("bestaetigung");
  });

  it("letzte Server-Fehler: nur Fehler-Ereignisse, höchstens 10, bereinigt im Zustand", async () => {
    const ring = new RecentErrors(10, () => 0);
    ring.note("bereit", { port: 1 });
    for (let i = 0; i < 12; i++) ring.note("telegram-start-fehler", { error: `boom ${i}` });
    ring.note("error", { message: "open /home/alex-example/x" });
    expect(ring.list()).toHaveLength(10);
    expect(ring.list().at(-1)?.message).toBe("error: open /home/alex-example/x");

    const { t } = await app();
    const service = new SupportService({ db: t.db, log: () => {}, version: "0.1.0", mode: "local", errors: ring, env: {} });
    const s = await service.state();
    expect(s.diagnostics).toMatchObject({ version: "0.1.0", mode: "local" });
    expect(s.diagnostics.errors.at(-1)?.message).toBe("error: open [path]");
  });
});
