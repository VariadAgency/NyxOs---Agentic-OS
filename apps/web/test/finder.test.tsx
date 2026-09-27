// „Dateien“ wie der macOS-Finder — Ansichten (Symbole/Liste/Spalten/Galerie, gemerkt), echte
// Spaltenansicht mit Tastatur und Vorschau-Spalte, Leertaste = Übersicht, Bilder öffnen + herunterladen,
// Markdown als Dokument („wie PDF“) ↔ Markdown bearbeiten → speichern (mit Prüfsumme, Rückmeldung).
import { FINDER_ROOTS, type FinderEntry, type FinderListResult, type FinderRootsResponse, type FinderTextResponse } from "@nyxos/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FinderView } from "../src/features/finder/FinderView";
import { sortEntries } from "../src/features/finder/sort";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { renderWithClient } from "./helpers";

beforeAll(() => {
  // CodeMirror misst Text über Range-Rechtecke; jsdom kennt sie nicht.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const e = (name: string, rel: string, over: Partial<FinderEntry> = {}): FinderEntry => ({
  name,
  rel,
  kind: over.isDir ? "folder" : name.endsWith(".md") ? "markdown" : name.endsWith(".png") ? "image" : "text",
  isDir: false,
  size: 1200,
  mtimeMs: Date.parse("2026-09-24T10:00:00Z"),
  children: null,
  hidden: false,
  secret: false,
  link: false,
  ...over,
});

const ROOTS: FinderRootsResponse = {
  bridge: "online",
  roots: [
    { id: FINDER_ROOTS[0].id, label: "Projekt", icon: "◆", abs: "/home/me/projekt", exists: true, writable: true },
    { id: "downloads", label: "Downloads", icon: "↓", abs: "/home/me/Downloads", exists: true, writable: false },
  ],
};

const LISTS: Record<string, FinderEntry[]> = {
  "": [e("docs", "docs", { isDir: true, children: 2 }), e("backend", "backend", { isDir: true, children: 0 }), e("README.md", "README.md", { size: 50 })],
  docs: [e("plan.md", "docs/plan.md", { size: 3000 }), e("bild.png", "docs/bild.png", { size: 900_000 })],
  backend: [],
};

const MD = "# Plan\n\nEinleitung mit **fett**.\n\n## Ziele\n\n- eins\n- zwei\n\n## Tabelle\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
const SHA = "a".repeat(64);

function stub() {
  __primeAuthForTests();
  const posts: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url, "http://x");
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/api/finder/roots") return json(ROOTS);
    if (u.pathname === "/api/finder/list") {
      const rel = u.searchParams.get("p") ?? "";
      const body: FinderListResult = { root: "project", rel, entries: LISTS[rel] ?? [], truncated: false, writable: true };
      return json(body);
    }
    if (u.pathname === "/api/finder/text") {
      const rel = u.searchParams.get("p") ?? "";
      const body: FinderTextResponse = { root: "project", rel, name: rel.split("/").pop() ?? "", content: MD, size: MD.length, mtimeMs: 1, sha256: SHA, writable: true };
      return json(body);
    }
    if (u.pathname === "/api/finder/write") {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ ok: true, mtimeMs: 2, sha256: "b".repeat(64), size: 10, backup: "/x.bak" });
    }
    if (u.pathname === "/api/files") return json({ total: 0, sessions: 0, truncated: false, areas: [], files: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts };
}

function renderAt(url: string) {
  return renderWithClient(
    <MemoryRouter initialEntries={[url]}>
      <FinderView />
    </MemoryRouter>,
  );
}

describe("Finder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("zeigt Favoriten, Pfadleiste und die vier Ansichten; die Wahl wird gemerkt", async () => {
    stub();
    const first = renderAt("/files?root=project");
    const fav = await screen.findByRole("navigation", { name: "Favoriten" });
    expect(await within(fav).findByRole("link", { name: /Projekt/ })).toBeInTheDocument();
    expect(within(fav).getByRole("link", { name: /Downloads/ })).toBeInTheDocument();
    const views = screen.getByRole("group", { name: "Darstellung" });
    for (const v of ["Symbole", "Liste", "Spalten", "Galerie"]) expect(within(views).getByRole("button", { name: v })).toBeInTheDocument();
    fireEvent.click(within(views).getByRole("button", { name: "Liste" }));
    expect(await screen.findByRole("table", { name: "Dateiliste" })).toBeInTheDocument();
    first.unmount();
    renderAt("/files?root=project");
    expect(await screen.findByRole("table", { name: "Dateiliste" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Darstellung" })).getByRole("button", { name: "Liste" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("navigation", { name: "Pfad" })).toHaveTextContent("Projekt");
  });

  it("Spalten: Ordner öffnen neue Spalten, Tastatur wie im Finder, letzte Spalte ist die Vorschau", async () => {
    stub();
    localStorage.setItem("nyx.finder.view", JSON.stringify("spalten"));
    renderAt("/files?root=project");
    const col0 = await screen.findByRole("listbox", { name: "Projekt" });
    expect(await within(col0).findByRole("option", { name: /docs/ })).toBeInTheDocument();
    // Klick auf einen Ordner öffnet rechts daneben eine Spalte
    fireEvent.click(within(col0).getByRole("option", { name: /docs/ }));
    const col1 = await screen.findByRole("listbox", { name: "docs" });
    expect(await within(col1).findByRole("option", { name: /plan\.md/ })).toBeInTheDocument();
    // Tastatur: ↑/↓ wählt die Zeile davor/danach (Ordner oben, nach Name), → geht in den Ordner, ← zurück
    fireEvent.keyDown(col0, { key: "ArrowUp" });
    expect(await screen.findByRole("listbox", { name: "backend" })).toBeInTheDocument();
    fireEvent.keyDown(col0, { key: "ArrowDown" });
    await screen.findByRole("listbox", { name: "docs" });
    fireEvent.keyDown(col0, { key: "ArrowRight" });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "docs" })).getByRole("option", { name: /bild\.png/ })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "docs" }), { key: "ArrowDown" });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "docs" })).getByRole("option", { name: /plan\.md/ })).toHaveAttribute("aria-selected", "true"));
    // Vorschau-Spalte für die gewählte Datei
    const preview = await screen.findByRole("region", { name: "Vorschau" });
    expect(within(preview).getByText("Markdown-Dokument")).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "Herunterladen" })).toHaveAttribute("href", "/api/finder/raw?root=project&p=docs%2Fplan.md&download=1");
    // Spaltenbreite ist ziehbar
    expect(screen.getAllByRole("separator", { name: /Spaltenbreite/ }).length).toBeGreaterThan(0);
    // ← zurück in die Eltern-Spalte
    fireEvent.keyDown(screen.getByRole("listbox", { name: "docs" }), { key: "ArrowLeft" });
    await waitFor(() => expect(within(col0).getByRole("option", { name: /docs/ })).toHaveAttribute("aria-selected", "true"));
  });

  it("Leertaste öffnet die Übersicht, Esc schließt sie", async () => {
    stub();
    localStorage.setItem("nyx.finder.view", JSON.stringify("spalten"));
    renderAt("/files?root=project&p=docs&sel=docs%2Fbild.png");
    const col = await screen.findByRole("listbox", { name: "docs" });
    fireEvent.keyDown(col, { key: " " });
    const ql = await screen.findByRole("dialog", { name: /Übersicht: bild\.png/ });
    expect(within(ql).getByRole("img", { name: "bild.png" })).toHaveAttribute("src", "/api/finder/raw?root=project&p=docs%2Fbild.png");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Übersicht/ })).toBeNull());
  });

  it("Bild öffnen: große Ansicht mit Zoom und Herunterladen", async () => {
    stub();
    renderAt("/files?root=project&p=docs&open=docs%2Fbild.png");
    const viewer = await screen.findByRole("dialog", { name: "bild.png" });
    expect(within(viewer).getByRole("img", { name: "bild.png" })).toHaveAttribute("src", "/api/finder/raw?root=project&p=docs%2Fbild.png");
    expect(within(viewer).getByRole("link", { name: "Herunterladen" })).toHaveAttribute("href", "/api/finder/raw?root=project&p=docs%2Fbild.png&download=1");
    fireEvent.click(within(viewer).getByRole("button", { name: "Vergrößern" }));
    expect(within(viewer).getByText("125 %")).toBeInTheDocument();
  });

  it("Markdown: erst Dokument mit Inhaltsverzeichnis, dann Markdown bearbeiten und speichern", async () => {
    const { posts } = stub();
    renderAt("/files?root=project&p=docs&open=docs%2Fplan.md");
    const viewer = await screen.findByRole("dialog", { name: "plan.md" });
    const doc = await within(viewer).findByRole("article", { name: "Dokument" });
    expect(within(doc).getByRole("heading", { level: 1, name: "Plan" })).toBeInTheDocument();
    expect(within(doc).getByRole("table")).toBeInTheDocument();
    const toc = within(viewer).getByRole("navigation", { name: "Inhalt" });
    expect(within(toc).getByRole("link", { name: "Ziele" })).toHaveAttribute("href", "#ziele");
    const mode = within(viewer).getByRole("group", { name: "Ansicht" });
    expect(within(mode).getByRole("button", { name: "Dokument" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(mode).getByRole("button", { name: "Markdown" }));
    // Editor mit Zeilennummern
    await waitFor(() => expect(viewer.querySelector(".cm-editor .cm-lineNumbers")).not.toBeNull());
    const content = viewer.querySelector(".cm-content");
    const view = content ? EditorView.findFromDOM(content as HTMLElement) : null;
    expect(view).not.toBeNull();
    act(() => view?.dispatch({ changes: { from: view.state.doc.length, insert: "\nNeu.\n" } }));
    fireEvent.click(within(viewer).getByRole("button", { name: "Speichern" }));
    expect(await within(viewer).findByText("Gespeichert")).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ root: "project", rel: "docs/plan.md", content: `${MD}\nNeu.\n`, baseSha256: SHA, baseMtimeMs: 1 });
  });
});

describe("Sortieren", () => {
  const list = [e("b.md", "b.md", { size: 5, mtimeMs: 3 }), e("A", "A", { isDir: true, mtimeMs: 1 }), e("c.png", "c.png", { size: 50, mtimeMs: 2 }), e("a.txt", "a.txt", { size: 500, mtimeMs: 4 })];
  it("Ordner oben, dann nach Name / Datum / Größe / Art", () => {
    expect(sortEntries(list, { by: "name", dir: "asc" }).map((x) => x.name)).toEqual(["A", "a.txt", "b.md", "c.png"]);
    expect(sortEntries(list, { by: "date", dir: "desc" }).map((x) => x.name)).toEqual(["A", "a.txt", "b.md", "c.png"]);
    expect(sortEntries(list, { by: "size", dir: "desc" }).map((x) => x.name)).toEqual(["A", "a.txt", "c.png", "b.md"]);
    expect(sortEntries(list, { by: "kind", dir: "asc" }).map((x) => x.name)).toEqual(["A", "c.png", "b.md", "a.txt"]);
  });
});

describe("Markdown mit kaputten Links", () => {
  it("eine kaputte %-Folge in Bild oder Link lässt das Dokument nicht abstürzen", async () => {
    const { MarkdownDocument } = await import("../src/features/finder/MarkdownDocument");
    renderWithClient(
      <MemoryRouter>
        <MarkdownDocument text={"# Titel\n\n![Skizze](bild%E0.png)\n\n[weiter](teil%E0.md)\n\nText danach"} base={{ root: "project", rel: "docs/a.md" }} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Text danach")).toBeTruthy();
  });
});
