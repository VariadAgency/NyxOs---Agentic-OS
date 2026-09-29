// Info-Karte zeigt Text statt rohem Markdown (sicher, kein HTML aus Daten) und schließt bzw.
// aktualisiert sich, wenn der lokale Graph zu einer anderen Session wechselt.
import { markdownToText, type GraphNode, type GraphNodeDetail } from "@nyxos/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeCard } from "../src/features/brain/NodeCard";

vi.mock("../src/features/brain/GraphCanvas", () => ({
  GraphCanvas: (p: { graph: { nodes: GraphNode[] }; onSelect(n: GraphNode | null): void }) => (
    <div data-testid="graph-canvas">
      {p.graph.nodes.map((n) => (
        <button key={n.id} type="button" onClick={() => p.onSelect(n)}>
          Punkt {n.label}
        </button>
      ))}
    </div>
  ),
}));

const sessionNode = (id: string, label: string): GraphNode => ({
  id: `session:claude:${id}`,
  type: "session",
  label,
  group: "coding",
  degree: 1,
  ref: { kind: "session", sessionKey: `claude:${id}`, sessionId: id, tool: "claude", art: "coding", baustelleSlug: null },
});
const graphs: Record<string, GraphNode[]> = {
  a: [sessionNode("a", "Session A"), sessionNode("gemeinsam", "Gemeinsam")],
  b: [sessionNode("b", "Session B"), sessionNode("gemeinsam", "Gemeinsam")],
};
vi.mock("../src/features/brain/useGraph", () => ({
  useLocalGraph: (nodeId: string) => ({
    status: "ready",
    graph: { version: 1, nodes: graphs[nodeId] ?? [], links: [] },
    stats: null,
    dataVersion: nodeId === "a" ? 1 : 2,
    structureVersion: nodeId === "a" ? 1 : 2,
    center: `session:claude:${nodeId}`,
    reload: () => undefined,
  }),
}));

const { LocalGraph } = await import("../src/features/brain/LocalGraph");

afterEach(() => vi.unstubAllGlobals());

describe("markdownToText (Info-Karte)", () => {
  it("macht aus Markdown lesbaren Text: keine Backticks, Sternchen, Rauten, Aufzählungsstriche, Link-Klammern", () => {
    const md = "## Ergebnis\n\n- **Fertig:** `pnpm test` läuft\n- Siehe [Doku](https://x.y/z) und [[04 Planung/Heatmap|Heatmap]]\n1. Schritt eins\n\n```ts\nconst a = 1;\n```\n> Zitat mit _Betonung_";
    const t = markdownToText(md);
    expect(t).not.toMatch(/[`*#]|\]\(|\[\[|^\s*-\s/m);
    expect(t).toContain("Ergebnis");
    expect(t).toContain("• Fertig: pnpm test läuft");
    expect(t).toContain("• Siehe Doku und Heatmap");
    expect(t).toContain("1. Schritt eins");
    expect(t).toContain("const a = 1;");
    expect(t).toContain("Zitat mit Betonung");
    // Zeilenumbrüche bleiben (einfache Darstellung), keine Leerzeilen-Wüsten
    expect(t.split("\n").length).toBeGreaterThan(3);
    expect(t).not.toMatch(/\n{3,}/);
  });

  it("entfernt HTML aus Daten vollständig (nichts wird als Markup gedeutet)", () => {
    const t = markdownToText('Hallo <img src=x onerror="window.__xss=1"> <script>alert(1)</script>Welt <b>fett</b>');
    expect(t).not.toMatch(/[<>]/);
    expect(t).toContain("Hallo");
    expect(t).toContain("Welt fett");
    expect(t).not.toContain("alert(1)");
  });

  it("ein einzelnes „<“ frisst keinen Text (kein Tag bis zum nächsten „>“ Zeilen später)", () => {
    const t = markdownToText("Wenn a<b gilt, sortieren.\n\nZweiter Absatz -> fertig");
    expect(t).toContain("gilt, sortieren.");
    expect(t).toContain("Zweiter Absatz");
    expect(t).toContain("fertig");
    // geschlossene Tags fliegen weiterhin raus
    expect(markdownToText("vor <span class=x>mitte</span> nach")).toBe("vor mitte nach");
  });

  it("Vergleiche und Unterstriche bleiben, nur gepaarte Markierungen fallen weg", () => {
    expect(markdownToText("Prüft x == 1 und y ~~ 2")).toBe("Prüft x == 1 und y ~~ 2");
    expect(markdownToText("==wichtig== und ~~alt~~ und __fett__")).toBe("wichtig und alt und fett");
  });

  it("reiner Text bleibt unverändert (auch zweimal angewendet)", () => {
    const plain = "Die Heatmap zeigt live, wo gefeiert wird.";
    expect(markdownToText(plain)).toBe(plain);
    const md = "- **a** `b`\n- c";
    expect(markdownToText(markdownToText(md))).toBe(markdownToText(md));
  });
});

describe("NodeCard zeigt Auszüge als sicheren Text", () => {
  it("rohes Markdown und HTML aus dem Server werden zu Text, kein <img> entsteht, kein Skript läuft", async () => {
    const node: GraphNode = sessionNode("x", "Gehirn polieren");
    const detail: GraphNodeDetail = {
      id: node.id,
      type: "session",
      title: "Gehirn polieren",
      facts: [["Werkzeug", "Claude"]],
      excerpt: { label: "Letzte Nachricht", text: '**Fertig:** `pnpm test` grün\n- Punkt eins\n- Punkt zwei <img src=x onerror="window.__xss=1">' },
      extra: { label: "Auftrag", text: "## Bitte\n[Link](javascript:alert(1)) prüfen" },
      tags: [],
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }))));
    render(
      <MemoryRouter>
        <NodeCard node={node} onClose={() => undefined} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("node-card");
    await waitFor(() => expect(card).toHaveTextContent("Fertig: pnpm test grün"));
    expect(card.textContent ?? "").not.toMatch(/[`*<>]|\*\*|##/);
    expect(card).toHaveTextContent("• Punkt eins");
    expect(card).toHaveTextContent("Link prüfen");
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});

describe("Info-Karte im lokalen Graphen beim Session-Wechsel", () => {
  it("schließt, wenn der gewählte Punkt in der neuen Session nicht vorkommt; neue Session → keine alte Karte", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const { rerender } = render(
      <MemoryRouter>
        <LocalGraph nodeId="a" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Punkt Session A" }));
    expect(screen.getByTestId("node-card")).toHaveAttribute("aria-label", "Info: Session A");
    rerender(
      <MemoryRouter>
        <LocalGraph nodeId="b" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("node-card")).toBeNull();
  });

  it("auch ein Punkt, den beide Sessions haben, gehört zur alten Ansicht: Karte schließt beim Wechsel", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const { rerender } = render(
      <MemoryRouter>
        <LocalGraph nodeId="a" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Punkt Gemeinsam" }));
    expect(screen.getByTestId("node-card")).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <LocalGraph nodeId="b" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("node-card")).toBeNull();
    // in der neuen Session wieder anklickbar
    await userEvent.click(screen.getByRole("button", { name: "Punkt Session B" }));
    expect(screen.getByTestId("node-card")).toHaveAttribute("aria-label", "Info: Session B");
  });
});
