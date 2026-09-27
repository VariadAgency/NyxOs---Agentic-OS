import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NightTimeline } from "../src/features/night/NightTimeline";

describe("NightTimeline", () => {
  it("zeigt Fenster, Budget-Ring und Läufe", () => {
    const now = new Date(2026, 0, 2, 1, 0); // 01:00, innerhalb 23:00–07:00
    render(
      <NightTimeline
        window={{ start: "23:00", end: "07:00" }}
        budgetUsedFraction={0.42}
        now={now}
        runs={[
          { taskId: "a1", title: "Aufgabe A1", status: "running", startedAt: new Date(2026, 0, 1, 23, 30).toISOString(), endedAt: null },
          { taskId: "a2", title: "Aufgabe A2", status: "done", startedAt: new Date(2026, 0, 1, 23, 45).toISOString(), endedAt: new Date(2026, 0, 2, 0, 15).toISOString() },
        ]}
      />,
    );
    expect(screen.getByText("Nachtfenster 23:00–07:00")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Aufgabe A1")).toBeInTheDocument();
    expect(screen.getByText("Aufgabe A2")).toBeInTheDocument();
  });

  it("zeigt einen leeren Hinweis ohne Läufe", () => {
    render(<NightTimeline window={{ start: "23:00", end: "07:00" }} budgetUsedFraction={0} runs={[]} />);
    expect(screen.getByText("Keine Nachtläufe.")).toBeInTheDocument();
  });
});
