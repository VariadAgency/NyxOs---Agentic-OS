// Nyx bedient alles: der Nutzer bat Nyx, eine neue Claude-Session mit Opus 5.5 zu öffnen – Nyx sagte „kann ich nicht“.
// Jetzt: riskant ist nur noch die Freigabe-Liste (Löschen, Merge, Push, Deploy, Migration, Session endgültig schließen,
// Freigaben/Entscheidungen). Neue Cursor-Aktion `select` (Auswahlliste, Radio-Gruppe, Schalter), stabile Kennungen
// im Dialog „Neue Session“ und „neue-session“ klappt von jeder Seite aus.
import { NyxUiCommandSchema, NyxUiReplySchema, isRiskyLabel } from "@nyxos/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "../src/features/terminal/NewSessionDialog";
import { openNewSession } from "../src/features/terminal/terminalApi";
import { executeNyxUi, isRiskyElement, readScreen, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function cursor(): NyxCursorDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    flyTo: vi.fn(async () => void calls.push("fly")),
    press: vi.fn(async () => void calls.push("press")),
    glow: vi.fn(() => void calls.push("glow")),
  };
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const deps = (root: ParentNode, c = cursor()) => ({ navigate: vi.fn(), cursor: c, root, route: () => "/x", waitMs: 0, typeDelayMs: 0 });
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

// ───────────── Vertrag ─────────────

describe("Vertrag: select", () => {
  it("nimmt { action: select, target, option } an und lehnt leere Wahl ab", () => {
    expect(NyxUiCommandSchema.parse({ action: "select", target: "new-session:model", option: "Opus 5.5" })).toEqual({ action: "select", target: "new-session:model", option: "Opus 5.5" });
    expect(NyxUiCommandSchema.safeParse({ action: "select", target: "new-session:model", option: "" }).success).toBe(false);
    expect(NyxUiCommandSchema.safeParse({ action: "select", target: "new-session:model" }).success).toBe(false);
  });

  it("read_screen-Antwort darf Optionen und Wert tragen", () => {
    const ok = NyxUiReplySchema.safeParse({
      type: "nyx.ui.screen",
      requestId: "req-0000000001",
      route: "/x",
      title: "",
      elements: [{ id: "new-session:model", label: "Modell", kind: "select", risk: false, options: ["Standard", "Opus 5.5"], value: "Opus 5.5" }],
    });
    expect(ok.success).toBe(true);
  });
});

// ───────────── Risiko = nur die Freigabe-Liste ─────────────

describe("Risiko-Wörter: nur die Freigabe-Liste", () => {
  it.each(["Neue Session", "Starten", "Senden", "Schließen", "Abbrechen", "Archivieren", "Antworten", "Änderung schicken", "Filter schließen", "Agent starten für P3"])("„%s“ ist erlaubt", (label) => {
    expect(isRiskyLabel(label)).toBe(false);
  });

  it.each(["Löschen", "Session löschen", "Entfernen", "Merge", "In main mergen", "Push", "Deploy starten", "Migration ausführen", "Prozess beenden", "Session beenden", "Freigeben", "Verwerfen", "Zurücksetzen", "Endgültig schließen", "In der NyxOS übernehmen", "Delete", "Remove"])(
    "„%s“ bleibt riskant",
    (label) => {
      expect(isRiskyLabel(label)).toBe(true);
    },
  );

  it("Wortanfang zählt: „Stempush“ oder „Kommerge“ sind keine Treffer, „Push-Fix“ schon", () => {
    expect(isRiskyLabel("Stempush")).toBe(false);
    expect(isRiskyLabel("Kommerge")).toBe(false);
    expect(isRiskyLabel("Push-Fix")).toBe(true);
  });

  it("Knöpfe: Starten/Senden klickbar, Löschen und data-nyx-risk weiter gesperrt", () => {
    const root = mount(`<button data-nyx="a">Starten</button><button data-nyx="b">Senden</button><button data-nyx="c">Löschen</button><div data-nyx-risk><button data-nyx="d">Ja</button></div>`);
    const at = (id: string) => root.querySelector(`[data-nyx="${id}"]`) as HTMLElement;
    expect(isRiskyElement(at("a"))).toBe(false);
    expect(isRiskyElement(at("b"))).toBe(false);
    expect(isRiskyElement(at("c"))).toBe(true);
    expect(isRiskyElement(at("d"))).toBe(true);
  });

  it("Quelltext: Starten (Neue Session, Aufgaben, Einträge) ohne data-nyx-risk; Entscheidungen behalten es", () => {
    expect(src("features/terminal/NewSessionDialog.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/tasks/TaskGroupCard.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/entries/EntryRow.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/entries/EntryOverlay.tsx")).not.toContain("data-nyx-risk");
    expect(src("features/inbox/DecisionActions.tsx")).toContain('data-nyx-risk=""');
    expect(src("features/haiku/PlanCards.tsx")).toContain('data-nyx-risk=""');
  });
});

// ───────────── Ausführer: select ─────────────

describe("Ausführer: select", () => {
  it("Auswahlliste per Beschriftung und per Wert – change/input blubbern hoch", async () => {
    const root = mount(`<select aria-label="Modell" data-nyx="m"><option value="">Standard</option><option value="opus">Opus 5.5</option><option value="claude-sonnet-5">Sonnet 5</option></select>`);
    const sel = root.querySelector("select") as HTMLSelectElement;
    const changes: string[] = [];
    root.addEventListener("change", () => changes.push(sel.value));
    const c = cursor();
    const r1 = await executeNyxUi({ action: "select", target: "m", option: "opus 5.5" }, deps(root, c));
    expect(r1).toMatchObject({ ok: true, detail: expect.stringContaining("Opus 5.5") });
    expect(sel.value).toBe("opus");
    const r2 = await executeNyxUi({ action: "select", target: "Modell", option: "claude-sonnet-5" }, deps(root, c));
    expect(r2.ok).toBe(true);
    expect(sel.value).toBe("claude-sonnet-5");
    expect(changes).toEqual(["opus", "claude-sonnet-5"]);
    expect(c.calls).toContain("fly");
  });

  it("unscharf: „Sonnet“ findet „Sonnet 5“", async () => {
    const root = mount(`<select aria-label="Modell"><option value="">Standard</option><option value="claude-sonnet-5">Sonnet 5</option></select>`);
    const r = await executeNyxUi({ action: "select", target: "Modell", option: "sonnet" }, deps(root));
    expect(r.ok).toBe(true);
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("claude-sonnet-5");
  });

  it("nichts passt → hilfreicher Fehler mit den Möglichkeiten, Wert bleibt", async () => {
    const root = mount(`<select aria-label="Modell"><option value="">Standard</option><option value="opus">Opus 5.5</option></select>`);
    const r = await executeNyxUi({ action: "select", target: "Modell", option: "GPT-9" }, deps(root));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Standard/);
    expect(r.detail).toMatch(/Opus 5\.5/);
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("");
  });

  it("Radio-Gruppe (role=radiogroup): klickt die passende Wahl", async () => {
    const root = mount(`<div role="radiogroup" aria-label="Werkzeug" data-nyx="tool"><button type="button" role="radio" aria-checked="true">Claude</button><button type="button" role="radio" aria-checked="false">Codex</button></div>`);
    const clicked = vi.fn();
    root.querySelectorAll("[role=radio]")[1]?.addEventListener("click", clicked);
    const r = await executeNyxUi({ action: "select", target: "Werkzeug", option: "codex" }, deps(root));
    expect(r).toMatchObject({ ok: true });
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("Schalter (role=switch): „an“ klickt nur, wenn er aus ist", async () => {
    const root = mount(`<button type="button" role="switch" aria-checked="false" aria-label="Temporär" data-nyx="temp">⏳</button>`);
    const sw = root.querySelector("button") as HTMLButtonElement;
    const clicked = vi.fn(() => sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true"));
    sw.addEventListener("click", clicked);
    expect((await executeNyxUi({ action: "select", target: "temp", option: "an" }, deps(root))).ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect((await executeNyxUi({ action: "select", target: "temp", option: "true" }, deps(root))).ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect((await executeNyxUi({ action: "select", target: "temp", option: "aus" }, deps(root))).ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(2);
    const bad = await executeNyxUi({ action: "select", target: "temp", option: "vielleicht" }, deps(root));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/an.*aus/);
  });

  it("in einem data-nyx-risk-Bereich wählt Nyx nie – nur zeigen", async () => {
    const root = mount(`<div data-nyx-risk><select aria-label="Antwort" data-nyx="ans"><option value="">–</option><option value="ja">Ja</option></select></div>`);
    const c = cursor();
    const r = await executeNyxUi({ action: "select", target: "ans", option: "Ja" }, deps(root, c));
    expect(r).toMatchObject({ ok: false, risky: true });
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("");
    expect(c.calls).toContain("glow");
  });

  it("Ziel ist keine Auswahl → ehrliche Antwort", async () => {
    const root = mount(`<button data-nyx="x">Los</button>`);
    const r = await executeNyxUi({ action: "select", target: "x", option: "a" }, deps(root));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/nichts auswählen|keine Auswahl/);
  });

  it("read_screen zeigt Auswahllisten und Radio-Gruppen mit Optionen und aktuellem Wert", () => {
    const opts = Array.from({ length: 30 }, (_, i) => `<option value="v${i}">Ordner ${i}</option>`).join("");
    const root = mount(`
      <select aria-label="Modell" data-nyx="new-session:model"><option value="">Standard</option><option value="opus" selected>Opus 5.5</option></select>
      <div role="radiogroup" aria-label="Werkzeug" data-nyx="new-session:tool"><button role="radio" aria-checked="true">Claude</button><button role="radio" aria-checked="false">Codex</button></div>
      <select aria-label="Ordner">${opts}</select>`);
    const s = readScreen(root, "/x");
    const model = s.elements.find((e) => e.id === "new-session:model");
    expect(model).toMatchObject({ label: "Modell", kind: "select", options: ["Standard", "Opus 5.5"], value: "Opus 5.5", risk: false });
    expect(s.elements.find((e) => e.id === "new-session:tool")).toMatchObject({ kind: "select", options: ["Claude", "Codex"], value: "Claude" });
    // Auswahl ohne data-nyx: über die Beschriftung ansprechbar, Optionen gekürzt.
    const folder = s.elements.find((e) => e.id === "Ordner");
    expect(folder?.options).toHaveLength(20);
    expect(NyxUiReplySchema.safeParse({ type: "nyx.ui.screen", requestId: "req-0000000001", ...s }).success).toBe(true);
  });
});

// ───────────── „Neue Session“ von überall, Dialog per Cursor bedienbar ─────────────

describe("neue-session von jeder Seite", () => {
  it("fehlt der Knopf auf der Seite, geht Nyx sichtbar über die Leiste zu /sessions und klickt dort", async () => {
    const root = mount(`<nav><a data-nyx="nav:ses" href="/sessions">Sessions</a></nav><main></main>`);
    const clicked = vi.fn();
    const link = root.querySelector("a") as HTMLAnchorElement;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const b = document.createElement("button");
      b.setAttribute("data-nyx", "neue-session");
      b.setAttribute("aria-label", "Neue Session");
      b.addEventListener("click", clicked);
      root.querySelector("main")?.appendChild(b);
    });
    const r = await executeNyxUi({ action: "click", target: "neue-session" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/sessions", waitMs: 500 });
    expect(r.ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("Quelltext: alle Einstiege tragen data-nyx=\"neue-session\"", () => {
    expect(src("components/sessions/TabRows.tsx")).toContain('data-nyx="neue-session"');
    expect(src("components/CommandPalette.tsx")).toContain('data-nyx="neue-session"');
    expect(src("features/haiku/HaikuRoot.tsx")).toMatch(/nyx: "neue-session"/);
  });
});

const ROOT = "/home/user/projects";
const FOLDERS = [
  { label: "projects", path: ROOT },
  { label: "App", path: `${ROOT}/App` },
  { label: "tools/NyxOS", path: `${ROOT}/tools/NyxOS` },
];

function renderDialog() {
  const starts: Record<string, unknown>[] = [];
  stubFetchRoutes({});
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/terminal/status") return jsonResponse({ online: true, machineId: "m1", since: null });
      if (url === "/api/terminal/folders") return jsonResponse({ folders: FOLDERS });
      if (url === "/api/terminal/start" && init?.method === "POST") {
        starts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ tmuxName: "zc-claude-aa11bb22", tool: "claude", sessionId: "s1", startedMs: 5 });
      }
      return base(input, init);
    }),
  );
  renderWithClient(
    <MemoryRouter initialEntries={["/overview"]}>
      <NewSessionDialog />
    </MemoryRouter>,
  );
  return starts;
}

describe("Dialog „Neue Session“ per Nyx-Cursor", () => {
  it("Kennungen existieren, Starten ist nicht riskant, das Rezept startet Opus 5.5 im gewählten Ordner", async () => {
    const starts = renderDialog();
    act(() => openNewSession());
    const dlg = await screen.findByRole("dialog", { name: "Neue Session" });
    for (const id of ["new-session:tool", "new-session:model", "new-session:folder", "new-session:prompt", "new-session:start"]) expect(dlg.querySelector(`[data-nyx="${id}"]`), id).not.toBeNull();
    const start = dlg.querySelector('[data-nyx="new-session:start"]') as HTMLElement;
    expect(isRiskyElement(start)).toBe(false);
    await waitFor(() => expect(within(dlg).getByLabelText("Ordner")).toHaveValue(ROOT));

    const d = { navigate: vi.fn(), cursor: cursor(), root: document, route: () => "/overview", waitMs: 200, typeDelayMs: 0 };
    expect((await executeNyxUi({ action: "select", target: "new-session:tool", option: "Claude" }, d)).ok).toBe(true);
    expect((await executeNyxUi({ action: "select", target: "new-session:model", option: "Opus 5.5" }, d)).ok).toBe(true);
    expect((await executeNyxUi({ action: "select", target: "new-session:folder", option: "NyxOS" }, d)).ok).toBe(true);
    expect((await executeNyxUi({ action: "type", target: "new-session:prompt", text: "Hallo" }, d)).ok).toBe(true);
    await waitFor(() => expect(within(dlg).getByLabelText("Modell")).toHaveValue("opus"));
    expect(within(dlg).getByLabelText("Ordner")).toHaveValue(`${ROOT}/tools/NyxOS`);
    const r = await executeNyxUi({ action: "click", target: "new-session:start" }, d);
    expect(r).toMatchObject({ ok: true });
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ tool: "claude", model: "opus", cwd: `${ROOT}/tools/NyxOS`, prompt: "Hallo" });
  });

  it("Codex per Radio-Gruppe umschalten (React-Zustand folgt)", async () => {
    renderDialog();
    act(() => openNewSession());
    const dlg = await screen.findByRole("dialog", { name: "Neue Session" });
    const d = { navigate: vi.fn(), cursor: cursor(), root: document, route: () => "/overview", waitMs: 0 };
    expect((await executeNyxUi({ action: "select", target: "new-session:tool", option: "Codex" }, d)).ok).toBe(true);
    await waitFor(() => expect(within(dlg).getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true"));
  });

  it("Modell-Liste kennt die aktuellen Claude-Modelle (Wert = was `claude --model` versteht)", async () => {
    renderDialog();
    act(() => openNewSession());
    const dlg = await screen.findByRole("dialog", { name: "Neue Session" });
    const values = [...(within(dlg).getByLabelText("Modell") as HTMLSelectElement).options].map((o) => [o.value, o.textContent]);
    expect(values).toEqual([
      ["", "Standard"],
      ["opus", "Opus 5.5"],
      ["claude-sonnet-5", "Sonnet 5"],
      ["claude-fable-5-1", "Fable 5.1"],
      ["claude-haiku-4-5", "Haiku 4.5"],
    ]);
  });
});

// Kleiner React-Beweis: kontrollierte Auswahl folgt dem Cursor (nativer Setter + change).
function Controlled({ onValue }: { onValue: (v: string) => void }) {
  const [v, setV] = useState("a");
  return (
    <select
      aria-label="Probe"
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onValue(e.target.value);
      }}
    >
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </select>
  );
}

describe("React-gesteuerte Auswahl", () => {
  it("onChange feuert und der Zustand bleibt beim neuen Wert", async () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    const r = await executeNyxUi({ action: "select", target: "Probe", option: "Beta" }, { navigate: vi.fn(), cursor: cursor(), root: document, route: () => "/x", waitMs: 0 });
    expect(r.ok).toBe(true);
    expect(onValue).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.getByLabelText("Probe")).toHaveValue("b"));
  });
});
