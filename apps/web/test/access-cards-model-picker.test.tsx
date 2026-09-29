// Zugänge als anklickbare Karten + „Alles auf einmal einrichten“ (schlau einfügen) + Modell-Wähler mit
// genauen Kennungen, Kontext und Preisen.
import { ACCESS_ITEMS, MODEL_CATALOG, type AccessStatus, type ModelChoice } from "@nyxos/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessPanel } from "../src/features/settings/access/AccessPanel";
import { ModelPicker } from "../src/features/settings/ModelPicker";
import { jsonResponse, renderWithClient } from "./helpers";

const items: AccessStatus[] = ACCESS_ITEMS.map((i) => ({
  id: i.id,
  state: i.storage === "link" ? "link" : i.id === "anthropic" ? "ok" : "missing",
  detail: i.id === "anthropic" ? "verbunden · 12 Modelle" : null,
  last4: i.id === "anthropic" ? "9876" : null,
  url: null,
  updatedAt: null,
  lastCheck: null,
  blocked: null,
}));

afterEach(() => vi.unstubAllGlobals());

describe("Zugänge", () => {
  it("Karte aufklappen zeigt Zweck, Schritte mit offiziellem Link; Assistent erkennt eingefügte Schlüssel und speichert alle", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === "/api/access/bulk")
          return jsonResponse({
            results: [
              { id: "openai", saved: true, error: null, check: { ok: true, at: "", ms: 5, message: "Verbunden – 80 Modelle gefunden." } },
              { id: "telegram", saved: true, error: null, check: { ok: false, at: "", ms: 5, message: "Telegram kennt dieses Token nicht" } },
            ],
            items,
          });
        if (url === "/api/access") return jsonResponse({ items, secretsKey: "ok" });
        return jsonResponse({}, { status: 404 });
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/settings"]}>
        <AccessPanel />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const tgCard = await screen.findByRole("button", { name: /Telegram-Bot/ });
    expect(screen.getByText("endet auf …9876")).toBeInTheDocument();
    await user.click(tgCard);
    const card = tgCard.closest("[data-access]") as HTMLElement;
    expect(within(card).getByText(/\/newbot/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /BotFather/ })).toHaveAttribute("href", "https://t.me/BotFather");

    await user.click(screen.getByRole("button", { name: "Alles auf einmal einrichten" }));
    const area = screen.getByLabelText("Mehrere Schlüssel einfügen");
    fireEvent.change(area, { target: { value: "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n123456789:AAH-abcdefghijklmnopqrstuvwxyz01234" } });
    await user.click(screen.getByRole("button", { name: "Erkennen" }));
    expect(screen.getByTestId("wizard-paste-note").textContent).toMatch(/OpenAI.*Telegram-Bot/);
    expect((screen.getByLabelText("OpenAI: Wert", { selector: "[data-wizard-item] input" }) as HTMLInputElement).value).toBe("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");

    await user.click(screen.getByRole("button", { name: /2 Zugänge speichern \+ prüfen/ }));
    expect(await screen.findByText(/Fertig – 1 von 2 eingerichtet/)).toBeInTheDocument();
    const bulk = calls.find((c) => c.url === "/api/access/bulk");
    expect(bulk?.method).toBe("POST");
    expect((bulk?.body as { entries: { id: string }[] }).entries.map((e) => e.id).sort()).toEqual(["openai", "telegram"]);
    expect(screen.getByTestId("wizard-result-telegram").textContent).toContain("Telegram kennt dieses Token nicht");
  });
});

describe("Modell-Wähler", () => {
  it("zeigt genaue Kennung, Kontext und Preis; Suche filtert; ohne Zugang nicht wählbar", async () => {
    const models: ModelChoice[] = MODEL_CATALOG.map((m) => ({ ...m, providerId: m.provider, providerLabel: m.provider === "anthropic" ? "Anthropic" : m.provider, usable: m.provider === "anthropic" }));
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ models })));
    const onPick = vi.fn();
    renderWithClient(<ModelPicker selected={null} onPick={onPick} onClose={() => {}} />);
    const haiku = (await screen.findByText("claude-haiku-4-5-20251001")).closest("button") as HTMLElement;
    expect(haiku.textContent).toContain("Claude Haiku 4.5");
    expect(haiku.textContent).toContain("Kontext 200K");
    expect(haiku.textContent).toContain("$1 / $5");
    const user = userEvent.setup();
    await user.click(haiku);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-haiku-4-5-20251001", providerId: "anthropic" }));

    await user.type(screen.getByLabelText("Modell suchen"), "gemini");
    expect(document.querySelector('[data-model="claude-haiku-4-5-20251001"]')).toBeNull();
    const gem = document.querySelector('[data-model="gemini-2.5-pro"]') as HTMLButtonElement;
    expect(gem.disabled).toBe(true);
  });
});

describe("Hinweis im Überblick (optionale Zugänge sind nicht bindend)", () => {
  const withStates = (states: Record<string, AccessStatus["state"]>) => items.map((i) => ({ ...i, state: states[i.id] ?? i.state }));
  const mountHint = async (list: AccessStatus[]) => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ items: list })));
    const { AccessHint } = await import("../src/features/settings/access/AccessHint");
    renderWithClient(
      <MemoryRouter>
        <AccessHint />
      </MemoryRouter>,
    );
  };

  it("fehlende Zugänge allein → kein Hinweis „N Zugänge fehlen noch“", async () => {
    await mountHint(items);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("access-hint")).toBeNull();
  });

  it("ein eingetragener Zugang mit Fehler → Hinweis bleibt", async () => {
    await mountHint(withStates({ telegram: "error" }));
    expect(await screen.findByTestId("access-hint")).toHaveTextContent(/1 Zugang mit Fehler/);
  });
});
