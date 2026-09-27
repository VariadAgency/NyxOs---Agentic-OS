// Konflikte-Tab: Zusammenfassung statt ganzer Karte, Entscheidungs-Knöpfe rufen die
// richtigen Endpunkte, Gruppen laden erst beim Aufklappen, Reservierung von Hand.
import type { ConflictDecision, ConflictsSummary } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conflicts } from "../src/features/conflicts/Conflicts";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOT = "/home/user/projects/App/docs/audit";

function decision(over: Partial<ConflictDecision> = {}): ConflictDecision {
  return {
    key: "App/docs/audit|claude:a+claude:b",
    kind: "together",
    folder: "App/docs/audit",
    areaGlob: `${ROOT}/**`,
    sessions: [
      { sessionKey: "claude:a", title: "Audit Webshop vollständig", tool: "claude", inNyxOS: true, fileCount: 12 },
      { sessionKey: "claude:b", title: "Bevor wir mit dem Webshop arbeiten", tool: "claude", inNyxOS: true, fileCount: 12 },
    ],
    fileCount: 12,
    samplePaths: [`${ROOT}/Bestandsaufnahme.md`],
    severity: "high",
    status: "open",
    reservation: null,
    latestAt: "2026-09-25T08:00:00.000Z",
    ...over,
  };
}

function summary(over: Partial<ConflictsSummary> = {}): ConflictsSummary {
  return {
    version: "v1",
    generatedAt: "2026-09-25T08:00:00.000Z",
    bridgeOnline: true,
    totals: { files: 13, conflicts: 12, sharedRead: 0, groups: 1, openDecisions: 1, past: 0 },
    decisions: [decision()],
    groups: [{ key: "App/docs/audit", fileCount: 13, conflictCount: 12, sharedReadCount: 0, pastCount: 0, severity: "high", writers: [{ sessionKey: "claude:a", title: "A" }], writerCount: 2, latestAt: null }],
    reservations: [{ id: 1, pathGlob: "apps/web/src/features/git/**", label: "P5-Git-UI", sessionKey: null, createdAt: "2026-09-25T08:00:00.000Z", until: null }],
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => Promise<Response> | undefined;

/** Eigener fetch-Stub: Antwort je URL, alle Aufrufe mitgeschrieben. */
function stub(s: ConflictsSummary, extra: Handler = () => undefined) {
  __primeAuthForTests();
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const custom = extra(url, init);
    if (custom) return custom;
    if (url.startsWith("/api/conflicts/summary")) return jsonResponse(s);
    if (url.startsWith("/api/conflicts/entries")) {
      return jsonResponse({
        total: 1,
        offset: 0,
        limit: 50,
        entries: [{ path: `${ROOT}/Bestandsaufnahme.md`, writers: [{ sessionKey: "claude:a", title: "A", firstSeenAt: "2026-09-25T08:00:00.000Z" }], readers: [], reservation: null, state: "conflict", reason: "2 Sessions schreiben gleichzeitig" }],
      });
    }
    if (method === "POST") return jsonResponse({ ok: true, reservation: { id: 9, pathGlob: `${ROOT}/**`, label: "x", sessionKey: null, createdAt: "", until: null }, notified: [], results: [] });
    return Promise.reject(new Error(`Test hat keine Antwort für ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { impl, calls, posts: () => calls.filter((c) => c.method === "POST") };
}

function renderPage() {
  return renderWithClient(
    <MemoryRouter>
      <Conflicts />
    </MemoryRouter>,
  );
}

describe("Konflikte-Tab: Zusammenfassung", () => {
  it("lädt nur die Zusammenfassung — keine ganze Karte, keine Einzelzeilen vor dem Aufklappen", async () => {
    const { calls } = stub(summary());
    renderPage();
    expect(await screen.findByText("Was muss ich entscheiden?")).toBeInTheDocument();
    expect(screen.getByText("App/docs/audit", { selector: "span" })).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/api/conflicts/summary"]);
  });

  it("Gruppe aufklappen lädt deren Dateien seitenweise", async () => {
    const { calls } = stub(summary());
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("group-toggle"));
    expect(await screen.findByText("Bestandsaufnahme.md", { selector: "span" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/conflicts/entries?group=App%2Fdocs%2Faudit&offset=0&limit=50"))).toBe(true);
  });
});

describe("„Was muss ich entscheiden?“", () => {
  it("ein Satz in einfacher Sprache + die großen Knöpfe", async () => {
    stub(summary());
    renderPage();
    const card = await screen.findByTestId("decision");
    expect(within(card).getByText("A und B ändern gerade gleichzeitig 12 Dateien im Bereich „App/docs/audit“.")).toBeInTheDocument();
    expect(within(card).getByText(/Was kann passieren/)).toBeInTheDocument();
    for (const name of ["A zuerst", "B zuerst", "Bereich reservieren", "Beide pausieren", "Ignorieren"]) expect(within(card).getByRole("button", { name })).toBeEnabled();
  });

  it("jeder Knopf ruft den richtigen Endpunkt", async () => {
    const { posts } = stub(summary());
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId("decision");
    const key = "App/docs/audit|claude:a+claude:b";

    await user.click(within(card).getByRole("button", { name: "B zuerst" }));
    expect(await screen.findByRole("status")).toHaveTextContent("B hat jetzt Vorrang");
    await user.click(within(card).getByRole("button", { name: "Bereich reservieren" }));
    await user.click(within(card).getByRole("button", { name: "Beide pausieren" }));
    await user.click(within(card).getByRole("button", { name: "Ignorieren" }));

    await vi.waitFor(() => expect(posts()).toHaveLength(4));
    expect(posts()).toEqual([
      { url: "/api/conflicts/decisions/prefer", method: "POST", body: { key, sessionKey: "claude:b" } },
      { url: "/api/conflicts/decisions/reserve", method: "POST", body: { key } },
      { url: "/api/conflicts/pause", method: "POST", body: { sessionKeys: ["claude:a", "claude:b"] } },
      { url: "/api/conflicts/decisions/dismiss", method: "POST", body: { key, status: "ignored" } },
    ]);
  });

  it("„Beide pausieren“ ist ehrlich: aus, wenn keine Session in der NyxOS läuft — mit Hinweis", async () => {
    const d = decision();
    stub(summary({ decisions: [{ ...d, sessions: d.sessions.map((s) => ({ ...s, inNyxOS: false })) }] }));
    renderPage();
    const card = await screen.findByTestId("decision");
    expect(within(card).getByRole("button", { name: "Beide pausieren" })).toBeDisabled();
    expect(within(card).getByText(/Anhalten geht nur bei Sessions, die in NyxOS laufen/)).toBeInTheDocument();
  });

  it("nur eine läuft in NyxOS → Knopf heißt nach ihr, Hinweis nennt die andere", async () => {
    const d = decision();
    const user = userEvent.setup();
    const { posts } = stub(summary({ decisions: [{ ...d, sessions: [d.sessions[0], { ...d.sessions[1], inNyxOS: false }] as ConflictDecision["sessions"] }] }));
    renderPage();
    const card = await screen.findByTestId("decision");
    expect(within(card).getByText("Nur A läuft in NyxOS. B kann hier nicht angehalten werden.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "A pausieren" }));
    await vi.waitFor(() => expect(posts()[0]).toMatchObject({ url: "/api/conflicts/pause", body: { sessionKeys: ["claude:a"] } }));
  });

  it("Fehler vom Server (z. B. schon reserviert) erscheint als verständliche Meldung", async () => {
    stub(summary(), (url) => (url === "/api/conflicts/decisions/prefer" ? jsonResponse({ error: 'Überlappt mit Reservierung "P5" (x/**)' }, { status: 409 }) : undefined));
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByTestId("decision")).getByRole("button", { name: "A zuerst" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Überlappt mit Reservierung");
  });

  it("schon Entschiedenes steht zugeklappt darunter und lässt sich rückgängig machen", async () => {
    const { posts } = stub(summary({ decisions: [decision({ status: "ignored" })], totals: { files: 1, conflicts: 1, sharedRead: 0, groups: 1, openDecisions: 0, past: 0 } }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Gerade nichts/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Schon entschieden \(1\)/ }));
    await user.click(screen.getByRole("button", { name: "Wieder öffnen" }));
    await vi.waitFor(() => expect(posts()[0]).toMatchObject({ url: "/api/conflicts/decisions/reopen", body: { key: "App/docs/audit|claude:a+claude:b" } }));
  });
});

describe("Reservierungen aufheben, „zuerst“-Knöpfe, Suche mit Tipp-Pause", () => {
  const reservedBy = (label: string, id: number) =>
    summary({ decisions: [decision({ status: "reserved", reservation: { id, pathGlob: `${ROOT}/**`, label, sessionKey: "claude:a", createdAt: "", until: null } })], totals: { files: 1, conflicts: 1, sharedRead: 0, groups: 1, openDecisions: 0, past: 0 } });

  it("eine FREMDE Reservierung (z. B. eines Auftrags) lässt sich hier nicht aufheben", async () => {
    stub(reservedBy("Auftrag T-01", 4));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Schon entschieden \(1\)/ }));
    expect(screen.queryByRole("button", { name: "Reservierung aufheben" })).not.toBeInTheDocument();
    expect(screen.getByText(/reserviert durch „Auftrag T-01“/)).toBeInTheDocument();
  });

  it("eine hier entstandene Reservierung lässt sich aufheben; Fehler werden gezeigt", async () => {
    const { calls } = stub(reservedBy("Vorrang: Audit", 9), (url, init) => (init?.method === "DELETE" ? jsonResponse({ error: "x" }, { status: 500 }) : undefined));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Schon entschieden \(1\)/ }));
    await user.click(screen.getByRole("button", { name: "Reservierung aufheben" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/reservations/9")).toBe(true));
    expect(await screen.findByText(/Das hat nicht geklappt/)).toBeInTheDocument();
  });

  it("jede beteiligte Session bekommt ihren „zuerst“-Knopf (auch D)", async () => {
    const d = decision();
    const four = ["claude:a", "claude:b", "claude:c", "claude:d"].map((k) => ({ sessionKey: k, title: k, tool: "claude", inNyxOS: false, fileCount: 1 }));
    stub(summary({ decisions: [{ ...d, sessions: four }] }));
    renderPage();
    const card = await screen.findByTestId("decision");
    for (const name of ["A zuerst", "B zuerst", "C zuerst", "D zuerst"]) expect(within(card).getByRole("button", { name })).toBeInTheDocument();
  });

  it("Suche fragt erst nach einer kurzen Tipp-Pause, nicht bei jedem Tastendruck", async () => {
    const { calls } = stub(summary());
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText("Kollisionskarte durchsuchen"), "audit");
    await vi.waitFor(() => expect(calls.filter((c) => c.url.includes("q=")).length).toBeGreaterThan(0));
    expect(calls.filter((c) => c.url.includes("q=")).map((c) => new URL(c.url, "http://x").searchParams.get("q"))).toEqual(["audit"]);
  });
});

describe("Reservierungen von Hand", () => {
  it("eine überlappende Reservierung wird abgelehnt, mit Begründung", async () => {
    stub(summary(), (url) => (url === "/api/reservations" ? jsonResponse({ error: 'Überlappt mit Reservierung "P5-Git-UI" (apps/web/src/features/git/**)', conflictingReservation: null }, { status: 409 }) : undefined));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("apps/web/src/features/git/**");
    await user.type(screen.getByLabelText("Dateibereich (Glob)"), "apps/web/src/features/git/Panel.tsx");
    await user.type(screen.getByLabelText("Bezeichnung"), "Konkurrierend");
    await user.click(screen.getByRole("button", { name: "Reservieren" }));
    expect(await screen.findByText(/Überlappt mit Reservierung/)).toBeInTheDocument();
  });
});
