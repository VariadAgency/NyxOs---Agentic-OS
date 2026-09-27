// Nyx-Tab: Vollbild mit Netz und rechter Leiste. Geprüft wird die Verdrahtung, nicht nur das Rendern:
// Live-Ereignisse schalten das Netz um (Werkzeug mit Namen), Aufgaben werden zu Karten, getippte Fragen laufen
// über denselben Chat-Weg (Kanal „web“) inkl. Kosten je Antwort, das Gedächtnis ist ehrlich leer, solange der
// Kern es nicht anbietet.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { emitNyxLive } from "../src/lib/liveBus";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { NAV_GROUPS } from "../src/nav";
import { jsonResponse, renderWithClient } from "./helpers";

function ndjson(lines: unknown[]): Promise<Response> {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
}

let chatBodies: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  chatBodies = [];
  __primeAuthForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [{ name: "git_lage", description: "Git-Lage" }, { name: "sessions_suchen", description: "Sessions" }] });
      if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
      if (url.startsWith("/api/nyx/memory")) return jsonResponse({ error: "Nicht gefunden" }, { status: 404 });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      if (url.startsWith("/api/haiku/chat")) {
        chatBodies.push(JSON.parse(String(init?.body)));
        return ndjson([
          { type: "thread", threadId: 42 },
          { type: "status", status: "tool", tool: "git_lage" },
          { type: "delta", text: "Der Build ist grün." },
          { type: "done", messageId: 7, text: "Der Build ist grün.", sources: [], estimate: false, usage: { inputTokens: 900, outputTokens: 20, costUsd: 0.0021, durationMs: 1400 }, callId: 3 },
        ]);
      }
      return jsonResponse({}, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTab(path = "/nyx") {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <NyxTab />
    </MemoryRouter>,
  );
}

describe("Nyx-Tab", () => {
  it("steht ganz oben in der Navigation", () => {
    expect(NAV_GROUPS[0]?.[0]).toMatchObject({ id: "nyx", label: "Nyx", path: "/nyx" });
  });

  it("zeigt das Netz, den Sprech-Knopf und alle sieben Reiter", async () => {
    renderTab();
    expect(await screen.findByRole("img", { name: /Nyx ruht/ })).toBeInTheDocument();
    // EIN Weck-Knopf – der große Sprech-Knopf unten.
    expect(screen.getByRole("button", { name: "Nyx wecken" })).toHaveAttribute("data-nyx", "nyx-sprechen");
    const tabs = within(screen.getByRole("tablist", { name: "Bereiche" })).getAllByRole("tab");
    // Reiter als Symbol-Leiste, der Name steht im Label (und oben in der Leiste).
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Chat", "Aufgaben live", "Dateien & Links", "Bilder", "Gedächtnis", "Kontext", "Einstellungen"]);
  });

  it("nyx.state vom Server schaltet das Netz um — Werkzeug mit Namen", async () => {
    renderTab();
    const net = await screen.findByRole("img", { name: /Nyx ruht/ });
    act(() => emitNyxLive({ type: "nyx.state", state: "tool", tool: "screenshot_simulator", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "tool"));
    expect(net).toHaveAttribute("data-tool", "screenshot_simulator");
    // Einfache Wörter statt der ID.
    expect(screen.getByRole("status")).toHaveTextContent("macht ein Bild vom Simulator");
    act(() => emitNyxLive({ type: "nyx.state", state: "speaking", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "speaking"));
  });

  it("nyx.task wird zu einer Karte mit Schritten und Vorschau in „Aufgaben live“", async () => {
    renderTab("/nyx?r=aufgaben");
    expect(await screen.findByText("Gerade keine Aufgabe.")).toBeInTheDocument();
    act(() => {
      emitNyxLive({ type: "nyx.task", taskId: "t1", phase: "started", title: "Simulator-Screenshot", where: "iPhone 17", at: new Date().toISOString() });
      emitNyxLive({ type: "nyx.task", taskId: "t1", phase: "step", title: "Simulator-Screenshot", step: { index: 0, label: "Bild machen", status: "done" }, at: new Date().toISOString() });
      emitNyxLive({ type: "nyx.task", taskId: "t1", phase: "done", title: "Simulator-Screenshot", image: { fileId: 5, title: "Startseite" }, at: new Date().toISOString() });
    });
    const card = await screen.findByRole("article", { name: "Aufgabe: Simulator-Screenshot" });
    expect(within(card).getByText("Bild machen")).toBeInTheDocument();
    expect(within(card).getByText("fertig")).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: "Startseite" })).toHaveAttribute("src", "/api/nyx/files/5");
  });

  it("getippte Frage → derselbe Chat-Weg mit Kanal „web“, Antwort mit Werkzeug und Kosten", async () => {
    renderTab();
    const input = await screen.findByLabelText("Nachricht an Nyx");
    fireEvent.change(input, { target: { value: "Ist der Build grün?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Der Build ist grün.")).toBeInTheDocument();
    expect(chatBodies[0]).toMatchObject({ message: "Ist der Build grün?", channel: "web", context: { path: "/nyx", tab: "Nyx" } });
    expect(screen.getByText("Git")).toBeInTheDocument(); // Werkzeug-Chip mit Namen statt „git_lage“
    expect(screen.getByText(/0,002\s\$ · 1,4 s · 920 Tokens · 1 Werkzeug/)).toBeInTheDocument();
    // Faden gemerkt: nach Neuladen geht es im selben Gespräch weiter – im selben Gedächtnis wie das Zentrum.
    expect(localStorage.getItem("nyxos.haiku.faden")).toBe("42");
  });

  it("Gedächtnis: ehrlich leer, solange der Nyx-Kern keins anbietet (kein Fehler, keine Technik)", async () => {
    renderTab("/nyx?r=gedaechtnis");
    expect(await screen.findByText("Nyx merkt sich noch nichts dauerhaft.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Einstellungen: kein Dauer-Zuhören mehr im Tab; „Nyx in der Leiste: Zuhören“ wird gemerkt (Schlüssel geteilt mit der Leiste)", async () => {
    renderTab("/nyx?r=einstellungen");
    fireEvent.click(await screen.findByRole("switch", { name: "Nyx in der Leiste: Zuhören" }));
    expect(screen.queryByRole("switch", { name: "Dauer-Zuhören" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("nyxos:companion") ?? "{}")).toMatchObject({ listening: true });
  });
});
