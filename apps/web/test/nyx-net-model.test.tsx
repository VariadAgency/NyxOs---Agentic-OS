// Das Netz im Nyx-Tab besteht aus echten Dingen (Gehirn-Graph: Baustellen, Sessions, Aufträge …) und
// Nyx' echten Werkzeugen. Nutzt Nyx ein Werkzeug, leuchtet dessen Knoten — und die Dinge, die es liest.
import type { GraphNode, GraphResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { buildNetModel, findToolIndex, targetsOfTool } from "../src/features/nyx/tab/netModel";
import { foldTasks } from "../src/features/nyx/tab/useNyxLive";

function node(id: string, type: GraphNode["type"], over: Partial<GraphNode> = {}): GraphNode {
  return { id, type, label: id, group: type, degree: 1, ref: { kind: "baustelle", slug: id }, ...over };
}

function graph(nodes: GraphNode[], links: GraphResponse["links"] = []): GraphResponse {
  return { version: 1, nodes, links, stats: { nodes: nodes.length, links: links.length, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } };
}

describe("Netz-Modell", () => {
  it("nimmt die jüngsten Sessions (nicht alle) und die Werkzeuge als Knoten", () => {
    const sessions = Array.from({ length: 80 }, (_, i) =>
      node(`s${i}`, "session", { ts: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), ref: { kind: "session", sessionKey: `claude:s${i}`, sessionId: `s${i}`, tool: "claude", art: "coding", baustelleSlug: null } }),
    );
    const m = buildNetModel(graph([...sessions, node("nyxos", "baustelle", { degree: 50 })]), ["git_lage", "sessions_suchen"]);
    const labels = m.nodes.map((n) => n.id);
    expect(labels).toContain("s79");
    expect(labels).not.toContain("s0");
    expect(m.nodes.filter((n) => n.kind === "entity" && n.type === "session").length).toBeLessThanOrEqual(36);
    expect(m.nodes.filter((n) => n.kind === "tool").map((n) => n.label)).toEqual(["git_lage", "sessions_suchen"]);
    expect(m.nodes[0]?.kind).toBe("core");
    // Session-Knoten führen per Klick in die Session.
    expect(m.nodes.find((n) => n.id === "s79")?.href).toBe("/sessions/coding/_/s79");
  });

  it("findet den Werkzeug-Knoten auch für MCP-Namen und ordnet ihm passende Dinge zu", () => {
    const m = buildNetModel(graph([node("c1", "commit"), node("t1", "task"), node("s1", "session")]), ["git_lage", "eintrag_suchen"]);
    const git = findToolIndex(m, "mcp__nyxos__git_lage");
    expect(git).toBeGreaterThan(0);
    expect(m.nodes[git]?.label).toBe("git_lage");
    expect(targetsOfTool(m, git).map((i) => m.nodes[i]?.id)).toEqual(["c1"]);
    const entry = findToolIndex(m, "eintrag_suchen");
    expect(targetsOfTool(m, entry).map((i) => m.nodes[i]?.id)).toEqual(["t1"]);
    expect(findToolIndex(m, "gibt_es_nicht")).toBe(-1);
  });

  it("ein unbekanntes Werkzeug (neu im Kern) bekommt trotzdem einen Knoten, sobald Nyx es nutzt", () => {
    const m = buildNetModel(graph([]), []);
    expect(findToolIndex(m, "screenshot_simulator", { add: true })).toBeGreaterThan(0);
    expect(m.nodes.at(-1)?.label).toBe("screenshot_simulator");
  });

  it("ohne Gehirn-Daten bleibt das Netz sichtbar (Kern + Werkzeuge + Neuronen ohne Beschriftung)", () => {
    const m = buildNetModel(null, ["lage"]);
    expect(m.nodes.length).toBeGreaterThan(20);
    expect(m.edges.length).toBeGreaterThan(20);
  });
});

describe("Aufgaben live: Ereignisse → Karten", () => {
  it("fasst begonnen/Schritt/fertig einer Aufgabe zu EINER Karte mit Schritt-Liste zusammen", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 20, 0, s)).toISOString();
    const cards = foldTasks([
      { taskId: "a", phase: "started", title: "Screenshot", at: at(1), where: "Simulator" },
      { taskId: "b", phase: "started", title: "Git prüfen", at: at(2) },
      { taskId: "a", phase: "step", title: "Screenshot", at: at(3), step: { index: 0, label: "Simulator läuft", status: "done" } },
      { taskId: "a", phase: "step", title: "Screenshot", at: at(4), step: { index: 1, label: "Bild machen", status: "running", total: 2 } },
      { taskId: "a", phase: "done", title: "Screenshot", at: at(5), image: { fileId: 7, title: "Startseite" } },
    ]);
    expect(cards.map((c) => c.taskId)).toEqual(["b", "a"]);
    const a = cards[1];
    expect(a).toMatchObject({ status: "done", where: "Simulator", images: [{ fileId: 7, title: "Startseite" }] });
    expect(a?.steps.map((s) => s.label)).toEqual(["Simulator läuft", "Bild machen"]);
  });
});
