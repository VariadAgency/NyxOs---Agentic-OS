// Menü „⋯“ an jedem Nyx-Faden – Löschen (Rückfrage im Tab, nie `confirm()`), Archivieren
// (+ Archiv-Ansicht, zurückholen), Zusammenfassen (Karte im Faden), Zu Auftrag machen (Link zur
// Aufgabe), In Obsidian ablegen (Ablageort bzw. ehrlicher Hinweis, wenn der Rechner fehlt).
import type { HaikuMessage, HaikuStatus, HaikuThread } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { LAST_THREAD_KEY } from "../src/features/haiku/useHaikuChat";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const STATUS: HaikuStatus = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const T7: HaikuThread = { id: 7, title: "Was wartet gerade?", topic: "sessions", day: "2026-09-25", updatedAt: ago(5), temporary: false, expiresAt: null, archivedAt: null };
const T2: HaikuThread = { id: 2, title: "Deploy-Plan für Freitag", topic: "server", day: "2026-09-24", updatedAt: ago(600), temporary: false, expiresAt: null, archivedAt: null };
const T9: HaikuThread = { id: 9, title: "Alter Faden im Archiv", topic: "server", day: "2026-09-20", updatedAt: ago(9000), temporary: false, expiresAt: null, archivedAt: ago(60) };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(opts: { obsidian?: { status: number; body: unknown } } = {}) {
  __primeAuthForTests();
  const calls: Call[] = [];
  let active = [T7, T2];
  let archived = [T9];
  const notes: Record<number, HaikuMessage[]> = {};
  const note = (id: number, noteKind: HaikuMessage["noteKind"], text: string, sources: HaikuMessage["sources"] = []): HaikuMessage => ({ id, role: "note", noteKind, text, sources, estimate: false, createdAt: ago(0) });
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/haiku/status") return jsonResponse(STATUS);
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
    if (url === "/api/context-guard/settings") return jsonResponse({ default: { hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: null }, haiku: null, models: [], sessions: [] });
    if (url === "/api/haiku/threads") return jsonResponse({ threads: active });
    if (url === "/api/haiku/threads?archived=1") return jsonResponse({ threads: archived });
    const m = /^\/api\/haiku\/threads\/(\d+)(?:\/(summary|task|obsidian))?$/.exec(url);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      if (method === "GET") {
        return jsonResponse({
          thread: [...active, ...archived].find((t) => t.id === id),
          messages: [
            { id: id * 10, role: "user", text: `Frage aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(10) },
            { id: id * 10 + 1, role: "assistant", text: `Antwort aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(9) },
            ...(notes[id] ?? []),
          ],
        });
      }
      if (method === "DELETE") {
        active = active.filter((t) => t.id !== id);
        archived = archived.filter((t) => t.id !== id);
        return jsonResponse({ deleted: id });
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { archived?: boolean };
        const t = [...active, ...archived].find((x) => x.id === id) as HaikuThread;
        if (body.archived) {
          active = active.filter((x) => x.id !== id);
          archived = [{ ...t, archivedAt: ago(0) }, ...archived];
        } else {
          archived = archived.filter((x) => x.id !== id);
          active = [{ ...t, archivedAt: null }, ...active];
        }
        return jsonResponse({ thread: { ...t, archivedAt: body.archived ? ago(0) : null } });
      }
      if (action === "summary") {
        const msg = note(id * 10 + 5, "summary", "- Deploy am Freitag\n- Vorher Backup");
        notes[id] = [...(notes[id] ?? []), msg];
        return jsonResponse({ message: msg });
      }
      if (action === "task") {
        const msg = note(id * 10 + 6, "task", "Als Aufgabe angelegt: „Deploy-Plan für Freitag“", [{ kind: "entry", id: "41", label: "Deploy-Plan für Freitag", href: "/tasks?e=41" }]);
        notes[id] = [...(notes[id] ?? []), msg];
        return jsonResponse({ entry: { id: 41, title: "Deploy-Plan für Freitag", href: "/tasks?e=41" }, message: msg }, { status: 201 });
      }
      if (action === "obsidian") {
        if (opts.obsidian) return jsonResponse(opts.obsidian.body, { status: opts.obsidian.status });
        const msg = note(id * 10 + 7, "obsidian", "In Obsidian abgelegt: `01 Sessions/Nyx/2026-09-24 Nyx – Deploy-Plan für Freitag.md`");
        notes[id] = [...(notes[id] ?? []), msg];
        return jsonResponse({ relPath: "01 Sessions/Nyx/2026-09-24 Nyx – Deploy-Plan für Freitag.md", message: msg });
      }
    }
    return Promise.reject(new Error(`unerwartet ${method} ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  renderWithClient(
    <MemoryRouter initialEntries={["/sessions"]}>
      <HaikuRoot />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: /^Nyx/ }));
  const panel = await screen.findByRole("dialog", { name: "Nyx" });
  await waitFor(() => expect(panel).toHaveAttribute("data-state", "open"));
  await within(panel).findByText(/Antwort aus Faden/);
  return panel;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: `Aktionen für „${title}“` }));
  return screen.findByRole("menu", { name: `Aktionen für „${title}“` });
}

describe("Menü „⋯“ an jedem Faden", () => {
  it("jeder Faden hat ein Menü mit allen fünf Aktionen", async () => {
    stub();
    const user = userEvent.setup();
    await openPanel(user);
    const menu = await openMenu(user, "Deploy-Plan für Freitag");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Zusammenfassen", "Zu Auftrag machen", "In Obsidian ablegen", "Archivieren", "Löschen …"]);
    expect(screen.getByRole("button", { name: "Aktionen für „Was wartet gerade?“" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("Löschen fragt im Tab nach (kein confirm); Abbrechen löscht nichts, Bestätigen löscht", async () => {
    const { calls } = stub();
    const confirmSpy = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "Löschen …" }));
    const ask = await screen.findByRole("alertdialog", { name: /„Deploy-Plan für Freitag“ löschen\?/ });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "Löschen …" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/haiku/threads/2"]));
    await waitFor(() => expect(within(panel).queryByText("Deploy-Plan für Freitag")).not.toBeInTheDocument());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("den offenen Faden löschen → Panel startet einen neuen Faden", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "7");
    stub();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Was wartet gerade?")).getByRole("menuitem", { name: "Löschen …" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(within(panel).queryByText("Antwort aus Faden 7")).not.toBeInTheDocument());
  });

  it("Archivieren nimmt den Faden aus der Liste; im Archiv lässt er sich zurückholen", async () => {
    const { calls } = stub();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "Archivieren" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "/api/haiku/threads/2", body: { archived: true } }));
    const list = within(panel).getByRole("list", { name: "Fäden" });
    await waitFor(() => expect(within(list).queryByText("Deploy-Plan für Freitag")).not.toBeInTheDocument());

    await user.click(within(panel).getByRole("button", { name: /Archiv/ }));
    const archive = await within(panel).findByRole("list", { name: "Archivierte Fäden" });
    expect(within(archive).getByText("Alter Faden im Archiv")).toBeInTheDocument();
    expect(within(archive).getByText("Deploy-Plan für Freitag")).toBeInTheDocument();
    const menu = await openMenu(user, "Alter Faden im Archiv");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toContain("Zurückholen");
    await user.click(within(menu).getByRole("menuitem", { name: "Zurückholen" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "/api/haiku/threads/9", body: { archived: false } }));
    await user.click(within(panel).getByRole("button", { name: "Zurück zu den Fäden" }));
    expect(await within(panel).findByText("Alter Faden im Archiv")).toBeInTheDocument();
  });

  it("Zusammenfassen: Karte „Zusammenfassung“ erscheint im Faden", async () => {
    const { calls } = stub();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "Zusammenfassen" }));
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/haiku/threads/2/summary" });
    const card = await within(panel).findByRole("note", { name: "Zusammenfassung" });
    expect(card).toHaveTextContent("Vorher Backup");
  });

  it("Zu Auftrag machen: Karte mit Link auf die neue Aufgabe", async () => {
    stub();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "Zu Auftrag machen" }));
    const card = await within(panel).findByRole("note", { name: "Aufgabe" });
    expect(within(card).getByRole("link", { name: /Deploy-Plan für Freitag/ })).toHaveAttribute("href", "/tasks?e=41");
  });

  it("In Obsidian ablegen: Ablageort sichtbar; ohne Mac ein verständlicher Hinweis", async () => {
    stub();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "In Obsidian ablegen" }));
    expect(await within(panel).findByRole("note", { name: "Obsidian" })).toHaveTextContent("01 Sessions/Nyx/");
  });

  it("In Obsidian ablegen ohne Mac: Hinweis vom Server, keine Technik", async () => {
    stub({ obsidian: { status: 503, body: { error: "Dein Mac ist gerade nicht verbunden. Sobald er wieder online ist, kannst du den Faden in Obsidian ablegen.", reason: "offline" } } });
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(within(await openMenu(user, "Deploy-Plan für Freitag")).getByRole("menuitem", { name: "In Obsidian ablegen" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Dein Mac ist gerade nicht verbunden");
    expect(alert.textContent).not.toMatch(/503|Server antwortet/);
  });
});
