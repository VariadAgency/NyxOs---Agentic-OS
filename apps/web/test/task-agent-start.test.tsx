// „Aufgabe → Agent starten“: Knopf je Auftrag im Aufgaben-Tab öffnet den bestehenden Dialog „Neue Session“
// vorbelegt (Ordner = Repo des Auftrags, Claude, Opus 5.5, erster Prompt `/goal <Pfad>`). Gestartet wird erst nach
// deinem Klick auf „Starten“; der Start trägt die Auftrags-Nummer mit (Session hängt danach am Auftrag).
import type { Entry } from "@nyxos/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentStartPrefill } from "../src/features/tasks/model";
import { TasksView } from "../src/features/tasks/TasksView";
import { NewSessionDialog } from "../src/features/terminal/NewSessionDialog";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(over: Partial<Entry>): Entry {
  return {
    id: 1,
    kind: "aufgabe",
    title: "Auftrag",
    description: null,
    stage: "geplant",
    priority: null,
    baustelle: null,
    progressPercent: 0,
    progressDoneWeight: 0,
    progressTotalWeight: 0,
    maturity: null,
    maturityCheckedAt: null,
    sourceType: "goal",
    sourceId: "atlas-app/docs/a/GOAL.md",
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    ...over,
  };
}

const ROOT = "/home/user/projects";
const FOLDERS = [
  { label: "projects", path: ROOT },
  { label: "atlas-app", path: `${ROOT}/atlas-app` },
  { label: "nyxos", path: `${ROOT}/nyxos` },
];

describe("Vorbelegung aus dem Auftrag", () => {
  it("GOAL.md: Repo als Ordner, `/goal` mit Pfad relativ zum Repo", () => {
    expect(agentStartPrefill(entry({ sourceId: "nyxos/auftraege/R2-nyx/GOAL.md" }))).toMatchObject({ tool: "claude", model: "opus", repo: "nyxos", prompt: "/goal auftraege/R2-nyx/GOAL.md" });
    expect(agentStartPrefill(entry({ sourceId: "atlas-app/docs/a/GOAL.md" }))).toMatchObject({ repo: "atlas-app", prompt: "/goal docs/a/GOAL.md" });
    expect(agentStartPrefill(entry({ sourceId: "atlas-web/x/GOAL.md" }))).toMatchObject({ repo: "atlas-web", prompt: "/goal x/GOAL.md" });
    // Datei direkt im Projektordner: kein Repo, Pfad bleibt ganz
    expect(agentStartPrefill(entry({ sourceId: "GOAL.md" }))).toMatchObject({ repo: "", prompt: "/goal GOAL.md" });
  });

  it("ohne GOAL.md: Titel und Kurztext als erste Nachricht, Ordner aus dem Dateibereich", () => {
    const p = agentStartPrefill(entry({ kind: "bug", sourceType: "audit", sourceId: "H-CUST-68", title: "H-CUST-68 — Hintergrund", description: "Bilder werden doppelt bestätigt.", fileScope: ["atlas-app/Xcode/a.swift"] }));
    expect(p.repo).toBe("atlas-app");
    expect(p.prompt).toContain("H-CUST-68 — Hintergrund");
    expect(p.prompt).toContain("Bilder werden doppelt bestätigt.");
  });
});

function renderAll(online: boolean, list: Entry[] = [entry({ id: 7, title: "R2 · Nyx", sourceId: "nyxos/auftraege/R2-nyx/GOAL.md" }), entry({ id: 8, title: "Fertig", stage: "erledigt" })]) {
  const starts: Record<string, unknown>[] = [];
  stubFetchRoutes({
    entries: () => jsonResponse({ entries: list }),
  });
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/terminal/status") return jsonResponse({ online, machineId: online ? "m1" : null, since: null });
      if (url === "/api/terminal/folders") return jsonResponse({ folders: FOLDERS });
      if (url === "/api/terminal/start" && init?.method === "POST") {
        starts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ tmuxName: "zc-claude-aa11bb22", tool: "claude", sessionId: "s1", startedMs: 5 });
      }
      return base(input, init);
    }),
  );
  renderWithClient(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TasksView />
      <NewSessionDialog />
    </MemoryRouter>,
  );
  return starts;
}

describe("Knopf „Agent starten“ im Aufgaben-Tab", () => {
  it("öffnet den Dialog vorbelegt; gestartet wird erst nach dem Klick, mit Auftrags-Nummer", async () => {
    const user = userEvent.setup();
    const starts = renderAll(true);
    const btn = await screen.findByRole("button", { name: "Agent starten für R2 · Nyx" });
    await waitFor(() => expect(btn).toBeEnabled());
    // Erledigte Pakete bekommen keinen Knopf.
    expect(screen.queryByRole("button", { name: "Agent starten für Fertig" })).toBeNull();
    await user.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "Neue Session" });
    expect(within(dlg).getByText(/R2 · Nyx/)).toBeInTheDocument();
    expect(within(dlg).getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    expect(within(dlg).getByLabelText("Modell")).toHaveValue("opus");
    expect(within(dlg).getByRole("option", { name: "Opus 5.5" })).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByLabelText("Ordner")).toHaveValue(`${ROOT}/nyxos`));
    expect(within(dlg).getByLabelText(/Erste Nachricht/)).toHaveValue("/goal auftraege/R2-nyx/GOAL.md");
    // Nichts startet von selbst.
    expect(starts).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "Starten" }));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ tool: "claude", model: "opus", cwd: `${ROOT}/nyxos`, prompt: "/goal auftraege/R2-nyx/GOAL.md", entryId: 7 });
  });

  it("ohne Brücke ist der Knopf aus und sagt warum", async () => {
    renderAll(false);
    const btn = await screen.findByRole("button", { name: "Agent starten für R2 · Nyx" });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute("title", expect.stringMatching(/Rechner/));
  });

  it("startklarer Auftrag hat genau einen Hauptknopf „▶ Agent starten“, der Zweig-Start ist anders beschriftet", async () => {
    renderAll(true, [entry({ id: 9, title: "Startklar", stage: "startklar", sourceId: "nyxos/auftraege/X/GOAL.md" })]);
    const main = await screen.findByRole("button", { name: "Agent starten für Startklar" });
    expect(main).toHaveTextContent("▶ Agent starten");
    expect(screen.getAllByRole("button", { name: /Agent starten/ })).toHaveLength(1);
    const branch = screen.getByRole("button", { name: "Im eigenen Zweig starten: Startklar" });
    expect(branch).toHaveTextContent("Im eigenen Zweig");
    expect(branch).toHaveAttribute("title", expect.stringMatching(/Worktree.*ohne Dialog/));
    // Kein zweiter Knopf mit „▶ Starten“ mehr neben „▶ Agent starten“.
    expect(screen.queryByRole("button", { name: /^▶ Starten$/ })).toBeNull();
  });
});
