// Regression (gefunden per Playwright gegen einen Test-Stack): eine Kennzahl-Kachel, deren Wert
// erst NACH dem ersten Render ankommt (typischer Fall bei async geladenen Daten), blieb vorher bei 0
// stehen, weil die Hochzähl-Animation nur beim allerersten Mount lief (leerer Deps-Array). Getestet
// über den `prefers-reduced-motion`-Pfad: der zeigt den Wert ohne Animation sofort an — deterministisch
// und unabhängig von `requestAnimationFrame`-Zeitstempeln, die jsdom anders liefert als ein echter
// Browser (die Animation selbst ist per Playwright-Screenshot geprüft).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KpiTile } from "../src/components/KpiTile";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KpiTile", () => {
  it("zeigt einen echten Wert, der schon beim ersten Render vorliegt", () => {
    render(<KpiTile label="Erledigt" value={7} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("zeigt den echten Wert, auch wenn er erst NACH dem ersten Render ankommt (async geladene Daten)", async () => {
    const { rerender } = render(<KpiTile label="Offen gesamt" value={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();

    // Daten treffen asynchron ein (wie bei useEntries()) — der Wert wechselt von 0 auf 399. Vor dem
    // Fix blieb die Kachel hier bei "0" stehen (Animations-Effekt lief nur beim allerersten Mount).
    await act(async () => rerender(<KpiTile label="Offen gesamt" value={399} />));

    expect(screen.getByText("399")).toBeInTheDocument();
  });

  it("zeigt einen späteren Live-Update-Wert direkt, ohne erneut von 0 zu starten", async () => {
    const { rerender } = render(<KpiTile label="Läuft" value={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    await act(async () => rerender(<KpiTile label="Läuft" value={5} />));
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
