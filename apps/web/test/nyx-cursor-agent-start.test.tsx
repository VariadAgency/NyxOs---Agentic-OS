// „Agent starten“ / „Im eigenen Zweig“ / „Starten“ waren für den Nyx-Cursor gesperrt. Jetzt gilt nur
// noch die Freigabe-Liste (Löschen, Merge, Push, Deploy, Migration, Session endgültig schließen, Freigaben/Entscheidungen) –
// Starten gehört nicht dazu: Nyx klickt es, wenn der Nutzer es will. Ein Knopf mit `data-nyx-risk` bleibt trotzdem tabu.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeNyxUi, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";

const cursor = (): NyxCursorDriver => ({ flyTo: vi.fn(async () => {}), press: vi.fn(async () => {}), glow: vi.fn() });
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("Agent-Start ist nicht mehr riskant", () => {
  it("Nyx klickt „Agent starten“ und „Im eigenen Zweig“ wirklich (über data-nyx und über die Beschriftung)", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button type="button" data-nyx="agent-starten" aria-label="Agent starten für P3">▶ Agent starten</button>
      <button type="button" data-nyx="aufgabe-starten" aria-label="Im eigenen Zweig starten: P3">⎇ Im eigenen Zweig</button>`;
    document.body.appendChild(root);
    const clicked = vi.fn();
    for (const b of root.querySelectorAll("button")) b.addEventListener("click", clicked);
    for (const target of ["agent-starten", "aufgabe-starten", "Agent starten für P3"]) {
      const r = await executeNyxUi({ action: "click", target }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/tasks", waitMs: 0 });
      expect(r.ok, target).toBe(true);
    }
    expect(clicked).toHaveBeenCalledTimes(3);
    root.remove();
  });

  it("ein Start-Knopf mit data-nyx-risk bliebe gesperrt (der Schutz selbst funktioniert weiter)", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<button type="button" data-nyx="agent-starten" data-nyx-risk="">▶ Agent starten</button>`;
    document.body.appendChild(root);
    const clicked = vi.fn();
    root.querySelector("button")?.addEventListener("click", clicked);
    const r = await executeNyxUi({ action: "click", target: "agent-starten" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/tasks", waitMs: 0 });
    expect(r).toMatchObject({ ok: false, risky: true });
    expect(clicked).not.toHaveBeenCalled();
    root.remove();
  });

  it("Quelltext: Start-Knöpfe (Aufgaben, Einträge, Neue Session) tragen kein data-nyx-risk mehr", () => {
    const card = src("features/tasks/TaskGroupCard.tsx");
    for (const id of ['data-nyx="agent-starten"', 'data-nyx="aufgabe-starten"']) {
      const at = card.indexOf(id);
      expect(at, id).toBeGreaterThan(-1);
      expect(card.slice(at, at + 200), id).not.toContain("data-nyx-risk");
    }
    expect(src("features/entries/EntryRow.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/entries/EntryOverlay.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/terminal/NewSessionDialog.tsx")).toMatch(/type="submit" data-nyx="new-session:start"/);
  });
});
