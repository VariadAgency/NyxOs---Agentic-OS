// Einstellungen als Übersicht + Unterseiten. Register (ein Eintrag je Bereich), Suche über Bereiche und
// einzelne Einstellungen, Weiterleitung alter Links (`/settings#push`, `/einstellungen/haiku` …), ⌘K kennt jede Unterseite.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, useLocation } from "react-router";
import { setLang } from "@nyxos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_SECTIONS, GENERAL_SECTIONS, NYX_SECTIONS, sectionsForMode, settingsPaletteItems, type SettingsSection } from "../src/features/settings/sections";
import { resolveLegacySettingsPath } from "../src/features/settings/legacy";
import { searchSettings } from "../src/features/settings/searchIndex";
import { settingsRoutes } from "../src/features/settings/routes";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
  window.localStorage.clear();
});

describe("Bereichs-Register", () => {
  it("jeder Bereich hat eindeutige id, Pfad, Titel, Symbol, Zusammenfassung und Stichwörter", () => {
    const ids = ALL_SECTIONS.map((s) => s.path);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_SECTIONS) {
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(s.icon.length, s.id).toBeGreaterThan(0);
      expect(s.summary.length, s.id).toBeGreaterThan(0);
      expect(s.keywords.length, s.id).toBeGreaterThan(0);
    }
    for (const s of GENERAL_SECTIONS) if (!s.href) expect(s.path).toBe(`/settings/${s.id}`);
    for (const s of NYX_SECTIONS) expect(s.path).toBe(`/einstellungen/nyx/${s.id}`);
  });

  it("enthält die vereinbarten Bereiche (Allgemein und Nyx)", () => {
    expect(GENERAL_SECTIONS.map((s) => s.id)).toEqual(expect.arrayContaining(["konto", "betrieb", "mitteilungen", "sessions", "nyx", "modelle", "zugaenge", "nutzung", "lernbuch", "ideen-links"]));
    expect(NYX_SECTIONS.map((s) => s.id)).toEqual(expect.arrayContaining(["persoenlichkeit", "ueber-dich", "stimme", "begleiter", "zugriff"]));
  });
});

describe("Suche", () => {
  const first = (q: string) => searchSettings(q, ALL_SECTIONS)[0];

  it("findet Bereiche über den Titel", () => {
    expect(first("Mitteilungen")?.path).toBe("/settings/mitteilungen");
    expect(first("lernbuch")?.path).toBe("/settings/lernbuch");
  });

  it("findet einzelne Einstellungen und springt an die Stelle", () => {
    // The search jumps exactly to the spot on the long notifications page (not to its top).
    expect(first("Ruhezeit")?.path).toBe("/settings/mitteilungen#erweitert-ruhezeit");
    expect(first("ntfy")?.path).toBe("/settings/mitteilungen#erweitert-iphone");
    expect(first("Nyx prüft")?.path).toMatch(/^\/settings\/mitteilungen-nyx/);
    expect(first("Verlauf")?.path).toBe("/settings/mitteilungen#verlauf");
    expect(first("Passkey")?.path).toMatch(/^\/settings\/konto/);
    expect(first("Stimme")?.path).toMatch(/^\/einstellungen\/nyx\/stimme/);
    expect(first("Telegram")?.path).toBe("/settings/telegram");
    expect(first("Verbindungen")?.path).toBe("/settings/verbindungen");
  });

  it("ohne Akzente und Groß-/Kleinschreibung, zeigt den Bereich als Kontext", () => {
    const hit = first("zugange");
    expect(hit?.path).toMatch(/^\/settings\/zugaenge/);
    expect(first("ruhezeit")?.context).toBe("Mitteilungen");
  });

  it("leere Suche und Unsinn liefern nichts", () => {
    expect(searchSettings("", ALL_SECTIONS)).toEqual([]);
    expect(searchSettings("   ", ALL_SECTIONS)).toEqual([]);
    expect(searchSettings("xyzzy-nichts", ALL_SECTIONS)).toEqual([]);
  });
});

describe("alte Links", () => {
  const cases: [string, string, string | null][] = [
    ["/settings", "#push", "/settings/mitteilungen#push"],
    ["/settings", "#verbindungen", "/settings/verbindungen"],
    ["/settings", "#zugaenge", "/settings/zugaenge"],
    ["/settings", "#zugaenge-einrichten", "/settings/zugaenge#zugaenge-einrichten"],
    ["/settings", "#konnektoren", "/settings/modelle#konnektoren"],
    ["/settings", "#modelle", "/settings/modelle"],
    ["/settings", "#telegram", "/settings/telegram"],
    ["/settings", "#nyx", "/einstellungen/nyx/begleiter"],
    ["/einstellungen/nyx", "#stimme", "/einstellungen/nyx/stimme"],
    ["/einstellungen/haiku", "", "/einstellungen/nyx/motor"],
    ["/einstellungen/ideen-links", "", "/settings/ideen-links"],
    ["/settings", "", null],
    ["/settings", "#gibtsnicht", null],
    ["/einstellungen/nyx", "", null],
  ];
  it.each(cases)("%s%s → %s", (path, hash, want) => {
    expect(resolveLegacySettingsPath(path, hash, ALL_SECTIONS)).toBe(want);
  });

  it("jeder Link aus den Zugänge-Karten landet auf einer Unterseite", async () => {
    const { ACCESS_ITEMS } = await import("@nyxos/shared");
    for (const item of ACCESS_ITEMS) {
      if (!item.target) continue;
      const [path = "", hash = ""] = item.target.split("#");
      const resolved = resolveLegacySettingsPath(path, hash ? `#${hash}` : "", ALL_SECTIONS) ?? path;
      expect(ALL_SECTIONS.some((s) => resolved.split("#")[0] === s.path), item.target).toBe(true);
    }
  });
});

describe("Feedback & Unterstützen, Info & Hilfe", () => {
  it("haben je eine Zeile in der Gruppe „Hilfe & Feedback“ ganz unten", () => {
    const help = GENERAL_SECTIONS.filter((s) => s.group === "hilfe").map((s) => s.id);
    expect(help).toEqual(["info", "unterstuetzen"]);
    expect(GENERAL_SECTIONS.find((s) => s.id === "unterstuetzen")?.path).toBe("/settings/unterstuetzen");
    expect(GENERAL_SECTIONS.find((s) => s.id === "info")?.href).toBe("/einstellungen/info");
  });

  it("die Suche findet sie über ihre Stichwörter", () => {
    expect(searchSettings("Postausgang", ALL_SECTIONS)[0]?.path).toBe("/settings/unterstuetzen");
    expect(searchSettings("Spenden", ALL_SECTIONS)[0]?.path).toBe("/settings/unterstuetzen");
    expect(searchSettings("Sprache", ALL_SECTIONS)[0]?.path).toBe("/einstellungen/info");
  });
});

describe("Lokal-Modus", () => {
  it("lässt Bereiche ohne Gegenstück weg (`modes`) und nimmt die lokalen Texte (`local`)", () => {
    const base = GENERAL_SECTIONS.find((s) => s.id === "lernbuch");
    if (!base) throw new Error("Lernbuch fehlt im Register");
    const serverOnly: SettingsSection = { ...base, id: "nur-server", path: "/settings/nur-server", modes: ["server"] };
    expect(sectionsForMode([...GENERAL_SECTIONS, serverOnly], "local").map((s) => s.id)).not.toContain("nur-server");
    expect(sectionsForMode([...GENERAL_SECTIONS, serverOnly], "server").map((s) => s.id)).toContain("nur-server");
    // Today every area exists in both modes (idea links too: reachable once NyxOS is shared in the tailnet).
    const local = sectionsForMode(GENERAL_SECTIONS, "local");
    expect(local.map((s) => s.id)).toEqual(GENERAL_SECTIONS.map((s) => s.id));
    const konto = local.find((s) => s.id === "konto");
    expect(konto?.summary).not.toMatch(/Passkey/);
    expect(konto?.keywords).not.toContain("Passkey");
    // „Betrieb & Zugriff“ locally: no server words, but the phone ways (Tailscale) work on this computer too.
    const betrieb = local.find((s) => s.id === "betrieb");
    expect(betrieb?.keywords).not.toContain("Server");
    expect(betrieb?.keywords).toContain("Tailscale");
    expect(betrieb?.panels.map((p) => p.id)).toEqual(["betrieb"]);
    // „Verbindungen“ is an own subpage of „Betrieb & Zugriff“, locally with the local explanation.
    const connections = local.find((s) => s.id === "verbindungen");
    expect(connections?.parent).toBe("betrieb");
    expect(connections?.lead).toMatch(/auf diesem Rechner/);
  });

  it("Suche und ⌘K kennen im Lokal-Modus keine Passkeys", () => {
    const local = sectionsForMode(ALL_SECTIONS, "local");
    expect(searchSettings("Passkey", local)).toEqual([]);
    expect(searchSettings("Passkey", ALL_SECTIONS)[0]?.path).toMatch(/^\/settings\/konto/);
    const words = (mode: "local" | "server") => settingsPaletteItems(mode).find((i) => i.id === "set-konto")?.words ?? "";
    expect(words("local")).not.toMatch(/passkey/);
    expect(words("server")).toMatch(/passkey/);
  });
});

describe("Englisch", () => {
  afterEach(() => setLang("de"));

  it("Titel und Stichwörter kommen übersetzt aus dem Register – die Suche findet englische Wörter", async () => {
    vi.resetModules();
    // The fresh module graph has its own copy of the translation state.
    (await import("@nyxos/shared")).setLang("en");
    const en = await import("../src/features/settings/sections");
    const search = await import("../src/features/settings/searchIndex");
    expect(en.GENERAL_SECTIONS.find((s) => s.id === "mitteilungen")?.title).toBe("Notifications");
    expect(search.searchSettings("quiet hours", en.ALL_SECTIONS)[0]?.path).toBe("/settings/mitteilungen#erweitert-ruhezeit");
    expect(search.searchSettings("voice", en.ALL_SECTIONS)[0]?.path).toMatch(/^\/einstellungen\/nyx\/stimme/);
    // Paths stay German-neutral, old links keep working.
    expect(en.GENERAL_SECTIONS.map((s) => s.path)).toContain("/settings/zugaenge");
  });
});

describe("⌘K", () => {
  it("einzelne Stellen der Mitteilungen stehen als eigene Zeile mit Anker in der Palette", () => {
    const items = settingsPaletteItems();
    expect(items.find((i) => i.label === "Mitteilungen · Ruhezeit")?.path).toBe("/settings/mitteilungen#erweitert-ruhezeit");
    expect(items.find((i) => i.label === "Telegram")?.path).toBe("/settings/telegram");
    expect(items.find((i) => i.label === "Verbindungen")?.path).toBe("/settings/verbindungen");
  });

  it("kennt jede Unterseite und die Nyx-Übersicht", () => {
    const paths = settingsPaletteItems().map((i) => i.path);
    for (const s of ALL_SECTIONS) expect(paths).toContain(s.path);
    expect(paths).toContain("/einstellungen/nyx");
  });
});

// ─── Seiten im jsdom ───

function stubFetch(mode: "local" | "server" = "server") {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/app/info") return jsonResponse({ version: "0.0.0-test", mode, demo: false, dataDir: null, settings: { lang: "de", userName: "", onboardingDone: true } });
    if (url === "/api/rules") return jsonResponse({ rules: [] });
    if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "x", hasPasskey: true, authReads: false });
    return jsonResponse({ error: "nicht in diesem Test" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.hash}`}</output>;
}

const renderAt = (path: string) =>
  renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{settingsRoutes}</Routes>
      <Where />
    </MemoryRouter>,
  );

describe("Übersicht und Unterseite", () => {
  it("Übersicht: Suchfeld, Gruppen, eine Zeile je Bereich mit Zusammenfassung", async () => {
    stubFetch();
    renderAt("/settings");
    expect(await screen.findByRole("heading", { name: "Einstellungen", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /Einstellungen durchsuchen/ })).toBeInTheDocument();
    const konto = screen.getByRole("link", { name: /Konto & Anmeldung/ });
    expect(konto).toHaveAttribute("href", "/settings/konto");
    expect(screen.getByRole("link", { name: /^Nyx – / })).toHaveAttribute("href", "/einstellungen/nyx");
    // Die Übersicht zeigt keine Panels mehr direkt.
    expect(screen.queryByText("Kontext-Wächter")).toBeNull();
  });

  it("Zeile öffnet die Unterseite, „‹ Einstellungen“ führt zurück", async () => {
    stubFetch();
    renderAt("/settings");
    fireEvent.click(await screen.findByRole("link", { name: /Lernbuch/ }));
    expect(await screen.findByRole("heading", { name: "Lernbuch", level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/lernbuch");
    expect(await screen.findByText("Noch keine gelernte Regel.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Einstellungen/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings$/));
  });

  it("Suche filtert live; ↓ + Enter springt auf die Unterseite an die Stelle", async () => {
    stubFetch();
    renderAt("/settings");
    const box = await screen.findByRole("searchbox", { name: /Einstellungen durchsuchen/ });
    fireEvent.change(box, { target: { value: "Ruhezeit" } });
    const list = screen.getByRole("listbox", { name: "Treffer" });
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent(/Ruhezeit/);
    expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/settings/mitteilungen#erweitert-ruhezeit"));
  });

  it("„/“ setzt den Fokus ins Suchfeld", async () => {
    stubFetch();
    renderAt("/settings");
    const box = await screen.findByRole("searchbox", { name: /Einstellungen durchsuchen/ });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(box).toHaveFocus();
  });

  it("alter Anker leitet auf die Unterseite weiter", async () => {
    stubFetch();
    renderAt("/settings#verbindungen");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/settings/verbindungen"));
    expect(await screen.findByRole("heading", { name: "Verbindungen", level: 1 })).toBeInTheDocument();
  });

  it("alter Anker auf eine heute eigene Unterseite (/settings/betrieb#verbindungen) leitet weiter", async () => {
    stubFetch();
    renderAt("/settings/betrieb#verbindungen");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings\/verbindungen$/));
  });

  it("Telegram/Verbindungen sind Unterseiten ihres Bereichs – keine eigene Zeile in der Übersicht", async () => {
    stubFetch();
    renderAt("/settings");
    await screen.findByRole("heading", { name: "Einstellungen", level: 1 });
    expect(screen.queryByRole("link", { name: /^Telegram – / })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Verbindungen – / })).toBeNull();
  });

  it("Unterseite Telegram – ein Titel, „‹ Mitteilungen“ führt zum Eltern-Bereich", async () => {
    stubFetch();
    renderAt("/settings/telegram");
    expect(await screen.findByRole("heading", { name: "Telegram", level: 1 })).toBeInTheDocument();
    // No second title „Telegram“ below the page title.
    expect(screen.queryAllByRole("heading", { name: "Telegram" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Zurück zu Mitteilungen" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings\/mitteilungen$/));
  });

  it("„Wie geschrieben?“ und „Nyx prüft & schreibt“ sind Unterseiten von Mitteilungen", async () => {
    const style = GENERAL_SECTIONS.find((s) => s.id === "mitteilungen-stil");
    const nyx = GENERAL_SECTIONS.find((s) => s.id === "mitteilungen-nyx");
    expect(style?.parent).toBe("mitteilungen");
    expect(nyx?.parent).toBe("mitteilungen");
    // Search and ⌘K land on the subpage, no longer on a spot of the long page.
    expect(searchSettings("Nyx prüft", ALL_SECTIONS)[0]?.path).toMatch(/^\/settings\/mitteilungen-nyx/);
    expect(searchSettings("Stil", ALL_SECTIONS)[0]?.path).toMatch(/^\/settings\/mitteilungen-stil/);
    expect(searchSettings("Vorschau", ALL_SECTIONS)[0]?.path).toMatch(/^\/settings\/mitteilungen-stil/);
    const palette = settingsPaletteItems();
    expect(palette.some((i) => i.path.startsWith("/settings/mitteilungen#wie") || i.path.startsWith("/settings/mitteilungen#nyx"))).toBe(false);
    expect(palette.find((i) => i.id === "set-mitteilungen-stil")?.path).toBe("/settings/mitteilungen-stil");
    // Old anchors on the notifications page lead to the new subpage.
    stubFetch();
    const first = renderAt("/settings/mitteilungen#wie");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings\/mitteilungen-stil$/));
    first.unmount();
    renderAt("/settings/mitteilungen#nyx");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings\/mitteilungen-nyx$/));
    fireEvent.click(await screen.findByRole("button", { name: "Zurück zu Mitteilungen" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings\/mitteilungen$/));
  });

  it("/einstellungen/haiku und unbekannte Unterseiten leiten weiter", async () => {
    stubFetch();
    renderAt("/einstellungen/haiku");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/einstellungen/nyx/motor"));
  });

  it("unbekannte Unterseite → Übersicht", async () => {
    stubFetch();
    renderAt("/settings/gibtsnicht");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings$/));
  });

  it("Lokal-Modus: Konto & Anmeldung mit den lokalen Texten", async () => {
    stubFetch("local");
    renderAt("/settings");
    expect(await screen.findByText("Angemeldet auf diesem Rechner, abmelden")).toBeInTheDocument();
    expect(screen.queryByText("Anmelden, Passkeys, weitere Geräte verbinden")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Konto & Anmeldung/ }));
    expect(await screen.findByText("Ob dieser Browser angemeldet ist – und wie du dich ab- und wieder anmeldest.")).toBeInTheDocument();
  });

  it("Feedback & Unterstützen: Unterseite öffnet das Blatt auf dem gewählten Reiter", async () => {
    stubFetch();
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push(String((e as CustomEvent<string>).detail));
    window.addEventListener("nyxos:open-support", onOpen);
    try {
      renderAt("/settings");
      fireEvent.click(await screen.findByRole("link", { name: /Feedback & Unterstützen/ }));
      expect(await screen.findByRole("heading", { name: "Feedback & Unterstützen", level: 1 })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Buy me Tokens/ }));
      fireEvent.click(screen.getByRole("button", { name: /Fehler melden/ }));
      expect(opened).toEqual(["tokens", "bug"]);
    } finally {
      window.removeEventListener("nyxos:open-support", onOpen);
    }
  });

  it("Zeile „Info & Hilfe“ führt auf die Info-Seite", async () => {
    stubFetch();
    renderAt("/settings");
    expect(await screen.findByRole("link", { name: /^Info & Hilfe – / })).toHaveAttribute("href", "/einstellungen/info");
  });

  it("Erweitert merkt sich den Zustand", async () => {
    stubFetch();
    const first = renderAt("/settings/modelle");
    const summary = await screen.findByText("Erweitert", { selector: "summary *, summary" });
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    await waitFor(() => expect(details).toHaveAttribute("open"));
    first.unmount();
    renderAt("/settings/modelle");
    const again = await screen.findByText("Erweitert", { selector: "summary *, summary" });
    expect(again.closest("details")).toHaveAttribute("open");
  });
});

describe("Sprung in zugeklappte Blöcke", () => {
  it("scrollToAnchor klappt ein <details> um die Stelle auf (sonst hat die Stelle keine Position)", async () => {
    const { scrollToAnchor } = await import("../src/features/settings/scroll");
    document.body.innerHTML = `<details id="aussen"><summary>Erweitert</summary><details id="innen"><summary>x</summary><div id="ziel">Ruhezeit</div></details></details>`;
    const stop = scrollToAnchor("ziel");
    expect((document.getElementById("aussen") as HTMLDetailsElement).open).toBe(true);
    expect((document.getElementById("innen") as HTMLDetailsElement).open).toBe(true);
    stop();
    document.body.innerHTML = "";
  });
});
