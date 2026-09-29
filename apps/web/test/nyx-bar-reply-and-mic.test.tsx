// Begleiter und Nyx-Tab teilen sich das Mikrofon nicht, und das Mikrofon geht nie ohne
// Zutun des Nutzers auf.
import { act, waitFor } from "@testing-library/react";
import { emitNyxLive } from "../src/lib/liveBus";
import { NyxUiRouteSchema } from "@nyxos/shared";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANION_KEY, COMPANION_SCHEMA } from "../src/features/nyx/companionSettings";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { executeNyxUi, isRiskyElement, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";
import { renderWithClient } from "./helpers";

function cursor(): NyxCursorDriver {
  return { flyTo: vi.fn(async () => undefined), press: vi.fn(async () => undefined), glow: vi.fn() };
}
function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

// ───────────── Antwort auf `nyx.ui` nur über den angemeldeten Weg (POST + Schutz), nie über `/live` ─────────────
describe("Nyx-Leiste: Antwort auf nyx.ui", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("antwortet per POST /api/nyx/ui/reply (Anmeldung + Schutz), nicht über den Live-Kanal", async () => {
    localStorage.setItem(COMPANION_KEY, JSON.stringify({ enabled: true, listening: false, speak: false, side: "right", y: 24 }));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/auth/status") return new Response(JSON.stringify({ signedIn: true, csrf: "x" }), { status: 200 });
      if (url === "/api/nyx/ui/reply") return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithClient(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="*" element={<button data-nyx="nav:git">Git</button>} />
        </Routes>
        <HaikuRoot />
      </MemoryRouter>,
    );
    act(() => emitNyxLive({ type: "nyx.ui", requestId: "req-post-000001", action: "focus", target: "nav:git" }));
    // Erst die Empfangsbestätigung, dann das Ergebnis – beides über den angemeldeten Weg.
    const replies = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/nyx/ui/reply").map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
    await waitFor(() => expect(replies().some((b) => b.type === "nyx.ui.result")).toBe(true), { timeout: 4000 });
    expect(replies()[0]).toMatchObject({ type: "nyx.ui.ack", requestId: "req-post-000001", visible: true });
    expect(replies().find((b) => b.type === "nyx.ui.result")).toMatchObject({ requestId: "req-post-000001", ok: true });
  });
});

// ───────────── Ausführer: riskante Ziele auch über Umwege nie auslösen ─────────────
describe("Ausführer: riskant über Umwege", () => {
  it("Kind mit data-nyx in einem Löschen-Knopf ist riskant (Klick würde hochblubbern)", () => {
    const root = mount(`<button>Session löschen <span data-nyx="x-icon">×</span></button>`);
    expect(isRiskyElement(root.querySelector('[data-nyx="x-icon"]') as HTMLElement)).toBe(true);
    root.remove();
  });

  it("aria-label harmlos, sichtbarer Text riskant → riskant", () => {
    const root = mount(`<button data-nyx="k" aria-label="Weiter">Deploy starten</button>`);
    expect(isRiskyElement(root.querySelector("button") as HTMLElement)).toBe(true);
    root.remove();
  });

  it("Senden, Antworten, Archivieren und Schicken sind erlaubt; Übernehmen (beendet ggf. einen fremden Prozess) bleibt riskant", () => {
    const root = mount(
      `<button data-nyx="a">Senden</button><button data-nyx="b">Antworten</button><button data-nyx="c">Archivieren</button><button data-nyx="d">Änderung schicken</button><button data-nyx="e">Übernehmen</button>`,
    );
    for (const id of ["a", "b", "c", "d"]) expect(isRiskyElement(root.querySelector(`[data-nyx="${id}"]`) as HTMLElement), id).toBe(false);
    expect(isRiskyElement(root.querySelector('[data-nyx="e"]') as HTMLElement)).toBe(true);
    root.remove();
  });

  it("Antworten auf einer Entscheidungs-Karte bleiben gesperrt (data-nyx-risk)", () => {
    const root = mount(`<article data-nyx-risk><button data-nyx="ja">Antworten</button></article>`);
    expect(isRiskyElement(root.querySelector('[data-nyx="ja"]') as HTMLElement)).toBe(true);
    root.remove();
  });

  it("type in ein riskantes Feld tippt nichts", async () => {
    const root = mount(`<form data-nyx-risk><textarea data-nyx="chat-eingabe"></textarea></form>`);
    const r = await executeNyxUi({ action: "type", target: "chat-eingabe", text: "alles verwerfen" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/x", typeDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, risky: true });
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    root.remove();
  });

  it("Route mit Backslash (fremde Adresse) wird abgelehnt", () => {
    expect(NyxUiRouteSchema.safeParse("/\\evil.com").success).toBe(false);
    expect(NyxUiRouteSchema.safeParse("//evil.com").success).toBe(false);
    expect(NyxUiRouteSchema.safeParse("/sessions?x=1").success).toBe(true);
  });
});

function renderBar(path: string) {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<div />} />
      </Routes>
      <HaikuRoot />
    </MemoryRouter>,
  );
}

describe("Nyx-Leiste: Mikrofon (Dauer-Zuhören)", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    getUserMedia = vi.fn(async () => {
      throw new DOMException("nein", "NotAllowedError");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal(
      "MediaRecorder",
      Object.assign(function MediaRecorder() {}, {
        isTypeSupported: () => true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("öffnet beim ersten Besuch (nichts gemerkt) kein Mikrofon von selbst", async () => {
    renderBar("/overview");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("hört im Nyx-Tab nicht mit – dort hat der Tab das Mikrofon (keine doppelte Antwort)", async () => {
    localStorage.setItem(
      COMPANION_KEY,
      JSON.stringify({
        enabled: true,
        listening: true,
        speak: true,
        side: "right",
        y: 24,
      }),
    );
    renderBar("/nyx");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("mit gemerktem (bewusst in den Einstellungen eingeschaltetem) Zuhören auf einer normalen Seite: Mikrofon geht auf", async () => {
    localStorage.setItem(
      COMPANION_KEY,
      JSON.stringify({
        schema: COMPANION_SCHEMA,
        enabled: true,
        listening: true,
        speak: true,
        side: "right",
        y: 24,
      }),
    );
    renderBar("/overview");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
