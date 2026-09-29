// Überblick – Zeile „N verwaiste Sessions – aufräumen?“ mit Liste und „Schließen“ je Session (nur mit
// Rückfrage), dazu fertige Namen statt „(noch ohne Titel)“/UUID in „Kritische Sessions“ und „Zuletzt fertig“.
import type { OverviewSnapshot } from "@nyxos/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { sessionName as conflictSessionName } from "../src/features/conflicts/decisionText";
import { sessionName as gitSessionName } from "../src/features/git/meta";
import { Overview } from "../src/features/overview/Overview";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCountUpMemory();
});

const orphan = (n: number) => ({
  sessionKey: `claude:8dcb7b0e-e737-4a1b-9c2d-00000000000${n}`,
  sessionId: `8dcb7b0e-e737-4a1b-9c2d-00000000000${n}`,
  title: null,
  label: `NyxOS · Session vom 2${n}.09., 20:02`,
  tool: "claude",
  state: "waiting",
  reason: "verwaist seit 2 T",
  href: `/sessions/unsortiert/_/8dcb7b0e-e737-4a1b-9c2d-00000000000${n}`,
});

const SNAP: OverviewSnapshot = {
  greetingName: "Alex",
  generatedAt: "2026-09-26T01:00:00.000Z",
  counts: { running: 0, waiting: 1, idle: 0, crashed: 0, startklar: 0 },
  lage: "Keine Session läuft, 1 wartet auf dich.",
  needsYouCount: 1,
  openQuestions: { approvals: 0, inbox: 0, conflicts: 0, total: 0 },
  fingerprint: "fp",
  metrics: [],
  commits: [],
  criticalSessions: [
    { sessionKey: "claude:w", sessionId: "00903b73-2f1a-4fdd-8d68-5f247359b598", title: "00903b73-2f1a-4fdd-8d68-5f247359b598", label: "NyxOS · Session vom 25.09., 10:38", tool: "claude", state: "waiting", reason: "wartet seit 5 min", href: "/sessions/coding/_/w" },
  ],
  orphanedSessions: [orphan(1), orphan(2)],
  orphanedTotal: 2,
  baustellen: [],
  recentDone: [{ kind: "session", id: "claude:d", title: "NyxOS · Session vom 25.09., 09:00", label: "Session beendet", at: "2026-09-25T07:00:00.000Z", href: "/sessions/_/_/d" }],
  pendingDeliveries: { count: 0, sessions: 0, href: null, title: null },
  serverOk: true,
};

function renderOverview(snap: OverviewSnapshot, onClose?: (url: string) => void) {
  const fetchMock = stubFetchRoutes({
    overview: () => jsonResponse(snap),
    fallback: (url) => {
      if (url.endsWith("/close")) {
        onClose?.(url);
        return jsonResponse({ ok: true });
      }
      return undefined;
    },
  });
  renderWithClient(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("verwaiste Sessions im Überblick", () => {
  it("Zeile „2 verwaiste Sessions – aufräumen?“ klappt die Liste mit Namen auf", async () => {
    renderOverview(SNAP);
    const toggle = await screen.findByRole("button", { name: /2 verwaiste Sessions – aufräumen\?/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("orphaned-list")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("orphaned-list");
    expect(within(list).getByRole("link", { name: /NyxOS · Session vom 21\.09\., 20:02/ })).toHaveAttribute("href", orphan(1).href);
    expect(within(list).getAllByText("verwaist seit 2 T")).toHaveLength(2);
    expect(within(list).getAllByRole("button", { name: /^Schließen:/ })).toHaveLength(2);
  });

  it("„Schließen“ fragt erst nach; ohne Bestätigung wird nichts geschlossen", async () => {
    const closed: string[] = [];
    renderOverview(SNAP, (u) => closed.push(u));
    fireEvent.click(await screen.findByRole("button", { name: /verwaiste Sessions – aufräumen\?/ }));
    fireEvent.click(screen.getByRole("button", { name: "Schließen: NyxOS · Session vom 21.09., 20:02" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("„NyxOS · Session vom 21.09., 20:02“ schließen?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(closed).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Schließen: NyxOS · Session vom 21.09., 20:02" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(closed).toEqual([`/api/sessions/${encodeURIComponent(orphan(1).sessionKey)}/close`]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("eine verwaiste Session: Einzahl; keine verwaisten: keine Zeile", async () => {
    renderOverview({ ...SNAP, orphanedSessions: [orphan(1)], orphanedTotal: 1 });
    expect(await screen.findByRole("button", { name: /1 verwaiste Session – aufräumen\?/ })).toBeInTheDocument();
  });

  it("Fehler beim Schließen bleibt sichtbar im Dialog; Erfolg lädt den Überblick neu", async () => {
    let fail = true;
    const fetchMock = stubFetchRoutes({
      overview: () => jsonResponse(SNAP),
      fallback: (url) => (url.endsWith("/close") ? (fail ? jsonResponse({ error: "kaputt" }, { status: 500 }) : jsonResponse({ ok: true })) : undefined),
    });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /verwaiste Sessions – aufräumen\?/ }));
    fireEvent.click(screen.getByRole("button", { name: "Schließen: NyxOS · Session vom 21.09., 20:02" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent("Das Schließen hat nicht geklappt");
    const overviewCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/overview")).length;
    const before = overviewCalls();
    fail = false;
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(overviewCalls()).toBeGreaterThan(before));
  });

  it("mehr verwaiste als geliefert – Zeile nennt die echte Zahl, Liste verweist auf den Rest", async () => {
    renderOverview({ ...SNAP, orphanedTotal: 25 });
    fireEvent.click(await screen.findByRole("button", { name: /25 verwaiste Sessions – aufräumen\?/ }));
    const list = screen.getByTestId("orphaned-list");
    expect(within(list).getByText(/23 weitere/)).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "alle unter Sessions" })).toHaveAttribute("href", "/sessions");
  });

  it("ohne verwaiste Sessions steht keine Aufräum-Zeile da", async () => {
    renderOverview({ ...SNAP, orphanedSessions: [], orphanedTotal: 0 });
    await screen.findByText("NyxOS · Session vom 25.09., 10:38");
    expect(screen.queryByRole("button", { name: /verwaiste/ })).toBeNull();
  });
});

describe("Namen in Git und Konflikten", () => {
  it("Git: ohne Titel Ordner + Zeit statt „Claude-Session 8dcb7b0e“", () => {
    const name = gitSessionName({ title: null, tool: "claude", key: "claude:8dcb7b0e-e737-4a1b-9c2d-000000000001", cwd: "/home/alex/projects/NyxOS", lastActivityAt: "2026-09-24T18:02:00.000Z" });
    expect(name).toBe("NyxOS · Session vom 24.09., 20:02");
    expect(gitSessionName({ title: "Login reparieren", tool: "codex", key: "codex:x" })).toBe("Login reparieren");
  });

  it("Konflikte: ohne Titel nie die rohe Kennung „claude:…“", () => {
    const name = conflictSessionName({ title: null, sessionKey: "claude:8dcb7b0e-e737-4a1b-9c2d-000000000001" });
    expect(name).not.toContain("8dcb7b0e");
    expect(name).toBe("Claude-Session");
  });
});

describe("Namen im Überblick", () => {
  it("„Kritische Sessions“ und „Zuletzt fertig“ zeigen den Server-Namen, nie UUID oder „(noch ohne Titel)“", async () => {
    renderOverview(SNAP);
    expect(await screen.findByText("NyxOS · Session vom 25.09., 10:38")).toBeInTheDocument();
    expect(screen.getByText("NyxOS · Session vom 25.09., 09:00")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("noch ohne Titel");
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
