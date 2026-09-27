// Audits: jeder Audit-Bereich (z. B. „Audit-Bereich IDC“) ist anklickbar und zeigt, was drinsteckt –
// Zahlen je Stufe, Dringlichkeit, die wichtigsten offenen Befunde – plus „Nyx fragen“.
// Dazu: Vorlesen dunkelt nichts mehr ab (nur ein farbiger Rahmen um die aktive Stelle).
import type { Entry } from "@nyxos/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditAreaSummary, groupTasks } from "../src/features/tasks/model";
import { TaskGroupCard } from "../src/features/tasks/TaskGroupCard";

function entry(over: Partial<Entry>): Entry {
  return {
    id: 1,
    kind: "audit",
    title: "Befund",
    description: null,
    stage: "geplant",
    priority: null,
    baustelle: null,
    progressPercent: 0,
    progressDoneWeight: 0,
    progressTotalWeight: 0,
    maturity: null,
    maturityCheckedAt: null,
    sourceType: "audit",
    sourceId: "IDC-1",
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    ...over,
  };
}

const ITEMS: Entry[] = [
  entry({ id: 1, title: "IDC-1 — Login bricht ab", sourceId: "IDC-1", priority: "p2" }),
  entry({ id: 2, title: "IDC-2 — Zahlungen doppelt", sourceId: "IDC-2", priority: "p0", stage: "laeuft" }),
  entry({ id: 3, title: "IDC-3 — Tippfehler", sourceId: "IDC-3", stage: "erledigt", priority: "p3" }),
  entry({ id: 4, title: "IDC-4 — Ohne Angabe", sourceId: "IDC-4" }),
];

describe("auditAreaSummary", () => {
  const group = groupTasks(ITEMS)[0];
  it("ein Bereich mit Satz, Stufen, Dringlichkeit und den wichtigsten offenen Befunden", () => {
    expect(group?.title).toBe("Audit-Bereich IDC");
    if (!group) return;
    const s = auditAreaSummary(group);
    expect(s.sentence).toBe("4 Befunde, 1 in Arbeit, 1 erledigt, 3 noch offen.");
    expect(s.priorities).toEqual([
      { label: "P0", count: 1 },
      { label: "P2", count: 1 },
      { label: "P3", count: 1 },
      { label: "ohne Angabe", count: 1 },
    ]);
    expect(s.top.map((e) => e.id)).toEqual([2, 1, 4]);
    expect(s.facts).toContain("Audit-Bereich IDC");
    expect(s.facts).toContain("Offen:");
  });

  it("Klick auf den Bereich öffnet die Zusammenfassung mit „Nyx fragen“", () => {
    if (!group) return;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TaskGroupCard group={group} index={0} onOpen={() => {}} onStart={() => {}} startingId={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("audit-area-summary")).toBeNull();
    fireEvent.click(screen.getByTestId("audit-area-toggle"));
    const panel = screen.getByTestId("audit-area-summary");
    expect(panel).toHaveTextContent("4 Befunde, 1 in Arbeit, 1 erledigt, 3 noch offen.");
    expect(panel).toHaveTextContent("Zahlungen doppelt");
    expect(panel.querySelector('[data-testid="ask-nyx"]')).not.toBeNull();
  });
});

describe("Vorlesen dunkelt nichts ab", () => {
  it("haiku.css: kein Helligkeits-/Deckkraft-Filter mehr während des Vorlesens, aktiver Rahmen in Kachelfarbe", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/haiku/haiku.css"), "utf8");
    const reading = css.split("\n").filter((l) => l.includes("[data-reading]"));
    expect(reading.length).toBeGreaterThan(0);
    expect(css).not.toMatch(/data-reading[^{]*\{[^}]*(brightness|opacity:\s*0\.)/);
    expect(css).toMatch(/\[data-speech-active\][^{]*\{[^}]*--speech-accent/);
  });
});
