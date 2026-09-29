// Leere Aufgaben/Audits erklären in einem Satz, woher die Daten kommen und was fehlt,
// mit Knopf „Jetzt importieren“. Einträge, deren Quelle weg ist, stehen gesondert als „Quelle entfernt“.
import type { Entry } from "@nyxos/shared";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "../src/features/tasks/TasksView";
import { importStatusBody, jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WAITING = importStatusBody({ dateien: { state: "wartet", message: "Die Brücke hat die Dateien noch nicht geschickt.", lastDeliveryAt: null, lastOkAt: null } });

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
    sourceId: "App/docs/a/GOAL.md",
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: "2026-09-25T08:00:00.000Z",
    updatedAt: "2026-09-25T08:00:00.000Z",
    ...over,
  };
}

describe("Aufgaben leer", () => {
  it("erklärt die Quelle in einem Satz und bietet „Jetzt importieren“ an", async () => {
    stubFetchRoutes({ entriesImport: () => jsonResponse(WAITING) });
    renderWithClient(
      <MemoryRouter>
        <TasksView />
      </MemoryRouter>,
    );
    const empty = await screen.findByTestId("entries-empty");
    await waitFor(() => expect(empty).toHaveTextContent("Aufgaben kommen aus den GOAL.md-Dateien im Projektordner. Die Brücke hat sie noch nicht geschickt."));
    expect(within(empty).getByRole("button", { name: "Jetzt importieren" })).toBeInTheDocument();
  });

  it("Audits: eigener Satz zum Maßnahmenplan", async () => {
    stubFetchRoutes({ entriesImport: () => jsonResponse(WAITING) });
    renderWithClient(
      <MemoryRouter>
        <TasksView fixedKind="audit" title="Audits" />
      </MemoryRouter>,
    );
    const empty = await screen.findByTestId("entries-empty");
    await waitFor(() => expect(empty).toHaveTextContent("Audits kommen aus dem Maßnahmenplan im Projektordner. Die Brücke hat ihn noch nicht geschickt."));
  });

  it("„Jetzt importieren“ ruft den Import auf dem Server auf", async () => {
    const calls: string[] = [];
    stubFetchRoutes({
      entriesImport: (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return jsonResponse(url.endsWith("/run") ? { status: importStatusBody() } : WAITING);
      },
    });
    renderWithClient(
      <MemoryRouter>
        <TasksView />
      </MemoryRouter>,
    );
    fireEvent.click(await within(await screen.findByTestId("entries-empty")).findByRole("button", { name: "Jetzt importieren" }));
    await waitFor(() => expect(calls).toContain("POST /api/entries/import/run"));
  });

  it("Einträge mit entfernter Quelle stehen gesondert und zählen nicht als offen", async () => {
    stubFetchRoutes({
      entries: () => jsonResponse({ entries: [entry({ id: 1, title: "Aktiv" }), entry({ id: 2, title: "Weg", sourceId: "App/docs/b/GOAL.md", sourceRemovedAt: "2026-09-25T09:00:00.000Z" })] }),
    });
    renderWithClient(
      <MemoryRouter>
        <TasksView />
      </MemoryRouter>,
    );
    const removed = await screen.findByRole("region", { name: "Quelle entfernt" });
    expect(within(removed).getByText("Weg")).toBeInTheDocument();
    expect(within(removed).queryByText("Aktiv")).toBeNull();
    expect(screen.getByText("Offen gesamt").parentElement).toHaveTextContent("1");
  });
});

