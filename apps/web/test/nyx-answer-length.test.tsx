// Antwort-Länge: Nyx wählt die Länge selbst oder nach Vorgabe – Längen-Wähler (Auto · Kurz · Normal · Ausführlich) direkt an der Eingabe im Nyx-Tab-Chat und im
// Nyx-Feld. Die Wahl wird gemerkt und geht mit JEDER Anfrage mit (Feld `length`), auch gesprochen.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_LENGTH_KEY, readAnswerLength, saveAnswerLength } from "../src/features/haiku/answerLength";
import { streamHaikuChat } from "../src/features/haiku/haikuApi";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

let chatBodies: Record<string, unknown>[] = [];

function ndjson(lines: unknown[]): Promise<Response> {
  return Promise.resolve(
    new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  chatBodies = [];
  __primeAuthForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/haiku/chat")) {
        chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return ndjson([
          { type: "thread", threadId: 42 },
          {
            type: "done",
            messageId: 7,
            text: "Ok.",
            sources: [],
            estimate: false,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              costUsd: 0,
              durationMs: 1,
            },
          },
        ]);
      }
      if (url === "/api/haiku/status")
        return jsonResponse({
          settings: {
            engine: "claude-cli",
            dailyBudgetUsd: 2,
            briefingTime: "07:00",
            recapTime: "21:30",
            rundgangMinutes: 15,
            timeoutSeconds: 90,
            ideaLinkBudgetPercent: 20,
            ideaLinkIdeasPerLinkDay: 10,
            ideaLinkIdeasPerDay: 30,
          },
          engine: {
            kind: "claude-cli",
            state: "ready",
            available: true,
            reason: null,
            model: "haiku",
          },
          reserve: { configured: false, baseUrl: null, model: null },
          today: {
            day: "2026-09-26",
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            budgetUsd: 2,
          },
          queue: { running: 0, waiting: 0 },
          lastRundgang: null,
        });
      if (url === "/api/haiku/threads") return jsonResponse({ threads: [] });
      if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url.startsWith("/api/nyx/live"))
        return jsonResponse({
          state: { state: "idle", at: new Date(0).toISOString() },
          tasks: [],
        });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      return jsonResponse({}, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Antwort-Länge: gemerkte Wahl", () => {
  it("Standard ist „auto“; gespeichert wird im Browser, Unsinn zählt als „auto“", () => {
    expect(readAnswerLength()).toBe("auto");
    saveAnswerLength("ausfuehrlich");
    expect(localStorage.getItem(ANSWER_LENGTH_KEY)).toBe("ausfuehrlich");
    expect(readAnswerLength()).toBe("ausfuehrlich");
    localStorage.setItem(ANSWER_LENGTH_KEY, "riesig");
    expect(readAnswerLength()).toBe("auto");
  });

  it("gesperrter Speicher (privates Fenster): kein Absturz, die Wahl gilt bis zum Neuladen", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blockiert");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blockiert");
    });
    expect(() => saveAnswerLength("kurz")).not.toThrow();
    expect(readAnswerLength()).toBe("kurz");
    get.mockRestore();
    set.mockRestore();
  });

  it("jede Chat-Anfrage (auch gesprochen) trägt die Wahl mit", async () => {
    saveAnswerLength("normal");
    await streamHaikuChat(
      {
        message: "Hi",
        context: { path: "/", filters: {} },
        channel: "voice",
      } as never,
      () => undefined,
    );
    expect(chatBodies.at(-1)).toMatchObject({
      channel: "voice",
      length: "normal",
    });
  });
});

describe("Antwort-Länge: Knöpfe an der Eingabe", () => {
  it("Nyx-Tab-Chat: Segment mit vier Knöpfen, „Auto“ ist gewählt; „Ausführlich“ wird gemerkt und mitgeschickt", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <NyxTab />
      </MemoryRouter>,
    );
    const group = await screen.findByRole("radiogroup", {
      name: "Antwort-Länge",
    });
    const opts = within(group).getAllByRole("radio");
    expect(opts.map((o) => o.textContent)).toEqual(["Auto", "Kurz", "Normal", "Ausführlich"]);
    expect(within(group).getByRole("radio", { name: /Auto/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(group).getByRole("radio", { name: /Ausführlich/ }));
    expect(within(group).getByRole("radio", { name: /Ausführlich/ })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(ANSWER_LENGTH_KEY)).toBe("ausfuehrlich");
    const input = screen.getByLabelText("Nachricht an Nyx");
    fireEvent.change(input, { target: { value: "Erklär mir den Build" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(chatBodies[0]).toMatchObject({
        message: "Erklär mir den Build",
        channel: "web",
        length: "ausfuehrlich",
      }),
    );
  });

  it("Nyx-Feld (Zentrum): derselbe Wähler, dieselbe gemerkte Wahl", async () => {
    saveAnswerLength("kurz");
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <HaikuRoot />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /^Nyx/ }));
    const panel = await screen.findByRole("dialog", { name: "Nyx" });
    const group = await within(panel).findByRole("radiogroup", {
      name: "Antwort-Länge",
    });
    expect(within(group).getByRole("radio", { name: /Kurz/ })).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: /Normal/ }));
    });
    expect(readAnswerLength()).toBe("normal");
  });
});
