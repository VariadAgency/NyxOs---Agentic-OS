// Info-Karte im lokalen Graphen — zeigt Art, Titel, Fakten und Textauszug; ✕ und Esc schließen.
import type { GraphNode, GraphNodeDetail } from "@nyxos/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeCard } from "../src/features/brain/NodeCard";

afterEach(() => vi.unstubAllGlobals());

const node: GraphNode = { id: "note:04 Planung/Heatmap.md", type: "note", label: "Heatmap", group: "04 Planung", degree: 3, ref: { kind: "note", path: "04 Planung/Heatmap.md", vault: "Vault" } };
const detail: GraphNodeDetail = {
  id: node.id,
  type: "note",
  title: "Heatmap Live",
  facts: [
    ["Ordner", "04 Planung"],
    ["Geändert", "20.09.2026, 12:00"],
  ],
  excerpt: { label: "Notiz-Anfang", text: "Die Heatmap zeigt live, wo gefeiert wird." },
  extra: null,
  tags: ["planung"],
};

describe("NodeCard (Info-Karte)", () => {
  it("lädt Details und zeigt Art (Notiz-Kategorie), Titel, Fakten, Auszug und Links", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes("/api/graph/node/") ? detail : {}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <NodeCard node={node} onClose={() => undefined} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("node-card");
    expect(card).toHaveTextContent("Planung"); // Kategorie aus dem Ordner
    await waitFor(() => expect(card).toHaveTextContent("Die Heatmap zeigt live, wo gefeiert wird."));
    expect(card).toHaveTextContent("Heatmap Live");
    expect(card).toHaveTextContent("04 Planung");
    expect(card).toHaveTextContent("#planung");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/graph/node/${encodeURIComponent(node.id)}`);
    expect(screen.getByRole("link", { name: /In Obsidian öffnen/ })).toHaveAttribute("href", expect.stringContaining("obsidian://open"));
    expect(screen.getByRole("link", { name: "Eigenes Gehirn" })).toHaveAttribute("href", `/gehirn?brain=${encodeURIComponent(node.id)}`);
  });

  it("✕ und Esc schließen die Karte", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }))));
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <NodeCard node={node} onClose={onClose} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Info schließen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Esc schließt nur die Karte, nicht auch die Großansicht drumherum (Aufgaben-Großansicht hört auch auf Esc)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }))));
    const outer = vi.fn();
    const onOuterKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") outer();
    };
    window.addEventListener("keydown", onOuterKey); // wie EntryOverlay: vor der Karte angemeldet
    try {
      const onClose = vi.fn();
      const { rerender } = render(
        <MemoryRouter>
          <NodeCard node={node} onClose={onClose} />
        </MemoryRouter>,
      );
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
      // Ohne Karte kommt Esc wieder bei der Großansicht an.
      rerender(<MemoryRouter>{null}</MemoryRouter>);
      await userEvent.keyboard("{Escape}");
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onOuterKey);
    }
  });

  it("Server nicht erreichbar: freundlicher Hinweis statt Technik-Meldung", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 500 }))));
    render(
      <MemoryRouter>
        <NodeCard node={{ ...node, id: "note:andere.md" }} onClose={() => undefined} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("node-card")).toHaveTextContent("Details sind gerade nicht abrufbar"));
  });
});
