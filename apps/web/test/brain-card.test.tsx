// In der Gehirn-Detailkarte liefen lange Pfade/Zeilen rechts aus der Karte, und es fehlte
// ein Nyx-Knopf. Jetzt: oben „Nyx erklärt“ (Seitenblatt im großen Gehirn und Info-Karte im lokalen Graphen); die Frage
// an Nyx enthält Art, Titel, Pfad, Notiz-Anfang, Verbindungen (Name + Art) und Zeitpunkt. Lange Texte brechen um.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphNodeDetail, HaikuChatRequest, HaikuStreamEvent } from "@nyxos/shared";

const calls: HaikuChatRequest[] = [];

vi.mock("../src/features/haiku/haikuApi", async (orig) => ({
  ...(await orig<typeof import("../src/features/haiku/haikuApi")>()),
  streamHaikuChat: async (req: HaikuChatRequest, onEvent: (e: HaikuStreamEvent) => void) => {
    calls.push(req);
    onEvent({ type: "done", messageId: 1, text: "Eine Notiz zur Messung.", speak: "Eine Notiz zur Messung.", sources: [], estimate: false, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } });
  },
}));
vi.mock("../src/features/nyx/voice/speaker", () => ({
  createSpeaker: () => ({ say: () => {}, end: () => Promise.resolve(), cancel: () => {}, level: () => 0, push: () => {}, speakingText: () => "", speakingSince: () => 0, isSpeaking: () => false, duck: () => {} }),
}));

import { NodeCard } from "../src/features/brain/NodeCard";
import { NodeSheet } from "../src/features/brain/NodeSheet";
import { ASK_NEIGHBOURS_MAX, nodeAskFacts } from "../src/features/brain/nodeAsk";
import { clearAskNyxCache } from "../src/components/nyx/useAskNyx";
import type { LiveGraph } from "../src/features/brain/graphData";

const LONG = "app/backend/services/api/.build/checkouts/swift-distributed-tracing/Sources/Instrumentation/InstrumentationSystem.md";
const node: GraphNode = { id: `note:${LONG}`, type: "note", label: "InstrumentationSystem", group: "App", degree: 2, ts: "2026-09-29T10:00:00Z", ref: { kind: "note", path: LONG, vault: "Atlas" } };
const heatmap: GraphNode = { id: "note:04 Planung/Heatmap.md", type: "note", label: "Heatmap", group: "04 Planung", degree: 5, ref: { kind: "note", path: "04 Planung/Heatmap.md" } };
const session: GraphNode = { id: "session:claude:1", type: "session", label: "Tracing einbauen", group: "x", degree: 1, ref: { kind: "session", id: "1", tool: "claude", art: "code" } } as unknown as GraphNode;
const graph = { nodes: [node, heatmap, session], links: [{ source: node.id, target: heatmap.id, kind: "link" }, { source: session.id, target: node.id, kind: "touch" }] } as unknown as LiveGraph;
const detail: GraphNodeDetail = {
  id: node.id,
  type: "note",
  title: "InstrumentationSystem",
  facts: [["Ordner", "app/backend/services/api/.build/checkouts"]],
  excerpt: { label: "Notiz-Anfang", text: `Siehe ${LONG}:42 für die **Messung**.` },
  extra: null,
  tags: [],
};

beforeEach(() => {
  calls.length = 0;
  clearAskNyxCache();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }))));
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe("Gehirn-Detailkarte", () => {
  it("Seitenblatt: Nyx-Knopf oben; die Frage enthält Art, Titel, Pfad, Notiz-Anfang, Verbindungen und Zeitpunkt", async () => {
    wrap(<NodeSheet node={node} graph={graph} onSelect={() => {}} onClose={() => {}} />);
    const sheet = screen.getByRole("complementary", { name: "Details: InstrumentationSystem" });
    await waitFor(() => expect(sheet).toHaveTextContent("für die Messung"));
    const btn = within(sheet).getByRole("button", { name: /Nyx erklärt/ });
    // oben: vor den Fakten
    expect(btn.compareDocumentPosition(within(sheet).getByText("Pfad")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toHaveLength(1));
    const msg = JSON.stringify(calls[0]);
    expect(msg).toContain("Was ist „InstrumentationSystem“ und wie hängt es zusammen?");
    expect(msg).toContain("Art: Notiz");
    expect(msg).toContain(`Pfad: ${LONG}`);
    expect(msg).toContain("Notiz-Anfang: Siehe");
    expect(msg).toContain("Heatmap (Notiz)");
    expect(msg).toContain("Tracing einbauen (Session)");
    expect(msg).toContain("Zuletzt:");
    await waitFor(() => expect(within(sheet).getByTestId("ask-nyx-answer")).toHaveTextContent("Eine Notiz zur Messung."));
  });

  it("Info-Karte im lokalen Graphen: gleicher Knopf, Verbindungen aus dem lokalen Graphen", async () => {
    wrap(<NodeCard node={node} graph={graph} onClose={() => {}} />);
    const card = screen.getByTestId("node-card");
    await waitFor(() => expect(card).toHaveTextContent("für die Messung"));
    fireEvent.click(within(card).getByRole("button", { name: /Nyx erklärt/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0])).toContain("Verbindungen (2): Heatmap (Notiz); Tracing einbauen (Session)");
  });

  it("lange Pfade/Zeilen brechen um (Fakten, Auszug, Titel) statt aus der Karte zu laufen", async () => {
    wrap(<NodeSheet node={node} graph={graph} onSelect={() => {}} onClose={() => {}} />);
    const sheet = screen.getByRole("complementary", { name: "Details: InstrumentationSystem" });
    await waitFor(() => expect(sheet).toHaveTextContent("für die Messung"));
    for (const el of [within(sheet).getByText(LONG), within(sheet).getByText(/für die Messung/), within(sheet).getByRole("heading", { level: 2 })]) {
      expect(el.className).toContain("[overflow-wrap:anywhere]");
      expect(el.className).toContain("min-w-0");
    }
    expect(sheet.className).toMatch(/max-w-\[calc\(100vw-2rem\)\]/);
  });

  it("Verbindungen für Nyx sind gekürzt", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ node: { ...heatmap, id: `n${i}`, label: `Punkt ${i}` }, kind: "link" }));
    const f = nodeAskFacts(node, detail, many);
    expect(f).toContain(`Punkt ${ASK_NEIGHBOURS_MAX - 1} (Notiz)`);
    expect(f).not.toContain(`Punkt ${ASK_NEIGHBOURS_MAX} (Notiz)`);
    expect(f).toContain(`… und ${30 - ASK_NEIGHBOURS_MAX} weitere`);
  });
});
