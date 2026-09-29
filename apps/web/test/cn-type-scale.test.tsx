// `cn()` kennt die Schrift-Skala aus app.css – Größe und Farbe bleiben beide erhalten.
import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/cn";

describe("cn mit Schrift-Skala", () => {
  it("behält Größe und Farbe, egal in welcher Reihenfolge", () => {
    expect(cn("text-caption", "text-a-mut")).toBe("text-caption text-a-mut");
    expect(cn("text-a-mut", "text-caption")).toBe("text-a-mut text-caption");
    expect(cn("text-label text-a-ink", "text-a-mut")).toBe("text-label text-a-mut");
  });
  it("spätere Größe ersetzt frühere", () => {
    expect(cn("text-caption", "text-title")).toBe("text-title");
    expect(cn("text-[12px]", "text-label")).toBe("text-label");
  });
});
