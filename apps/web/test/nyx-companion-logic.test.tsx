// Nyx-Begleiter: reine Logik zuerst (rot → grün).
// Ausführer (Ziel finden, riskant nie klicken), VAD-Schwelle, lokale Befehle, Satz-Zerleger.
import { describe, expect, it, vi } from "vitest";
import { executeNyxUi, findNyxTarget, isRiskyElement, readScreen, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";
import { parseLocalCommand } from "../src/features/nyx/localCommands";
import { createVadGate } from "../src/features/nyx/voice/vadGate";
import { createSentenceChunker } from "../src/features/nyx/voice/chunker";
import { holdFor, isEcho } from "../src/features/nyx/voice/turn";

// ───────────── VAD (Stille-Erkennung) ─────────────

describe("VAD-Schwelle", () => {
  function feed(gate: ReturnType<typeof createVadGate>, energy: number, fromMs: number, ms: number) {
    const events: { e: string; t: number }[] = [];
    for (let t = fromMs; t < fromMs + ms; t += 16) {
      const e = gate.push(energy, t);
      if (e) events.push({ e, t });
    }
    return events;
  }

  it("Rauschen allein löst nie aus; Schwelle liegt über dem Boden", () => {
    const g = createVadGate();
    expect(feed(g, 0.004, 0, 3000)).toEqual([]);
    const m = g.meter();
    expect(m.threshold).toBeGreaterThan(m.floor * 2);
  });

  // Bestätigung erst nach ~350 ms statt 110 ms.
  it("Sprache: erst Vorlauf (arm), nach ~350 ms bestätigt (start), nach Stille Ende (end)", () => {
    const g = createVadGate();
    feed(g, 0.004, 0, 2000);
    const speech = feed(g, 0.08, 2000, 1000);
    expect(speech[0]?.e).toBe("arm");
    const start = speech.find((x) => x.e === "start");
    expect(start).toBeDefined();
    expect((start?.t ?? 0) - 2000).toBeGreaterThanOrEqual(340);
    expect((start?.t ?? 0) - 2000).toBeLessThan(450);
    const tail = feed(g, 0.004, 3000, 1200);
    const end = tail.find((x) => x.e === "end");
    expect(end).toBeDefined();
    expect((end?.t ?? 0) - 3000).toBeGreaterThanOrEqual(600);
  });

  it("kurzer Knall (< 350 ms) wird verworfen", () => {
    const g = createVadGate();
    feed(g, 0.004, 0, 2000);
    const ev = [...feed(g, 0.1, 2000, 240), ...feed(g, 0.004, 2240, 500)].map((x) => x.e);
    expect(ev).toEqual(["arm", "discard"]);
  });

  it("während Nyx spricht (Guard) braucht es deutlich mehr Pegel", () => {
    const a = createVadGate();
    const b = createVadGate();
    feed(a, 0.004, 0, 2000);
    feed(b, 0.004, 0, 2000);
    b.setGuard(true);
    expect(feed(a, 0.025, 2000, 500).map((x) => x.e)).toContain("start");
    expect(feed(b, 0.025, 2000, 500).map((x) => x.e)).not.toContain("start");
  });
});

// ───────────── Ausführer (nyx.ui im Browser) ─────────────

function cursor(): NyxCursorDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    flyTo: vi.fn(async () => void calls.push("fly")),
    press: vi.fn(async () => void calls.push("press")),
    glow: vi.fn(() => void calls.push("glow")),
  };
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("Ausführer: Ziel finden", () => {
  it("per data-nyx, per Präfix (*) und per sichtbarer Beschriftung", () => {
    const root = mount(`
      <nav><a href="/git" data-nyx="nav:git">Git</a></nav>
      <button data-nyx="recent-item:claude:a">Erste</button>
      <button data-nyx="recent-item:claude:b">Zweite</button>
      <button aria-label="Zuletzt geöffnet"><svg></svg></button>
      <button hidden data-nyx="versteckt">Versteckt</button>`);
    expect(findNyxTarget("nav:git", root)?.textContent).toBe("Git");
    expect(findNyxTarget("recent-item:*", root)?.textContent).toBe("Erste");
    expect(findNyxTarget("zuletzt geöffnet", root)?.getAttribute("aria-label")).toBe("Zuletzt geöffnet");
    expect(findNyxTarget("Git", root)?.getAttribute("data-nyx")).toBe("nav:git");
    expect(findNyxTarget("versteckt", root)).toBeNull();
    expect(findNyxTarget("gibt es nicht", root)).toBeNull();
    root.remove();
  });

  it("riskant: data-nyx-risk am Element oder Vorfahren, oder riskante Beschriftung", () => {
    const root = mount(`
      <div data-nyx-risk><button data-nyx="a">OK</button></div>
      <button data-nyx="b">Session löschen</button>
      <button data-nyx="c">Öffnen</button>`);
    expect(isRiskyElement(root.querySelector('[data-nyx="a"]') as HTMLElement)).toBe(true);
    expect(isRiskyElement(root.querySelector('[data-nyx="b"]') as HTMLElement)).toBe(true);
    expect(isRiskyElement(root.querySelector('[data-nyx="c"]') as HTMLElement)).toBe(false);
    root.remove();
  });
});

describe("Ausführer: Befehle", () => {
  it("click: Cursor fliegt hin, drückt, klickt", async () => {
    const root = mount(`<button data-nyx="go">Los</button>`);
    const onClick = vi.fn();
    root.querySelector("button")?.addEventListener("click", onClick);
    const c = cursor();
    const r = await executeNyxUi({ action: "click", target: "go" }, { navigate: vi.fn(), cursor: c, root, route: () => "/x" });
    expect(r).toMatchObject({ ok: true });
    expect(onClick).toHaveBeenCalledTimes(1);
    // Nach dem Klick leuchtet das Ziel kurz auf
    expect(c.calls).toEqual(["fly", "press", "glow"]);
    root.remove();
  });

  it("riskantes Ziel wird NIE geklickt – nur gezeigt (Glow)", async () => {
    const root = mount(`<button data-nyx="del" data-nyx-risk>Endgültig schließen</button><button data-nyx="del2">Session löschen</button>`);
    const onClick = vi.fn();
    for (const b of root.querySelectorAll("button")) b.addEventListener("click", onClick);
    const c = cursor();
    const r1 = await executeNyxUi({ action: "click", target: "del" }, { navigate: vi.fn(), cursor: c, root, route: () => "/x" });
    const r2 = await executeNyxUi({ action: "click", target: "del2" }, { navigate: vi.fn(), cursor: c, root, route: () => "/x" });
    const r3 = await executeNyxUi({ action: "focus", target: "del2" }, { navigate: vi.fn(), cursor: c, root, route: () => "/x" });
    expect(onClick).not.toHaveBeenCalled();
    for (const r of [r1, r2]) expect(r).toMatchObject({ ok: false, risky: true });
    expect(r3).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x === "glow").length).toBeGreaterThanOrEqual(2);
    expect(c.calls).not.toContain("press");
    root.remove();
  });

  it("Ziel fehlt → ehrliche Antwort, kein Klick", async () => {
    const root = mount(`<button>Etwas</button>`);
    const r = await executeNyxUi({ action: "click", target: "nav:git" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/x", waitMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/nicht zu sehen/);
    root.remove();
  });

  it("type: tippt in das Feld und löst input-Ereignisse aus", async () => {
    const root = mount(`<input data-nyx="suche" />`);
    const input = root.querySelector("input") as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const r = await executeNyxUi({ action: "type", target: "suche", text: "Heat" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/x", typeDelayMs: 0 });
    expect(r.ok).toBe(true);
    expect(input.value).toBe("Heat");
    expect(onInput).toHaveBeenCalled();
    root.remove();
  });

  it("navigate ruft den Router", async () => {
    const navigate = vi.fn();
    const r = await executeNyxUi({ action: "navigate", route: "/git" }, { navigate, cursor: cursor(), root: document.body, route: () => "/git" });
    expect(navigate).toHaveBeenCalledWith("/git");
    expect(r).toMatchObject({ ok: true, route: "/git" });
  });

  it("read_screen: Route, Titel und sichtbare data-nyx-Elemente mit Risiko", () => {
    const root = mount(`
      <a data-nyx="nav:git" href="/git">Git</a>
      <button data-nyx="close" data-nyx-risk>Schließen</button>
      <button data-nyx="weg" style="display:none">Weg</button>
      <input data-nyx="suche" placeholder="Suchen" />`);
    const s = readScreen(root, "/sessions");
    expect(s.route).toBe("/sessions");
    expect(s.elements).toEqual([
      { id: "nav:git", label: "Git", kind: "link", risk: false },
      { id: "close", label: "Schließen", kind: "button", risk: true },
      { id: "suche", label: "Suchen", kind: "input", risk: false },
    ]);
    root.remove();
  });
});

// ───────────── Schneller lokaler Pfad ─────────────

describe("lokale Sprachbefehle", () => {
  const nav = [
    { id: "ses", label: "Sessions", path: "/sessions" },
    { id: "git", label: "Git", path: "/git" },
    { id: "settings", label: "Einstellungen", path: "/settings" },
  ];

  it("„Öffne die zuletzt geöffnete Session“ → Sessions, Zuletzt geöffnet, erster Eintrag", () => {
    const p = parseLocalCommand("Öffne die zuletzt geöffnete Session.", { path: "/git", nav });
    expect(p?.steps).toEqual([
      { action: "click", target: "nav:ses" },
      { action: "click", target: "recent" },
      { action: "click", target: "recent-item:*" },
    ]);
    // schon auf Sessions: kein Umweg über die Leiste.
    expect(parseLocalCommand("öffne vorige session", { path: "/sessions/x/y", nav })?.steps[0]).toEqual({ action: "click", target: "recent" });
  });

  it("„zeig Git“ / „öffne die Einstellungen“ → Klick in der Leiste", () => {
    expect(parseLocalCommand("zeig git", { path: "/", nav })?.steps).toEqual([{ action: "click", target: "nav:git" }]);
    expect(parseLocalCommand("Öffne die Einstellungen", { path: "/", nav })?.steps).toEqual([{ action: "click", target: "nav:settings" }]);
  });

  it("„zurück“ → zurück; alles andere geht ans Modell", () => {
    expect(parseLocalCommand("zurück", { path: "/", nav })).toMatchObject({ back: true });
    expect(parseLocalCommand("Wie viele Sessions laufen gerade?", { path: "/", nav })).toBeNull();
    expect(parseLocalCommand("öffne bitte den Bericht von gestern und fasse ihn zusammen", { path: "/", nav })).toBeNull();
  });
});

// ───────────── Sprechen: Sätze, Turn-Ende, Echo ─────────────

describe("Satz-Zerleger (Sprachausgabe)", () => {
  it("gibt fertige Sätze sofort heraus, Abkürzungen/Daten sind kein Satzende", () => {
    const out: string[] = [];
    const c = createSentenceChunker((s) => out.push(s));
    c.push("Hallo Alex. Das ist z. B. ein Test am 25.09. um 18 Uhr");
    expect(out).toEqual(["Hallo Alex."]);
    c.push(". Fertig! ");
    expect(out).toEqual(["Hallo Alex.", "Das ist z. B. ein Test am 25.09. um 18 Uhr.", "Fertig!"]);
    c.push("Rest ohne Punkt");
    c.end();
    expect(out.at(-1)).toBe("Rest ohne Punkt");
  });

  it("entfernt Markdown und Links vor dem Sprechen", () => {
    const out: string[] = [];
    const c = createSentenceChunker((s) => out.push(s));
    c.push("**Fertig**: siehe [Git](/git) und https://x.de/a. ");
    expect(out).toEqual(["Fertig: siehe Git und."]);
  });
});

describe("Turn-Ende und Echo", () => {
  it("unfertiger Satz wartet länger, fertiger kaum", () => {
    expect(holdFor("Öffne die Sessions.")).toBe(0);
    expect(holdFor("Öffne die Sessions und")).toBeGreaterThan(1000);
    expect(holdFor("Öffne die Sessions")).toBeLessThan(500);
    expect(holdFor("stopp")).toBeLessThan(500);
  });

  it("Echo der eigenen Stimme wird erkannt, „Stopp“ kommt immer durch", () => {
    expect(isEcho("die Session läuft seit zehn Minuten", "Die Session läuft seit zehn Minuten.")).toBe(true);
    expect(isEcho("stopp", "Die Session läuft seit zehn Minuten.")).toBe(false);
    expect(isEcho("öffne den Git Tab", "Die Session läuft seit zehn Minuten.")).toBe(false);
  });
});
