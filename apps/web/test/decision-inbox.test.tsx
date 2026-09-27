import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxView } from "../src/features/inbox/InboxView";
import { jsonResponse, renderWithClient } from "./helpers";

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
  attempts: 2,
  createdAt: new Date().toISOString(),
  decidedAt: null,
  decidedBy: null,
  consumedAt: null,
};

const question = {
  id: 8,
  kind: "frage",
  title: "Soll der Ideen-Link 30 Tage gelten?",
  body: "Standard für neue Links.",
  options: [
    { id: "ja", label: "Ja" },
    { id: "nein", label: "Nein" },
  ],
  status: "open",
  answer: null,
  sessionKey: "claude:t01",
  entryId: null,
  baustelle: "nyxos",
  decisionFile: "auftraege/ENTSCHEIDUNGEN.md",
  sources: [],
  createdBy: "session",
  estimateMinutes: 1,
  yesNo: true,
  escalation: null,
  delivery: null,
  createdAt: new Date().toISOString(),
  answeredAt: null,
};

const escalation = { ...question, id: 9, kind: "eskalation", title: "Produktionsdaten löschen?", yesNo: false, escalation: "datenverlust", options: [{ id: "stopp", label: "Stoppen" }] };
const answered = { ...question, id: 3, title: "Alte Frage", status: "answered", answer: { optionId: "ja", text: null }, answeredAt: new Date().toISOString() };

function stubFetch(opts: { approvals?: unknown[]; items?: unknown[] } = {}) {
  const impl = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/approvals/21/decide") return jsonResponse({ approval: { ...approval, status: "approved" } });
    if (url === "/api/inbox/8/answer") {
      return jsonResponse({
        item: { ...question, status: "answered", delivery: { toSession: "sent", decisionCommit: "abc1234def", note: null } },
      });
    }
    if (url === "/api/inbox/8/dismiss") return jsonResponse({ item: { ...question, status: "dismissed" } });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: opts.approvals ?? [approval] });
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: opts.items ?? [question, escalation, answered] });
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderInbox() {
  return renderWithClient(
    <MemoryRouter>
      <InboxView />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Entscheidungs-Inbox", () => {
  it("zeigt Freigaben zuerst, mit Befehl, Regel und Hinweis; Freigeben ruft decide", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderInbox();

    const card = await screen.findByRole("article", { name: /Freigabe: git push/ });
    const firstArticle = screen.getAllByRole("article")[0];
    expect(firstArticle).toBe(card);
    expect(within(card).getByText("git push origin auftrag/t-01")).toBeInTheDocument();
    expect(within(card).getByText(/erlaubt genau diesen einen Befehl einmal/)).toBeInTheDocument();
    expect(within(card).getByText(/2 Versuche/)).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Freigeben" }));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/approvals/21/decide")).toBe(true));
    const call = impl.mock.calls.find(([u]) => String(u) === "/api/approvals/21/decide");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "approve" });
  });

  it("Ja/Nein ruft answer und der Toast nennt die Zustellung", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderInbox();

    const card = await screen.findByRole("article", { name: /Soll der Ideen-Link 30 Tage gelten/ });
    await user.click(within(card).getByRole("button", { name: "Ja" }));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/inbox/8/answer")).toBe(true));
    const call = impl.mock.calls.find(([u]) => String(u) === "/api/inbox/8/answer");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ optionId: "ja" });
    expect(await screen.findByText(/an Session geschickt/)).toBeInTheDocument();
    expect(screen.getByText(/in ENTSCHEIDUNGEN.md eingetragen \(Commit abc1234\)/)).toBeInTheDocument();
  });

  it("markiert Eskalationen und klappt Erledigtes ein", async () => {
    stubFetch();
    renderInbox();
    const esc = await screen.findByRole("article", { name: /Produktionsdaten löschen/ });
    expect(within(esc).getByText(/Datenverlust/)).toBeInTheDocument();
    expect(screen.getByText("Erledigt (1)")).toBeInTheDocument();
    expect(screen.queryByText("Alte Frage")).not.toBeVisible();
  });

  it("zeigt einen ehrlichen Leerzustand", async () => {
    stubFetch({ approvals: [], items: [] });
    renderInbox();
    expect(await screen.findByText("Nichts zu entscheiden.")).toBeInTheDocument();
  });
});
