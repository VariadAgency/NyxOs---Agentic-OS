// Nyx navigiert IMMER mit dem Cursor – `navigate` ist kein stiller Routensprung mehr, sondern eine Folge
// sichtbarer Klicks: Leiste (am Handy „Mehr“) → Zeile/Kachel → Unterseite, nach dem Klickpfad aus der NyxOS-Karte.
// Befund: „Navigiere in Skills und öffne den meistgenutzten Skill“ → Nyx sagte, es gebe keinen Skill-Tab.
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeNyxUi, type ExecDeps, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";
import { parseLocalCommand } from "../src/features/nyx/localCommands";

function cursor(): NyxCursorDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    flyTo: vi.fn(async () => void calls.push("fly")),
    press: vi.fn(async () => void calls.push("press")),
    glow: vi.fn(() => void calls.push("glow")),
  };
}

/** Kleine NyxOS-Attrappe: Leiste (Desktop oder Handy-Schublade), Seiten rendern nach einem Klick verzögert (wie Abrufe). */
function app(opts: { mobile?: boolean; start?: string } = {}) {
  const root = document.createElement("div");
  root.innerHTML = `
    <aside id="leiste" ${opts.mobile ? "hidden" : ""}>
      <a href="/sessions" data-nyx="nav:ses">Sessions</a>
      <a href="/skills" data-nyx="nav:skills">Skills</a>
      <a href="/git" data-nyx="nav:git">Git</a>
      <a href="/settings" data-nyx="nav:settings">Einstellungen</a>
      <a href="/briefing" data-nyx="nav:brief">Briefing</a>
    </aside>
    <main></main>
    ${opts.mobile ? `<nav><a href="/sessions" data-nyx="tabbar:ses">Sessions</a><button type="button" data-nyx="tabbar:mehr">Mehr</button></nav>` : ""}`;
  document.body.appendChild(root);
  let route = opts.start ?? "/git";
  const clicks: string[] = [];
  const main = root.querySelector("main") as HTMLElement;
  const aside = root.querySelector("aside") as HTMLElement;
  const go = (to: string) => {
    route = to;
    if (opts.mobile) aside.hidden = true;
    main.innerHTML = "<p>Lädt …</p>";
    setTimeout(() => render(to), 40);
  };
  const wire = () => {
    for (const el of root.querySelectorAll<HTMLElement>("a[href],[data-nyx-href]")) {
      if (el.dataset.wired) continue;
      el.dataset.wired = "1";
      el.addEventListener("click", (e) => {
        e.preventDefault();
        clicks.push(el.getAttribute("data-nyx") ?? el.textContent ?? "");
        go(el.getAttribute("data-nyx-href") ?? el.getAttribute("href") ?? "/");
      });
    }
  };
  const render = (to: string) => {
    if (to === "/skills")
      main.innerHTML = `
        <button type="button" data-nyx="skills-new">Neuer Skill</button>
        <button type="button" data-nyx="skill-review" data-nyx-href="/skills/review">/review · 3× genutzt</button>
        <button type="button" data-nyx="skill-web-design" data-nyx-href="/skills/web-design">/web-design · 41× genutzt</button>`;
    else if (to === "/settings")
      main.innerHTML = `<a href="/settings/konto" data-nyx="settings:konto">Konto</a><a href="/settings/mitteilungen" data-nyx="settings:mitteilungen">Mitteilungen</a>`;
    else if (to === "/settings/mitteilungen")
      main.innerHTML = `<h1>Mitteilungen</h1><a href="/settings/telegram" data-nyx="settings-sub:telegram">Telegram</a><div id="erweitert-ruhezeit">Ruhezeit</div>`;
    else if (to === "/briefing") main.innerHTML = "<h1>Briefing</h1>";
    else main.innerHTML = `<h1>${to}</h1>`;
    wire();
  };
  (root.querySelector('[data-nyx="tabbar:mehr"]') as HTMLElement | null)?.addEventListener("click", () => {
    clicks.push("tabbar:mehr");
    aside.hidden = false;
  });
  wire();
  render(route);
  const navigate = vi.fn((r: string) => {
    route = r;
  });
  const deps = (c: NyxCursorDriver): ExecDeps => ({ navigate, cursor: c, root, route: () => route, typeDelayMs: 0, waitMs: 800 });
  return { root, clicks, navigate, deps, route: () => route };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ui_navigate = Cursor-Schritte statt Routensprung", () => {
  it("Skill-Fall: /skills/web-design → Leiste „Skills“, dann die Kachel des Skills (kein navigate)", async () => {
    const a = app();
    const c = cursor();
    const r = await executeNyxUi({ action: "navigate", route: "/skills/web-design", via: ["nav:skills", "skill-web-design"] }, a.deps(c));
    expect(r.ok).toBe(true);
    expect(a.route()).toBe("/skills/web-design");
    expect(a.clicks).toEqual(["nav:skills", "skill-web-design"]);
    expect(a.navigate).not.toHaveBeenCalled();
    expect(c.calls.filter((x) => x === "fly").length).toBeGreaterThanOrEqual(2);
    expect(c.calls.filter((x) => x === "press").length).toBe(2);
  });

  it("auch ohne Klickpfad: Leiste nach Pfad, dann der Link bzw. data-nyx-href zum Ziel", async () => {
    const a = app();
    const r = await executeNyxUi({ action: "navigate", route: "/skills/review" }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["nav:skills", "skill-review"]);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("Unterseite eines Bereichs: Einstellungen → Mitteilungen → Telegram, Schritt für Schritt", async () => {
    const a = app();
    const r = await executeNyxUi({ action: "navigate", route: "/settings/telegram", via: ["nav:settings", "settings:mitteilungen", "settings-sub:telegram"] }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["nav:settings", "settings:mitteilungen", "settings-sub:telegram"]);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("schon im Bereich: klickt nicht noch mal die Leiste, sondern gleich weiter", async () => {
    const a = app({ start: "/settings/mitteilungen" });
    const r = await executeNyxUi({ action: "navigate", route: "/settings/telegram", via: ["nav:settings", "settings:mitteilungen", "settings-sub:telegram"] }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["settings-sub:telegram"]);
  });

  it("Anker (#erweitert-ruhezeit): per Cursor zur Seite, dann nur die Stelle auf derselben Seite", async () => {
    const a = app();
    const c = cursor();
    const r = await executeNyxUi({ action: "navigate", route: "/settings/mitteilungen#erweitert-ruhezeit", via: ["nav:settings", "settings:mitteilungen"] }, a.deps(c));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["nav:settings", "settings:mitteilungen"]);
    // Nur der Anker auf der schon erreichten Seite – kein Seitenwechsel per Router.
    expect(a.navigate).toHaveBeenCalledTimes(1);
    expect(a.navigate).toHaveBeenCalledWith("/settings/mitteilungen#erweitert-ruhezeit");
    expect(c.calls.at(-1)).toBe("glow");
  });

  it("Briefing vorlesen: Leiste per Cursor, ?vorlesen=1 erst auf der Briefing-Seite", async () => {
    const a = app();
    const r = await executeNyxUi({ action: "navigate", route: "/briefing?vorlesen=1", via: ["nav:brief"] }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["nav:brief"]);
    expect(a.navigate).toHaveBeenCalledTimes(1);
    expect(a.route()).toBe("/briefing?vorlesen=1");
  });

  it("Handy (390 px): Leiste zu → erst „Mehr“, dann der Eintrag; Tabs der unteren Leiste direkt", async () => {
    const a = app({ mobile: true });
    const r = await executeNyxUi({ action: "navigate", route: "/skills", via: ["nav:skills"] }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["tabbar:mehr", "nav:skills"]);
    const b = await executeNyxUi({ action: "navigate", route: "/sessions", via: ["nav:ses"] }, a.deps(cursor()));
    expect(b.ok).toBe(true);
    expect(a.clicks.slice(2)).toEqual(["tabbar:ses"]);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("kein Klickweg → ehrliche Antwort, KEIN stiller Sprung", async () => {
    const a = app();
    const r = await executeNyxUi({ action: "navigate", route: "/skills/gibtsnicht", via: ["nav:skills", "skill-gibtsnicht"] }, { ...a.deps(cursor()), waitMs: 150 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Skills");
    expect(a.navigate).not.toHaveBeenCalled();
    expect(a.route()).toBe("/skills");
  });

  it("ui_click auf eine Skill-Kachel von woanders: erst sichtbar zu Skills", async () => {
    const a = app();
    const r = await executeNyxUi({ action: "click", target: "skill-web-design" }, a.deps(cursor()));
    expect(r.ok).toBe(true);
    expect(a.clicks).toEqual(["nav:skills", "skill-web-design"]);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("„öffne Skills“ geht in die Skill-Bibliothek, nicht zu den Agenten", () => {
    const nav = [
      { id: "agent", label: "Agenten", path: "/agents" },
      { id: "skills", label: "Skills", path: "/skills" },
    ];
    const p = parseLocalCommand("öffne skills", { path: "/git", nav });
    expect(JSON.stringify(p?.steps)).toContain("skills");
    expect(JSON.stringify(p?.steps)).not.toContain("agent");
  });
});
