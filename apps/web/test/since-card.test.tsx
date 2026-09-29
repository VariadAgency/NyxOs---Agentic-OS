// „Seit du weg warst“: Karte oben auf Überblick und Briefing. Leer → „Nichts Neues seit …“, voll → jede
// Zeile ist ein Link, Zahl = Länge der Liste, Umschalter wählt den Zeitraum, „letzter Besuch“ aus dem Browser.
import type { ChangesResponse } from "@nyxos/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_SEEN_KEY, LAST_VISIT_KEY, __resetLastVisitForTests, readLastVisitForTests } from "../src/features/overview/lastVisit";
import { SinceCard } from "../src/features/overview/SinceCard";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const SINCE = "2026-09-25T06:00:00.000Z";
const EMPTY: ChangesResponse = { since: SINCE, until: "2026-09-25T20:00:00.000Z", capped: false, groups: [] };
const FULL: ChangesResponse = {
  ...EMPTY,
  groups: [
    { kind: "sessions_waiting", title: "Wartet auf dich", count: 1, more: 0, items: [{ label: "Heatmap-Session", detail: "wartet seit 2 Std", at: "2026-09-25T18:00:00.000Z", path: "/sessions/coding/_/abc" }] },
    { kind: "sessions_done", title: "Sessions fertig", count: 1, more: 0, items: [{ label: "Test-Session fertig", detail: "fertig", at: "2026-09-25T19:00:00.000Z", path: "/sessions/coding/_/done" }] },
    {
      kind: "commits",
      title: "Commits · NyxOS",
      count: 7,
      more: 2,
      items: Array.from({ length: 7 }, (_, i) => ({ label: `Commit ${i + 1}`, detail: null, at: `2026-09-25T1${i}:00:00.000Z`, path: `/git?g=commit&r=nyxos&k=sha${i}` })),
    },
  ],
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderCard() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route path="*" element={<><SinceCard /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

const changeUrls = (fetchMock: ReturnType<typeof stubFetchRoutes>) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/changes"));

beforeEach(() => {
  localStorage.clear();
  __resetLastVisitForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("SinceCard", () => {
  it("leer: ehrlicher Satz „Nichts Neues seit …“", async () => {
    stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    renderCard();
    expect(await screen.findByText(/Nichts Neues seit/)).toBeInTheDocument();
  });

  it("voll: Gruppen-Zahl = echte Gesamtzahl (Liste + weitere), Rest aufklappbar, weitere ehrlich genannt", async () => {
    stubFetchRoutes({ changes: () => jsonResponse(FULL) });
    renderCard();
    const commits = await screen.findByRole("region", { name: "Commits · NyxOS" });
    expect(within(commits).getByTestId("since-count")).toHaveTextContent("9"); // 7 gezeigt + 2 weitere
    // zuerst 5 Zeilen, dann „alle 7 zeigen“
    expect(within(commits).getAllByRole("link")).toHaveLength(5);
    await userEvent.click(within(commits).getByRole("button", { name: /Alle 7 zeigen/ }));
    expect(within(commits).getAllByRole("link")).toHaveLength(7);
    expect(within(commits).getByText(/2 weitere/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Wartet auf dich" })).toHaveTextContent("wartet seit 2 Std");
  });

  it("Klick auf eine Zeile springt zur Quelle", async () => {
    stubFetchRoutes({ changes: () => jsonResponse(FULL) });
    renderCard();
    await userEvent.click(await screen.findByRole("link", { name: /Test-Session fertig/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/coding/_/done");
  });

  it("ohne gemerkten Besuch gelten 24 Std; mit gemerktem Besuch genau dieser Zeitpunkt", async () => {
    const f = stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    const first = renderCard();
    await screen.findByText(/Nichts Neues seit/);
    expect(changeUrls(f).at(-1)).toBe("/api/changes?since=24h");
    expect(screen.getByText(/kein letzter Besuch gemerkt/i)).toBeInTheDocument();
    first.unmount();

    localStorage.setItem(LAST_VISIT_KEY, String(Date.parse("2026-09-25T06:00:00Z")));
    __resetLastVisitForTests();
    const f2 = stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    renderCard();
    await screen.findByText(/Nichts Neues seit/);
    expect(changeUrls(f2).at(-1)).toBe(`/api/changes?since=${encodeURIComponent(SINCE)}`);
  });

  it("Umschalter wählt den Zeitraum (7 Tage) und merkt ihn", async () => {
    const f = stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    renderCard();
    await screen.findByText(/Nichts Neues seit/);
    await userEvent.click(screen.getByRole("button", { name: "7 Tage" }));
    await waitFor(() => expect(changeUrls(f).at(-1)).toBe("/api/changes?since=7d"));
    expect(screen.getByRole("button", { name: "7 Tage" })).toHaveAttribute("aria-pressed", "true");
  });

  it("verlässt man den Tab, wird der Zeitpunkt gemerkt (zuletzt gesehen)", async () => {
    stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    renderCard();
    await screen.findByText(/Nichts Neues seit/);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(Number(localStorage.getItem(LAST_SEEN_KEY))).toBeGreaterThan(Date.now() - 5_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  it("Neuladen (F5) setzt den letzten Besuch NICHT auf „jetzt“ zurück", () => {
    const visit = Date.now() - 3 * 3_600_000;
    localStorage.setItem(LAST_VISIT_KEY, String(visit));
    // gerade eben noch gesehen (Seite wurde nur neu geladen)
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now() - 2_000));
    __resetLastVisitForTests();
    expect(readLastVisitForTests()).toBe(visit);
  });

  it("nach mehr als 5 Min weg gilt der Zeitpunkt, an dem NyxOS zuletzt offen war", () => {
    const seen = Date.now() - 2 * 3_600_000;
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now() - 24 * 3_600_000));
    localStorage.setItem(LAST_SEEN_KEY, String(seen));
    __resetLastVisitForTests();
    expect(readLastVisitForTests()).toBe(seen);
    // und bleibt beim nächsten Neuladen stehen
    __resetLastVisitForTests();
    expect(readLastVisitForTests()).toBe(seen);
  });

  it("mehrere Tabs – kommt ein alter Hintergrund-Tab nach vorn, während ein anderer Tab gerade offen war, bleibt der Besuch", async () => {
    const visit = Date.now() - 3 * 3_600_000;
    localStorage.setItem(LAST_VISIT_KEY, String(visit));
    __resetLastVisitForTests();
    stubFetchRoutes({ changes: () => jsonResponse(EMPTY) });
    renderCard();
    await screen.findByText(/Nichts Neues seit/);
    // dieser Tab geht vor 2 Std in den Hintergrund …
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() - 2 * 3_600_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    vi.mocked(Date.now).mockRestore();
    // … ein anderer NyxOS-Tab war bis eben offen …
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now() - 1_000));
    // … jetzt kommt dieser Tab nach vorn: kein neuer Besuch
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(readLastVisitForTests()).toBe(visit);
  });

  it("Fehler: verständlicher Satz und Knopf „Erneut versuchen“", async () => {
    stubFetchRoutes({ changes: () => jsonResponse({ error: "x" }, { status: 500 }) });
    renderCard();
    expect(await screen.findByText(/konnte gerade nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });
});
