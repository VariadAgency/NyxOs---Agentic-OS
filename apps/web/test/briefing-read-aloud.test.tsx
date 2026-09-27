// Briefing zum Anhören (Web): Knopf „▶ Vorlesen“, Satz für Satz über die Server-Stimme; der gerade
// erwähnte Abschnitt ist hervorgehoben, der Rest abgedunkelt, der Satz steht als Untertitel da. Nächster Satz
// wird vorgeladen; Tempo geht als `speed` an den Server (nie `playbackRate`). Esc beendet.
import type { BriefingFigures, BriefingSpeech, HaikuReport } from "@nyxos/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { Briefing } from "../src/features/haiku/Briefing";
import { createBriefingReader, type PlayHandle, type ReaderSnapshot } from "../src/features/haiku/briefingReader";
import { parseLocalCommand } from "../src/features/nyx/localCommands";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const SPEECH: BriefingSpeech = {
  reportId: 7,
  kind: "briefing",
  day: "2026-09-25",
  sentences: [
    { section: "kernaussage", target: "headline", text: "Guten Morgen, Alex.", written: "Guten Morgen, Alex." },
    { section: "braucht_dich", target: "needs", text: "Zwei Punkte brauchen dich.", written: "2 Punkte brauchen dich." },
    { section: "kennzahlen", target: "tile:commits", text: "In den letzten sieben Tagen gab es siebzehn Commits.", written: "In den letzten 7 Tagen gab es 17 Commits." },
    { section: "haengt", target: "group:haengt", text: "Eine Session wartet auf dich.", written: "1 Session wartet auf dich." },
  ],
};

describe("Vorleser (ohne Browser-Audio)", () => {
  function fakes() {
    const synthCalls: { text: string; speed: number }[] = [];
    const handles: { finish: () => void; paused: boolean }[] = [];
    const synth = vi.fn((text: string, speed: number) => {
      synthCalls.push({ text, speed });
      return Promise.resolve(new Blob([text]));
    });
    const play = vi.fn((): PlayHandle => {
      let finish: () => void = () => {};
      const done = new Promise<void>((r) => (finish = r));
      const h = { finish, paused: false };
      handles.push(h);
      return { started: Promise.resolve(true), done, pause: () => (h.paused = true), resume: () => void (h.paused = false), stop: () => finish() };
    });
    return { synth, play, synthCalls, handles };
  }
  const flush = () => act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

  it("Hervorhebung folgt dem Satz; der nächste Satz ist schon vorgeladen, bevor der aktuelle endet", async () => {
    const f = fakes();
    const seen: ReaderSnapshot[] = [];
    const reader = createBriefingReader(SPEECH.sentences, { synth: f.synth, play: f.play }, (s) => seen.push(s), { speed: 1 });
    reader.start();
    await flush();
    expect(reader.snapshot()).toMatchObject({ state: "playing", index: 0 });
    expect(reader.snapshot().sentence?.target).toBe("headline");
    // vorgeladen: Satz 2 ist schon beim Server angefragt, Satz 3 noch nicht
    expect(f.synthCalls.map((c) => c.text)).toEqual([SPEECH.sentences[0]?.text, SPEECH.sentences[1]?.text]);
    f.handles[0]?.finish();
    await flush();
    expect(reader.snapshot()).toMatchObject({ state: "playing", index: 1 });
    expect(reader.snapshot().sentence?.target).toBe("needs");
    f.handles[1]?.finish();
    await flush();
    expect(reader.snapshot().sentence?.target).toBe("tile:commits");
    expect(seen.map((s) => s.sentence?.target).filter(Boolean)).toEqual(expect.arrayContaining(["headline", "needs", "tile:commits"]));
  });

  it("Tempo geht als speed an den Server (ab dem nächsten Satz); Pause/Weiter/Stopp", async () => {
    const f = fakes();
    const reader = createBriefingReader(SPEECH.sentences, { synth: f.synth, play: f.play }, () => {}, { speed: 1 });
    reader.start();
    await flush();
    reader.setSpeed(1.3);
    await flush();
    f.handles[0]?.finish();
    await flush();
    // Satz 2 wurde mit neuem Tempo neu angefragt, Satz 3 ebenso
    expect(f.synthCalls.filter((c) => c.speed === 1.3).map((c) => c.text)).toEqual(expect.arrayContaining([SPEECH.sentences[1]?.text, SPEECH.sentences[2]?.text]));
    reader.pause();
    expect(reader.snapshot().state).toBe("paused");
    expect(f.handles[1]?.paused).toBe(true);
    reader.resume();
    expect(reader.snapshot().state).toBe("playing");
    expect(f.handles[1]?.paused).toBe(false);
    reader.stop();
    expect(reader.snapshot()).toMatchObject({ state: "idle", sentence: null });
  });

  it("ohne Stimme: ehrlicher Hinweis statt Stille", async () => {
    const f = fakes();
    const reader = createBriefingReader(SPEECH.sentences, { synth: () => Promise.resolve(null), play: f.play }, () => {}, { speed: 1 });
    reader.start();
    await flush();
    expect(reader.snapshot().state).toBe("error");
    expect(reader.snapshot().message).toMatch(/Stimme/);
    expect(f.play).not.toHaveBeenCalled();
  });

  it("vom Browser blockiert (Autoplay): pausiert mit Hinweis, Weiter spielt denselben Satz", async () => {
    const f = fakes();
    let resumed = 0;
    const play = (): PlayHandle => ({ started: Promise.resolve(false), done: new Promise(() => {}), pause: () => {}, resume: () => void resumed++, stop: () => {} });
    const reader = createBriefingReader(SPEECH.sentences, { synth: f.synth, play }, () => {}, { speed: 1 });
    reader.start();
    await flush();
    expect(reader.snapshot()).toMatchObject({ state: "paused", index: 0 });
    expect(reader.snapshot().message).toMatch(/Weiter/);
    reader.resume();
    expect(resumed).toBe(1);
    expect(reader.snapshot().state).toBe("playing");
  });
});

// ───────────────────────────── Seite ─────────────────────────────

const FIGURES = {
  at: "2026-09-25T08:38:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 2, waiting: 1, idle: 3, crashed: 1, activeInPeriod: 7, closedInPeriod: 4 },
  commits: { today: 3, week: 17, prevWeek: 9 },
  tasks: { open: 11, byStage: [{ stage: "startklar", count: 2 }] },
  usage: { today: { claude: 3_000_000, codex: 1_000_000 }, week: { claude: 21_000_000, codex: 6_000_000 }, prevWeek: { claude: 1, codex: 1 } },
  openQuestions: { approvals: 1, inbox: 1, conflicts: 0, total: 2 },
  conflicts: 1,
  buildsRed: 1,
  needsYou: 2,
  charts: { usage7d: [], sessionsHourly: [], commitsDaily: [], commitRepos: [] },
} as unknown as BriefingFigures;

const REPORT: HaikuReport = {
  id: 7,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T08:38:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "2 Sessions laufen, 1 wartet auf dich.",
  headline: { text: "Zwei Punkte brauchen dich.", sources: [], estimate: false, author: "regeln" },
  sections: [
    { title: "Was lief", statements: [{ text: "7 Sessions waren seit gestern 0 Uhr aktiv.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Was wartet", statements: [{ text: "1 Session wartet auf dich.", sources: [], estimate: false, author: "regeln" }] },
  ],
  runsWithoutYou: [],
  needsYou: [],
  mode: "ok",
  callId: 3,
  snapshot: { at: "2026-09-25T08:38:00.000Z", counts: { running: 2, waiting: 1, idle: 3, crashed: 1, startklar: 2 }, lage: "", needsYouCount: 0, fingerprint: "fp" },
  stale: false,
  figures: FIGURES,
  highlights: ["commits"],
  chartOrder: [],
};

const VOICE_READY = { stt: { state: "ready", ready: true }, tts: { state: "ready", ready: true, voice: "thorsten", voices: [] }, sentence: "Stimme bereit.", fix: null };
const VOICE_OFF = { stt: { state: "offline", ready: false }, tts: { state: "offline", ready: false, voice: null, voices: [] }, sentence: "Die Stimme läuft gerade nicht.", fix: null };

describe("Briefing-Seite liest vor", () => {
  let audios: HTMLAudioElement[] = [];
  let speakBodies: { text: string; speed?: number }[] = [];

  beforeEach(() => {
    audios = [];
    speakBodies = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      audios.push(this as HTMLAudioElement);
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCountUpMemory();
  });

  function stub(voice: unknown) {
    __primeAuthForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/haiku/report")) return jsonResponse({ report: REPORT });
        if (url === "/api/briefing/7/speech") return jsonResponse({ speech: SPEECH });
        if (url.startsWith("/api/nyx/voice/status")) return jsonResponse(voice);
        if (url.startsWith("/api/nyx/voice/speak")) {
          speakBodies.push(JSON.parse(String(init?.body)) as { text: string; speed?: number });
          return Promise.resolve(new Response(new Blob(["RIFF"], { type: "audio/wav" }), { status: 200 }));
        }
        if (url === "/health") return jsonResponse({ ok: true, checks: {} });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
  }

  const active = () => document.querySelector("[data-speech-active]")?.getAttribute("data-speech-target") ?? null;

  it("Klick auf Vorlesen: Kopf hervorgehoben, Rest abgedunkelt, Untertitel; nach dem Satz wandert die Hervorhebung weiter; Esc beendet", async () => {
    stub(VOICE_READY);
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /Vorlesen/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    // Safari/iOS – noch IM Klick wird das eine <audio> freigeschaltet (Stille), bevor irgendetwas lädt.
    expect(audios).toHaveLength(1);
    expect(audios[0]?.src).toMatch(/^data:audio\/wav/);
    await waitFor(() => expect(active()).toBe("headline"));
    expect(document.querySelector("[data-reading]")).not.toBeNull();
    expect(screen.getByTestId("speech-subtitle")).toHaveTextContent("Guten Morgen, Alex.");
    // WAV für Safari, Tempo nur als speed, Wiedergabe-Tempo bleibt 1
    await waitFor(() => expect(speakBodies.length).toBeGreaterThanOrEqual(2));
    expect(audios[0]?.playbackRate).toBe(1);

    act(() => void audios[0]?.dispatchEvent(new Event("ended")));
    await waitFor(() => expect(active()).toBe("needs"));
    expect(screen.getByTestId("speech-subtitle")).toHaveTextContent("Zwei Punkte brauchen dich.");
    await waitFor(() => expect(audios.length).toBe(3));
    // EIN Element für alle Sätze (ein neues Audio() je Satz wäre in Safari ab Satz 2 wieder gesperrt).
    expect(new Set(audios).size).toBe(1);
    act(() => void audios[2]?.dispatchEvent(new Event("ended")));
    await waitFor(() => expect(active()).toBe("tile:commits"));
    // Blob-URLs der fertigen Sätze sind freigegeben.
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(active()).toBeNull());
    expect(document.querySelector("[data-reading]")).toBeNull();
    expect(screen.queryByTestId("speech-subtitle")).toBeNull();
  });

  it("während Nyx die Sprechfassung schreibt, läuft oben der Balken „Vorlesen wird erstellt“ – danach weg", async () => {
    stub(VOICE_READY);
    let release: (() => void) | null = null;
    const base = globalThis.fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/briefing/7/speech") return new Promise<Response>((r) => (release = () => void r(new Response(JSON.stringify({ speech: SPEECH }), { status: 200, headers: { "content-type": "application/json" } }))));
        return base(input, init);
      }),
    );
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /Vorlesen/ });
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.queryByTestId("read-aloud-progress")).toBeNull();
    fireEvent.click(btn);
    const bar = await screen.findByTestId("read-aloud-progress");
    expect(bar).toHaveTextContent(/Vorlesen wird erstellt/);
    expect(screen.getByRole("progressbar", { name: "Vorlesen wird erstellt" })).toBeInTheDocument();
    act(() => release?.());
    await waitFor(() => expect(active()).toBe("headline"));
    await waitFor(() => expect(screen.queryByTestId("read-aloud-progress")).toBeNull());
  });

  it("während der bis zu 25 s Vorbereitung lässt sich das Vorlesen abbrechen (Knopf nicht gesperrt)", async () => {
    stub(VOICE_READY);
    const base = globalThis.fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input) === "/api/briefing/7/speech" ? new Promise<Response>(() => {}) : base(input, init))),
    );
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /Vorlesen/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await screen.findByTestId("read-aloud-progress");
    const cancel = screen.getByRole("button", { name: "Vorlesen abbrechen" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByTestId("read-aloud-progress")).toBeNull());
    expect(screen.getByRole("button", { name: "Vorlesen" })).toBeEnabled();
  });

  it("Stimme nicht bereit: Knopf aus und nennt den Grund", async () => {
    stub(VOICE_OFF);
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /Vorlesen/ });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(screen.getByText(/Die Stimme läuft gerade nicht/)).toBeInTheDocument();
  });

  it("?vorlesen=1 (von Nyx) startet das Vorlesen von selbst", async () => {
    stub(VOICE_READY);
    renderWithClient(
      <MemoryRouter initialEntries={["/briefing?vorlesen=1"]}>
        <Briefing />
      </MemoryRouter>,
    );
    await waitFor(() => expect(active()).toBe("headline"));
  });

  it("Seite verlassen – Ton aus, Blob-URL frei, keine Abdunkelung übrig", async () => {
    stub(VOICE_READY);
    const view = renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /Vorlesen/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(active()).toBe("headline"));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    view.unmount();
    expect(pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-reading], [data-speech-active]")).toBeNull();
    expect(screen.queryByTestId("speech-subtitle")).toBeNull();
  });

  it("Seite schon offen, Nyx will den Recap vorlesen – schaltet auf Recap und liest DEN vor", async () => {
    __primeAuthForTests();
    const RECAP = { ...REPORT, id: 8, kind: "recap" as const, greeting: "Guten Abend, Alex" };
    const recapSpeech: BriefingSpeech = { ...SPEECH, reportId: 8, kind: "recap", sentences: [{ section: "kernaussage", target: "headline", text: "Guten Abend, Alex.", written: "Guten Abend, Alex." }] };
    const speechUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/haiku/report")) return jsonResponse({ report: url.includes("kind=recap") ? RECAP : REPORT });
        if (url.startsWith("/api/briefing/")) {
          speechUrls.push(url);
          return jsonResponse({ speech: url.includes("/8/") ? recapSpeech : SPEECH });
        }
        if (url.startsWith("/api/nyx/voice/status")) return jsonResponse(VOICE_READY);
        if (url.startsWith("/api/nyx/voice/speak")) return Promise.resolve(new Response(new Blob(["RIFF"], { type: "audio/wav" }), { status: 200 }));
        if (url === "/health") return jsonResponse({ ok: true, checks: {} });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    function NyxGo() {
      const navigate = useNavigate();
      return (
        <button type="button" data-speech-keep onClick={() => void navigate("/briefing?vorlesen=1&art=recap")}>
          nyx
        </button>
      );
    }
    renderWithClient(
      <MemoryRouter initialEntries={["/briefing?art=briefing"]}>
        <NyxGo />
        <Briefing />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Vorlesen/ });
    fireEvent.click(screen.getByRole("button", { name: "nyx" }));
    await waitFor(() => expect(screen.getByTestId("speech-subtitle")).toHaveTextContent("Guten Abend, Alex."));
    expect(speechUrls).toEqual(["/api/briefing/8/speech"]);
  });
});

describe("Nyx-Befehl", () => {
  it("„Lies mir das Briefing vor“ öffnet das Briefing mit Vorlesen", () => {
    for (const t of ["Lies mir das Briefing vor", "Nyx, lies mir bitte das Briefing vor.", "Briefing vorlesen", "lies den Recap vor"]) {
      const plan = parseLocalCommand(t, { path: "/overview", nav: [] });
      expect(plan, t).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.action).toBe("navigate");
      expect(step && "route" in step ? step.route : "").toMatch(/^\/briefing\?vorlesen=1/);
    }
    const recap = parseLocalCommand("lies den Recap vor", { path: "/overview", nav: [] });
    expect(recap?.steps[0] && "route" in recap.steps[0] ? recap.steps[0].route : "").toContain("art=recap");
  });
});
