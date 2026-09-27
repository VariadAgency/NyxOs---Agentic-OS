// Agenten-Prompts enthalten oft Tabellen und Listen direkt nach einem Absatz. Bisher erschienen
// sie in der Großansicht als rohe „| … |“-Zeilen bzw. als ein Fließtext-Absatz mit Bindestrichen.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/lib/markdown";

describe("Markdown · Tabellen und Listen nach Absatz", () => {
  it("rendert eine Markdown-Tabelle als echte Tabelle (Kopf + Zeilen, Inline-Formate)", () => {
    const text =
      "Was verboten ist:\n\n| Verboten | Suchbegriffe |\n|---|---|\n| **Fotomodus** | `AVCapturePhotoOutput`, `capturePhoto` |\n| AR | `ARKit` |";
    render(<Markdown text={text} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Verboten", "Suchbegriffe"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Fotomodus").tagName).toBe("B");
    expect(within(table).getByText("ARKit").tagName).toBe("CODE");
    expect(screen.queryByText(/\|---/)).toBeNull();
  });

  it("eine Liste direkt nach einer Absatzzeile wird eine Liste", () => {
    render(<Markdown text={"Erlaubte Ausnahmen:\n- ShazamKit nur in P10\n- AVAssetImageGenerator"} />);
    expect(screen.getByText("Erlaubte Ausnahmen:").tagName).toBe("P");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["ShazamKit nur in P10", "AVAssetImageGenerator"]);
  });

  // Wie GFM unterbricht nur eine mit „1.“ beginnende Liste einen Absatz — ein umbrochenes
  // Datum („am\n3. Oktober“) bleibt Fließtext.
  it("eine Zahl mit Punkt mitten im Absatz startet keine Liste", () => {
    render(<Markdown text={"Wir treffen uns am\n3. Oktober im Club."} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("3. Oktober im Club.", { exact: false }).closest("p")).toHaveTextContent("Wir treffen uns am3. Oktober im Club.");
  });

  it("einzelne senkrechte Striche im Text bleiben normaler Text", () => {
    render(<Markdown text={"a | b ist kein Tisch"} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("a | b ist kein Tisch")).toBeInTheDocument();
  });
});
