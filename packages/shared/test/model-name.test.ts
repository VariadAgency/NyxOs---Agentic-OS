// modelName: aus Alias oder Kennung wird der Anzeigename mit genauer Version (nicht nur „Haiku“),
// z. B. für die Kopfzeile von Nyx.
import { describe, expect, it } from "vitest";
import { modelName } from "../src/access.js";

describe("modelName", () => {
  it("macht aus dem Alias „haiku“ den Namen mit Version", () => {
    expect(modelName("haiku")).toBe("Claude Haiku 4.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });
  it("lässt unbekannte Kennungen stehen", () => {
    expect(modelName("mein-eigenes-modell")).toBe("mein-eigenes-modell");
  });
});
