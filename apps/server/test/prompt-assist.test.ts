// Prompt verbessern: Sonnet 5 mit Denkstufe „hoch“ macht aus des Nutzers Entwurf einen klaren Prompt,
// mit dem Stand der Session als Kontext. Nie still Haiku; kaputte Antwort → ehrlicher Fehler.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { PROMPT_IMPROVE_MODEL, type PromptAssistResult, type RoleView } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { haikuCalls, sessions } from "../src/db/schema.js";
import { ClaudeCliEngine } from "../src/haiku/claudeCli.js";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { clampQuestions } from "../src/prompt-assist/assist.js";
import { FakeEngine, setupAssistant, TOKEN } from "./assistant/assistant-helpers.js";

const SID = "aaaaaaaa-0000-4000-8000-00000000b0a1";
const KEY = `claude:${SID}`;
const TECH = /tmux|CSRF|ENOENT|CLI|undefined|null/;

type T = Awaited<ReturnType<typeof setupAssistant>>;

/** Antwort wie vom Claude-Programm mit dem angefragten Modell. */
function modelAnswer(text: string, model = PROMPT_IMPROVE_MODEL): (req: EngineRequest) => AsyncIterable<EngineEvent> {
  return async function* () {
    yield { type: "session", sessionId: "22222222-2222-4222-8222-222222222222", model };
    yield { type: "delta", text };
    yield { type: "result", text, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.012 }, model, sessionId: null, isError: false, error: null };
  };
}

const RESULT = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    prompt: "Ziel: Die Chat-Eingabe bekommt Anhänge.\n\nAnforderungen:\n- Bilder und PDF\n\nAbnahme: Test grün.",
    aenderungen: ["Tippfehler geglättet", "Ziel und Abnahme ergänzt"],
    verstaendnis: "hoch",
    ...extra,
  });

async function seedSession(t: T) {
  const base = { isSidechain: false, cwd: "/Users/alex/projects/tools/NyxOS", sessionId: SID, version: "2.1.282" };
  const raw = Buffer.from(
    [
      JSON.stringify({ ...base, type: "user", uuid: "u-1", timestamp: "2026-09-25T10:00:00.000Z", message: { role: "user", content: "Bau bitte die Chat-Eingabe mit Anhang" } }),
      JSON.stringify({ ...base, type: "assistant", uuid: "u-2", timestamp: "2026-09-25T10:00:03.000Z", message: { model: "claude-opus-5-5", id: "m1", role: "assistant", content: [{ type: "text", text: "Route steht in session-chat.ts, Tests sind grün." }] } }),
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

const URL = `/api/sessions/${KEY}/prompt-assist`;

describe("Prompt verbessern", { timeout: 60_000 }, () => {
  it("Rolle „Prompt verbessern“: fest Sonnet 5 · Reasoning hoch, nicht änderbar", async () => {
    const t = await setupAssistant();
    const res = await t.app.request("/api/models/roles");
    const roles = ((await res.json()) as { roles: RoleView[] }).roles;
    const role = roles.find((r) => r.role === "prompt.improve");
    expect(role).toMatchObject({ label: "Prompt verbessern", fixed: true, active: { source: "claude-cli", model: "claude-sonnet-5" } });
    expect(role?.active.label).toMatch(/Sonnet 5.*Reasoning hoch/);
    expect(role?.active.label).not.toMatch(/Haiku/);
    const put = await t.json("/api/models/roles/prompt.improve", { providerId: null, model: null }, "PUT");
    expect(put.status).toBe(409);
  });

  it("Verbessern: läuft mit claude-sonnet-5 + Denkstufe hoch, liest den Session-Stand, liefert Prompt + Änderungen", async () => {
    const engine = new FakeEngine(modelAnswer(RESULT()));
    const t = await setupAssistant({ engine });
    await seedSession(t);
    const res = await t.json(URL, { entwurf: "mach die chat eingabe mit anhängen fertig bidde", modus: "verbessern" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptAssistResult;
    expect(body.prompt).toContain("Ziel: Die Chat-Eingabe");
    expect(body.aenderungen).toEqual(["Tippfehler geglättet", "Ziel und Abnahme ergänzt"]);
    expect(body.verstaendnis).toBe("hoch");
    expect(body.fragen).toEqual([]);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.effort).toBe("high");

    const req = engine.requests[0] as EngineRequest;
    expect(req.model).toBe("claude-sonnet-5");
    expect(req.model).not.toMatch(/haiku/i);
    expect(req.effort).toBe("high");
    expect(req.thinking).not.toBe(false);
    expect(req.kind).toBe("prompt");
    expect(req.scope).toBe("none");
    expect(req.prompt).toContain("Chat-Eingabe bauen");
    expect(req.prompt).toContain("Bau bitte die Chat-Eingabe mit Anhang");
    expect(req.prompt).toContain("Route steht in session-chat.ts");
    expect(req.prompt).toContain("mach die chat eingabe mit anhängen fertig bidde");

    // Kosten im bestehenden Protokoll, mit dem echten Modell.
    const calls = await t.db.select().from(haikuCalls).where(eq(haikuCalls.kind, "prompt"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "ok", model: "claude-sonnet-5", costUsd: 0.012 });
  });

  it("Ergänzungen und Antworten auf Fragen gehen mit an Sonnet", async () => {
    const engine = new FakeEngine(modelAnswer(RESULT()));
    const t = await setupAssistant({ engine });
    await seedSession(t);
    const res = await t.json(URL, {
      entwurf: "anhänge fertig machen",
      bisher: "Ziel: Anhänge fertig bauen.",
      zusaetze: ["Bitte auch PDF erlauben"],
      antworten: [{ frage: "Welche Dateitypen?", auswahl: ["Bilder", "PDF"], text: "keine Videos" }],
      modus: "verbessern",
    });
    expect(res.status).toBe(200);
    const req = engine.requests[0] as EngineRequest;
    expect(req.prompt).toContain("Bitte auch PDF erlauben");
    expect(req.prompt).toContain("Welche Dateitypen?");
    expect(req.prompt).toContain("Bilder, PDF");
    expect(req.prompt).toContain("keine Videos");
    expect(req.prompt).toContain("Ziel: Anhänge fertig bauen.");
  });

  it("Fragen: Anzahl passt zum Verständnis (hoch 1–2, mittel 3, niedrig 5) – zu viele werden beschnitten", async () => {
    const q = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, frage: `Frage ${i + 1}?`, optionen: ["A", "B"], mehrfach: i === 0 }));
    const engine = new FakeEngine(modelAnswer(RESULT({ verstaendnis: "mittel", fragen: q(6) })));
    const t = await setupAssistant({ engine });
    await seedSession(t);
    const res = await t.json(URL, { entwurf: "irgendwas mit dem ding", modus: "fragen" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptAssistResult;
    expect(body.verstaendnis).toBe("mittel");
    expect(body.fragen).toHaveLength(3);
    expect(body.fragen[0]).toMatchObject({ id: "f1", frage: "Frage 1?", optionen: ["A", "B"], mehrfach: true });
    expect((engine.requests[0] as EngineRequest).prompt).toMatch(/Fragen/);

    expect(clampQuestions("hoch", q(4))).toHaveLength(2);
    expect(clampQuestions("niedrig", q(8))).toHaveLength(5);
    expect(clampQuestions("mittel", q(2))).toHaveLength(2);
    // doppelte/leere Fragen fliegen raus, IDs werden eindeutig
    const messy = clampQuestions("niedrig", [{ id: "x", frage: "  " }, { id: "x", frage: "Eins?" }, { id: "x", frage: "Zwei?", optionen: ["", "Ja"] }] as never);
    expect(messy.map((f) => f.frage)).toEqual(["Eins?", "Zwei?"]);
    expect(new Set(messy.map((f) => f.id)).size).toBe(2);
    expect(messy[1]?.optionen).toEqual(["Ja"]);
  });

  it("kaputte Modell-Antwort → ehrlicher Fehler (502), kein Prompt erfunden", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(modelAnswer("Hier ist dein Prompt: mach es einfach.")) });
    await seedSession(t);
    const res = await t.json(URL, { entwurf: "test", modus: "verbessern" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Sonnet/);
    expect(body.error).not.toMatch(TECH);
  });

  it("antwortet der Motor mit Haiku statt Sonnet → ehrlicher Fehler, nie still Haiku", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(modelAnswer(RESULT(), "claude-haiku-4-5-20251001")) });
    await seedSession(t);
    const res = await t.json(URL, { entwurf: "test", modus: "verbessern" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Sonnet 5/);
    const [call] = await t.db.select().from(haikuCalls).where(eq(haikuCalls.kind, "prompt"));
    expect(call?.status).toBe("error");
  });

  it("leerer Entwurf → 400; unbekannte Session → 404", async () => {
    const t = await setupAssistant();
    await seedSession(t);
    expect((await t.json(URL, { entwurf: "  ", modus: "verbessern" })).status).toBe(400);
    expect((await t.json(`/api/sessions/claude:gibtsnicht/prompt-assist`, { entwurf: "x", modus: "verbessern" })).status).toBe(404);
  });

  it("Anmeldung + CSRF: ohne Anmeldung 401, ohne CSRF-Kopf 403, kein Lauf", async () => {
    const engine = new FakeEngine(modelAnswer(RESULT()));
    const t = await setupAssistant({ engine, signedIn: false });
    await seedSession(t);
    const body = JSON.stringify({ entwurf: "x", modus: "verbessern" });
    const anon = await t.app.request(URL, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(anon.status).toBe(401);
    const cookieOnly = await t.app.request(URL, { method: "POST", body, headers: { "content-type": "application/json", cookie: t.authHeaders.cookie as string } });
    expect(cookieOnly.status).toBe(403);
    expect(engine.requests).toHaveLength(0);
  });

  it("Claude-Programm bekommt --model claude-sonnet-5 und --effort high (nur für diesen Lauf)", () => {
    const cli = new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", model: "haiku", mcp: { command: "x", args: [] }, homeDir: "/tmp/nyxos-test" });
    const base: EngineRequest = { kind: "prompt", systemPrompt: "s", prompt: "p", resumeSessionId: null, scope: "none", runToken: "t", tools: [], timeoutMs: 1000, signal: new AbortController().signal, toolDefs: [], callTool: async () => null };
    const args = cli.buildArgs({ ...base, model: "claude-sonnet-5", effort: "high" }, "/tmp/cfg.json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    const plain = cli.buildArgs(base, "/tmp/cfg.json");
    expect(plain[plain.indexOf("--model") + 1]).toBe("haiku");
    expect(plain).not.toContain("--effort");
  });
});
