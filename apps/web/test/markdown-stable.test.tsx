// Markdown vergab früher bei JEDEM Rendern neue Schlüssel (globaler Zähler) → React hängte alle Absätze,
// Listen und Code-Blöcke bei jeder Kleinigkeit (Status-Abfrage, Fadenliste) neu ein. Folgen: markierter
// Text in einer Haiku-Antwort ging verloren, und Tests fanden „element nicht (mehr) im DOM“ (wackelig).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/lib/markdown";

const TEXT = "Absatz mit **fett** und `code`\nzweite Zeile\n\n- Punkt eins\n- Punkt *zwei*\n\n```\nlet x = 1\n```";

describe("Markdown · stabile Knoten", () => {
  it("gleicher Text, neu gerendert → dieselben DOM-Knoten (nichts wird neu eingehängt)", () => {
    const { rerender } = render(<Markdown text={TEXT} />);
    const para = screen.getByText(/Absatz mit/);
    const bold = screen.getByText("fett");
    const item = screen.getByText("Punkt eins");
    const code = screen.getByText("let x = 1");
    rerender(<Markdown text={TEXT} />);
    rerender(<Markdown text={TEXT} />);
    for (const el of [para, bold, item, code]) expect(el).toBeInTheDocument();
    expect(screen.getByText(/Absatz mit/)).toBe(para);
    expect(screen.getByText("fett")).toBe(bold);
  });

  it("wächst der Text (Antwort kommt stückweise), bleiben die schon gezeigten Absätze stehen", () => {
    const { rerender } = render(<Markdown text={"Erster Absatz"} />);
    const first = screen.getByText("Erster Absatz");
    rerender(<Markdown text={"Erster Absatz\n\nZweiter Absatz"} />);
    expect(screen.getByText("Erster Absatz")).toBe(first);
    expect(screen.getByText("Zweiter Absatz")).toBeInTheDocument();
  });
});
