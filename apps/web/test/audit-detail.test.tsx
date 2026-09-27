// Audit öffnen zeigt viel mehr als den Graphen — Werte (Datei, Datum, Schwere, Status …), den
// Befund-Text formatiert als Vorschau, verwandte Befunde, Aufträge, Sessions und die GANZE Audit-Datei.
import type { AuditDetail, EntryDetail } from "@nyxos/shared";
import { FINDER_ROOTS } from "@nyxos/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryOverlay } from "../src/features/entries/EntryOverlay";
import { renderWithClient } from "./helpers";

vi.mock("../src/features/brain/LocalGraph", () => ({ LocalGraph: () => <div>Graph-Attrappe</div> }));

afterEach(() => vi.unstubAllGlobals());

const NOW = "2026-09-25T10:00:00.000Z";
const ENTRY: EntryDetail = {
  entry: {
    id: 5,
    kind: "audit",
    title: "B-115 — Negative Seitengröße führt zum Absturz",
    description: "Schwere: Kritisch · Stufe 0 · Paket P-KOMM",
    stage: "geplant",
    priority: "p0",
    baustelle: { slug: "P-KOMM", label: "P-KOMM" },
    progressPercent: 0,
    progressDoneWeight: 0,
    progressTotalWeight: 0,
    maturity: null,
    maturityCheckedAt: null,
    sourceType: "audit",
    sourceId: "B-115",
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  subtasks: [],
  links: [],
  events: [],
  docs: [],
};

const SOURCE = "# Sicherheit — Community\n\n## Befunde\n\n### [B-115] Negative Seitengröße führt zum Absturz\n\n**Beleg:** `limit` ungeprüft.\n\n| Weg | Folge |\n|---|---|\n| GET /feed | Absturz |\n\n### [B-116] Fremder wird Besitzer\n\nText.\n";
const AUDIT: AuditDetail = {
  entryId: 5,
  finding: { id: "B-115", title: "Negative Seitengröße führt zum Absturz", rang: 1, stufe: 0, schwere: "Kritisch", risiko: 5, aufwand: "S", paket: "P-KOMM", vorher: [], paketArbeit: "Seitengrößen gemeinsam prüfen." },
  planPath: "App/docs/audit-2026-09/11-Priorisierter-Massnahmenplan/MASSNAHMENPLAN.md",
  source: {
    path: "App/docs/audit-2026-09/02-Sicherheit/Backend-Community-Sicherheit.md",
    name: "Backend-Community-Sicherheit.md",
    section: "### [B-115] Negative Seitengröße führt zum Absturz\n\n**Beleg:** `limit` ungeprüft.\n\n| Weg | Folge |\n|---|---|\n| GET /feed | Absturz |",
    content: SOURCE,
    origin: "mac",
    updatedAt: "2026-09-21T10:00:00.000Z",
    finderRel: "App/docs/audit-2026-09/02-Sicherheit/Backend-Community-Sicherheit.md",
  },
  related: [{ findingId: "B-116", title: "Fremder wird Besitzer", entryId: 6, stage: "geplant", schwere: "Hoch", reason: "paket" }],
  tasks: [{ entryId: 9, title: "P9 Community härten", stage: "geplant", path: "tools/NyxOS/auftraege/P9-komm/GOAL.md" }],
  sessions: [{ key: "claude:s1", title: "Audit Community lesen", tool: "claude", modes: ["read"], firstSeenAt: NOW, lastActivityAt: NOW, state: "wartet", closed: false, href: "/sessions/coding/_/s1" }],
};

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

describe("Audit-Detail", () => {
  it("zeigt Werte, Befund-Text, Verwandte, Aufträge, Sessions und die ganze Datei", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith("/api/audits/5") ? AUDIT : url.startsWith("/api/entries/5") ? ENTRY : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/audits?e=5"]}>
        <EntryOverlay />
        <Where />
      </MemoryRouter>,
    );
    const facts = await screen.findByRole("region", { name: "Befund-Werte" });
    expect(within(facts).getByText("Kritisch")).toBeInTheDocument();
    expect(within(facts).getByText("Backend-Community-Sicherheit.md")).toBeInTheDocument();
    expect(within(facts).getByText("Geplant")).toBeInTheDocument();
    expect(within(facts).getByText("P-KOMM")).toBeInTheDocument();
    expect(within(facts).getByText(/21\.09\.2026/)).toBeInTheDocument();

    const text = screen.getByRole("region", { name: "Befund" });
    expect(within(text).getByRole("cell", { name: "Absturz" })).toBeInTheDocument();
    expect(within(text).getByText("Beleg:")).toBeInTheDocument();

    const full = screen.getByRole("region", { name: "Ganze Audit-Datei" });
    expect(within(full).getByRole("heading", { name: /Fremder wird Besitzer/ })).toBeInTheDocument();
    expect(within(full).getByRole("link", { name: /In Dateien öffnen/ })).toHaveAttribute(
      "href",
      `/files?root=${FINDER_ROOTS.find((r) => r.base === "project" && r.rel === "")?.id}&p=App%2Fdocs%2Faudit-2026-09%2F02-Sicherheit&sel=App%2Fdocs%2Faudit-2026-09%2F02-Sicherheit%2FBackend-Community-Sicherheit.md&open=App%2Fdocs%2Faudit-2026-09%2F02-Sicherheit%2FBackend-Community-Sicherheit.md`,
    );

    expect(screen.getByRole("link", { name: /Audit Community lesen/ })).toHaveAttribute("href", "/sessions/coding/_/s1");
    const rel = screen.getByRole("region", { name: "Zugehörige Befunde" });
    expect(within(rel).getByRole("button", { name: /B-116/ })).toHaveTextContent("gleiches Paket");
    expect(screen.getByRole("button", { name: /P9 Community härten/ })).toBeEnabled();
    // Verwandter Befund öffnet seine Großansicht (Stapel in der Adresse, Browser-Zurück geht)
    fireEvent.click(within(rel).getByRole("button", { name: /B-116/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/audits?e=5,6");
  });
});
