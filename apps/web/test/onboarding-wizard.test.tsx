// Onboarding: Schritt-Logik (rein) und der Assistent als Ganzes – Name ist Pflicht, alles andere überspringbar,
// „Nyx fragen“ erst ab Schritt 2, ohne KI die Fragen als Formular, am Ende Name + „fertig“ speichern und zum Überblick.
import type { AppInfo, NyxProfile, OnboardingAiState, OnboardingInterviewResult } from "@nyxos/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "../src/features/onboarding/OnboardingWizard";
import { onboardingMode } from "../src/features/onboarding/useOnboardingGate";
import { canContinue, canSkip, clearWizardState, INITIAL_STATE, loadWizardState, saveWizardState, wizardReducer, type WizardState } from "../src/features/onboarding/wizardState";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

describe("Onboarding · Schritt-Logik", () => {
  it("Name ist Pflicht: ohne Namen kein Weiter und kein Überspringen", () => {
    expect(canContinue(INITIAL_STATE)).toBe(false);
    expect(canSkip("welcome")).toBe(false);
    expect(wizardReducer(INITIAL_STATE, { type: "next" }).step).toBe("welcome");
    expect(wizardReducer(INITIAL_STATE, { type: "skip" }).step).toBe("welcome");
    const named = wizardReducer(INITIAL_STATE, { type: "name", name: "Mara" });
    expect(wizardReducer(named, { type: "next" }).step).toBe("ai");
    expect(wizardReducer(INITIAL_STATE, { type: "name", name: "   " }).step).toBe("welcome");
    expect(canContinue(wizardReducer(INITIAL_STATE, { type: "name", name: "   " }))).toBe(false);
  });

  it("Überspringen merkt sich den Schritt, Weiter nimmt die Markierung wieder weg; der letzte Schritt ist nicht überspringbar", () => {
    let s: WizardState = { ...INITIAL_STATE, name: "Mara", step: "ai" };
    s = wizardReducer(s, { type: "skip" });
    expect(s).toMatchObject({ step: "interview", skipped: ["ai"] });
    s = wizardReducer(wizardReducer(s, { type: "back" }), { type: "next" });
    expect(s).toMatchObject({ step: "interview", skipped: [] });
    expect(canSkip("done")).toBe(false);
    const done = { ...s, step: "done" as const };
    expect(wizardReducer(done, { type: "skip" }).step).toBe("done");
    expect(wizardReducer(done, { type: "next" }).step).toBe("done");
  });

  it("Springen im Fortschritt nur zurück, nie nach vorn", () => {
    const s: WizardState = { ...INITIAL_STATE, name: "Mara", step: "interview" };
    expect(wizardReducer(s, { type: "goto", step: "welcome" }).step).toBe("welcome");
    expect(wizardReducer(s, { type: "goto", step: "done" }).step).toBe("interview");
  });

  it("Fortschritt überlebt ein Neuladen (Sprachwechsel), aber nie hinter dem Namen ohne Namen", () => {
    saveWizardState({ ...INITIAL_STATE, name: "Mara", step: "setup", answers: { who: "a", work: "", style: "" } });
    expect(loadWizardState()).toMatchObject({ name: "Mara", step: "setup", answers: { who: "a" } });
    saveWizardState({ ...INITIAL_STATE, name: "", step: "setup" });
    expect(loadWizardState().step).toBe("welcome");
    localStorage.setItem("nyxos.onboarding", "{kaputt");
    expect(loadWizardState()).toEqual(INITIAL_STATE);
    clearWizardState();
  });

  it("Tor: beim ersten Start immer, später nur auf /onboarding; unbekannter Stand blockiert nie", () => {
    expect(onboardingMode("/overview", false)).toBe("first");
    expect(onboardingMode("/overview", true)).toBeNull();
    expect(onboardingMode("/onboarding", true)).toBe("again");
    expect(onboardingMode("/overview", undefined)).toBeNull();
  });
});

const INFO: AppInfo = {
  name: "NyxOS",
  version: "0.1.0",
  mode: "local",
  demo: false,
  demoHomeUrl: null,
  demoEngine: null,
  repo: "owner/nyxos",
  settings: { lang: "de", userName: "", onboardingDone: false, autoUpdate: true },
  update: { latest: null, available: false, checkedAt: null, canInstall: true, installing: false, error: null },
  dataDir: null,
};

const AI_OFF: OnboardingAiState = {
  ready: false,
  reason: "Das Claude-Programm ist auf diesem Rechner nicht installiert.",
  via: "claude-cli",
  modelLabel: null,
  cli: { found: false, version: null, token: false },
  lastAnswerAt: null,
  providers: (["anthropic", "openai", "openrouter", "ollama", "lmstudio"] as const).map((kind) => ({ kind, configured: false, ok: null, message: null, models: 0 })),
  budgetUsd: 2,
  spentTodayUsd: 0,
};

const PROFILE: NyxProfile = {
  user: { name: "Mara", role: "Designerin", projects: "Rezept-App", workStyle: "kurz", likes: "", noGos: "", notes: "" },
  personality: { character: "", tone: "", address: "du", soul: "" },
  sliders: { length: 15, speed: 45, expertise: 90, formality: 85, initiative: 55, humor: 25 },
  activePreset: null,
};

type Call = { url: string; method: string; body: unknown };

function stubServer(): Call[] {
  __primeAuthForTests();
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url.startsWith("/api/app/info")) return jsonResponse(INFO);
      if (url.startsWith("/api/onboarding/ai")) return jsonResponse(AI_OFF);
      if (url.startsWith("/api/setup")) return jsonResponse({ error: "nicht da" }, { status: 404 });
      if (url.startsWith("/api/onboarding/interview")) return jsonResponse({ profile: PROFILE, source: "rules", understood: ["Du heißt Mara.", "Über dich: Designerin"] } satisfies OnboardingInterviewResult);
      if (url.startsWith("/api/nyx/profile")) return jsonResponse({ profile: PROFILE, defaults: PROFILE, updatedAt: "2026-09-26T10:00:00Z" });
      if (url.startsWith("/api/onboarding/finish")) return jsonResponse({ userName: "Mara", onboardingDone: true, briefing: "skipped" });
      return Promise.reject(new Error(`keine Antwort für ${url}`));
    }),
  );
  return calls;
}

function renderWizard() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingWizard />} />
        <Route path="/overview" element={<p>Überblick</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Onboarding · Assistent", () => {
  beforeEach(() => clearWizardState());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearWizardState();
  });

  it("führt vom Namen bis zum Überblick – ohne KI mit Formular, Schritte überspringbar", async () => {
    const calls = stubServer();
    const user = userEvent.setup();
    renderWizard();

    // Schritt 1: Weiter erst mit Namen; „Nyx fragen“ gibt es hier noch nicht.
    const next = screen.getByRole("button", { name: "Weiter" });
    expect(next).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Überspringen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Nyx fragen/ })).toBeNull();
    await user.type(screen.getByLabelText("Dein Name"), "Mara");
    expect(next).toBeEnabled();
    await user.click(next);

    // Schritt 2: KI verbinden – Zustand live, „Nyx fragen“ zeigt ohne KI die häufigsten Fragen.
    expect(await screen.findByRole("heading", { name: "KI verbinden" })).toBeInTheDocument();
    expect(await screen.findByText("Noch keine KI verbunden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Nyx fragen/ }));
    expect(await screen.findByText("Was ist NyxOS?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Überspringen" }));

    // Schritt 3: ohne KI dieselben drei Fragen als Formular → Übersicht zum Prüfen → speichern.
    expect(await screen.findByRole("heading", { name: "Kennenlernen" })).toBeInTheDocument();
    const fields = await screen.findAllByRole("textbox");
    await user.type(fields[0] as HTMLElement, "Designerin");
    await user.type(fields[1] as HTMLElement, "Rezept-App");
    await user.click(screen.getByRole("button", { name: "Übersicht zeigen" }));
    expect(await screen.findByText("Über dich: Designerin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Speichern & weiter" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/nyx/profile" && c.method === "PUT")).toBe(true));
    const interview = calls.find((c) => c.url === "/api/onboarding/interview");
    expect(interview?.body).toMatchObject({ name: "Mara", who: "Designerin", work: "Rezept-App" });

    // Schritt 4: Einrichtung fehlt auf dem Server → verständlicher Hinweis, überspringen.
    expect(await screen.findByRole("heading", { name: "Einrichten" })).toBeInTheDocument();
    expect(await screen.findByText(/noch nicht verfügbar/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Überspringen" }));

    // Schritt 5: Fertig → Name + „fertig“ speichern, dann weg vom Assistenten.
    expect(await screen.findByRole("heading", { name: "Alles bereit, Mara!" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Überspringen" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Los geht's" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/onboarding/finish")?.body).toMatchObject({ userName: "Mara", briefing: false }));
    expect(await screen.findByText("Überblick")).toBeInTheDocument();
  });

  it("Zurück behält den Namen, der Fortschritt zeigt übersprungene Schritte", async () => {
    stubServer();
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText("Dein Name"), "Ben");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await user.click(await screen.findByRole("button", { name: "Überspringen" }));
    expect(await screen.findByText(/KI verbinden · übersprungen/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zurück" }));
    await user.click(screen.getByRole("button", { name: "Zurück" }));
    expect(screen.getByLabelText("Dein Name")).toHaveValue("Ben");
  });
});
