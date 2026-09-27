// Temporäre Sessions: „Behalten“ und „Zurückholen“ müssen in der Oberfläche erreichbar sein. Ohne Knopf
// (nur über die API) – eine fälschlich automatisch markierte Session verschwand nach 6 h ohne Ausweg.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoPanel } from "../src/components/sessions/InfoPanel";
import { TemporarySettingsPanel } from "../src/features/temporary/TemporarySettingsPanel";
import type { Session, SessionDetail } from "../src/lib/api";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function session(over: Partial<Session>): Session {
  return {
    id: "claude:x",
    tool: "claude",
    sessionId: "x",
    machineId: null,
    parentId: null,
    title: "Recherche Bar-Systeme",
    titleSource: null,
    status: "ended",
    cwd: "/Users/dev/project",
    gitBranch: null,
    cliVersion: null,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    models: ["claude-haiku-4-5-20251001"],
    tokens: {},
    tokensTotal: 0,
    toolCalls: {},
    subagents: [],
    limits: null,
    parsedEventCount: 0,
    eventCount: 0,
    parseErrors: 0,
    state: null,
    closedAt: null,
    closedBy: null,
    categoryRuleId: null,
    categoryManual: false,
    art: "recherche",
    baustelle: null,
    reason: [],
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    temporarySince: null,
    temporaryReason: null,
    temporaryExpiresAt: null,
    archivedAt: null,
    ...over,
  } as Session;
}

/** Fängt POST /api/sessions/:id/temporary ab; alles andere liefert leere Antworten. */
function stubWrites(extra: (url: string) => Response | null = () => null) {
  __primeAuthForTests();
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/temporary")) {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return jsonResponse({ id: "claude:x", temporary: false });
      }
      const e = extra(url);
      if (e) return Promise.resolve(e);
      if (url === "/api/temporary/settings") return jsonResponse({ hours: 6 });
      return Promise.reject(new Error(`nicht gestubbt: ${url}`));
    }),
  );
  return posts;
}

const detail = (s: Session): SessionDetail => ({ session: s, files: [], archive: [], events: [] });

describe("Session-Infos: Behalten / Zurückholen", () => {
  it("temporäre Session: Hinweis mit Restzeit und Knopf „Behalten“ (schickt temporary: false)", async () => {
    const posts = stubWrites();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <InfoPanel detail={detail(session({ temporarySince: new Date().toISOString(), temporaryReason: "haiku_run", temporaryExpiresAt: inHours(4.1) }))} />
      </MemoryRouter>,
    );
    const box = screen.getByRole("region", { name: /Temporär/ });
    expect(box).toHaveTextContent(/4 Std/);
    await user.click(within(box).getByRole("button", { name: "Behalten" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/sessions/claude%3Ax/temporary", body: { temporary: false } }]));
  });

  it("archivierte Session: Knopf „Zurückholen“", async () => {
    const posts = stubWrites();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <InfoPanel detail={detail(session({ temporarySince: new Date().toISOString(), temporaryReason: "selftest", archivedAt: new Date().toISOString() }))} />
      </MemoryRouter>,
    );
    const box = screen.getByRole("region", { name: /Archiv/ });
    await user.click(within(box).getByRole("button", { name: "Zurückholen" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ temporary: false });
  });

  it("normale Session: kein Hinweis, kein Knopf", () => {
    stubWrites();
    renderWithClient(
      <MemoryRouter>
        <InfoPanel detail={detail(session({}))} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: /Behalten|Zurückholen/ })).not.toBeInTheDocument();
  });
});

describe("Einstellungen: das Archiv ist sichtbar", () => {
  it("listet archivierte Sessions mit Link und „Zurückholen“", async () => {
    const posts = stubWrites((url) =>
      url === "/api/temporary/archive"
        ? new Response(
            JSON.stringify({
              sessions: [
                { id: "claude:x", sessionId: "x", tool: "claude", title: "Antworte nur mit OK.", href: "/sessions/coding/_/x", temporaryReason: "selftest", archivedAt: new Date().toISOString(), lastActivityAt: null },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          )
        : null,
    );
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <TemporarySettingsPanel />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: /Im Archiv/ });
    expect(within(list).getByRole("link", { name: /Antworte nur mit OK\./ })).toHaveAttribute("href", "/sessions/coding/_/x");
    await user.click(within(list).getByRole("button", { name: /Zurückholen/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});
