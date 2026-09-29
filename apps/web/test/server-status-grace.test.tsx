// Statuszeile: Nach einem Brücken-Neustart (Tunnel 47801 kurz weg) zeigte die
// Statuszeile sofort ROT „Server nicht erreichbar“, obwohl der Server die ganze Zeit gesund war.
// Jetzt: kurze Aussetzer (< 90 s) gelb „Verbindung wird neu aufgebaut …“, erst danach rot — mit Grund.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { describeServer, SERVER_GRACE_MS } from "../src/hooks/useHealth";
import { renderWithClient } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("describeServer (rein)", () => {
  const now = 1_000_000;
  it("gesund → grün", () => {
    expect(describeServer({ ok: true, lastOkAt: now, failingSince: null, failure: null, now, viaLocalTunnel: true }).tone).toBe("ok");
  });
  it("kurzer Aussetzer (Tunnel weg, 5 s) → gelb, nicht rot", () => {
    const d = describeServer({ ok: false, lastOkAt: now - 5_000, failingSince: now - 5_000, failure: "network", now, viaLocalTunnel: true });
    expect(d.tone).toBe("wait");
    expect(d.text).toBe("Verbindung wird neu aufgebaut …");
  });
  it("auch Server-Fehler (502) in den ersten 90 s nur gelb", () => {
    expect(describeServer({ ok: false, lastOkAt: now - 60_000, failingSince: now - 60_000, failure: "http", now, viaLocalTunnel: false }).tone).toBe("wait");
  });
  it("länger als 90 s ohne Netz über den lokalen Tunnel → rot, Grund: Brücke/Tunnel", () => {
    const d = describeServer({ ok: false, lastOkAt: now - SERVER_GRACE_MS - 1, failingSince: now - SERVER_GRACE_MS - 1, failure: "network", now, viaLocalTunnel: true });
    expect(d.tone).toBe("bad");
    expect(d.detail).toMatch(/Brücke|Tunnel/);
  });
  it("länger als 90 s, Server antwortet mit Fehler → rot, Grund: Server antwortet nicht richtig", () => {
    const d = describeServer({ ok: false, lastOkAt: now - 120_000, failingSince: now - 120_000, failure: "http", now, viaLocalTunnel: true });
    expect(d.tone).toBe("bad");
    expect(d.text).toBe("Server antwortet nicht");
  });
  it("noch nie eine Antwort → prüfe …", () => {
    expect(describeServer({ ok: null, lastOkAt: null, failingSince: null, failure: null, now, viaLocalTunnel: true }).tone).toBe("unknown");
  });
});

describe("ConnectionStatus – kurzer Aussetzer", () => {
  it("erster fehlgeschlagener Abruf nach Start zeigt gelb „Verbindung wird neu aufgebaut …“, nie rot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/status") return Promise.resolve(new Response(JSON.stringify({ authenticated: true, csrf: "c", hasPasskey: true, authReads: true })));
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    renderWithClient(<ConnectionStatus />);
    await screen.findByText("Verbindung wird neu aufgebaut …");
    expect(screen.queryByText("Server nicht erreichbar")).toBeNull();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });
});
