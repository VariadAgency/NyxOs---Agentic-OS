// Überblick und Briefing im Web:
// - Überblick und Briefing zeigen dieselben Zahlen aus demselben Stand (Lage-Satz vom Server, „Stand HH:MM“);
//   veraltetes Briefing wird ehrlich markiert und neu erstellt; „ohne Haiku erstellt“ mit Grund; korrigierte Zahl markiert.
// - Neue Kacheln/Listen aus echten Daten, klickbar.
// - „NyxOS“-Logo führt zum Überblick (Link, per Tastatur erreichbar).
// - Einstellung „abgestürzt gilt bis … Stunden“.
import type { HaikuReport, MetricTile, OverviewSnapshot } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/components/Sidebar";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { Briefing } from "../src/features/haiku/Briefing";
import { Overview } from "../src/features/overview/Overview";
import { SessionStateSettingsPanel } from "../src/features/settings/SessionStateSettingsPanel";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, presenceBody, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCountUpMemory();
});

const tile = (over: Partial<MetricTile> & Pick<MetricTile, "key" | "label" | "value" | "href">): MetricTile => ({
  format: "count",
  trend: null,
  sparkline: [],
  sparklineLabel: null,
  caption: null,
  captionTone: null,
  placeholder: false,
  placeholderReason: null,
  ...over,
});

const counts = { running: 1, waiting: 2, idle: 0, crashed: 1, startklar: 0 };
const LAGE = "1 Session läuft, 2 warten auf dich, 1 ist abgestürzt.";
const AT = "2026-09-25T08:38:00.000Z"; // 10:38 Berlin
const FP = "fp-1038";

const SNAPSHOT: OverviewSnapshot = {
  greetingName: "Alex",
  generatedAt: AT,
  counts,
  lage: LAGE,
  needsYouCount: 3,
  openQuestions: { approvals: 0, inbox: 0, conflicts: 0, total: 0 },
  fingerprint: FP,
  metrics: [
    tile({ key: "sessions_open", label: "Sessions offen", value: 3, href: "/sessions" }),
    tile({ key: "sessions_waiting", label: "Wartet auf dich", value: 2, href: "/sessions?state=waiting" }),
    tile({ key: "tokens_today", label: "Tokens heute", value: 4_000_000, format: "tokens", trend: { current: 4_000_000, previous: 2_000_000, period: "ggü. gestern", upIsGood: null }, sparkline: [1, 2, 4], sparklineLabel: "Tokens je Tag · 14 T", href: "/usage" }),
    tile({ key: "builds_red", label: "Builds rot", value: 1, caption: "NyxOS: Typen-Check", captionTone: "bad", href: "/server" }),
  ],
  commits: [],
  orphanedSessions: [],
  orphanedTotal: 0,
  criticalSessions: [
    { sessionKey: "claude:c1", sessionId: "c1", title: "Zähle langsam bis 50", label: "Zähle langsam bis 50", tool: "claude", state: "crashed", reason: "abgestürzt", href: "/sessions/coding/_/c1" },
    { sessionKey: "claude:w1", sessionId: "w1", title: "Neumorphic dashboard design", label: "Neumorphic dashboard design", tool: "claude", state: "waiting", reason: "wartet seit 5 min", href: "/sessions/coding/nyxos/w1" },
    { sessionKey: "claude:w2", sessionId: "w2", title: "Projekt-Orchestrierung", label: "Projekt-Orchestrierung", tool: "claude", state: "waiting", reason: "wartet seit 14 Std", href: "/sessions/planung/_/w2" },
  ],
  baustellen: [],
  recentDone: [
    { kind: "entry", id: "entry:7", title: "Login-Absturz behoben", label: "Bug erledigt", at: "2026-09-25T08:28:00.000Z", href: "/tasks?e=7" },
    { kind: "session", id: "claude:e1", title: "Fertige Session Login", label: "Session beendet", at: "2026-09-25T07:58:00.000Z", href: "/sessions/coding/app/e1" },
  ],
  pendingDeliveries: { count: 0, sessions: 0, href: null, title: null },
  serverOk: true,
};

const needsYou = [
  { id: "session:claude:w1", kind: "session", title: "Wartet: Neumorphic dashboard design", detail: null, minutes: 5, zeroEnergy: false, href: "/sessions/coding/nyxos/w1", sources: [], action: null },
  { id: "session:claude:w2", kind: "session", title: "Wartet: Projekt-Orchestrierung", detail: null, minutes: 5, zeroEnergy: false, href: "/sessions/planung/_/w2", sources: [], action: null },
  { id: "crashed:claude:c1", kind: "crashed", title: "Abgestürzt: Zähle langsam bis 50", detail: "Neu starten oder schließen", minutes: 2, zeroEnergy: false, href: "/sessions/coding/_/c1", sources: [], action: null },
] as HaikuReport["needsYou"];

const REPORT: HaikuReport = {
  id: 5,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: AT,
  greeting: "Guten Morgen, Alex",
  lage: LAGE,
  sections: [
    { title: "Was wartet", statements: [{ text: "2 Sessions warten auf dich: „Neumorphic dashboard design“, „Projekt-Orchestrierung“.", sources: [], estimate: false, author: "haiku" }] },
    { title: "Was ist kaputt", statements: [{ text: "1 Session ist abgestürzt: „Zähle langsam bis 50“.", sources: [], estimate: false, author: "regeln", corrected: true }] },
  ],
  runsWithoutYou: [],
  needsYou,
  mode: "ok",
  modeReason: null,
  callId: 3,
  snapshot: { at: AT, counts, lage: LAGE, needsYouCount: 3, fingerprint: FP },
  stale: false,
};

function renderIn(ui: React.ReactElement, path = "/") {
  return renderWithClient(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

describe("Logo führt zum Überblick", () => {
  it("„NyxOS“ oben links ist ein Link auf /overview und per Tastatur erreichbar", async () => {
    stubFetchRoutes({ health: () => jsonResponse({ ok: true }), machines: () => jsonResponse([]), fallback: () => jsonResponse({}) });
    renderIn(<Sidebar />, "/sessions");
    const logo = screen.getByRole("link", { name: /NyxOS.*Überblick/ });
    expect(logo).toHaveAttribute("href", "/overview");
    logo.focus();
    expect(logo).toHaveFocus();
    expect(logo.className).toMatch(/focus-visible:/);
    await userEvent.setup().tab();
  });
});

describe("Überblick und Briefing aus demselben Stand", () => {
  it("Kopfzeile, Kacheln, Kritische Sessions und Briefing nennen dieselben Zahlen; Stand sichtbar", async () => {
    stubFetchRoutes({ overview: () => jsonResponse(SNAPSHOT), haikuReport: () => jsonResponse({ report: REPORT }) });
    renderIn(<Overview />);
    const header = await screen.findByTestId("overview-lage");
    expect(header).toHaveTextContent(LAGE);
    expect(screen.getByTestId("overview-stand")).toHaveTextContent("Stand 10:38");
    const critical = screen.getByRole("region", { name: "Kritische Sessions" });
    expect(within(critical).getAllByText("abgestürzt")).toHaveLength(counts.crashed);
    expect(within(critical).getAllByText(/^wartet/)).toHaveLength(counts.waiting);
    // Teaser: aktuelles Briefing → erster Satz (nicht noch einmal der Lage-Satz), Zeit dabei.
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(await within(teaser).findByText(/2 Sessions warten auf dich/)).toBeInTheDocument();
    expect(teaser).toHaveTextContent("Briefing von 10:38");
  });

  it("Briefing zeigt denselben Lage-Satz, „Stand 10:38“ und „Braucht dich“ mit genau den Zahlen des Überblicks", async () => {
    stubFetchRoutes({ haikuReport: () => jsonResponse({ report: REPORT }) });
    renderIn(<Briefing />);
    expect(await screen.findByTestId("briefing-lage")).toHaveTextContent(LAGE);
    expect(screen.getByText(/Stand 10:38/)).toBeInTheDocument();
    const needs = screen.getByRole("region", { name: "Braucht dich" });
    expect(within(needs).getAllByText("Session")).toHaveLength(counts.waiting);
    expect(within(needs).getAllByText("Abgestürzt")).toHaveLength(counts.crashed);
    expect(within(needs).getByTestId("needs-count")).toHaveTextContent(String(SNAPSHOT.needsYouCount));
    // Korrigierte Zahl ist markiert.
    expect(screen.getByText("Zahl korrigiert")).toBeInTheDocument();
  });

  it("veraltetes Briefing: ehrlicher Hinweis und es wird von selbst neu erstellt", async () => {
    // Tageszeit fest (ab 18 Uhr wählt die Seite „Recap“).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 25, 8, 0));
    const posted: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/haiku/report") && init?.method === "POST") {
        posted.push(String(init.body));
        return gate.then(() => jsonResponse({ report: { ...REPORT, id: 6, stale: false } }));
      }
      if (url.startsWith("/api/haiku/report")) return jsonResponse({ report: { ...REPORT, stale: true } });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    vi.stubGlobal("fetch", impl);
    renderIn(<Briefing />);
    expect(await screen.findByText(/Seit 10:38 hat sich etwas geändert – wird gerade neu geschrieben/)).toBeInTheDocument();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.parse(posted[0] ?? "{}")).toEqual({ kind: "briefing" });
    // Fertig geschrieben → der Hinweis verschwindet, und es bleibt bei EINEM automatischen Lauf.
    release();
    await waitFor(() => expect(screen.queryByText(/hat sich etwas geändert/)).not.toBeInTheDocument());
    expect(posted).toHaveLength(1);
  });

  it("Überblick mit veraltetem Briefing zeigt keine alten Zahlen, sondern den Hinweis", async () => {
    stubFetchRoutes({ overview: () => jsonResponse(SNAPSHOT), haikuReport: () => jsonResponse({ report: { ...REPORT, stale: true, lage: "Keine Session läuft gerade, nichts braucht dich." } }) });
    renderIn(<Overview />);
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(await within(teaser).findByText(/Seit dem Briefing von 10:38 hat sich etwas geändert/)).toBeInTheDocument();
    expect(teaser).not.toHaveTextContent("nichts braucht dich");
  });

  it("ohne Haiku: „Ohne Haiku erstellt“ mit Grund", async () => {
    stubFetchRoutes({ haikuReport: () => jsonResponse({ report: { ...REPORT, mode: "nur-daten", modeReason: "Wartet auf Token von Alex." } }) });
    renderIn(<Briefing />);
    expect(await screen.findByText("Ohne Nyx erstellt – Wartet auf Token von Alex.")).toBeInTheDocument();
  });
});

describe("mehr echte Daten", () => {
  it("neue Kacheln sind Links; „Zuletzt fertig“ und „Betrieb“ zeigen echte Einträge mit Wegen zur Quelle", async () => {
    stubFetchRoutes({
      overview: () => jsonResponse(SNAPSHOT),
      bridgePresence: () => jsonResponse(presenceBody({ since: new Date(Date.now() - 3 * 3_600_000).toISOString() })),
      bridgeHistory: () =>
        jsonResponse({
          events: [
            { at: new Date(Date.now() - 5 * 3_600_000).toISOString(), state: "reconnecting", reason: "Tunnel neu aufgebaut", durationMs: 6_000 },
            { at: new Date(Date.now() - 3 * 3_600_000).toISOString(), state: "online", reason: null, durationMs: null },
          ],
        }),
      server: () =>
        jsonResponse({
          docker: { available: false, reason: "x" },
          containers: [],
          deploys: [{ id: 2, project: "nyxos", containerName: "nyxos-api", imageId: "sha", createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), gitRev: "69e82dc", source: "deploy.sh" }],
          nyxosHealthy: true,
          health: {},
          serverBehind: null,
          nasBackup: null,
          dozzleUrl: null,
        }),
      builds: () =>
        jsonResponse({
          recent: [],
          groups: [{ key: "k", kind: "nyxos", state: "red", headline: "Build rot: NyxOS", sentence: "Der Typen-Check der NyxOS meldet Fehler.", details: null, signature: "s", count: 2, firstAt: AT, lastAt: AT, lastId: 3, firstId: 2, ids: [2, 3], sessionKeys: [] }],
        }),
    });
    renderIn(<Overview />);
    expect((await screen.findByText("Tokens heute")).closest("a")).toHaveAttribute("href", "/usage");
    expect(screen.getByText("Builds rot").closest("a")).toHaveAttribute("href", "/server");

    const done = screen.getByRole("region", { name: "Zuletzt fertig" });
    expect(within(done).getByRole("link", { name: /Login-Absturz behoben/ })).toHaveAttribute("href", "/tasks?e=7");
    expect(within(done).getByRole("link", { name: /Fertige Session Login/ })).toHaveAttribute("href", "/sessions/coding/app/e1");

    const ops = screen.getByRole("region", { name: "Betrieb" });
    expect(await within(ops).findByText(/Brücke verbunden seit/)).toBeInTheDocument();
    expect(await within(ops).findByText(/1 Aussetzer in 24 Std/)).toBeInTheDocument();
    expect(await within(ops).findByText(/Letzter Deploy vor 2 Std/)).toBeInTheDocument();
    expect(within(ops).getByText(/69e82dc/)).toBeInTheDocument();
    expect(await within(ops).findByText(/NyxOS: rot · 2× seit/)).toBeInTheDocument();
    for (const link of within(ops).getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/(server|settings)/);
  });
});

describe("Betrieb im lokalen Modus", () => {
  // Lokal ist Docker freiwillig: ohne Docker-Zugang fehlt nichts — keine gelbe „Ansicht fehlt noch“-Zeile.
  async function containersLine(mode: "local" | "server") {
    const impl = stubFetchRoutes({
      overview: () => jsonResponse(SNAPSHOT),
      server: () => jsonResponse({ docker: { available: false, reason: "x" }, containers: [], deploys: [], nyxosHealthy: true, health: {}, serverBehind: null, nasBackup: null, dozzleUrl: null }),
    });
    const routed = impl.getMockImplementation();
    if (!routed) throw new Error("fetch-Stub fehlt");
    impl.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/app/info") ? jsonResponse({ version: "1.0.0", mode, demo: false }) : routed(input, init)));
    renderIn(<Overview />);
    const ops = await screen.findByRole("region", { name: "Betrieb" });
    await within(ops).findByText("NyxOS läuft");
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u).startsWith("/api/app/info"))).toBe(true));
    return ops;
  }

  it("lokal ohne Docker: keine Container-Zeile", async () => {
    const ops = await containersLine("local");
    await waitFor(() => expect(within(ops).queryByText(/Projekt-Container/)).toBeNull());
  });

  it("Server-Modus ohne Docker-Zugang: die Zeile bleibt", async () => {
    const ops = await containersLine("server");
    expect(await within(ops).findByText(/Projekt-Container: Ansicht fehlt noch/)).toBeInTheDocument();
  });
});

describe("Einstellung Altersgrenze", () => {
  it("zeigt die Schwelle und speichert eine neue", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    __primeAuthForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : null });
        if (url === "/api/settings/session-state" && init?.method === "PATCH") return jsonResponse(JSON.parse(String(init.body)));
        if (url === "/api/settings/session-state") return jsonResponse({ crashedMaxHours: 12 });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    const user = userEvent.setup();
    renderIn(<SessionStateSettingsPanel />);
    const input = await screen.findByLabelText(/abgestürzt/i);
    await waitFor(() => expect(input).toHaveValue(12));
    await user.clear(input);
    await user.type(input, "24");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")?.body ?? "{}")).toEqual({ crashedMaxHours: 24 });
    expect(await screen.findByText("Gespeichert")).toBeInTheDocument();
  });
});
