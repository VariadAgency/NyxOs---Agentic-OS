// Der Reiter „Gedächtnis“ war leer – er erwartete `items[].text`, der
// Nyx-Kern liefert `entries[].fact` (NyxMemoryView), und „Ändern“ schickte `{text}` statt `{fact}` (400).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "../src/features/nyx/tab/panels/MemoryPanel";
import { jsonResponse, renderWithClient } from "./helpers";

const VIEW = {
  entries: [
    { id: 3, category: "preference", fact: "Deploys nur nach 22 Uhr.", sourceThreadId: 12, sourceMessageId: 40, createdBy: "nyx", createdAt: "2026-09-25T18:00:00Z", updatedAt: "2026-09-25T18:00:00Z" },
    { id: 4, category: "user", fact: "Alex diktiert per Mikrofon.", sourceThreadId: null, sourceMessageId: null, createdBy: "user", createdAt: "2026-09-25T18:05:00Z", updatedAt: "2026-09-25T18:05:00Z" },
  ],
  usage: [],
  suggestions: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/status") return jsonResponse({ signedIn: true, csrf: "x" });
    if (url === "/api/nyx/memory" && (!init?.method || init.method === "GET")) return jsonResponse(VIEW);
    if (url === "/api/nyx/memory/3" && init?.method === "PATCH") return jsonResponse({ ok: true });
    return jsonResponse({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Reiter Gedächtnis ↔ Nyx-Kern", () => {
  it("zeigt die Einträge (fact, Kategorie, Herkunft)", async () => {
    renderWithClient(<MemoryPanel />);
    expect(await screen.findByText("Deploys nur nach 22 Uhr.")).toBeInTheDocument();
    expect(screen.getByText("Alex diktiert per Mikrofon.")).toBeInTheDocument();
    expect(screen.getByText("2 Erinnerungen")).toBeInTheDocument();
    expect(screen.getByText("Vorlieben")).toBeInTheDocument();
  });

  it("Ändern schickt {fact} an den Server-Vertrag", async () => {
    renderWithClient(<MemoryPanel />);
    await screen.findByText("Deploys nur nach 22 Uhr.");
    fireEvent.click(screen.getAllByRole("button", { name: "Ändern" })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Erinnerung ändern"), { target: { value: "Deploys nur nach 23 Uhr." } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ fact: "Deploys nur nach 23 Uhr." });
    });
  });
});
