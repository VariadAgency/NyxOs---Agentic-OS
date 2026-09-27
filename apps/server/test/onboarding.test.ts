// Onboarding: AI access state, "Nyx uses this access", interview → suggested Nyx profile (with and without AI),
// finish (name, onboarding done, the author's default profile never survives).
import { randomBytes } from "node:crypto";
import { DEFAULT_NYX_PROFILE, type AppInfo, type NyxProfileResponse, type OnboardingAiState, type OnboardingFinishResult, type OnboardingInterviewResult, type OnboardingUseProviderResult, type RoleView } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { addressFromStyle, neutralProfile, parseInterview, pickDefaultModel, rulesProfile, slidersFromStyle } from "../src/routes/onboarding.js";
import { setup } from "./helpers.js";
import { FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

const JSONH = { "content-type": "application/json" };
type Req = { request: (p: string, i?: RequestInit) => Response | Promise<Response> };
const post = (app: Req, path: string, body: unknown, method = "POST") => app.request(path, { method, headers: JSONH, body: JSON.stringify(body) });
const ENV = { NYXOS_SECRETS_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;

function jsonAnswer(text: string): (req: EngineRequest) => AsyncIterable<EngineEvent> {
  return async function* () {
    yield { type: "delta", text };
    yield { type: "result", text, usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, costUsd: 0.001 }, model: "fake-haiku", sessionId: null, isError: false, error: null };
  };
}

const ANSWERS = { name: "Mara", who: "Ich bin Designerin und neu bei KI-Werkzeugen.", work: "Eine Web-App für Rezepte und mein Portfolio.", style: "Bitte kurz, einfach erklärt und locker." };

describe("Onboarding · reine Helfer", () => {
  it("Stil in einfachen Worten → Regler, beide Sprachen", () => {
    const base = neutralProfile("x").sliders;
    const de = slidersFromStyle("Bitte kurz, einfach erklärt und locker", base);
    expect(de).toMatchObject({ length: 15, expertise: 90, formality: 85 });
    const en = slidersFromStyle("Detailed, technical and serious please", base);
    expect(en).toMatchObject({ length: 80, expertise: 15, humor: 5 });
    expect(slidersFromStyle("", base)).toEqual(base);
  });

  it("„Sie“ nur bei ausdrücklichem Wunsch – „Sie soll kurz antworten“ meint Nyx", () => {
    expect(addressFromStyle("Sie soll kurz antworten", "du")).toBe("du");
    expect(addressFromStyle("Bitte siezen", "du")).toBe("Sie");
    expect(addressFromStyle("Per du bitte", "Sie")).toBe("du");
  });

  it("ohne KI landen die Antworten in den passenden Feldern", () => {
    const p = rulesProfile(neutralProfile("Mara"), ANSWERS);
    expect(p.user).toMatchObject({ name: "Mara", role: ANSWERS.who, projects: ANSWERS.work, workStyle: ANSWERS.style, likes: "", noGos: "" });
    expect(p.activePreset).toBeNull();
    expect(JSON.stringify(p)).not.toContain("Alex");
  });

  it("Standard-Modell je Anbieter: klein und günstig, lokal das erste Chat-Modell", () => {
    expect(pickDefaultModel("anthropic", [])).toBe("claude-haiku-4-5-20251001");
    expect(pickDefaultModel("openai", [{ id: "gpt-5" , label: null }, { id: "gpt-5-mini", label: null }])).toBe("gpt-5-mini");
    expect(pickDefaultModel("ollama", [{ id: "nomic-embed-text", label: null }, { id: "llama3.2", label: null }])).toBe("llama3.2");
    expect(pickDefaultModel("lmstudio", [])).toBeNull();
  });

  it("Modell-Antwort: Felder, Regler (begrenzt), Anrede; Kaputtes → null", () => {
    const base = neutralProfile("Mara");
    const raw = JSON.stringify({ role: "Designerin", projects: "Rezept-App", workStyle: "", sliders: { length: 140, humor: 60 }, address: "Sie", understood: ["Du bist Designerin."] });
    const out = parseInterview(raw, base, ANSWERS);
    expect(out?.profile.user).toMatchObject({ name: "Mara", role: "Designerin", projects: "Rezept-App" });
    expect(out?.profile.sliders.length).toBe(100);
    expect(out?.profile.sliders.humor).toBe(60);
    expect(out?.profile.personality.address).toBe("Sie");
    expect(out?.understood).toEqual(["Du bist Designerin."]);
    expect(parseInterview("keine Ahnung", base, ANSWERS)).toBeNull();
  });
});

describe("Onboarding · Routen", { timeout: 60_000 }, () => {
  it("GET /api/onboarding/ai: bereit über das Claude-Programm, alle fünf Zugänge gelistet", async () => {
    const t = await setupAssistant();
    const res = await t.app.request("/api/onboarding/ai");
    expect(res.status).toBe(200);
    const s = (await res.json()) as OnboardingAiState;
    expect(s).toMatchObject({ ready: true, reason: null, via: "claude-cli", cli: { found: true } });
    expect(s.providers.map((p) => p.kind)).toEqual(["anthropic", "openai", "openrouter", "ollama", "lmstudio"]);
    expect(s.providers.every((p) => !p.configured)).toBe(true);
    expect(s.budgetUsd).toBeGreaterThan(0);
  });

  it("GET /api/onboarding/ai: Motor nicht da → nicht bereit, mit Grund in einfachen Worten", async () => {
    const engine = new FakeEngine(jsonAnswer("{}"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    const s = (await (await t.app.request("/api/onboarding/ai")).json()) as OnboardingAiState;
    expect(s.ready).toBe(false);
    expect(s.reason).toBeTruthy();
    expect(s.cli.found).toBe(false);
  });

  it("Interview mit Nyx: Vorschlag aus der Modell-Antwort, noch NICHT gespeichert", async () => {
    const engine = new FakeEngine(jsonAnswer(JSON.stringify({ role: "Designerin, neu bei KI", projects: "Rezept-Web-App, Portfolio", workStyle: "Kurz und locker", sliders: { length: 10, expertise: 95 }, understood: ["Du bist Designerin.", "Du willst kurze, einfache Antworten."] })));
    const t = await setupAssistant({ engine });
    const res = await post(t.app, "/api/onboarding/interview", ANSWERS);
    expect(res.status).toBe(200);
    const r = (await res.json()) as OnboardingInterviewResult;
    expect(r.source).toBe("nyx");
    expect(r.profile.user).toMatchObject({ name: "Mara", role: "Designerin, neu bei KI", projects: "Rezept-Web-App, Portfolio" });
    expect(r.profile.sliders).toMatchObject({ length: 10, expertise: 95 });
    expect(r.understood).toHaveLength(2);
    // Der Lauf bekam die Antworten, ohne Werkzeuge.
    expect(engine.requests.at(-1)?.prompt).toContain(ANSWERS.work);
    const saved = (await (await t.app.request("/api/nyx/profile")).json()) as NyxProfileResponse;
    expect(saved.updatedAt).toBeNull();
  });

  it("Interview ohne KI: dieselben Fragen als Formular → einfache Zuordnung, nie das Autoren-Profil", async () => {
    const engine = new FakeEngine(jsonAnswer("{}"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    const r = (await (await post(t.app, "/api/onboarding/interview", ANSWERS)).json()) as OnboardingInterviewResult;
    expect(r.source).toBe("rules");
    expect(r.profile.user.role).toBe(ANSWERS.who);
    expect(r.profile.user.role).not.toBe(DEFAULT_NYX_PROFILE.user.role);
    expect(r.profile.sliders.length).toBe(15);
    expect(r.understood.length).toBeGreaterThan(0);
    expect(engine.requests).toHaveLength(0);
  });

  it("Interview: unbrauchbare Modell-Antwort → Rückfall auf die einfache Zuordnung", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(jsonAnswer("Das kann ich nicht.")) });
    const r = (await (await post(t.app, "/api/onboarding/interview", ANSWERS)).json()) as OnboardingInterviewResult;
    expect(r.source).toBe("rules");
    expect(r.profile.user.projects).toBe(ANSWERS.work);
  });

  it("Fertig: Name + onboardingDone gespeichert, Nyx-Profil heißt wie der Nutzer, kein Autoren-Profil", async () => {
    const engine = new FakeEngine(jsonAnswer("{}"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    expect((await post(t.app, "/api/onboarding/finish", { userName: "" })).status).toBe(400);
    const res = await post(t.app, "/api/onboarding/finish", { userName: "Mara", lang: "en", briefing: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as OnboardingFinishResult).toEqual({ userName: "Mara", onboardingDone: true, briefing: "skipped" });
    const info = (await (await t.app.request("/api/app/info")).json()) as AppInfo;
    expect(info.settings).toMatchObject({ userName: "Mara", onboardingDone: true, lang: "en" });
    const p = (await (await t.app.request("/api/nyx/profile")).json()) as NyxProfileResponse;
    expect(p.profile.user.name).toBe("Mara");
    expect({ ...p.profile.user, name: "" }).toEqual(DEFAULT_NYX_PROFILE.user);
    // zurück auf Deutsch für die übrigen Tests dieser Datei
    await post(t.app, "/api/app/settings", { lang: "de" }, "PUT");
  });

  it("Fertig nach gespeichertem Profil: nur der Name ändert sich, der Rest bleibt", async () => {
    const t = await setupAssistant();
    const mine = { ...neutralProfile("Alt"), user: { ...neutralProfile("Alt").user, role: "Lehrer" } };
    expect((await post(t.app, "/api/nyx/profile", mine, "PUT")).status).toBe(200);
    await post(t.app, "/api/onboarding/finish", { userName: "Ben", briefing: false });
    const p = (await (await t.app.request("/api/nyx/profile")).json()) as NyxProfileResponse;
    expect(p.profile.user).toMatchObject({ name: "Ben", role: "Lehrer" });
  });

  it("Zugang für Nyx: erst eingerichtet, dann laufen Chat, Briefing und Stimme darüber", async () => {
    const t = await setup({ models: { env: ENV } });
    const early = await post(t.app, "/api/onboarding/ai/use", { provider: "anthropic" });
    expect(early.status).toBe(409);
    expect((await post(t.app, "/api/onboarding/ai/use", { provider: "gibtsnicht" })).status).toBe(400);
    expect((await post(t.app, "/api/access/anthropic", { value: "sk-ant-api-fake-0987654321WXYZ" }, "PUT")).status).toBe(200);
    const res = await post(t.app, "/api/onboarding/ai/use", { provider: "anthropic" });
    expect(res.status).toBe(200);
    const used = (await res.json()) as OnboardingUseProviderResult;
    expect(used).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const roles = ((await (await t.app.request("/api/models/roles")).json()) as { roles: RoleView[] }).roles;
    for (const role of ["nyx.chat", "nyx.briefing", "nyx.voice"]) {
      expect(roles.find((r) => r.role === role)?.active).toMatchObject({ source: "provider", providerId: "anthropic", model: "claude-haiku-4-5-20251001" });
    }
    // Feste Rollen bleiben unberührt.
    expect(roles.find((r) => r.role === "prompt.improve")?.active.source).toBe("claude-cli");
  });
});
