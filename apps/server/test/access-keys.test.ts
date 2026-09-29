// Zugänge (write-only, alles auf einmal, Prüfen gegen Attrappen) + Modell-Katalog mit genauen Kennungen.
import { randomBytes } from "node:crypto";
import type { TelegramStatus } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { AccessService } from "../src/access/service.js";
import { ModelService } from "../src/models/providers.js";
import { SecretStore } from "../src/secrets/store.js";
import { setup, sharedDb } from "./helpers.js";

const KEY = randomBytes(32).toString("base64");
const ENV = { NYXOS_SECRETS_KEY: KEY } as NodeJS.ProcessEnv;
const ANTHROPIC = "sk-ant-api03-GEHEIM-abcdefghijklmnop-9876";
const OPENROUTER = "sk-or-v1-GEHEIM0123456789abcdef0123456789-5555";
const TG = "123456789:AAH-geheimgeheimgeheimgeheimgeh7777";
const JSONH = { "content-type": "application/json" };

type App = { request: (p: string, i?: RequestInit) => Response | Promise<Response> };
const call = (app: App, method: string, path: string, body?: unknown) => app.request(path, { method, headers: JSONH, body: body === undefined ? undefined : JSON.stringify(body) });

describe("Zugänge über die API", () => {
  it("speichert viele Schlüssel auf einmal – kein Wert kommt je zurück, nur „endet auf …“", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const bulk = await call(app, "POST", "/api/access/bulk", { entries: [{ id: "anthropic", value: ANTHROPIC }, { id: "openrouter", value: OPENROUTER }, { id: "higgsfield", value: "egal-1234567890" }], check: false });
    expect(bulk.status).toBe(200);
    const text = await bulk.text();
    for (const secret of [ANTHROPIC, OPENROUTER]) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { results: { id: string; saved: boolean; error: string | null }[]; items: { id: string; state: string; last4: string | null }[] };
    expect(body.results.find((r) => r.id === "anthropic")).toMatchObject({ saved: true, error: null });
    expect(body.results.find((r) => r.id === "higgsfield")).toMatchObject({ saved: false });
    const by = Object.fromEntries(body.items.map((i) => [i.id, i]));
    expect(by.anthropic).toMatchObject({ state: "unchecked", last4: "9876" });
    expect(by.openrouter).toMatchObject({ state: "unchecked", last4: "5555" });
    expect(by.openai?.state).toBe("missing");
    expect(by.elevenlabs?.state).toBe("link");

    const list = await (await app.request("/api/access")).text();
    for (const secret of [ANTHROPIC, OPENROUTER]) expect(list).not.toContain(secret);

    // Entfernen: Schlüssel weg, Zustand „fehlt“.
    const del = (await (await call(app, "DELETE", "/api/access/anthropic")).json()) as { state: string; last4: string | null };
    expect(del).toMatchObject({ state: "missing", last4: null });
    await call(app, "DELETE", "/api/access/openrouter");
  });

  it("lehnt Unsinn ab: falsches Telegram-Token, unbekannter Zugang, leerer Wert", async () => {
    const { app } = await setup({ models: { env: ENV } });
    expect((await call(app, "PUT", "/api/access/gibtsnicht", { value: "x" })).status).toBe(404);
    expect((await call(app, "PUT", "/api/access/openai", { value: "" })).status).toBe(400);
    const tg = await call(app, "PUT", "/api/access/telegram", { value: "kein-token" });
    expect(tg.status).toBe(400);
    expect(((await tg.json()) as { error: string }).error).toContain("BotFather");
  });
});

function fakeTelegram(): { svc: { status(): Promise<TelegramStatus>; setToken(t: string): Promise<void>; clearToken(): Promise<void> }; tokens: string[] } {
  const tokens: string[] = [];
  const status = async () =>
    ({
      state: tokens.length ? "connected" : "no_token",
      sentence: "",
      fix: null,
      bot: tokens.length ? { username: "nyx_bot", name: "Nyx" } : null,
      token: { set: tokens.length > 0, last4: tokens.at(-1)?.slice(-4) ?? null, source: tokens.length ? "store" : null, canEdit: true, editHint: null },
      paired: null,
    }) as unknown as TelegramStatus;
  return { svc: { status, setToken: async (t) => void tokens.push(t), clearToken: async () => void tokens.splice(0) }, tokens };
}

describe("Prüfen (Attrappen statt echter Dienste)", () => {
  it("Telegram: getMe mit dem gespeicherten Token; Postfach: x-sync-token – Ergebnis ohne Wert", async () => {
    const db = await sharedDb();
    const secrets = new SecretStore(db, KEY);
    const models = new ModelService(db, { env: ENV });
    const tg = fakeTelegram();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { username: "nyx_bot" } }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    // Telegram liest das Token wie der Bot aus dem Speicher (telegram.bot_token).
    const access = new AccessService({ models, secrets, telegram: { ...tg.svc, setToken: async (t) => void (await secrets.setSecret("telegram.bot_token", t), tg.tokens.push(t)) }, env: ENV, fetchImpl });

    const r = await access.bulk([{ id: "telegram", value: TG }]);
    expect(JSON.stringify(r)).not.toContain(TG);
    expect(r.results.find((x) => x.id === "telegram")?.check).toMatchObject({ ok: true });
    expect(r.results.find((x) => x.id === "telegram")?.check?.message).toContain("@nyx_bot");
    expect(seen.some((s) => s.url === `https://api.telegram.org/bot${TG}/getMe`)).toBe(true);

    expect((await access.get("telegram")).state).toBe("ok");

    await access.remove("telegram");
    await secrets.deleteSecret("telegram.bot_token");
  });
});

describe("Modell-Katalog", () => {
  it("zeigt genaue Kennungen je Anbieter; Standard-Rolle nennt die Haiku-Version", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const cat = (await (await app.request("/api/models/catalog")).json()) as { models: { id: string; providerId: string; name: string; context: number | null; priceIn: number | null; usable: boolean }[] };
    const haiku = cat.models.find((m) => m.id === "claude-haiku-4-5-20251001");
    expect(haiku).toMatchObject({ providerId: "anthropic", name: "Claude Haiku 4.5", context: 200_000, priceIn: 1, usable: false });
    for (const id of ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "gpt-5", "gemini-2.5-pro", "deepseek-chat"]) expect(cat.models.map((m) => m.id)).toContain(id);

    const roles = (await (await app.request("/api/models/roles")).json()) as { roles: { role: string; active: { label: string } }[] };
    expect(roles.roles.find((r) => r.role === "nyx.chat")?.active.label).toContain("claude-haiku-4-5-20251001");
    // Skills bleiben fest auf Opus 5.5 – nie Haiku.
    expect(roles.roles.find((r) => r.role === "skills.create")?.active.label).toContain("claude-opus-5-5");
    expect(roles.roles.find((r) => r.role === "skills.create")?.active.label).not.toMatch(/haiku/i);
  });
});
