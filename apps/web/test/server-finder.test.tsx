// Server-Finder = der Finder des Dateien-Tabs mit Server-Quelle (gleiche Ansichten Symbole/Liste/Spalten/
// Galerie, Sortieren, Versteckte, Suche, Vorschau, Übersicht mit Leertaste, Enter öffnet) — NUR LESEN.
// Klick-Fehler: Einträge werden bei Klick markiert; Einträge in der Ordner-Vorschau sind anklickbar.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerFinder } from "../src/features/server/ServerFinder";
import { jsonResponse, renderWithClient } from "./helpers";

const entry = (name: string, over: Record<string, unknown> = {}) => ({ name, rel: name, isDir: false, size: 12, mtimeMs: 1_790_000_000_000, locked: false, link: false, mode: 0o644, ...over });

const LISTS: Record<string, unknown[]> = {
  "": [entry("Projekt", { isDir: true, size: 0 }), entry(".env", { size: 0, mtimeMs: 0, locked: true, mode: undefined }), entry("alpha.txt"), entry("beta.json")],
  Projekt: [entry("README.md", { rel: "Projekt/README.md" }), entry("backend", { rel: "Projekt/backend", isDir: true, size: 0 })],
};
const TEXTS: Record<string, string> = { "alpha.txt": "Inhalt von Alpha", "beta.json": '{"port":8080}', "Projekt/README.md": "# Lies mich" };

function stub() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const params = new URL(url, "http://x").searchParams;
      const p = params.get("p") ?? "";
      if (url.startsWith("/api/server/files/roots")) {
        return jsonResponse({
          roots: [
            { id: "home", label: "Home (user)", hostPath: "/home/user", exists: true },
            { id: "srv", label: "/srv", hostPath: "/srv", exists: true },
            { id: "log", label: "Logs (/var/log)", hostPath: "/var/log", exists: true },
          ],
        });
      }
      if (url.startsWith("/api/server/files/list")) return jsonResponse({ root: params.get("root"), rel: p, truncated: false, entries: LISTS[p] ?? [] });
      if (url.startsWith("/api/server/files/text")) {
        const content = TEXTS[p];
        if (content === undefined) return jsonResponse({ error: "Das ist keine Textdatei." }, { status: 415 });
        return jsonResponse({ root: "home", rel: p, name: p.split("/").pop(), content, size: content.length, mtimeMs: 1 });
      }
      if (url.startsWith("/api/server/files/search")) return jsonResponse({ root: "home", rel: p, q: params.get("q"), truncated: false, entries: [entry("tief.txt", { rel: "Projekt/backend/tief.txt" })] });
      return Promise.reject(new Error(`kein Stub für ${url}`));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openAsList() {
  const calls = stub();
  renderWithClient(<ServerFinder />);
  fireEvent.click(await screen.findByRole("button", { name: "Liste" }));
  await screen.findByText("alpha.txt");
  return calls;
}

const rowOf = (name: string) => screen.getByText(name).closest("[aria-selected]");

describe("Server-Finder = Finder des Dateien-Tabs mit Server-Quelle", () => {
  it("dieselben Ansichten und Werkzeuge; Seitenleiste zeigt die Server-Orte", async () => {
    stub();
    renderWithClient(<ServerFinder />);
    const views = await screen.findByRole("group", { name: "Darstellung" });
    for (const v of ["Symbole", "Liste", "Spalten", "Galerie"]) expect(within(views).getByRole("button", { name: v })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sortieren nach" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Versteckte/ })).toBeTruthy();
    const places = screen.getByRole("navigation", { name: "Favoriten" });
    expect(await within(places).findByText("Home (user)")).toBeTruthy();
    expect(within(places).getByText("/srv")).toBeTruthy();
    expect(within(places).getByText("Logs (/var/log)")).toBeTruthy();
  });

  it("Klick markiert Dateien UND Ordner (ohne zu öffnen), Doppelklick öffnet den Ordner", async () => {
    const calls = await openAsList();
    fireEvent.click(screen.getByText("alpha.txt"));
    expect(rowOf("alpha.txt")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByText("Projekt"));
    expect(rowOf("Projekt")?.getAttribute("aria-selected")).toBe("true");
    expect(rowOf("alpha.txt")?.getAttribute("aria-selected")).toBe("false");
    expect(calls.some((u) => u.startsWith("/api/server/files/list") && u.includes("p=Projekt"))).toBe(false);
    fireEvent.doubleClick(screen.getByText("Projekt"));
    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("Enter öffnet die Datei (nur lesen, kein Speichern)", async () => {
    await openAsList();
    fireEvent.click(screen.getByText("alpha.txt"));
    fireEvent.keyDown(screen.getByText("alpha.txt"), { key: "Enter" });
    const viewer = await screen.findByRole("dialog", { name: "alpha.txt" });
    expect(await within(viewer).findByText(/Inhalt von Alpha/)).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: /Speichern/ })).toBeNull();
    expect(within(viewer).getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toBe("/api/server/files/raw?root=home&p=alpha.txt&download=1");
  });

  it("Leertaste = Übersicht; Einträge in der Ordner-Vorschau sind anklickbar (öffnet Ordner, markiert Datei)", async () => {
    await openAsList();
    fireEvent.click(screen.getByText("Projekt"));
    fireEvent.keyDown(screen.getByText("Projekt"), { key: " " });
    const ql = await screen.findByRole("dialog", { name: /Übersicht: Projekt/ });
    fireEvent.click(await within(ql).findByRole("button", { name: /README\.md/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(rowOf("README.md")?.getAttribute("aria-selected")).toBe("true");
  });

  it("gesperrte Datei: ehrlicher Hinweis, kein Inhalt, kein Herunterladen", async () => {
    const calls = await openAsList();
    expect(screen.queryByText(".env")).toBeNull(); // Punkt-Dateien wie im Finder erst mit „Versteckte“
    fireEvent.click(screen.getByRole("checkbox", { name: /Versteckte/ }));
    fireEvent.click(await screen.findByText(".env"));
    fireEvent.keyDown(screen.getByText(".env"), { key: " " });
    const ql = await screen.findByRole("dialog", { name: /Übersicht: \.env/ });
    expect(within(ql).getByText(/Gesperrt, weil hier ein Geheimnis liegen kann/)).toBeTruthy();
    expect(within(ql).queryByRole("link", { name: "Herunterladen" })).toBeNull();
    expect(calls.some((u) => u.includes("files/text") && u.includes(".env"))).toBe(false);
  });

  it("Suche geht an den Server (rekursiv) und zeigt Treffer", async () => {
    const calls = await openAsList();
    fireEvent.change(screen.getByRole("searchbox", { name: "Dateien suchen" }), { target: { value: "tief" } });
    expect(await screen.findByText("tief.txt")).toBeTruthy();
    expect(calls.some((u) => u.startsWith("/api/server/files/search") && u.includes("q=tief"))).toBe(true);
  });

  it("Orte wechseln lädt die andere Wurzel", async () => {
    const calls = await openAsList();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Favoriten" })).getByText("Logs (/var/log)"));
    await waitFor(() => expect(calls.some((u) => u.startsWith("/api/server/files/list") && u.includes("root=log"))).toBe(true));
  });
});
