// „Nyx kann nicht mehr antworten“: Der Browser verwarf `nyx.ui` still (Hintergrund-Fenster) bzw.
// schluckte Fehler – Nyx wartete 12 s ins Leere. Jetzt: sofortige Bestätigung, Hintergrund-Ausführung auf Zuruf,
// jeder Fehler wird zur Antwort.
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_NOTE, createUiRemote, type UiRemoteDeps } from "../src/features/nyx/uiRemote";

function setup(over: Partial<UiRemoteDeps> = {}) {
  const posts: Record<string, unknown>[] = [];
  const deps: UiRemoteDeps = {
    tabId: "tab-a",
    visible: () => true,
    route: () => "/briefing",
    post: (b) => posts.push(b),
    run: vi.fn(async () => ({ ok: true, route: "/sessions" })),
    ...over,
  };
  return { posts, deps, remote: createUiRemote(deps) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("nyx.ui im Browser", () => {
  it("sichtbar: bestätigt sofort und liefert das Ergebnis", async () => {
    const { posts, deps, remote } = setup();
    remote.handle({ type: "nyx.ui", requestId: "req-00000001", action: "navigate", route: "/sessions" });
    await flush();
    expect(posts[0]).toEqual({ type: "nyx.ui.ack", requestId: "req-00000001", tabId: "tab-a", visible: true, route: "/briefing" });
    expect(posts[1]).toMatchObject({ requestId: "req-00000001", type: "nyx.ui.result", ok: true, route: "/sessions" });
    expect(deps.run).toHaveBeenCalledWith([{ action: "navigate", route: "/sessions" }], { background: false });
  });

  it("Fehler beim Ausführen → ehrliche Antwort statt Schweigen", async () => {
    const { posts, remote } = setup({ run: () => Promise.reject(new Error("kaputt")) });
    remote.handle({ type: "nyx.ui", requestId: "req-00000002", action: "click", target: "item:session" });
    await flush();
    expect(posts[1]).toMatchObject({ type: "nyx.ui.result", ok: false, detail: "Fehler im Browser: kaputt" });
  });

  it("auch ein synchron werfender Lauf wird zur Antwort", async () => {
    const { posts, remote } = setup({
      run: () => {
        throw new TypeError("weg");
      },
    });
    remote.handle({ type: "nyx.ui", requestId: "req-00000003", action: "read_screen" });
    await flush();
    expect(posts[1]).toMatchObject({ ok: false, detail: "Fehler im Browser: weg" });
  });

  it("Hintergrund: nur bestätigen, erst auf `nyx.ui.run` für DIESES Fenster ausführen (ohne Animation)", async () => {
    const { posts, deps, remote } = setup({ visible: () => false });
    remote.handle({ type: "nyx.ui", requestId: "req-00000004", action: "navigate", route: "/sessions" });
    await flush();
    expect(posts).toEqual([{ type: "nyx.ui.ack", requestId: "req-00000004", tabId: "tab-a", visible: false, route: "/briefing" }]);
    expect(deps.run).not.toHaveBeenCalled();
    remote.handle({ type: "nyx.ui.run", requestId: "req-00000004", tabId: "anderes-fenster" });
    await flush();
    expect(deps.run).not.toHaveBeenCalled();
    remote.handle({ type: "nyx.ui.run", requestId: "req-00000004", tabId: "tab-a" });
    await flush();
    expect(deps.run).toHaveBeenCalledWith([{ action: "navigate", route: "/sessions" }], { background: true });
    expect(posts[1]).toMatchObject({ type: "nyx.ui.result", ok: true, detail: BACKGROUND_NOTE });
    // Ein zweites `run` führt nicht doppelt aus.
    remote.handle({ type: "nyx.ui.run", requestId: "req-00000004", tabId: "tab-a" });
    await flush();
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("unbekannter Befehl: sichtbar ehrlich ablehnen", async () => {
    const { posts, remote } = setup();
    remote.handle({ type: "nyx.ui", requestId: "req-00000005", action: "sprengen" });
    await flush();
    expect(posts[1]).toMatchObject({ type: "nyx.ui.result", ok: false });
  });
});
