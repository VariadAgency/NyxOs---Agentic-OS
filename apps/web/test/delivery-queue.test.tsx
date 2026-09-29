// Die Zustell-Warteschlange ist im Session-Chat sichtbar (wartet / abgelaufen) und zurückziehbar.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { SessionDeliveryView } from "@nyxos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryQueue } from "../src/features/session-chat/DeliveryQueue";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const now = Date.now();
const item = (over: Partial<SessionDeliveryView>): SessionDeliveryView => ({
  id: 1,
  kind: "approval",
  text: "Freigabe #3 erteilt: git push",
  status: "queued",
  reason: "Die Session arbeitet gerade – geht raus, sobald sie auf dich wartet.",
  attempts: 0,
  createdAt: new Date(now - 5 * 60_000).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(),
  doneAt: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("DeliveryQueue", () => {
  it("zeigt Wartendes mit Art + Text, ehrlich Abgelaufenes, und zieht auf Klick zurück", async () => {
    __primeAuthForTests();
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.startsWith("/api/deliveries/")) return jsonResponse({ cancelled: true });
        return jsonResponse({ deliveries: [item({}), item({ id: 2, kind: "compact", text: "/compact", status: "expired", doneAt: new Date(now - 60_000).toISOString(), reason: "Nicht zugestellt: Die Session hat in der Zeit nicht auf dich gewartet." })] });
      }),
    );
    renderWithClient(<DeliveryQueue sessionId="claude:s1" />);
    expect(await screen.findByText(/geht raus, sobald die Session auf dich wartet/)).toBeTruthy();
    expect(screen.getByText("Freigabe-Bescheid")).toBeTruthy();
    expect(screen.getByText(/Nicht zugestellt/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zurückziehen" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/deliveries/1" && c.method === "DELETE")).toBe(true));
  });

  it("„unterwegs“ ohne Zurückziehen; zu spätes Zurückziehen sagt ehrlich warum", async () => {
    __primeAuthForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/deliveries/")) return jsonResponse({ error: "Zu spät: Die Nachricht ist schon unterwegs, raus oder abgelaufen." }, { status: 409 });
        return jsonResponse({ deliveries: [item({}), item({ id: 3, kind: "inbox", text: "Ja, mach", status: "sending" })] });
      }),
    );
    renderWithClient(<DeliveryQueue sessionId="claude:s3" />);
    expect(await screen.findByText("Ja, mach")).toBeTruthy();
    expect(screen.getByText("wird gerade gesendet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Zurückziehen" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Zurückziehen" }));
    expect(await screen.findByText(/Zu spät/)).toBeTruthy();
  });

  it("leer → nichts anzeigen", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ deliveries: [] })));
    const { container } = renderWithClient(<DeliveryQueue sessionId="claude:s2" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-testid=delivery-queue]")).toBeNull();
  });
});
