// Untere Leiste, kompakte Kopfzeile, Terminal-Tastenzeile, Tastatur-Höhe (visualViewport),
// PWA-Grundlagen.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTabBar } from "../src/components/MobileTabBar";
import { Sidebar } from "../src/components/Sidebar";
import { TopBar } from "../src/components/TopBar";
import { OPEN_PALETTE_EVENT } from "../src/lib/palette";
import { installViewportTracking, KEYBOARD_MIN_PX } from "../src/lib/visualViewport";
import { ctrlChar, keySequence, TerminalKeys } from "../src/features/terminal/TerminalKeys";
import { ChatComposer } from "../src/features/session-chat/ChatComposer";
import { renderWithClient } from "./helpers";

const WEB = join(import.meta.dirname, "..");

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-kb");
  document.documentElement.style.removeProperty("--app-h");
  document.documentElement.style.removeProperty("--app-top");
});

function stubFetch(openQuestions = { total: 3, sorting: 0 }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = String(url).includes("/api/open-questions") ? openQuestions : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    }),
  );
}

function renderShell(path = "/overview") {
  stubFetch();
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
      <Sidebar />
      <MobileTabBar />
    </MemoryRouter>,
  );
}

describe("untere Leiste (unter md)", () => {
  it("hat Nyx · Sessions · Entscheidungen · Überblick als Links und „Mehr“ als Knopf, nur schmal sichtbar", () => {
    renderShell();
    const bar = screen.getByRole("navigation", { name: "Schnellzugriff" });
    expect(bar.className).toMatch(/md:hidden/);
    const links = [...bar.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/nyx", "/sessions", "/inbox", "/overview"]);
    expect(screen.getByRole("button", { name: "Mehr" })).toBeInTheDocument();
  });

  it("markiert die aktive Seite (aria-current) und zeigt den Zähler offener Entscheidungen", async () => {
    renderShell("/inbox");
    const bar = screen.getByRole("navigation", { name: "Schnellzugriff" });
    const inbox = bar.querySelector('a[href="/inbox"]');
    expect(inbox).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(bar.querySelector("[data-testid=tabbar-badge]")).toHaveTextContent("3"));
  });

  it("„Mehr“ öffnet und schließt die bestehende Schublade (Hauptmenü)", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Hauptmenü" });
    const more = screen.getByRole("button", { name: "Mehr" });
    expect(more).toHaveAttribute("aria-controls", "app-sidebar");
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(nav).toHaveAttribute("data-open", "true");
    expect(more).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(more);
    expect(nav).toHaveAttribute("data-open", "false");
  });

  it("„Mehr“ leuchtet, wenn die Seite nicht in der Leiste steht (z. B. Git)", () => {
    renderShell("/git");
    expect(screen.getByRole("button", { name: "Mehr" })).toHaveAttribute("data-active", "true");
  });

  it("hält unten Abstand zur Home-Leiste (safe-area) und Tipp-Ziele ≥ 44 px", () => {
    renderShell();
    const bar = screen.getByRole("navigation", { name: "Schnellzugriff" });
    expect(bar.className).toMatch(/safe-area-inset-bottom/);
    for (const el of bar.querySelectorAll("a, button")) expect(el.className).toMatch(/min-h-11|h-12|h-\[49px\]/);
  });
});

describe("Kopfzeile kompakt", () => {
  it("kein doppelter Menü-Knopf mehr oben – dafür ein Such-Knopf (⌘K gibt es auf dem Handy nicht)", () => {
    renderShell();
    expect(screen.queryByRole("button", { name: "Menü öffnen" })).toBeNull();
    const search = screen.getByRole("button", { name: "Suchen und Befehle" });
    expect(search.className).toMatch(/md:hidden/);
    const onOpen = vi.fn();
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    fireEvent.click(search);
    window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("Terminal-Tastenzeile", () => {
  it("übersetzt Tasten in die richtigen Zeichenfolgen (auch Pfeile im Anwendungs-Modus)", () => {
    expect(keySequence("esc")).toBe("\x1b");
    expect(keySequence("tab")).toBe("\t");
    expect(keySequence("shiftTab")).toBe("\x1b[Z");
    expect(keySequence("enter")).toBe("\r");
    expect(keySequence("ctrlC")).toBe("\x03");
    expect(keySequence("slash")).toBe("/");
    expect(keySequence("up")).toBe("\x1b[A");
    expect(keySequence("down")).toBe("\x1b[B");
    expect(keySequence("right")).toBe("\x1b[C");
    expect(keySequence("left")).toBe("\x1b[D");
    expect(keySequence("up", { appCursor: true })).toBe("\x1bOA");
  });

  it("Strg + Buchstabe ergibt das Steuerzeichen", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("C")).toBe("\x03");
    expect(ctrlChar("a")).toBe("\x01");
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar("ab")).toBeNull();
    expect(ctrlChar("1")).toBeNull();
  });

  it("Knöpfe schicken Esc/Strg-C, stehlen der Tastatur nie den Fokus, Strg rastet ein", () => {
    const onSend = vi.fn();
    const onCtrl = vi.fn();
    renderWithClient(<TerminalKeys disabled={false} ctrlArmed={false} onCtrlToggle={onCtrl} onSend={onSend} appCursor={() => false} />);
    const esc = screen.getByRole("button", { name: "Esc" });
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    esc.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(esc);
    fireEvent.click(screen.getByRole("button", { name: "Strg-C" }));
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(["\x1b", "\x03"]);
    const ctrl = screen.getByRole("button", { name: "Strg" });
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(ctrl);
    expect(onCtrl).toHaveBeenCalledTimes(1);
  });

  it("ist gesperrt, solange „Nur ansehen“ an ist oder keine Verbindung besteht", () => {
    renderWithClient(<TerminalKeys disabled ctrlArmed={false} onCtrlToggle={() => {}} onSend={() => {}} appCursor={() => false} />);
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
  });
});

describe("Tastatur schiebt nichts aus dem Bild (visualViewport)", () => {
  function fakeViewport(height: number, scale = 1) {
    const listeners: Record<string, (() => void)[]> = {};
    const vv = {
      height,
      offsetTop: 0,
      scale,
      addEventListener: (t: string, fn: () => void) => (listeners[t] ??= []).push(fn),
      removeEventListener: () => {},
    };
    const fire = () => listeners.resize?.forEach((fn) => fn());
    return { vv, fire };
  }

  it("Tastatur offen → App ist so hoch wie der sichtbare Bereich; zu → wieder normal", () => {
    const { vv, fire } = fakeViewport(844);
    const win = { visualViewport: vv, innerHeight: 844, document } as unknown as Window;
    const stop = installViewportTracking(win);
    expect(document.documentElement.dataset.kb).toBeUndefined();
    vv.height = 844 - KEYBOARD_MIN_PX - 200;
    fire();
    expect(document.documentElement.dataset.kb).toBe("open");
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe(`${vv.height}px`);
    vv.height = 844;
    fire();
    expect(document.documentElement.dataset.kb).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("");
    stop();
  });

  it("Zwei-Finger-Zoom (scale ≠ 1) ist keine Tastatur", () => {
    const { vv, fire } = fakeViewport(844);
    const win = { visualViewport: vv, innerHeight: 844, document } as unknown as Window;
    const stop = installViewportTracking(win);
    vv.height = 300;
    vv.scale = 2.5;
    fire();
    expect(document.documentElement.dataset.kb).toBeUndefined();
    stop();
  });
});

describe("Schreiben auf dem Handy", () => {
  it("Enter macht auf Touch-Geräten eine neue Zeile (Senden per Knopf), am Rechner sendet Enter", () => {
    const props = {
      who: "Claude",
      availability: { canSend: true, busy: false, message: null } as never,
      availabilityError: false,
      text: "Hallo",
      onText: () => {},
      drafts: [],
      onAddFiles: () => {},
      onRemove: () => {},
      sending: false,
      error: null,
    };
    const onSend = vi.fn();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("coarse"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const { unmount } = renderWithClient(<ChatComposer {...props} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/Senden mit dem Knopf/)).toBeInTheDocument();
    unmount();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    renderWithClient(<ChatComposer {...props} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe("Zum Home-Bildschirm = richtige App", () => {
  it("index.html: viewport-fit=cover, schwarze Statusleiste, Manifest und apple-touch-icon", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
    expect(html).toMatch(/name="theme-color" content="#000000"/);
    expect(html).toMatch(/apple-mobile-web-app-status-bar-style" content="black"/);
    expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="\/apple-touch-icon.png"/);
    expect(html).toMatch(/rel="manifest" href="\/manifest.webmanifest"/);
  });

  it("Manifest: standalone, schwarz, Icons inkl. maskable, Start auf dem Überblick", () => {
    const m = JSON.parse(readFileSync(join(WEB, "public", "manifest.webmanifest"), "utf8")) as { display: string; theme_color: string; background_color: string; icons: { src: string; purpose: string }[]; start_url: string; id?: string };
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#000000");
    expect(m.background_color).toBe("#000000");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(m.icons.some((i) => i.src === "/icon-512.png")).toBe(true);
    expect(m.id).toBe("/");
  });
});
