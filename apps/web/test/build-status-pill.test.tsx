import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuildStatusPill } from "../src/features/builds/BuildStatusPill";

describe("BuildStatusPill", () => {
  it("zeigt 'noch nicht geprüft' ohne Lauf", () => {
    render(<BuildStatusPill current={null} />);
    expect(screen.getByText("noch nicht geprüft")).toBeInTheDocument();
  });

  it("zeigt grün/rot je nach Status und rendert die Sparkline", () => {
    const { rerender } = render(<BuildStatusPill current={{ status: "green", startedAt: new Date().toISOString() }} history={[{ status: "red", startedAt: new Date().toISOString() }, { status: "green", startedAt: new Date().toISOString() }]} />);
    expect(screen.getByText("grün")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();

    rerender(<BuildStatusPill current={{ status: "red", startedAt: new Date().toISOString() }} />);
    expect(screen.getByText("rot")).toBeInTheDocument();
  });
});
