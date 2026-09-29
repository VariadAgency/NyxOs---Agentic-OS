// Der Nyx-Cursor klickt jetzt WIRKLICH. Entscheidungen (Ja/Nein, Optionen, Freigeben,
// eigene Antwort) darf er trotzdem nie treffen — weder über `item:decision` noch über die Beschriftung „Ja“.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeNyxUi, readScreen, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";

const cursor = (): NyxCursorDriver => ({ flyTo: vi.fn(async () => {}), press: vi.fn(async () => {}), glow: vi.fn() });

/** Wie die echte Frage-Karte in InboxView (mit `data-nyx-risk`). */
function card() {
  const root = document.createElement("div");
  root.innerHTML = `
    <article data-nyx-item="decision" data-nyx-risk="" data-nyx-at="2026-09-26T09:00:00Z" aria-label="Soll ich pushen?">
      <button data-id="ja">Ja</button><button data-id="nein">Nein</button><button data-id="opt">Variante B nehmen</button>
      <form><textarea aria-label="Eigene Antwort"></textarea><button type="submit">Antworten</button></form>
    </article>`;
  document.body.appendChild(root);
  const clicked: string[] = [];
  for (const b of root.querySelectorAll("button")) b.addEventListener("click", () => clicked.push(b.getAttribute("data-id") ?? b.textContent ?? ""));
  const submitted = vi.fn((e: Event) => e.preventDefault());
  root.querySelector("form")?.addEventListener("submit", submitted);
  return { root, clicked, submitted };
}

describe("Cursor und Entscheidungen", () => {
  it("Beschriftung „Ja“/„Nein“/Option in einer Entscheidung: nur zeigen, nie klicken", async () => {
    const { root, clicked } = card();
    for (const target of ["Ja", "Nein", "Variante B nehmen"]) {
      const r = await executeNyxUi({ action: "click", target }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/inbox", waitMs: 0 });
      expect(r.ok, target).toBe(false);
      expect(r.risky, target).toBe(true);
    }
    expect(clicked).toEqual([]);
  });

  it("item:decision zeigt die Karte ruhig an („Hier ist es.“) und klickt nichts darin", async () => {
    const { root, clicked } = card();
    const r = await executeNyxUi({ action: "click", target: "item:decision" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/inbox", waitMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("Hier ist es.");
    expect(clicked).toEqual([]);
  });

  it("eigene Antwort tippen + abschicken geht nicht (Nyx antwortet nie an Stelle des Nutzers)", async () => {
    const { root, submitted } = card();
    const r = await executeNyxUi({ action: "type", target: "Eigene Antwort", text: "Ja, mach", submit: true }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/inbox", waitMs: 0, typeDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.risky).toBe(true);
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("read_screen meldet die Entscheidung und ihre Knöpfe als riskant", () => {
    const { root } = card();
    const screen = readScreen(root, "/inbox");
    const item = screen.elements.find((e) => e.id === "item:decision:0");
    expect(item?.risk).toBe(true);
  });
});

describe("echte Karten tragen die Sperre", () => {
  it("InboxView-Quelltext: alle drei Entscheidungs-Karten (Sortier-, Freigabe-, Frage-Karte) mit data-nyx-risk", () => {
    const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
    const src = read("features/inbox/InboxView.tsx");
    const cards = src.split('data-nyx-item="decision"').length - 1;
    expect(cards).toBe(3);
    // jede Karte: data-nyx-risk innerhalb derselben öffnenden Zeile/nächsten 4 Zeilen
    for (const part of src.split('data-nyx-item="decision"').slice(1)) expect(part.slice(0, 260)).toContain("data-nyx-risk");
    const plan = read("features/haiku/PlanCards.tsx");
    expect(plan).toContain('data-nyx-risk=""');
    const brief = read("features/haiku/Briefing.tsx");
    expect(brief).toMatch(/data-nyx-risk=\{action \? "" : undefined\}/);
  });
});

