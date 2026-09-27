// „Letzte Builds“: gleiche Fehlläufe gebündelt (ein Eintrag mit Zähler), „nicht eingerichtet“ statt rot,
// Technik-Meldung nur aufklappbar unter „Details“ — im Server-Tab und in „Braucht dich“.
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildStatusPill } from "../src/features/builds/BuildStatusPill";
import { RecentBuilds } from "../src/features/builds/RecentBuilds";
import { Briefing } from "../src/features/haiku/Briefing";
import { jsonResponse, renderWithClient } from "./helpers";

const legacy = (id: number, startedAt: string) => ({
  id,
  sessionKey: "claude:a",
  kind: "nyxos",
  command: "pnpm test",
  status: "red",
  exitCode: -1,
  logExcerpt: "\nFehler beim Starten: spawn pnpm ENOENT",
  derivedDataPath: null,
  trigger: "stop_hook",
  startedAt,
  endedAt: startedAt,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecentBuilds (Server-Tab)", () => {
  it("zeigt 4 gleiche alte Fehlläufe als EINEN Eintrag „nicht eingerichtet“ mit Zähler, Rohmeldung nur unter Details", async () => {
    // Älterer Server (ohne `groups`): die Web-App bündelt dann selbst mit derselben Funktion.
    const recent = [legacy(7, "2026-09-25 09:20:06+00"), legacy(6, "2026-09-25 09:19:36+00"), legacy(5, "2026-09-25 09:13:27+00"), legacy(4, "2026-09-25 09:12:47+00")];
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ recent })));
    renderWithClient(<RecentBuilds />);
    expect(await screen.findByText("4× seit 11:12")).toBeInTheDocument();
    expect(screen.getAllByText("nicht eingerichtet")).toHaveLength(1);
    expect(screen.queryByText("rot")).not.toBeInTheDocument();
    const raw = screen.getByText(/spawn pnpm ENOENT/);
    const details = raw.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(/Jetzt prüft der Rechner/)).toBeVisible();
  });
});

describe("BuildStatusPill", () => {
  it("kennt „nicht eingerichtet“", () => {
    renderWithClient(<BuildStatusPill current={{ status: "unavailable", startedAt: new Date().toISOString() }} />);
    expect(screen.getByText("nicht eingerichtet")).toBeInTheDocument();
  });
});

describe("Braucht dich", () => {
  it("zeigt beim Build-Eintrag oben den Satz mit Zähler und die Rohmeldung nur aufklappbar", async () => {
    const report = {
      id: 1,
      kind: "briefing",
      day: "2026-09-25",
      createdAt: "2026-09-25T05:00:00.000Z",
      greeting: "Guten Morgen, Alex",
      lage: "Lage",
      sections: [],
      runsWithoutYou: [],
      needsYou: [
        {
          id: "build:9",
          kind: "build",
          title: "Build rot: NyxOS",
          detail: "Der Typen-Check der NyxOS meldet Fehler. · 3× seit 11:12",
          rawDetail: "src/x.ts(1,1): error TS2322: kaputt",
          count: 3,
          minutes: 10,
          zeroEnergy: false,
          href: "/server",
          sources: [],
          action: null,
        },
      ],
      mode: "nur-daten",
      callId: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/haiku/report")) return jsonResponse({ report });
        if (url === "/api/haiku/light-day") return jsonResponse({ items: [], deferred: 0 });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Der Typen-Check der NyxOS meldet Fehler. · 3× seit 11:12")).toBeInTheDocument();
    const raw = screen.getByText(/error TS2322/);
    expect(raw.closest("details")).not.toHaveAttribute("open");
    // Details liegen außerhalb des Links (Aufklappen darf nicht zum Server-Tab springen).
    expect(raw.closest("a")).toBeNull();
  });
});
