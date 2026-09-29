// „Steuerung“ in den Session-Infos – Modell wechseln, Denkaufwand, Komprimieren (nur noch hier).
import { sessionControlsFor } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionControls } from "../src/features/session-controls/SessionControls";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient } from "./helpers";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "claude:s2",
    tool: "claude",
    sessionId: "s2",
    status: "running",
    state: "running",
    models: ["claude-opus-5-5"],
    lastUsageModel: "claude-opus-5-5",
    attachable: true,
    tmuxName: "zc-claude-abcd1234",
    contextPct: 71,
    ...over,
  } as Session;
}

function stub(s: Session, posts: { url: string; body: unknown }[], answer: (url: string) => unknown = () => ({ status: "queued", command: "", message: "Modellwechsel kommt, sobald die Session auf dich wartet." })) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse(answer(url));
      }
      if (url.endsWith("/controls")) return jsonResponse(sessionControlsFor(s.tool, s.lastUsageModel ?? s.models.at(-1) ?? null));
      if (url.startsWith("/api/context-guard/sessions/")) return jsonResponse({ sessionKey: s.id, thresholds: { hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: 80, source: "default" }, pct: 71, hint: true, forced: false, attachable: true, state: s.state });
      return jsonResponse({}, { status: 404 });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Steuerung in den Session-Infos", { timeout: 20_000 }, () => {
  it("Claude: aktuelles Modell lesbar, Liste nur Anthropic, Klick → POST { kind: model } und Status „sobald sie wartet“", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const s = session();
    stub(s, posts);
    renderWithClient(<SessionControls session={s} />);
    const box = await screen.findByTestId("session-controls");
    expect(await within(box).findByText("Opus 5.5")).toBeInTheDocument();
    await userEvent.click(within(box).getByRole("button", { name: "Wechseln" }));
    const list = within(box).getByRole("list", { name: "Mögliche Modelle" });
    const names = within(list)
      .getAllByRole("button")
      .map((b) => b.getAttribute("title"));
    expect(names.every((n) => n?.startsWith("claude-"))).toBe(true);
    expect(within(list).getByRole("button", { name: /^Opus 5\.5/ })).toBeDisabled(); // aktiv
    await userEvent.click(within(list).getByRole("button", { name: /^Sonnet 5 – / }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/sessions/claude%3As2/controls", body: { kind: "model", model: "claude-sonnet-5" } });
    expect(await within(box).findByRole("status")).toHaveTextContent("sobald die Session auf dich wartet");
  });

  it("Denkaufwand: Stufen des Modells; Haiku kennt keinen → keine Knöpfe, nur ein Satz", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const s = session();
    stub(s, posts, () => ({ status: "sent", command: "/effort max", message: "Denkaufwand ist unterwegs – der Verlauf zeigt es gleich." }));
    const view = renderWithClient(<SessionControls session={s} />);
    const group = await screen.findByRole("group", { name: "Denkaufwand" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Wenig", "Mittel", "Hoch", "Sehr hoch", "Maximal", "Automatisch"]);
    await userEvent.click(within(group).getByRole("button", { name: "Maximal" }));
    await waitFor(() => expect(posts[0]?.body).toEqual({ kind: "effort", level: "max" }));
    view.unmount();

    const h = session({ id: "claude:h", models: ["claude-haiku-4-5-20251001"], lastUsageModel: "claude-haiku-4-5-20251001" });
    stub(h, []);
    renderWithClient(<SessionControls session={h} />);
    expect(await screen.findByText(/kennt keinen einstellbaren Denkaufwand/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Denkaufwand" })).toBeNull();
  });

  it("Codex: kein Modell-/Stufen-Wechsel angeboten (geht nur im eigenen Menü), Komprimieren schon", async () => {
    const s = session({ id: "codex:c", tool: "codex", models: ["gpt-6-astra"], lastUsageModel: "gpt-6-astra" });
    stub(s, []);
    renderWithClient(<SessionControls session={s} />);
    const box = await screen.findByTestId("session-controls");
    expect(await within(box).findAllByText(/nur im eigenen Auswahlmenü/)).not.toHaveLength(0);
    expect(within(box).queryByRole("button", { name: "Wechseln" })).toBeNull();
    expect(within(box).queryByRole("group", { name: "Denkaufwand" })).toBeNull();
    expect(within(box).getByRole("button", { name: /Kontext komprimieren/ })).toBeEnabled();
  });

  it("Komprimieren: Knopf nutzt den Weg des Kontext-Wächters (wartet auf die Pause), mit Hinweis „empfohlen“", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const s = session();
    stub(s, posts, () => ({ sent: false, queued: true, reason: "Die Session arbeitet gerade – geht raus, sobald sie auf dich wartet." }));
    renderWithClient(<SessionControls session={s} />);
    const box = await screen.findByTestId("session-controls");
    expect(await within(box).findByText(/komprimieren empfohlen/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole("button", { name: /Kontext komprimieren/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/context-guard/sessions/claude%3As2/compact-now", body: {} });
    expect(await within(box).findByRole("status")).toHaveTextContent("sobald die Session auf dich wartet");
  });

  it("läuft nicht in NyxOS: alles gesperrt, mit Grund", async () => {
    const s = session({ attachable: false, tmuxName: null });
    stub(s, []);
    renderWithClient(<SessionControls session={s} />);
    const box = await screen.findByTestId("session-controls");
    expect(within(box).getByText(/übernimm sie zuerst/)).toBeInTheDocument();
    expect(await within(box).findByRole("button", { name: /Kontext komprimieren/ })).toBeDisabled();
    expect(within(box).getByRole("button", { name: "Wechseln" })).toBeDisabled();
  });
});
