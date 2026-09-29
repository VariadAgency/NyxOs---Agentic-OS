// Diff-Komponente (Zeilennummern, Farben, nebeneinander/untereinander) und der Vergleich
// in der Großansicht (Änderungen beider Sessions, Git-Stände).
import type { CollisionEntry, DiffLine } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollisionDetail } from "../src/features/conflicts/CollisionDetail";
import { DiffModeToggle, DiffView, type DiffMode } from "../src/features/conflicts/DiffView";
import { pauseAvailability } from "../src/features/conflicts/decisionText";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const LINES: DiffLine[] = [
  { kind: "hunk", oldNo: null, newNo: null, text: "@@ -41,3 +41,3 @@" },
  { kind: "ctx", oldNo: 41, newNo: 41, text: "davor" },
  { kind: "del", oldNo: 42, newNo: null, text: "alt" },
  { kind: "add", oldNo: null, newNo: 42, text: "neu" },
];

function Toggleable() {
  const [mode, setMode] = useState<DiffMode>("unified");
  return (
    <>
      <DiffModeToggle mode={mode} onChange={setMode} />
      <DiffView lines={LINES} mode={mode} />
    </>
  );
}

describe("DiffView", () => {
  it("untereinander: je Zeile alte + neue Nummer, Hinzufügen/Entfernen markiert", () => {
    const { container } = render(<DiffView lines={LINES} mode="unified" />);
    const del = container.querySelector('[data-kind="del"]');
    const add = container.querySelector('[data-kind="add"]');
    expect(del?.textContent).toBe("42−alt");
    expect(add?.textContent).toBe("42+neu");
    expect(del?.className).toContain("bg-a-bad/10");
    expect(add?.className).toContain("bg-a-ok/10");
  });

  it("nebeneinander: alt links, neu rechts in derselben Zeile; umschaltbar", async () => {
    const user = userEvent.setup();
    render(<Toggleable />);
    expect(screen.getByTestId("diff-view")).toHaveAttribute("data-mode", "unified");
    await user.click(screen.getByRole("radio", { name: "Nebeneinander" }));
    const view = screen.getByTestId("diff-view");
    expect(view).toHaveAttribute("data-mode", "split");
    const halves = view.querySelectorAll('[data-kind="del"], [data-kind="add"]');
    expect([...halves].map((h) => h.textContent)).toEqual(["42−alt", "42+neu"]);
  });

  it("leerer Diff → verständlicher Text", () => {
    render(<DiffView lines={[]} mode="split" />);
    expect(screen.getByText("Keine Unterschiede.")).toBeInTheDocument();
  });
});

describe("pauseAvailability", () => {
  const d = {
    key: "k",
    kind: "together" as const,
    folder: "f",
    areaGlob: null,
    fileCount: 1,
    samplePaths: [],
    severity: "low" as const,
    status: "open" as const,
    reservation: null,
    latestAt: null,
    sessions: [
      { sessionKey: "a", title: null, tool: null, inNyxOS: true, fileCount: 1 },
      { sessionKey: "b", title: null, tool: null, inNyxOS: true, fileCount: 1 },
    ],
  };
  it("Brücke offline → aus, mit Grund", () => {
    expect(pauseAvailability(d, false)).toMatchObject({ enabled: false, hint: expect.stringMatching(/Brücke/) });
  });
  it("beide in der NyxOS → „Beide pausieren“", () => {
    expect(pauseAvailability(d, true)).toMatchObject({ enabled: true, label: "Beide pausieren", sessionKeys: ["a", "b"] });
  });
});

const ENTRY: CollisionEntry = {
  path: "/home/user/projects/App/x.md",
  writers: [
    { sessionKey: "claude:a", title: "Session A", firstSeenAt: "2026-09-25T08:00:00.000Z" },
    { sessionKey: "codex:b", title: "Session B", firstSeenAt: "2026-09-25T08:00:00.000Z" },
  ],
  readers: [],
  reservation: null,
  state: "conflict",
  reason: "2 Sessions schreiben gleichzeitig",
};

describe("Großansicht: Vergleichen", () => {
  it("zeigt die Änderungen beider Sessions nebeneinander (aus dem Verlauf)", async () => {
    __primeAuthForTests();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conflicts/file-changes")) {
        return jsonResponse({
          path: ENTRY.path,
          sessions: [
            { sessionKey: "claude:a", title: "Session A", tool: "claude", missingArchive: false, edits: [{ at: "2026-09-25T08:00:00.000Z", tool: "Edit", kind: "edit", exactLines: true, truncated: false, lines: LINES }] },
            { sessionKey: "codex:b", title: "Session B", tool: "codex", missingArchive: true, edits: [] },
          ],
        });
      }
      return Promise.reject(new Error(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithClient(
      <MemoryRouter>
        <CollisionDetail entry={ENTRY} onClose={() => {}} />
      </MemoryRouter>,
    );
    const cols = await screen.findAllByTestId("session-changes");
    expect(cols).toHaveLength(2);
    expect(within(cols[0] as HTMLElement).getByText("neu")).toBeInTheDocument();
    expect(within(cols[1] as HTMLElement).getByText(/Verlauf dieser Session liegt noch nicht/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/conflicts/file-changes?path=${encodeURIComponent(ENTRY.path)}&sessions=${encodeURIComponent("claude:a,codex:b")}`);
  });

  it("Git-Stände: Commits zur Auswahl, „Vergleichen“ holt den Diff; Brücke offline → klare Meldung", async () => {
    __primeAuthForTests();
    let offline = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conflicts/file-changes")) return jsonResponse({ path: ENTRY.path, sessions: [] });
      if (url.startsWith("/api/conflicts/compare")) {
        if (offline) return jsonResponse({ error: "Die Brücke ist gerade nicht verbunden – der Vergleich braucht sie." }, { status: 503 });
        const withDiff = url.includes("from=");
        return jsonResponse({
          repoRoot: "/home/user/projects/App",
          relPath: "x.md",
          commits: [{ sha: "a".repeat(40), short: "aaaaaaa", author: "C", at: "", subject: "Plan geändert" }],
          from: withDiff ? "HEAD" : null,
          to: null,
          truncated: false,
          files: withDiff ? [{ oldPath: "x.md", newPath: "x.md", binary: false, lines: LINES }] : [],
        });
      }
      return Promise.reject(new Error(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <CollisionDetail entry={ENTRY} onClose={() => {}} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("tab", { name: "Git-Stände vergleichen" }));
    expect(await within(await screen.findByLabelText("Von")).findByRole("option", { name: "aaaaaaa · Plan geändert" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Vergleichen" }));
    expect(await screen.findByTestId("diff-view")).toHaveAttribute("data-mode", "split");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(`/api/conflicts/compare?path=${encodeURIComponent(ENTRY.path)}&from=HEAD`);

    offline = true;
    await user.selectOptions(screen.getByLabelText("Bis"), "HEAD");
    await user.click(screen.getByRole("button", { name: "Vergleichen" }));
    expect(await screen.findByText(/Die Brücke ist gerade nicht verbunden/)).toBeInTheDocument();
  });
});
