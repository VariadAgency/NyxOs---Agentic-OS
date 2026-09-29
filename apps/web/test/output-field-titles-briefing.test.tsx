// Ausgabe-Feld, Seitentitel, Briefing-Gruß und -Neuschreiben, Faden-Wahl im Nyx-Zentrum.
// 1. Ausgabe-Feld unter der Leiste: Markdown und Belege wie im Zentrum, nicht roh.
// 2. Seitentitel je Tab (zentral aus der Leisten-Definition), bei einer Session ihr Name.
// 3. Briefing-Kopf grüßt nach der gemeinsamen Regel (01:24 = Nacht).
// 4. Briefing schreibt sich beim Öffnen höchstens EINMAL neu – auch über Neu-Einhängen hinweg.
// 5. Nyx-Zentrum springt nie in einen Telegram-Faden.
import type { HaikuSource, HaikuThread } from "@nyxos/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Briefing, greetingFor } from "../src/features/haiku/Briefing";
import { pickThread } from "../src/features/haiku/useHaikuChat";
import { NyxCaption, type NyxCaptionProps } from "../src/features/nyx/bar/NyxCaption";
import { pageTitle, usePageTitle } from "../src/hooks/usePageTitle";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ohne Speicher egal
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1 · Ausgabe-Feld ───
const SOURCES: HaikuSource[] = [{ kind: "session", id: "s1", label: "Karte bauen", href: "/sessions/coding/app/s1" }];

function captionProps(over: Partial<NyxCaptionProps> = {}): NyxCaptionProps {
  return {
    anchorRef: createRef<HTMLElement>(),
    talking: false,
    transcribing: false,
    visual: "idle" as NyxCaptionProps["visual"],
    toolName: null,
    heard: "Wie ist die Lage?",
    reply: "",
    sources: [],
    error: null,
    draft: "",
    setDraft: () => {},
    onSubmit: () => {},
    onClose: () => {},
    onOpenCenter: () => {},
    onFocusChange: () => {},
    ...over,
  };
}

describe("Ausgabe-Feld unter der Leiste", () => {
  it("zeigt Fett als Fett und Belege als kleine Links, kein rohes Markdown", () => {
    render(
      <MemoryRouter>
        <NyxCaption {...captionProps({ reply: "**Aktiv jetzt:** 3 Sessions laufen [1].", sources: SOURCES })} />
      </MemoryRouter>,
    );
    const reply = screen.getByTestId("nyx-caption-reply");
    expect(reply).not.toHaveTextContent("**");
    expect(reply).not.toHaveTextContent("[1]");
    expect(reply.querySelector("b")).toHaveTextContent("Aktiv jetzt:");
    // Beleg im Text: kleine Nummer, die zur Quelle führt.
    const marker = screen.getByRole("link", { name: "Quelle 1: Karte bauen" });
    expect(marker).toHaveAttribute("href", "/sessions/coding/app/s1");
    // Darunter die Quellen-Chips wie im Zentrum.
    expect(screen.getByRole("list", { name: "Quellen" })).toHaveTextContent("Karte bauen");
  });

  it("Beleg ohne passende Quelle verschwindet still statt als „[2]“ stehen zu bleiben", () => {
    render(
      <MemoryRouter>
        <NyxCaption {...captionProps({ reply: "Zwei Builds sind rot [2].", sources: [] })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("nyx-caption-reply")).toHaveTextContent(/^Zwei Builds sind rot\.$/);
  });
});

// ─── 2 · Seitentitel ───
describe("Seitentitel je Tab", () => {
  it.each([
    ["/overview", "Überblick · NyxOS"],
    ["/nyx", "Nyx · NyxOS"],
    ["/briefing", "Briefing · NyxOS"],
    ["/sessions", "Sessions · NyxOS"],
    ["/sessions/coding/nyxos", "Sessions · NyxOS"],
    ["/ideas/12", "Ideen · NyxOS"],
    ["/skills/dataviz", "Skills · NyxOS"],
    ["/einstellungen/nyx", "Einstellungen · NyxOS"],
    ["/files", "Dateien · NyxOS"],
    ["/gibtsnicht", "NyxOS"],
  ])("%s → %s", (path, title) => {
    expect(pageTitle(path)).toBe(title);
  });

  it("offene Session: ihr Name steht im Titel", () => {
    expect(pageTitle("/sessions/coding/nyxos/claude%3Aabc", "Karte bauen")).toBe("Karte bauen · NyxOS");
  });

  it("der Hook setzt document.title und nimmt den Session-Namen aus der geladenen Liste", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["sessions"], [{ id: "claude:abc", sessionId: "abc", title: "Karte bauen" }]);
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse([])));
    function Probe() {
      usePageTitle();
      return null;
    }
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude%3Aabc"]}>
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toBe("Karte bauen · NyxOS"));
    unmount();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/overview"]}>
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toBe("Überblick · NyxOS"));
  });
});

// ─── 3 · Gruß ───
describe("Briefing-Kopf grüßt nach der gemeinsamen Regel", () => {
  it("01:24 Uhr ist Nacht – wie Server und Vorlesen", () => {
    expect(greetingFor(new Date("2026-09-25T23:24:00Z"), "Alex")).toBe("Noch wach, Alex?");
    expect(greetingFor(new Date("2026-09-26T06:00:00Z"), "Alex")).toBe("Guten Morgen, Alex");
    expect(greetingFor(new Date("2026-09-26T18:30:00Z"), "Alex")).toBe("Guten Abend, Alex");
  });
});

// ─── 4 · Briefing schreibt sich höchstens einmal neu ───
const STALE_REPORT = {
  id: 5,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T05:00:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "Lage.",
  sections: [],
  runsWithoutYou: [],
  needsYou: [],
  mode: "ok",
  modeReason: null,
  callId: 1,
  snapshot: { at: "2026-09-25T05:00:00.000Z", counts: {}, lage: "Lage.", needsYouCount: 0, fingerprint: "fp" },
  stale: true,
};

function stubBriefing(postResult: "fail" | "ok") {
  let posts = 0;
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/haiku/report" && init?.method === "POST") {
      posts++;
      if (postResult === "fail") return jsonResponse({ error: "blocked" }, { status: 503 });
      return jsonResponse({ report: { ...STALE_REPORT, stale: false } });
    }
    if (url.startsWith("/api/haiku/report")) return jsonResponse({ report: STALE_REPORT });
    if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "c", hasPasskey: true, authReads: true });
    if (url === "/api/haiku/light-day") return jsonResponse({ items: [], deferred: 0 });
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { posts: () => posts };
}

function mountBriefing() {
  return renderWithClient(
    <MemoryRouter>
      <Briefing />
    </MemoryRouter>,
  );
}

describe("Briefing: höchstens EIN automatisches Neuschreiben", () => {
  // Tageszeit festlegen: ab 18 Uhr zeigt das Briefing den Abend-Rückblick – die Tests meinen das Tages-Briefing.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("scheitert das Neuschreiben, versucht es ein erneutes Öffnen NICHT noch einmal (4 × POST)", async () => {
    const f = stubBriefing("fail");
    const first = mountBriefing();
    await waitFor(() => expect(f.posts()).toBe(1));
    first.unmount();
    // Tab-Wechsel und zurück = neu eingehängt, frischer Query-Cache.
    for (let i = 0; i < 3; i++) {
      const again = mountBriefing();
      await screen.findByText("Lage.");
      again.unmount();
    }
    expect(f.posts()).toBe(1);
  });

  it("derselbe veraltete Bericht wird auch nach einem geglückten Lauf nicht gleich wieder neu geschrieben", async () => {
    const f = stubBriefing("ok");
    const first = mountBriefing();
    await waitFor(() => expect(f.posts()).toBe(1));
    first.unmount();
    const again = mountBriefing();
    await screen.findByText("Lage.");
    again.unmount();
    expect(f.posts()).toBe(1);
  });
});

// ─── 5 · Faden im Zentrum ───
const thread = (id: number, topic: string): HaikuThread => ({ id, title: `F${id}`, topic, day: "2026-09-25", updatedAt: "2026-09-25T10:00:00Z", temporary: false, expiresAt: null });

describe("Nyx-Zentrum wählt den Faden wie der Tab", () => {
  const threads = [thread(9, "telegram"), thread(7, "chat"), thread(3, "chat")];
  it("nichts gemerkt → jüngster eigener Faden, nie Telegram", () => {
    expect(pickThread(threads, null)).toBe(7);
    expect(pickThread([thread(9, "telegram")], null)).toBeNull();
  });
  it("gemerkter Faden fehlt → leer statt eines fremden", () => {
    expect(pickThread(threads, 42)).toBeNull();
  });
  it("gemerkter Telegram-Faden → leer", () => {
    expect(pickThread(threads, 9)).toBeNull();
  });
  it("gemerkter eigener Faden und „neu“ bleiben", () => {
    expect(pickThread(threads, 3)).toBe(3);
    expect(pickThread(threads, "neu")).toBeNull();
  });
});

// ─── Grenzfälle ───
describe("Belege sind nur App-interne Links", () => {
  it.each(["javascript:alert(1)", "https://example.com/x", "//example.com/x", "/\\example.com/x"])("href %s → kein Link, nur Nummer", (href) => {
    render(
      <MemoryRouter>
        <NyxCaption {...captionProps({ reply: "Achtung [1].", sources: [{ kind: "session", id: "s1", label: "Fremd", href }] })} />
      </MemoryRouter>,
    );
    const reply = screen.getByTestId("nyx-caption-reply");
    expect(reply.querySelector("a")).toBeNull();
    expect(reply).toHaveTextContent("Achtung1.");
  });
});

describe("Sperre hält auch ohne Browser-Speicher (älteres Safari privat)", () => {
  it("getItem liefert null, setItem wirft → trotzdem nur EIN automatischer Lauf je Bericht", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    vi.resetModules(); // frischer Modulzustand (storageOk) nur für diesen Fall
    const { claimAutoRewrite, autoRewriteAllowed } = await import("../src/features/haiku/autoRewrite");
    expect(claimAutoRewrite("recap", 777, 1_000)).toBe(true);
    expect(autoRewriteAllowed("recap", 777, 2_000)).toBe(false);
    expect(claimAutoRewrite("recap", 777, 2_000)).toBe(false);
  });

  it("kaputter Speicher-Inhalt blockiert nichts und wirft nicht", async () => {
    vi.resetModules();
    const { autoRewriteAllowed } = await import("../src/features/haiku/autoRewrite");
    localStorage.setItem("nyxos.briefing.autoRewrite", "null");
    expect(autoRewriteAllowed("briefing", 1)).toBe(true);
    localStorage.setItem("nyxos.briefing.autoRewrite", "{kaputt");
    expect(() => autoRewriteAllowed("briefing", 1)).not.toThrow();
  });
});

describe("Titel wird beim Aushängen zurückgesetzt", () => {
  it("nach unmount steht wieder „NyxOS“", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      usePageTitle();
      return null;
    }
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/usage"]}>
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toBe("Nutzung · NyxOS"));
    unmount();
    expect(document.title).toBe("NyxOS");
  });
});
