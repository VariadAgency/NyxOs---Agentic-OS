import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Briefing, greetingFor } from "../src/features/haiku/Briefing";
import { jsonResponse, renderWithClient } from "./helpers";

const approvalItem = {
  id: "approval:9",
  kind: "approval",
  title: "Nachtlauf A02 freigeben",
  detail: null,
  minutes: 0,
  zeroEnergy: true,
  href: "/inbox",
  sources: [],
  action: { type: "approval", approvalId: 9 },
};
const questionItem = {
  id: "inbox:4",
  kind: "question",
  title: "Dunkles Theme als Standard?",
  detail: null,
  minutes: 1,
  zeroEnergy: true,
  href: "/inbox",
  sources: [],
  action: { type: "inbox", inboxId: 4, options: [{ id: "ja", label: "Ja" }, { id: "nein", label: "Nein" }] },
};
const reviewItem = {
  id: "review:A01",
  kind: "review",
  title: "A01 abnehmen",
  detail: "Kritiker: PASS",
  minutes: 12,
  zeroEnergy: false,
  href: "/sessions/coding/nyxos/abc",
  sources: [],
  action: null,
};

const report = {
  id: 1,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T05:00:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "3 Sessions laufen, 1 wartet auf dich.",
  sections: [
    {
      title: "Gestern und nachts",
      statements: [
        { text: "P8 wurde zusammengeführt.", sources: [{ kind: "commit", id: "1e01371", label: "Commit 1e01371", href: null }], estimate: false, author: "regeln" },
        { text: "Heute lohnt sich A02.", sources: [], estimate: true, author: "haiku" },
      ],
    },
  ],
  runsWithoutYou: [approvalItem],
  needsYou: [reviewItem],
  mode: "ok",
  callId: 12,
};

function stubFetch(opts: { report?: unknown; lightDay?: unknown } = {}) {
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/haiku/report") && !init?.method) return jsonResponse({ report: opts.report === undefined ? report : opts.report });
    if (url === "/api/haiku/report" && init?.method === "POST") return jsonResponse({ report });
    if (url === "/api/haiku/release-all") return jsonResponse({ released: JSON.parse(String(init?.body)).ids.length });
    if (url === "/api/nyx/profile") return jsonResponse({ profile: { user: { name: "Alex" } } });
    if (url === "/api/haiku/light-day") return jsonResponse(opts.lightDay ?? { items: [approvalItem, questionItem, reviewItem], deferred: 4 });
    if (url.startsWith("/api/inbox/4/answer")) return jsonResponse({ item: {} });
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderBriefing() {
  return renderWithClient(
    <MemoryRouter>
      <Briefing />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ohne Speicher egal
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Briefing", () => {
  it("begrüßt tageszeitabhängig und zeigt die Lage", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 25, 8, 0));
    stubFetch();
    renderBriefing();
    expect(await screen.findByRole("heading", { name: "Guten Morgen, Alex" })).toBeInTheDocument();
    expect(await screen.findByText("3 Sessions laufen, 1 wartet auf dich.")).toBeInTheDocument();
    expect(screen.getByText("Einschätzung")).toBeInTheDocument();
  });

  it("sagt abends „Guten Abend“", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 25, 21, 0));
    stubFetch();
    renderBriefing();
    expect(await screen.findByRole("heading", { name: "Guten Abend, Alex" })).toBeInTheDocument();
  });

  it("sagt nach Mitternacht nie „Guten Morgen“ (gemeinsame Regel, nachts „Noch wach“)", () => {
    // Um 00:41 darf weder „Guten Abend“ (Überblick) noch „Guten Morgen“ (Briefing) stehen.
    expect(greetingFor(new Date(2026, 8, 26, 0, 41), "Alex")).toBe("Noch wach, Alex?");
    expect(greetingFor(new Date(2026, 8, 26, 5, 0), "Alex")).toBe("Guten Morgen, Alex");
  });

  it("zeigt „Braucht dich“ oben und „Läuft ohne dich“ weiter unten", async () => {
    stubFetch();
    renderBriefing();
    const runs = await screen.findByRole("region", { name: "Läuft ohne dich" });
    const needs = screen.getByRole("region", { name: "Braucht dich" });
    // „Braucht dich“ direkt unter dem Kopf, „Läuft ohne dich“ am Ende — beide im selben Seiten-Stapel.
    expect(needs.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runs.parentElement).toBe(needs.parentElement);
    expect(within(needs).getByText("~12 Min")).toBeInTheDocument();
    expect(within(needs).getByRole("link", { name: /A01 abnehmen/ })).toHaveAttribute("href", "/sessions/coding/nyxos/abc");
  });

  it("„Alles freigeben“ fragt nach und ruft release-all mit den IDs", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderBriefing();
    const runs = await screen.findByRole("region", { name: "Läuft ohne dich" });
    await user.click(within(runs).getByRole("button", { name: "Alles freigeben" }));
    await user.click(within(runs).getByRole("button", { name: "Ja, 1 freigeben" }));

    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/haiku/release-all")).toBe(true));
    const call = impl.mock.calls.find(([u]) => String(u) === "/api/haiku/release-all");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ ids: ["approval:9"] });
    expect(await screen.findByText("1 Punkt freigegeben")).toBeInTheDocument();
  });

  it("„Leichter Tag“ zeigt nur Punkte ohne Aufwand und beantwortet Ja/Nein direkt", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderBriefing();
    await screen.findByRole("region", { name: "Läuft ohne dich" });

    await user.click(screen.getByRole("button", { name: "Leichter Tag" }));
    const light = await screen.findByRole("region", { name: "Leichter Tag" });
    expect(within(light).getByText("Nachtlauf A02 freigeben")).toBeInTheDocument();
    expect(within(light).getByText("Dunkles Theme als Standard?")).toBeInTheDocument();
    expect(screen.queryByText("A01 abnehmen")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Braucht dich" })).not.toBeInTheDocument();
    expect(within(light).getByText("4 Punkte still auf später verschoben")).toBeInTheDocument();

    await user.click(within(light).getByRole("button", { name: "Ja" }));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/inbox/4/answer")).toBe(true));
    const call = impl.mock.calls.find(([u]) => String(u) === "/api/inbox/4/answer");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ optionId: "ja" });
    expect(localStorage.getItem("nyxos.lightDay")).toBe("1");
  });

  it("ohne Bericht: ehrlicher Leerzustand mit „Briefing jetzt erstellen“", async () => {
    // Tageszeit fest (ab 18 Uhr wählt die Seite „Recap“).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 25, 8, 0));
    const impl = stubFetch({ report: null });
    const user = userEvent.setup();
    renderBriefing();
    const create = await screen.findByRole("button", { name: "Briefing jetzt erstellen" });
    await user.click(create);
    await waitFor(() => expect(impl.mock.calls.some(([u, i]) => String(u) === "/api/haiku/report" && i?.method === "POST")).toBe(true));
    expect(await screen.findByText("3 Sessions laufen, 1 wartet auf dich.")).toBeInTheDocument();
  });

  it("nur-daten: Hinweis „ohne Haiku erstellt“ (mit Grund)", async () => {
    stubFetch({ report: { ...report, mode: "nur-daten" } });
    renderBriefing();
    expect(await screen.findByText("Ohne Nyx erstellt – Nyx war nicht bereit.")).toBeInTheDocument();
  });
});
