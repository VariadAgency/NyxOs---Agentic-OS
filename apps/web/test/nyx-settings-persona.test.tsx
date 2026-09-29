// Einstellungen → Nyx. Live-Beispielsatz (lokal, ohne Modell), Vorlagen-Chips, Speichern, Zurücksetzen.
import { BUILTIN_NYX_PRESETS, DEFAULT_NYX_PROFILE, type NyxProfile } from "@nyxos/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxAboutPanel, NyxPersonalityPanel, NyxSaveBar } from "../src/features/settings/nyx/NyxProfilePanels";
import { NyxProfileProvider } from "../src/features/settings/nyx/NyxProfileContext";
import { previewAnswer } from "../src/features/settings/nyx/preview";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
});

const withSliders = (over: Partial<NyxProfile["sliders"]>): NyxProfile => ({ ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, ...over } });

describe("Live-Beispielsatz", () => {
  it("kurz ist kürzer als ausführlich", () => {
    expect(previewAnswer(withSliders({ length: 0 })).length).toBeLessThan(previewAnswer(withSliders({ length: 100 })).length);
  });

  it("fachlich nennt Technik, sehr einfach nicht", () => {
    expect(previewAnswer(withSliders({ expertise: 0 }))).toMatch(/Tests|Typecheck|Commit/);
    expect(previewAnswer(withSliders({ expertise: 100 }))).not.toMatch(/Tests|Typecheck|Commit/);
  });

  it("jeder Regler verändert den Satz, Anrede Sie wirkt", () => {
    for (const key of ["length", "speed", "expertise", "formality", "initiative", "humor"] as const) {
      expect(previewAnswer(withSliders({ [key]: 0 })), key).not.toBe(previewAnswer(withSliders({ [key]: 100 })));
    }
    const sie = previewAnswer({ ...withSliders({ initiative: 100 }), personality: { ...DEFAULT_NYX_PROFILE.personality, address: "Sie" } });
    expect(sie).toMatch(/\bSie\b/);
    expect(sie).not.toMatch(/\bdu\b|\bdir\b/);
  });
});

function stub(profile: NyxProfile = DEFAULT_NYX_PROFILE) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/nyx/profile" && method === "GET") return jsonResponse({ profile, defaults: DEFAULT_NYX_PROFILE, updatedAt: null });
    if (url === "/api/nyx/profile" && method === "PUT") return jsonResponse({ profile: JSON.parse(String(init?.body)) as NyxProfile, defaults: DEFAULT_NYX_PROFILE, updatedAt: "2026-09-25T18:00:00.000Z" });
    if (url === "/api/nyx/presets" && method === "GET") return jsonResponse({ presets: BUILTIN_NYX_PRESETS });
    if (url === "/api/nyx/presets" && method === "POST") return jsonResponse({ preset: { id: "eigen-1", builtin: false, description: "", ...(JSON.parse(String(init?.body)) as object) } }, { status: 201 });
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const render = () =>
  renderWithClient(
    // Persönlichkeit and Über dich are own subpages with a shared draft – rendered together here.
    <MemoryRouter>
      <NyxProfileProvider>
        <NyxPersonalityPanel />
        <NyxAboutPanel />
        <NyxSaveBar />
      </NyxProfileProvider>
    </MemoryRouter>,
  );

describe("Seite Einstellungen → Nyx", () => {
  it("zeigt Profil, Persönlichkeit, Regler mit Beschriftung und alle Vorlagen", async () => {
    stub({ ...DEFAULT_NYX_PROFILE, user: { ...DEFAULT_NYX_PROFILE.user, name: "Alex" } });
    render();
    await screen.findByTestId("nyx-preview");
    expect(screen.getByLabelText("Name")).toHaveValue("Alex");
    expect(screen.getByLabelText("Anrede")).toBeInTheDocument();
    const sliders = screen.getByRole("region", { name: "Verhalten" });
    for (const word of ["kurz", "ausführlich", "schnell", "gründlich", "fachlich", "sehr einfach", "förmlich", "locker", "zurückhaltend", "proaktiv"]) {
      expect(within(sliders).getAllByText(word).length).toBeGreaterThan(0);
    }
    const chips = screen.getByRole("group", { name: "Vorlagen" });
    for (const p of BUILTIN_NYX_PRESETS) expect(within(chips).getByRole("button", { name: new RegExp(p.label) })).toBeInTheDocument();
    expect(screen.getByText(/So würde Nyx jetzt antworten/)).toBeInTheDocument();
  });

  it("Vorlage anklicken setzt die Regler und ändert den Beispielsatz; Speichern schickt sie mit", async () => {
    const fetchMock = stub();
    render();
    await screen.findByTestId("nyx-preview");
    const before = screen.getByTestId("nyx-preview").textContent;
    fireEvent.click(within(screen.getByRole("group", { name: "Vorlagen" })).getByRole("button", { name: /Gründlich/ }));
    expect(screen.getByRole("slider", { name: "Tempo" })).toHaveValue("95");
    // Der Satz wird bei jeder Änderung neu eingeblendet (neues Element) – darum neu abfragen.
    expect(screen.getByTestId("nyx-preview").textContent).not.toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/nyx/profile" && i?.method === "PUT")).toBe(true));
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/nyx/profile" && i?.method === "PUT");
    const sent = JSON.parse(String(call?.[1]?.body)) as NyxProfile;
    expect(sent.activePreset).toBe("gruendlich");
    expect(sent.sliders.speed).toBe(95);
    expect(await screen.findByText("Gespeichert")).toBeInTheDocument();
  });

  it("Regler von Hand: Vorlage nicht mehr aktiv; Zurücksetzen holt die Startwerte", async () => {
    stub({ ...DEFAULT_NYX_PROFILE, sliders: BUILTIN_NYX_PRESETS[0]?.sliders ?? DEFAULT_NYX_PROFILE.sliders, activePreset: "kurz-knapp" });
    render();
    await screen.findByTestId("nyx-preview");
    const chip = within(screen.getByRole("group", { name: "Vorlagen" })).getByRole("button", { name: /Kurz & knapp/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("slider", { name: "Länge" }), { target: { value: "70" } });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Zurücksetzen" }));
    expect(screen.getByRole("slider", { name: "Länge" })).toHaveValue(String(DEFAULT_NYX_PROFILE.sliders.length));
  });

  it("Als Vorlage speichern: Name eingeben → POST mit den aktuellen Reglern", async () => {
    const fetchMock = stub();
    render();
    await screen.findByTestId("nyx-preview");
    fireEvent.click(screen.getByRole("button", { name: "Als Vorlage speichern" }));
    fireEvent.change(screen.getByLabelText("Name der Vorlage"), { target: { value: "Abends" } });
    fireEvent.click(screen.getByRole("button", { name: "Vorlage anlegen" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/nyx/presets" && i?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/nyx/presets" && i?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ label: "Abends", sliders: DEFAULT_NYX_PROFILE.sliders });
  });
});
