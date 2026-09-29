// Der Hover-Titel eines Knotens lief über den Rand der Pille hinaus, „· Klick öffnet“
// stand außerhalb. Langer Titel wird jetzt mit „…“ gekürzt, der Hinweis bleibt im Etikett.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../src/features/nyx/tab/nyxTab.css"), "utf8");
const tsx = readFileSync(resolve(__dirname, "../src/features/nyx/tab/net3d/NyxNet3D.tsx"), "utf8");

describe("Netz-Etikett im Nyx-Tab", () => {
  it("Titel kürzt mit Ellipse, Hinweis schrumpft nicht, Etikett breiter als 300 px", () => {
    expect(css).toMatch(/\.nyx-net-label \[data-text\]\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.nyx-net-label__hint\s*\{[^}]*flex:\s*none/);
    expect(css).not.toMatch(/\.nyx-net-label\s*\{[^}]*max-width:\s*300px/);
    expect(tsx).toContain('className="nyx-net-label__hint"');
  });
});
