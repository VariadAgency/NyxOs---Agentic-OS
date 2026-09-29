// Der Kern sendet Plan-Schritte im gemeinsamen Format (nyx-live). Der Reiter „Aufgaben live“ faltet sie
// zu EINER Karte je Plan: offene Schritte sichtbar, gestrichene fallen heraus, ein neuer Plan läuft wieder.
import type { NyxTaskEventOut } from "@nyxos/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TasksPanel } from "../src/features/nyx/tab/panels/TasksPanel";
import { foldTasks } from "../src/features/nyx/tab/useNyxLive";

const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 20, 0, s)).toISOString();
const step = (phase: NyxTaskEventOut["phase"], index: number, total: number, label: string, status: NonNullable<NyxTaskEventOut["step"]>["status"], s: number): NyxTaskEventOut => ({
  taskId: "plan-7",
  phase,
  title: `Plan: ${total} Schritte`,
  tool: "todo",
  threadId: 7,
  step: { index, total, label, status },
  at: at(s),
});

describe("Plan als Aufgaben-Karte", () => {
  it("offene Schritte, erledigte, gestrichene; fertig und neuer Plan", () => {
    const events = [step("started", 0, 3, "Build prüfen", "running", 1), step("step", 1, 3, "Tests", "pending", 2), step("step", 2, 3, "Bericht", "pending", 3)];
    let [card] = foldTasks(events);
    expect(card?.steps.map((s) => `${s.label}:${s.status}`)).toEqual(["Build prüfen:running", "Tests:pending", "Bericht:pending"]);
    // Liste auf zwei Einträge gekürzt: der dritte fällt heraus.
    events.push(step("step", 0, 2, "Build prüfen", "done", 4), step("done", 1, 2, "Tests", "cancelled", 5));
    [card] = foldTasks(events);
    expect(card?.steps.map((s) => `${s.label}:${s.status}`)).toEqual(["Build prüfen:done", "Tests:cancelled"]);
    expect(card?.status).toBe("done");
    // Neuer Plan im selben Faden: die Karte läuft wieder.
    events.push(step("started", 0, 1, "Deploy vorbereiten", "running", 6));
    [card] = foldTasks(events);
    expect(card?.status).toBe("running");
    expect(card?.steps.map((s) => s.label)).toEqual(["Deploy vorbereiten"]);
  });

  it("Reiter zeigt offene und verworfene Schritte mit eigener Beschriftung", () => {
    const tasks = foldTasks([step("started", 0, 2, "Build prüfen", "running", 1), step("step", 1, 2, "Tests", "pending", 2)]);
    render(
      <MemoryRouter>
        <TasksPanel tasks={tasks} state="tool" tool="todo" openImage={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("offen")).toBeTruthy();
    expect(screen.getByLabelText("läuft")).toBeTruthy();
    expect(screen.getByText("Tests")).toBeTruthy();
  });
});
