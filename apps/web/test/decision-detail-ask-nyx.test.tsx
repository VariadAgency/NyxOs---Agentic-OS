// Entscheidungen: Klick auf eine Karte öffnet die Großansicht (#inbox-<id> / #approval-<id>), „Nyx fragen“
// an JEDER Karte (Freigabe, Frage, Sortieren, Erledigtes) mit Einschätzung in drei Teilen; die Antwort-Knöpfe
// der Großansicht bleiben für den Nyx-Cursor gesperrt (data-nyx-risk).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxView } from "../src/features/inbox/InboxView";
import { jsonResponse, renderWithClient } from "./helpers";

const now = new Date().toISOString();

const approval = {
  id: 21,
  status: "pending",
  rule: "git_push",
  reason: "git push braucht deine Freigabe",
  tool: "Bash",
  command: "git push origin auftrag/t-01",
  cwd: "/home/user/projects/NyxOS",
  sessionKey: "claude:t01",
  auftrag: "T-01",
  worktree: null,
  attempts: 1,
  createdAt: now,
  decidedAt: null,
  decidedBy: null,
  consumedAt: null,
};

const base = {
  body: null,
  status: "open",
  answer: null,
  sessionKey: "claude:t01",
  entryId: null,
  baustelle: "nyxos",
  decisionFile: null,
  sources: [],
  createdBy: "session",
  estimateMinutes: 1,
  escalation: null,
  delivery: null,
  createdAt: now,
  answeredAt: null,
};

const question = {
  ...base,
  id: 8,
  kind: "frage",
  title: "Alle alten Worktrees löschen (126 Stück)?",
  body: "Aufräumen in den alten Worktrees.",
  options: [
    { id: "ja", label: "Ja" },
    { id: "nein", label: "Nein" },
  ],
  yesNo: true,
};

const sort = {
  ...base,
  id: 5,
  kind: "frage",
  title: "Sortier-Vorschlag von Nyx: „Build prüfen“ → Server & Deploy?",
  body: "Vorschlag von Nyx (nicht aus Regeln): Es geht um den Server.",
  options: [
    { id: "ja", label: "Ja" },
    { id: "nein", label: "Nein" },
  ],
  createdBy: "haiku",
  sessionKey: "claude:s5",
  yesNo: true,
};

const done = { ...question, id: 3, title: "Alte Frage zum Push", status: "answered", answer: { optionId: "nein", text: "erst nach dem Review" }, answeredAt: now };

const summary = {
  worum: "Eine Session will 126 alte Worktrees löschen.",
  empfehlung: { wahl: "Nein", grund: "Löschen ist nicht umkehrbar." },
  wichtig: ["Nicht gemergte Arbeit geht verloren.", "Regel: Worktrees nur nach Merge löschen."],
  at: now,
  cached: false,
};

function stubFetch(opts: { summaryStatus?: number } = {}) {
  const impl = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (/\/nyx-summary$/.test(url)) {
      if (opts.summaryStatus && opts.summaryStatus !== 200) return jsonResponse({ error: "Nyx hat keine brauchbare Einschätzung geliefert – bitte noch einmal fragen." }, { status: opts.summaryStatus });
      return jsonResponse({ summary });
    }
    if (url === "/api/inbox/8/answer") return jsonResponse({ item: { ...question, status: "answered", answer: { optionId: "ja", text: null } } });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [approval] });
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: [question, sort, done] });
    if (url.startsWith("/api/sessions/")) return jsonResponse({ session: { id: "claude:t01", title: "Aufräumen", titleSource: "ai" }, files: [], archive: [], events: [] });
    if (url.includes("open-questions")) return jsonResponse({ approvals: 1, inbox: 1, conflicts: 0, sorting: 1, total: 2 });
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderInbox(entry = "/inbox") {
  return renderWithClient(
    <MemoryRouter initialEntries={[entry]}>
      <InboxView />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Großansicht einer Entscheidung", () => {
  it("Klick auf die Karte öffnet die Großansicht – Klick auf einen Knopf nicht; Esc schließt", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderInbox();
    const card = await screen.findByRole("article", { name: /Alle alten Worktrees löschen/ });

    await user.click(within(card).getByRole("button", { name: "Ja" }));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/inbox/8/answer")).toBe(true));
    expect(screen.queryByTestId("decision-detail")).toBeNull();

    await user.click(within(card).getByText("Aufräumen in den alten Worktrees."));
    const detail = await screen.findByTestId("decision-detail");
    expect(within(detail).getByRole("heading", { level: 1, name: /Alle alten Worktrees löschen/ })).toBeInTheDocument();
    expect(within(detail).getByText(/aus einer Session/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("decision-detail")).toBeNull());
    expect(await screen.findByRole("article", { name: /Alle alten Worktrees löschen/ })).toBeInTheDocument();
  });

  it("Freigabe per Link (#approval-21): Befehl, Regel, Folgen; Antwort-Knöpfe tragen data-nyx-risk", async () => {
    stubFetch();
    renderInbox("/inbox#approval-21");
    const detail = await screen.findByTestId("decision-detail");
    expect((await within(detail).findAllByText("git push origin auftrag/t-01")).length).toBeGreaterThan(0);
    expect(within(detail).getByText(/genau diesen einen Befehl einmal/)).toBeInTheDocument();
    for (const name of ["Freigeben", "Ablehnen"]) {
      const btn = within(detail).getByRole("button", { name });
      expect(btn.closest("[data-nyx-risk]")).not.toBeNull();
    }
    expect(within(detail).getByRole("button", { name: /Nyx fragen/ })).toBeInTheDocument();
  });

  it("Frage per Link (#inbox-8): alle Antwort-Knöpfe tragen data-nyx-risk", async () => {
    stubFetch();
    renderInbox("/inbox#inbox-8");
    const detail = await screen.findByTestId("decision-detail");
    await within(detail).findByRole("heading", { level: 1, name: /Alle alten Worktrees/ });
    for (const name of ["Ja", "Nein", "Antworten", "Verwerfen"]) {
      expect(within(detail).getByRole("button", { name }).closest("[data-nyx-risk]")).not.toBeNull();
    }
  });

  it("Sortier-Vorschlag: Kategorie und betroffene Sessions als Links", async () => {
    stubFetch();
    renderInbox("/inbox#inbox-5");
    const detail = await screen.findByTestId("decision-detail");
    expect((await within(detail).findAllByText(/Server & Deploy/)).length).toBeGreaterThan(0);
    const link = await within(detail).findByRole("link", { name: /Aufräumen|eine Session/ });
    expect(link.getAttribute("href")).toContain("/sessions/");
  });

  it("Erledigtes öffnet die Großansicht nur zum Lesen, mit der gegebenen Antwort", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByText(/Erledigt \(1\)/));
    await user.click(screen.getByRole("link", { name: /Alte Frage zum Push/ }));
    const detail = await screen.findByTestId("decision-detail");
    expect(within(detail).getByText(/Nein · erst nach dem Review/)).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Ja" })).toBeNull();
    expect(within(detail).getByRole("button", { name: /Nyx fragen/ })).toBeInTheDocument();
  });
});

describe("Nyx fragen an jeder Karte", () => {
  it("jede Karten-Art und jede erledigte Zeile hat „Nyx fragen“", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderInbox();
    for (const name of [/Freigabe: git push/, /Alle alten Worktrees löschen/, /nach „Server & Deploy“ sortieren/]) {
      const card = await screen.findByRole("article", { name });
      expect(within(card).getByRole("button", { name: /Nyx fragen/ })).toBeInTheDocument();
    }
    await user.click(screen.getByText(/Erledigt \(1\)/));
    const row = screen.getByRole("link", { name: /Alte Frage zum Push/ }).closest("li");
    expect(row && within(row).getByRole("button", { name: /Nyx fragen/ })).toBeTruthy();
  });

  it("Einschätzung zeigt genau drei Teile und öffnet NICHT die Großansicht", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderInbox();
    const card = await screen.findByRole("article", { name: /nach „Server & Deploy“ sortieren/ });
    await user.click(within(card).getByRole("button", { name: /Nyx fragen/ }));
    const box = await within(card).findByTestId("nyx-summary");
    await within(box).findByText("Eine Session will 126 alte Worktrees löschen.");
    expect(within(box).getByText("Worum geht's")).toBeInTheDocument();
    expect(within(box).getByText("Meine Empfehlung")).toBeInTheDocument();
    expect(within(box).getByText("Wichtig zu wissen")).toBeInTheDocument();
    expect(within(box).getByText("Nein")).toBeInTheDocument();
    expect(within(box).getAllByRole("listitem")).toHaveLength(2);
    expect(impl.mock.calls.some(([u]) => String(u) === "/api/inbox/5/nyx-summary")).toBe(true);
    expect(screen.queryByTestId("decision-detail")).toBeNull();
  });

  it("Fehler von Nyx wird ehrlich angezeigt, mit „Noch einmal“", async () => {
    stubFetch({ summaryStatus: 502 });
    const user = userEvent.setup();
    renderInbox();
    const card = await screen.findByRole("article", { name: /Freigabe: git push/ });
    await user.click(within(card).getByRole("button", { name: /Nyx fragen/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/keine brauchbare Einschätzung/);
    expect(within(card).getByRole("button", { name: "Noch einmal" })).toBeInTheDocument();
  });
});
