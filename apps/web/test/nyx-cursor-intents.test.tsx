// Nyx-Cursor klickt wirklich: Leiste anklicken → auf die Seite warten → Seite scannen → Ziel anklicken.
// Rot zuerst: „Öffne die neueste Session“ muss über die Leiste gehen, auf die (verzögert geladene) Liste warten
// und dann die NEUESTE Session anklicken – nicht die erste im DOM und nicht nur den Router rufen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLocalCommand } from "../src/features/nyx/localCommands";
import { executeNyxUi, readScreen, type ExecDeps, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";

const nav = [
  { id: "ses", label: "Sessions", path: "/sessions" },
  { id: "task", label: "Aufgaben", path: "/tasks" },
  { id: "inbox", label: "Entscheidungen", path: "/inbox" },
  { id: "git", label: "Git", path: "/git" },
];

function cursor(): NyxCursorDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    flyTo: vi.fn(async () => void calls.push("fly")),
    press: vi.fn(async () => void calls.push("press")),
    glow: vi.fn(() => void calls.push("glow")),
  };
}

/** Kleine „App“: Leiste mit echten Links; ein Klick auf „Sessions“ lädt die Liste erst nach 80 ms (wie ein Abruf). */
function app() {
  const root = document.createElement("div");
  root.innerHTML = `
    <nav>
      <a href="/sessions" data-nyx="nav:ses">Sessions</a>
      <a href="/tasks" data-nyx="nav:task">Aufgaben</a>
      <a href="/git" data-nyx="nav:git">Git</a>
    </nav>
    <main></main>`;
  document.body.appendChild(root);
  let route = "/git";
  const opened: string[] = [];
  const events: string[] = [];
  const main = root.querySelector("main") as HTMLElement;
  const render: Record<string, () => void> = {
    "/sessions": () => {
      main.innerHTML = `
        <button data-nyx-item="session" data-nyx-at="2026-09-20T10:00:00Z" data-id="alt">Alte Session</button>
        <button data-nyx-item="session" data-nyx-at="2026-09-26T09:00:00Z" data-id="neu">Neue Session</button>
        <button data-nyx-item="session" data-nyx-at="2026-09-24T09:00:00Z" data-id="mittel">Mittlere Session</button>`;
      for (const b of main.querySelectorAll("button")) b.addEventListener("click", () => opened.push(b.getAttribute("data-id") ?? ""));
    },
    "/tasks": () => {
      main.innerHTML = `
        <button data-nyx-item="task" data-nyx-at="2026-09-26T09:00:00Z" title="Login reparieren">Login reparieren</button>
        <button data-nyx-item="task" data-nyx-at="2026-09-20T09:00:00Z" title="Heatmap schneller machen">Heatmap schneller machen</button>`;
      for (const b of main.querySelectorAll("button")) b.addEventListener("click", () => opened.push(b.textContent ?? ""));
    },
    "/git": () => {
      main.innerHTML = "";
    },
  };
  for (const a of root.querySelectorAll("nav a")) {
    a.addEventListener("pointerdown", () => events.push("pointerdown"));
    a.addEventListener("mousedown", () => events.push("mousedown"));
    a.addEventListener("click", (e) => {
      e.preventDefault();
      events.push("click");
      route = a.getAttribute("href") ?? "/";
      main.innerHTML = "<p>Lädt …</p>";
      setTimeout(() => render[route]?.(), 80);
    });
  }
  const navigate = vi.fn((r: string) => {
    route = r;
  });
  const deps = (c: NyxCursorDriver): ExecDeps => ({ navigate, cursor: c, root, route: () => route, typeDelayMs: 0, waitMs: 1500 });
  return { root, opened, events, navigate, deps, route: () => route };
}

async function run(text: string, a: ReturnType<typeof app>, c = cursor()) {
  const plan = parseLocalCommand(text, { path: a.route(), nav });
  expect(plan, `„${text}“ muss lokal geplant werden`).not.toBeNull();
  let last = { ok: true } as Awaited<ReturnType<typeof executeNyxUi>>;
  for (const step of plan?.steps ?? []) {
    last = await executeNyxUi(step, a.deps(c));
    if (!last.ok) break;
  }
  return { plan, last, c };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("„Öffne die neueste Session“ Ende zu Ende", () => {
  it("klickt Sessions in der Leiste, wartet auf die Liste und klickt die neueste Session", async () => {
    const a = app();
    const { last, c } = await run("Öffne die neueste Session", a);
    expect(last.ok).toBe(true);
    // echter Klick in der Leiste (Zeiger-Ereignisse + click), kein Router-Sprung
    expect(a.events).toEqual(["pointerdown", "mousedown", "click"]);
    expect(a.navigate).not.toHaveBeenCalled();
    expect(a.route()).toBe("/sessions");
    // die neueste (nach Zeit), nicht die erste im DOM
    expect(a.opened).toEqual(["neu"]);
    // Cursor ist beide Male sichtbar hingeflogen und hat gedrückt
    expect(c.calls.filter((x) => x === "fly").length).toBe(2);
    expect(c.calls.filter((x) => x === "press").length).toBe(2);
  });

  it("„letzte Session“ meint dasselbe; schon auf Sessions → kein Umweg über die Leiste", () => {
    const p = parseLocalCommand("öffne die letzte session", { path: "/sessions", nav });
    expect(p?.steps).toEqual([{ action: "click", target: "item:session" }]);
  });

  it("keine Session da → ehrliche Antwort statt nichts", async () => {
    const a = app();
    // Leere Liste: /sessions rendert nichts
    const c = cursor();
    const r = await executeNyxUi({ action: "click", target: "item:session" }, { ...a.deps(c), waitMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("Ich finde keine Session.");
    expect(c.calls).not.toContain("press");
  });
});

describe("weitere lokale Absichten", () => {
  it("„Öffne Aufgabe Heatmap“ → Aufgaben anklicken, Aufgabe per Text finden (unscharf)", async () => {
    const a = app();
    const { plan, last } = await run("Öffne die Aufgabe heat map schneller", a);
    expect(plan?.steps).toEqual([
      { action: "click", target: "nav:task" },
      { action: "click", target: "item:task:heat map schneller" },
    ]);
    expect(last.ok).toBe(true);
    expect(a.opened).toEqual(["Heatmap schneller machen"]);
  });

  it("„Öffne die neueste Entscheidung“ → Entscheidungen, dann neueste Entscheidung", () => {
    expect(parseLocalCommand("Öffne die neueste Entscheidung", { path: "/", nav })?.steps).toEqual([
      { action: "click", target: "nav:inbox" },
      { action: "click", target: "item:decision" },
    ]);
  });

  it("„Such nach Heatmap“ → Suche anklicken, Text tippen", async () => {
    const p = parseLocalCommand("Such mal nach Heatmap", { path: "/", nav });
    expect(p?.steps).toEqual([
      { action: "click", target: "suche" },
      { action: "type", target: "suche", text: "Heatmap" },
    ]);
    const root = document.createElement("div");
    root.innerHTML = `<input data-nyx="suche" value="alt" />`;
    document.body.appendChild(root);
    const c = cursor();
    for (const s of p?.steps ?? []) expect((await executeNyxUi(s, { navigate: vi.fn(), cursor: c, root, route: () => "/", typeDelayMs: 0 })).ok).toBe(true);
    // Suche wird ersetzt, nicht angehängt
    expect((root.querySelector("input") as HTMLInputElement).value).toBe("Heatmap");
  });

  it("Entscheidungs-Karte ist kein Knopf → nur zeigen (Glow), nie einen Ja/Nein-Knopf darin klicken", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<article data-nyx-item="decision" data-nyx-at="2026-09-26T09:00:00Z" aria-label="Frage"><button>Ja</button></article>`;
    document.body.appendChild(root);
    const onClick = vi.fn();
    root.querySelector("button")?.addEventListener("click", onClick);
    const c = cursor();
    const r = await executeNyxUi({ action: "click", target: "item:decision" }, { navigate: vi.fn(), cursor: c, root, route: () => "/inbox" });
    expect(r.ok).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(c.calls).toContain("glow");
  });
});

describe("Listeneinträge öffnen nur", () => {
  it("eine Session mit „Push“ im Titel wird trotzdem geöffnet (der Eintrag öffnet nur, er pusht nichts)", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<button data-nyx-item="session" data-nyx-at="2026-09-26T09:00:00Z">Git push reparieren</button>`;
    document.body.appendChild(root);
    const onClick = vi.fn();
    root.querySelector("button")?.addEventListener("click", onClick);
    const r = await executeNyxUi({ action: "click", target: "item:session:push" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/sessions" });
    expect(r.ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Text passt zu nichts → ehrlich „Ich finde keine Aufgabe zu …“", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<button data-nyx-item="task">Login reparieren</button>`;
    document.body.appendChild(root);
    const r = await executeNyxUi({ action: "click", target: "item:task:rechnung" }, { navigate: vi.fn(), cursor: cursor(), root, route: () => "/tasks", waitMs: 30 });
    expect(r).toMatchObject({ ok: false, detail: "Ich finde keine Aufgabe zu „rechnung“." });
  });
});

describe("Navigation vom Modell und Scan", () => {
  it("navigate klickt den passenden Eintrag in der Leiste sichtbar statt nur den Router zu rufen", async () => {
    const a = app();
    const c = cursor();
    const r = await executeNyxUi({ action: "navigate", route: "/tasks" }, a.deps(c));
    expect(r.ok).toBe(true);
    expect(a.events).toContain("click");
    expect(a.navigate).not.toHaveBeenCalled();
    expect(c.calls).toContain("press");
    // Seiten ohne Klickweg → ehrliche Antwort statt stillem Router-Sprung.
    const deep = await executeNyxUi({ action: "navigate", route: "/ideas/7" }, { ...a.deps(c), waitMs: 100 });
    expect(deep.ok).toBe(false);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("read_screen nennt Listeneinträge nach Rang (item:<art>:<rang>), neueste zuerst", async () => {
    const a = app();
    await run("öffne sessions", a);
    await vi.waitFor(() => expect(a.root.querySelectorAll("[data-nyx-item]").length).toBe(3));
    const s = readScreen(a.root, "/sessions");
    const items = s.elements.filter((e) => e.id.startsWith("item:"));
    expect(items.map((e) => e.id)).toEqual(["item:session:0", "item:session:1", "item:session:2"]);
    expect(items[0]?.label).toBe("Neue Session");
  });
});
