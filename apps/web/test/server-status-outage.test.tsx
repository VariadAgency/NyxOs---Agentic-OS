// Die Statuszeile muss bei einem ECHTEN Ausfall nach 90 s ehrlich rot werden (kein Dauer-Gelb),
// und bei /health 503 (Datenbank/Archiv gestört) den richtigen Grund nennen — nicht „liefert Fehler“.
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { SERVER_GRACE_MS } from "../src/hooks/useHealth";
import { renderWithClient } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubServer(health: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/status") return Promise.resolve(new Response(JSON.stringify({ authenticated: true, csrf: "c", hasPasskey: true, authReads: true })));
      if (url === "/health") return health();
      return Promise.reject(new TypeError("Failed to fetch"));
    }),
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Statuszeile – echter Ausfall", () => {
  it("Server dauerhaft weg: erst gelb, nach 90 s rot mit Grund", async () => {
    vi.useFakeTimers();
    stubServer(() => Promise.reject(new TypeError("Failed to fetch")));
    renderWithClient(<ConnectionStatus />);
    await advance(100);
    expect(screen.getByTestId("server-status").dataset.tone).toBe("wait");
    await advance(SERVER_GRACE_MS + 2_000);
    const row = screen.getByTestId("server-status");
    expect(row.dataset.tone).toBe("bad");
    expect(row.textContent).toContain("Server nicht erreichbar");
  });

  it("/health 503 (Datenbank/Archiv gestört) → nach 90 s rot „Server meldet eine Störung“", async () => {
    vi.useFakeTimers();
    stubServer(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false, checks: { db: { ok: false } } }), { status: 503, headers: { "content-type": "application/json" } })),
    );
    renderWithClient(<ConnectionStatus />);
    await advance(100);
    expect(screen.getByTestId("server-status").dataset.tone).toBe("wait");
    await advance(SERVER_GRACE_MS + 2_000);
    const row = screen.getByTestId("server-status");
    expect(row.dataset.tone).toBe("bad");
    expect(row.textContent).toContain("Server meldet eine Störung");
  });
});
