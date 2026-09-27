// Kleine UI-Details: Brotkrümel mit Namen und „…“-Menü, Session-Kopf (Modell-Kurzform, Ordner),
// Kontext-Ring-Tooltip ohne Technik, Build-Plakette „nicht eingerichtet“ mit Erklärung.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Breadcrumbs } from "../src/components/Breadcrumbs";
import { ContextRing, contextRingTitle } from "../src/components/sessions/ContextRing";
import { BuildStatusPill } from "../src/features/builds/BuildStatusPill";
import { folderLabel, modelLabel } from "../src/features/session-chat/model";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

describe("Brotkrümel: Namen statt Kennungen, Ellipse + Tooltip", () => {
  it("zeigt die Baustelle mit ihrem Namen („NyxOS“), nicht die Kennung „nyxos“", async () => {
    stubFetchRoutes({
      categories: () => jsonResponse({ categories: [{ art: "audit", count: 12, baustellen: [{ slug: "nyxos", label: "NyxOS", count: 4 }] }] }),
      fallback: (url) =>
        url.includes("/api/sessions/abc-123")
          ? jsonResponse({ session: { id: "abc-123", title: "Software review audio and everything else that is long", baustelle: { slug: "nyxos", label: "NyxOS" } }, files: [], archive: [], events: [] })
          : undefined,
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/audit/nyxos/abc-123"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(await within(nav).findByText("NyxOS")).toBeInTheDocument();
    expect(within(nav).queryByText("nyxos")).not.toBeInTheDocument();
    expect(within(nav).getByText("Audit")).toBeInTheDocument();
  });

  it("jeder Krümel kürzt per CSS mit Ellipse und trägt den vollen Text als Tooltip", async () => {
    const long = "Software review audio and everything else that is way too long for the bar";
    stubFetchRoutes({ fallback: (url) => (url.includes("/api/sessions/abc-123") ? jsonResponse({ session: { id: "abc-123", title: long }, files: [], archive: [], events: [] }) : undefined) });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/audit/_/abc-123"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    const last = await screen.findByText(long);
    // voller Titel (kein hartes Abschneiden im Text), gekürzt wird sichtbar mit „…“ (text-overflow: ellipsis)
    expect(last).toHaveClass("truncate");
    expect(last).toHaveAttribute("title", long);
  });
});

describe("Session-Kopf: Modell-Kurzform und Ordner vorn", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-4-1-20250805", "Opus 4.1"],
    ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-4-20250514", "Opus 4"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-opus-4-6[1m]", "Opus 4.6 · 1M"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5-codex", "GPT-5 Codex"],
    ["o3", "o3"],
    // Echte Namen aus einer Produktions-DB (sessions/usage_events/haiku_calls, 25.09.2026).
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-opus-5", "Opus 5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["opus-5-5", "Opus 5.5"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-6-astra", "GPT-6 Astra"],
    // Unbekanntes bleibt wie es ist (nie „Gpt 5“ o. Ä. aus fremden Namen raten).
    ["unbekannt", "unbekannt"],
    ["mistral-large-2", "mistral-large-2"],
    ["<synthetic>", "<synthetic>"],
  ])("%s → %s", (raw, label) => {
    expect(modelLabel(raw)).toBe(label);
  });

  it.each([
    ["/home/alex/projects/NyxOS", "…/NyxOS"],
    ["/home/alex/projects/NyxOS/", "…/NyxOS"],
    ["/Users/alex/work/App/Xcode/My App", "…/My App"],
    ["/", "/"],
  ])("Pfad %s → %s", (cwd, label) => {
    expect(folderLabel(cwd)).toBe(label);
  });
});

describe("Kontext-Ring: Tooltip ohne Technik", () => {
  it("sagt Anteil, Fenstergröße und Stand in einfachen Worten", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(contextRingTitle({ pct: 58, window: 200_000, at: "2026-09-25T11:58:00Z", now })).toBe("Kontext: 58 % von 200.000 Tokens · Stand vor 2 Min");
    expect(contextRingTitle({ pct: 58, window: null, at: null, now })).toBe("Kontext: 58 %");
    expect(contextRingTitle({ pct: null, window: null, at: null, now })).toBe("Kontext: unbekannt – für dieses Modell ist keine Fenstergröße bekannt");
  });

  it("der Ring nennt nie die Quelle (LiteLLM, ccusage …)", () => {
    render(<ContextRing pct={58} contextWindow={200_000} at={new Date().toISOString()} />);
    const ring = screen.getByTestId("context-ring");
    expect(ring.getAttribute("title")).toMatch(/^Kontext: 58 % von 200\.000 Tokens · Stand /);
    expect(ring.getAttribute("title")).not.toMatch(/LiteLLM|ccusage|json/i);
  });
});

describe("Build-Plakette „nicht eingerichtet“ erklärt sich", () => {
  const run = { status: "unavailable" as const, startedAt: new Date().toISOString() };
  const view = { headline: "Build-Prüfung nicht eingerichtet: iOS-App", sentence: "Auf dem Rechner fehlt das Werkzeug „xcodebuild“ – die Brücke findet es nicht." };

  it("Tooltip sagt, was fehlt", () => {
    renderWithClient(
      <MemoryRouter>
        <BuildStatusPill current={run} view={view} />
      </MemoryRouter>,
    );
    const pill = screen.getByTestId("build-pill");
    expect(pill.getAttribute("title")).toContain("Build-Prüfung nicht eingerichtet: iOS-App");
    expect(pill.getAttribute("title")).toContain("xcodebuild");
  });

  it("Klick öffnet ein Detail mit Satz und Weg zu den Builds", () => {
    renderWithClient(
      <MemoryRouter>
        <BuildStatusPill current={run} view={view} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("build-pill"));
    const dialog = screen.getByRole("dialog", { name: /Build-Prüfung/ });
    expect(within(dialog).getByText(view.sentence)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Alle Builds ansehen/ })).toHaveAttribute("href", "/server");
  });
});

// Bei wenig Platz klappen die mittleren Ebenen in „…“ ein — Art und Baustelle
// bleiben per Klick erreichbar, der Session-Titel behält den Platz. Ob eingeklappt wird, entscheidet eine
// Container-Abfrage (jsdom rechnet sie nicht) — hier zählt: Knopf + Menü sind da und führen richtig.
describe("Brotkrümel: mittlere Ebenen über „…“ erreichbar", () => {
  function renderSession() {
    stubFetchRoutes({
      categories: () => jsonResponse({ categories: [{ art: "coding", count: 12, baustellen: [{ slug: "nyxos", label: "NyxOS", count: 4 }] }] }),
      fallback: (url) => (url.includes("/api/sessions/abc-123") ? jsonResponse({ session: { id: "abc-123", title: "Ein langer Titel" }, files: [], archive: [], events: [] }) : undefined),
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/abc-123"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
  }

  it("„…“ öffnet ein Menü mit Sessions, Art und Baustelle (richtige Ziele), der Titel bleibt stehen", async () => {
    renderSession();
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(await within(nav).findByText("Ein langer Titel")).toBeInTheDocument();
    const more = within(nav).getByRole("button", { name: "Weitere Ebenen" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = await screen.findByRole("menu", { name: "Weitere Ebenen" });
    expect(within(menu).getByRole("menuitem", { name: "Sessions" })).toHaveAttribute("href", "/sessions");
    expect(within(menu).getByRole("menuitem", { name: "Coding" })).toHaveAttribute("href", "/sessions/coding");
    expect(await within(menu).findByRole("menuitem", { name: "NyxOS" })).toHaveAttribute("href", "/sessions/coding/nyxos");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Weitere Ebenen" })).not.toBeInTheDocument();
  });

  it("die ausgeschriebenen Ebenen und „…“ schalten über dieselbe Container-Breite um (nie beide, nie keins)", async () => {
    renderSession();
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    await within(nav).findByText("Ein langer Titel");
    const more = within(nav).getByRole("button", { name: "Weitere Ebenen" });
    const full = within(nav).getByText("Coding").closest("[data-crumb-level]");
    expect(full?.className).toMatch(/@max-\[\d+px\]\/crumbs:hidden/);
    const cut = /@max-\[(\d+)px\]\/crumbs:hidden/.exec(full?.className ?? "")?.[1];
    expect(more.closest("[data-crumb-more]")?.className).toContain(`@max-[${cut}px]/crumbs:flex`);
  });

  it("nur zwei Ebenen: kein „…“", () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(within(nav).queryByRole("button", { name: "Weitere Ebenen" })).not.toBeInTheDocument();
  });
});
