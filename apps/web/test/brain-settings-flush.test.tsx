// Einstellungen des Gehirns (3D, Farbe, Ansicht) gehen nicht verloren, wenn man die
// Seite direkt nach dem Ändern verlässt (vorher: 300-ms-Verzögerung, beim Verlassen verworfen).
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useBrainSettings } from "../src/features/brain/BrainView";
import { loadSettings } from "../src/features/brain/settings";

afterEach(() => window.localStorage.clear());

describe("useBrainSettings", () => {
  it("merkt eine Änderung auch, wenn die Seite sofort verlassen wird", () => {
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
    const { result, unmount } = renderHook(() => useBrainSettings(), { wrapper });
    act(() => result.current[1]({ ...result.current[0], mode: "3d", colors: { session: "#ff7a00" } }));
    unmount(); // < 300 ms später
    const saved = loadSettings();
    expect(saved.mode).toBe("3d");
    expect(saved.colors.session).toBe("#ff7a00");
  });
});
