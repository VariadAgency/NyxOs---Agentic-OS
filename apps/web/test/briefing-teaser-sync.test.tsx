// Briefing-Teaser im Überblick bleibt mit dessen Stand synchron:
// 1. Der Überblick lädt alle 30 s neu, das Briefing nicht — der Teaser zeigte deshalb Sätze eines Briefings,
//    das beim Laden noch „aktuell“ war, obwohl die Kopfzeile darüber schon einen neueren Stand hatte
//    (wieder „2 warten“ neben „3 warten“). Gleichheit heißt: gleicher Fingerabdruck wie der Überblick.
// 2. Sessions ohne Titel erschienen in „Zuletzt fertig“ als Kürzel („7c721716“) statt „(noch ohne Titel)“.
import type { HaikuReport, OverviewSnapshot } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { Overview } from "../src/features/overview/Overview";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCountUpMemory();
});

const AT = "2026-09-25T08:38:00.000Z";
const OV: OverviewSnapshot = {
  greetingName: "Alex",
  generatedAt: "2026-09-25T08:39:00.000Z",
  counts: { running: 0, waiting: 3, idle: 0, crashed: 0, startklar: 0 },
  lage: "Keine Session läuft, 3 warten auf dich.",
  needsYouCount: 3,
  openQuestions: { approvals: 0, inbox: 0, conflicts: 0, total: 0 },
  fingerprint: "fp-neu",
  metrics: [],
  commits: [],
  criticalSessions: [],
  orphanedSessions: [],
  orphanedTotal: 0,
  baustellen: [],
  recentDone: [],
  pendingDeliveries: { count: 0, sessions: 0, href: null, title: null },
  serverOk: true,
};
const REPORT: HaikuReport = {
  id: 5,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: AT,
  greeting: "Guten Morgen, Alex",
  lage: "1 Session läuft, 2 warten auf dich.",
  sections: [{ title: "Was wartet", statements: [{ text: "2 Sessions warten auf dich.", sources: [], estimate: false, author: "haiku" }] }],
  runsWithoutYou: [],
  needsYou: [],
  mode: "ok",
  modeReason: null,
  callId: 3,
  snapshot: { at: AT, counts: { running: 1, waiting: 2, idle: 0, crashed: 0, startklar: 0 }, lage: "1 Session läuft, 2 warten auf dich.", needsYouCount: 2, fingerprint: "fp-alt" },
  // Beim Laden des Briefings war es noch aktuell — der Überblick ist inzwischen weiter.
  stale: false,
};

describe("Teaser gleicht mit dem Stand des Überblicks ab", () => {
  it("anderer Fingerabdruck als der Überblick → keine alten Zahlen, sondern der Hinweis", async () => {
    stubFetchRoutes({ overview: () => jsonResponse(OV), haikuReport: () => jsonResponse({ report: REPORT }) });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(await within(teaser).findByText(/Seit dem Briefing von 10:38 hat sich etwas geändert/)).toBeInTheDocument();
    expect(teaser).not.toHaveTextContent("2 Sessions warten");
  });

  it("gleicher Fingerabdruck → der erste Satz des Briefings", async () => {
    stubFetchRoutes({ overview: () => jsonResponse({ ...OV, fingerprint: "fp-alt" }), haikuReport: () => jsonResponse({ report: REPORT }) });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(await within(teaser).findByText("2 Sessions warten auf dich.")).toBeInTheDocument();
  });
});

