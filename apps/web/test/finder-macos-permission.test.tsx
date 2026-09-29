// Fragt macOS, ob NyxOS „Downloads“ lesen darf, sagt der Finder das in einem
// verständlichen Satz — mit „Erneut versuchen“ und eigenem Neuversuch alle 5 s (höchstens 2 Min).
import { FINDER_ERR, finderPermissionText, type FinderEntry, type FinderListResult, type FinderRootsResponse } from "@nyxos/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinderView } from "../src/features/finder/FinderView";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { renderWithClient } from "./helpers";

const ROOTS: FinderRootsResponse = {
  bridge: "online",
  roots: [
    { id: "project", label: "Projekt", icon: "◆", abs: "/home/me/projekt", exists: true, writable: true },
    { id: "downloads", label: "Downloads", icon: "↓", abs: "/home/me/Downloads", exists: true, writable: false },
  ],
};

const ENTRY: FinderEntry = { name: "rechnung.pdf", rel: "rechnung.pdf", kind: "pdf", isDir: false, size: 1200, mtimeMs: 1, children: null, hidden: false, secret: false, link: false };
const SENTENCE = finderPermissionText("Downloads");

/** `/api/finder/list` antwortet `failures`-mal mit „macOS fragt“, danach mit der Liste. */
function stub(failures: number) {
  __primeAuthForTests();
  const calls = { list: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString(), "http://x");
      const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }));
      if (u.pathname === "/api/finder/roots") return json(ROOTS);
      if (u.pathname === "/api/finder/list") {
        calls.list++;
        if (calls.list <= failures) return json({ error: SENTENCE, code: FINDER_ERR.macosPermission }, 503);
        const body: FinderListResult = { root: "downloads", rel: "", entries: [ENTRY], truncated: false, writable: false };
        return json(body);
      }
      return json({});
    }),
  );
  return calls;
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Finder: macOS fragt nach der Freigabe", () => {
  it("Spalten (Standard): verständlicher Satz, dann lädt die Liste von selbst", async () => {
    const calls = stub(2);
    renderWithClient(
      <MemoryRouter initialEntries={["/files?root=downloads"]}>
        <FinderView />
      </MemoryRouter>,
    );
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(calls.list).toBe(1); // kein sofortiger Doppel-Versuch — der Hinweis übernimmt
    await tick(5_000);
    expect(calls.list).toBe(2);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    await tick(5_000);
    expect(await screen.findByText("rechnung.pdf")).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });

  it("Liste: „Erneut versuchen“ fragt sofort; nach 2 Min hört der Neuversuch auf", async () => {
    localStorage.setItem("nyx.finder.view", JSON.stringify("liste"));
    const calls = stub(Number.POSITIVE_INFINITY);
    renderWithClient(
      <MemoryRouter initialEntries={["/files?root=downloads"]}>
        <FinderView />
      </MemoryRouter>,
    );
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await tick(0);
    expect(calls.list).toBe(2);
    await tick(125_000);
    const after = calls.list;
    // 2 Min ÷ 5 s ≈ 24 Neuversuche, dann Ruhe
    expect(after).toBeGreaterThanOrEqual(20);
    expect(after).toBeLessThanOrEqual(27);
    await tick(60_000);
    expect(calls.list).toBe(after);
    expect(screen.getByText(/nicht mehr von selbst/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await tick(0);
    expect(calls.list).toBe(after + 1);
  });
});
