// Nyx-Denken: Denken wird nie gesprochen. Text VOR einem Werkzeug-Aufruf ist ein Gedanke (eigener Kanal
// „thought“, in der Oberfläche eingeklappt, nie vorgelesen); bis die Daten da sind, kommt genau EINE kurze
// Zwischenmeldung („Ich schau mal.“). Antwort = nur der Text nach dem letzten Werkzeug-Ergebnis.
// Dazu: „Was war die letzte Session / letzte Änderung?“ → Werkzeug `letzte_aktivitaet` mit genauen Daten.
import type { HaikuStreamEvent } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { AnswerGate, FILLERS, fillerFor } from "../src/nyx/answerGate.js";
import { gitCommits, gitRepos, sessionEvents, sessions } from "../src/db/schema.js";
import { latestActivityView, loadLatestActivity } from "../src/haiku/latestActivity.js";
import { buildNyxSystemPrompt } from "../src/nyx/prompt.js";
import { buildPersona } from "../src/nyx/personaDefault.js";
import { CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant/assistant-helpers.js";

type GateOut = ReturnType<AnswerGate["push"]>;
const texts = (out: GateOut, type: string) => out.filter((e) => e.type === type).map((e) => e.text).join("");

describe("AnswerGate: Gedanken vs. Antwort", () => {
  it("Text vor einem Werkzeug wird Gedanke, nicht Antwort; die Zwischenmeldung kommt genau einmal", () => {
    const g = new AnswerGate({ filler: "Ich schau mal." });
    const out: GateOut = [];
    out.push(...g.push("Ich prüfe erst die Sessions. "));
    out.push(...g.push("Ah nee, doch nicht."));
    out.push(...g.tool());
    out.push(...g.push("Moment, noch Git."));
    out.push(...g.tool());
    out.push(...g.push("Die letzte Session war „Nyx-Denken“, "));
    out.push(...g.push("heute um 11:02."));
    out.push(...g.end());
    expect(texts(out, "delta")).toBe("Die letzte Session war „Nyx-Denken“, heute um 11:02.");
    expect(out.filter((e) => e.type === "thought").map((e) => e.text)).toEqual(["Ich prüfe erst die Sessions. Ah nee, doch nicht.", "Moment, noch Git."]);
    expect(out.filter((e) => e.type === "filler")).toEqual([{ type: "filler", text: "Ich schau mal." }]);
    expect(g.thoughts).toHaveLength(2);
  });

  it("ohne Werkzeug: die ganze Antwort kommt (kurz: am Ende, lang: gestreamt)", () => {
    const g = new AnswerGate({ filler: "Ich schau mal.", releaseChars: 20 });
    const a = g.push("Hallo Alex. ");
    expect(texts(a, "delta")).toBe("");
    const b = g.push("Alles läuft ruhig, drei Sessions warten.");
    expect(texts(b, "delta")).toBe("Hallo Alex. Alles läuft ruhig, drei Sessions warten.");
    const c = g.push(" Mehr nicht.");
    expect(texts(c, "delta")).toBe(" Mehr nicht.");
    expect(g.end()).toEqual([]);
    expect(g.thoughts).toEqual([]);
  });

  it("schon gestreamter Text vor einem späten Werkzeug wird zurückgenommen (retract)", () => {
    const g = new AnswerGate({ filler: "Let me check.", releaseChars: 10 });
    const a = g.push("Das ist ein langer Anlauf ohne Ende");
    expect(texts(a, "delta")).toBe("Das ist ein langer Anlauf ohne Ende");
    const t = g.tool();
    expect(t).toContainEqual({ type: "thought", text: "Das ist ein langer Anlauf ohne Ende", retract: true });
    expect(t).toContainEqual({ type: "filler", text: "Let me check." });
  });

  it("answer(): der Endtext verliert die Gedanken (Reserve-Motor liefert alle Runden als einen Text)", () => {
    const g = new AnswerGate({ filler: "Ich schau mal." });
    g.push("Ich schau mal nach.");
    g.tool();
    g.push("Ah nee, doch nicht.");
    g.tool();
    g.push("Die letzte Änderung: „Bericht“ in NyxOS, heute 10:41.");
    expect(g.answer("Ich schau mal nach.Ah nee, doch nicht.Die letzte Änderung: „Bericht“ in NyxOS, heute 10:41.")).toBe("Die letzte Änderung: „Bericht“ in NyxOS, heute 10:41.");
    // CLI liefert schon nur die letzte Runde – dann bleibt sie unverändert.
    expect(g.answer("Die letzte Änderung: „Bericht“.")).toBe("Die letzte Änderung: „Bericht“.");
  });

  // (Beispiele aus dem Alltag: „Ich weiß, ich gucke danach“ / „Ich schau mir das mal an.“): ein ganzer, natürlicher Satz,
  // je Frage fest gewählt (gleiche Frage → gleicher Satz), über viele Fragen abwechselnd.
  it("fillerFor: natürlicher Satz, Deutsch/Englisch, fest je Frage, abwechselnd über Fragen", () => {
    expect(FILLERS.de).toContain("Ich schau mir das mal an.");
    expect(FILLERS.de).toContain(fillerFor("Was war die letzte Session?"));
    expect(FILLERS.en).toContain(fillerFor("What was the last session?"));
    expect(fillerFor("Was war die letzte Session?")).toBe(fillerFor("Was war die letzte Session?"));
    const many = new Set(["Wie ist der Server?", "Was läuft gerade?", "Zeig mir die Commits.", "Welche Sessions laufen?", "Was hängt?", "Wie viel habe ich heute verbraucht?"].map(fillerFor));
    expect(many.size).toBeGreaterThan(1);
    for (const f of [...FILLERS.de, ...FILLERS.en]) {
      expect(f).toMatch(/^[A-ZÄÖÜ].{8,40}[.]$/);
      expect(f).not.toBe("Ich schau mal.");
    }
  });
});

describe("Runde über /api/haiku/chat: Denken wird nie Antwort", () => {
  // Wie der Reserve-Motor: Text vor dem Werkzeug, dann Werkzeug, dann Antwort; Endtext = alle Runden.
  const thinkingScript = () =>
    async function* (_req: EngineRequest): AsyncIterable<EngineEvent> {
      yield { type: "session", sessionId: "11111111-1111-4111-8111-111111111111", model: "fake-haiku" };
      yield { type: "delta", text: "Ich prüfe das. " };
      yield { type: "delta", text: "Ah nee, doch nicht." };
      yield { type: "tool", name: "letzte_aktivitaet" };
      yield { type: "delta", text: "Die letzte Session war „Nyx-Denken“ " };
      yield { type: "delta", text: "in NyxOS, heute um 11:02." };
      yield {
        type: "result",
        text: "Ich prüfe das. Ah nee, doch nicht.Die letzte Session war „Nyx-Denken“ in NyxOS, heute um 11:02.",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
        model: "fake-haiku",
        sessionId: "11111111-1111-4111-8111-111111111111",
        isError: false,
        error: null,
      };
    };

  // (live gemessen: grün → eine Runde orange → grün): Der Server meldete „idle“ erst nach dem Aufräumen
  // (Faden speichern, afterTurn) – bis dahin hing im Tab noch „tool“ und schaltete nach der Antwort zurück auf orange.
  it("nyx.state idle geht raus, bevor das done-Ereignis ankommt", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(thinkingScript()) });
    const states: string[] = [];
    t.hub.add({ send: (d: string) => {
      const m = JSON.parse(d) as { type?: string; state?: string };
      if (m.type === "nyx.state" && m.state) states.push(m.state);
    } });
    const res = await t.json("/api/haiku/chat", { message: "Was war die letzte Session?", context: CTX, channel: "voice" });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    let atDone: string | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (atDone === undefined && buf.includes('"type":"done"')) atDone = states.at(-1);
    }
    expect(states).toContain("tool");
    expect(atDone).toBe("idle");
  });

  for (const channel of ["voice", "web"] as const) {
    it(`Kanal ${channel}: Gedanke kommt als thought, Zwischenmeldung einmal, Antwort + Sprechfassung ohne Denken`, async () => {
      const t = await setupAssistant({ engine: new FakeEngine(thinkingScript()) });
      const evs = await readNdjson(await t.json("/api/haiku/chat", { message: "Was war die letzte Session?", context: CTX, channel }));
      const deltas = evs.filter((e): e is Extract<HaikuStreamEvent, { type: "delta" }> => e.type === "delta").map((e) => e.text).join("");
      expect(deltas).not.toMatch(/Ah nee|prüfe das/);
      expect(deltas).toContain("Die letzte Session war „Nyx-Denken“");
      const thoughts = evs.filter((e) => e.type === "thought");
      expect(thoughts).toHaveLength(1);
      expect(JSON.stringify(thoughts)).toContain("Ah nee, doch nicht.");
      expect(evs.filter((e) => e.type === "filler")).toEqual([{ type: "filler", text: fillerFor("Was war die letzte Session?") }]);
      const done = evs.find((e): e is Extract<HaikuStreamEvent, { type: "done" }> => e.type === "done");
      expect(done?.text).toBe("Die letzte Session war „Nyx-Denken“ in NyxOS, heute um 11:02.");
      expect(done?.speak ?? "").not.toMatch(/Ah nee/);
      expect(done?.thoughts).toEqual(["Ich prüfe das. Ah nee, doch nicht."]);
    });
  }
});

describe("letzte_aktivitaet: genaue Daten zu letzter Session und letzter Änderung", () => {
  const now = new Date("2026-09-26T09:20:00Z"); // 11:20 Berlin
  const view = latestActivityView(
    {
      sessions: [
        {
          id: "claude:abc",
          title: "Nyx-Denken",
          sessionId: "abc",
          tool: "claude",
          state: "running",
          closedAt: null,
          cwd: "/Users/alex/projects/tools/NyxOS",
          baustelle: "NyxOS",
          branch: "worktree-agent-a05",
          startedAt: "2026-09-26T09:05:00Z",
          lastActivityAt: "2026-09-26T09:18:00Z",
          lastPrompt: "Fix Nyx: Denken nie sprechen, genaue Antworten zu letzter Session.",
          lastAnswer: "Ich habe AnswerGate gebaut und die Tests laufen grün.",
        },
        {
          id: "codex:def",
          title: null,
          sessionId: "def",
          tool: "codex",
          state: null,
          closedAt: "2026-09-26T08:00:00Z",
          cwd: "/Users/alex/projects/App",
          baustelle: null,
          branch: "main",
          startedAt: "2026-09-26T07:00:00Z",
          lastActivityAt: "2026-09-26T07:59:00Z",
          lastPrompt: null,
          lastAnswer: null,
        },
      ],
      commits: [
        { sha: "3b3ca3856e", subject: "Bericht + Stand nach Deploy 6 (Stimme vollständig)", repo: "NyxOS", branch: "main", author: "Alex Doe", at: "2026-09-26T08:41:00Z", filesChanged: 3, insertions: 40, deletions: 2, sessionKey: "claude:abc" },
        { sha: "f3688b92aa", subject: "Pocket-Stimme mit eigenem Stopp-Signal", repo: "NyxOS", branch: "main", author: "Claude", at: "2026-09-26T08:10:00Z", filesChanged: 1, insertions: 5, deletions: 1, sessionKey: null },
      ],
    },
    now,
  );

  it("letzte Session: Titel, Werkzeug, Projekt, Zeit, was zuletzt gefragt/geantwortet wurde", () => {
    const s = view.letzte_session;
    expect(s?.titel).toBe("Nyx-Denken");
    expect(s?.werkzeug).toBe("Claude");
    expect(s?.projekt).toBe("NyxOS");
    expect(s?.zweig).toBe("worktree-agent-a05");
    expect(s?.zustand).toBe("läuft");
    expect(s?.zuletzt_aktiv).toBe("heute 11:18");
    expect(s?.vor).toBe("vor 2 Minuten");
    expect(s?.zuletzt_gefragt).toContain("Denken nie sprechen");
    expect(s?.zuletzt_geantwortet).toContain("AnswerGate");
    expect(s?.ref).toBe("[[session:claude:abc]]");
    expect(view.weitere_sessions).toHaveLength(1);
    expect(view.weitere_sessions[0]?.projekt).toBe("App");
  });

  it("letzte Änderung: Commit-Nachricht, Repo, Zweig, Zeit, Autor, Umfang", () => {
    const c = view.letzte_aenderung;
    expect(c?.titel).toBe("Bericht + Stand nach Deploy 6 (Stimme vollständig)");
    expect(c?.repo).toBe("NyxOS");
    expect(c?.zweig).toBe("main");
    expect(c?.zeit).toBe("heute 10:41");
    expect(c?.vor).toBe("vor 39 Minuten");
    expect(c?.autor).toBe("Alex Doe");
    expect(c?.sha).toBe("3b3ca38");
    expect(c?.umfang).toBe("3 Dateien, +40 −2");
    expect(c?.session).toBe("[[session:claude:abc]]");
  });

  it("fertige Sätze zum Vorlesen, mit den genauen Werten", () => {
    expect(view.satz_session).toBe("Die letzte Session war „Nyx-Denken“ (Claude, NyxOS), zuletzt aktiv heute 11:18. Zuletzt ging es um: „Fix Nyx: Denken nie sprechen, genaue Antworten zu letzter Session“.");
    expect(view.satz_aenderung).toBe("Die letzte Änderung war der Commit „Bericht + Stand nach Deploy 6 (Stimme vollständig)“ in NyxOS, heute 10:41, von Alex Doe.");
  });

  it("leer: ehrlich „keine“, nie erfunden", () => {
    const empty = latestActivityView({ sessions: [], commits: [] }, now);
    expect(empty.letzte_session).toBeNull();
    expect(empty.letzte_aenderung).toBeNull();
    expect(empty.satz_session).toBe("Es ist noch keine Session erfasst.");
    expect(empty.satz_aenderung).toBe("Es ist noch kein Commit erfasst.");
  });
});

describe("Prompt: kein lautes Denken, Jarvis-Ton, genaue Daten", () => {
  const prompt = buildNyxSystemPrompt({ memoryBlock: "", tools: ["letzte_aktivitaet", "lage", "git_lage"], channel: "voice" });
  it("verbietet Denk-Erzählung und Selbstkorrekturen in der Antwort", () => {
    expect(prompt).toMatch(/Denkprozess/);
    expect(prompt).toMatch(/Selbstkorrektur/);
  });
  it("letzte Session / letzte Änderung → letzte_aktivitaet", () => {
    expect(prompt).toMatch(/letzte Session.*letzte_aktivitaet/s);
  });
  it("Ton: ruhig, keine KI-Floskeln", () => {
    const p = buildPersona(null, "web");
    expect(p).toMatch(/ruhig/);
    expect(p).toMatch(/Als KI/);
  });
});

describe("letzte_aktivitaet aus der Datenbank", () => {
  it("jüngste Session mit letzter Frage/Antwort, jüngster Commit; Prüfläufe und Sub-Agenten zählen nicht", async () => {
    const t = await setupAssistant({ isolated: true });
    const base = { tool: "claude", machineId: "m1" };
    await t.db.insert(sessions).values([
      { ...base, id: "claude:alt", sessionId: "alt", title: "Alte Session", lastActivityAt: "2026-09-25T18:00:00Z" },
      { ...base, id: "claude:neu", sessionId: "neu", title: "Nyx-Denken", cwd: "/Users/alex/projects/tools/NyxOS", gitBranch: "nyx-denken", state: "running", lastActivityAt: "2026-09-26T09:18:00Z" },
      { ...base, id: "claude:sub", sessionId: "sub", parentId: "claude:neu", title: "Sub-Agent", lastActivityAt: "2026-09-26T09:19:00Z" },
      { ...base, id: "claude:probe", sessionId: "probe", title: "Probe", temporaryReason: "selftest", lastActivityAt: "2026-09-26T09:19:30Z" },
    ]);
    await t.db.insert(sessionEvents).values([
      { id: "e1", sessionKey: "claude:neu", ts: "2026-09-26T09:10:00Z", kind: "prompt", source: "transcript", data: { text: "Erste Frage" } },
      { id: "e2", sessionKey: "claude:neu", ts: "2026-09-26T09:17:00Z", kind: "prompt", source: "transcript", data: { text: "Denken nie sprechen" } },
      { id: "e3", sessionKey: "claude:neu", ts: "2026-09-26T09:18:00Z", kind: "assistant", source: "transcript", data: { text: "AnswerGate ist fertig." } },
    ]);
    await t.db.insert(gitRepos).values({ id: "nyxos", label: "NyxOS", kind: "nyxos", root: "/x" });
    await t.db.insert(gitCommits).values([
      { repoId: "nyxos", sha: "aaaaaaa1111", authorDate: "2026-09-26T08:00:00Z", subject: "Älterer Commit", branch: "main" },
      { repoId: "nyxos", sha: "bbbbbbb2222", authorDate: "2026-09-26T08:41:00Z", subject: "Bericht", branch: "main", authorName: "Alex Doe", filesChanged: 2, insertions: 10, deletions: 1 },
      // Merge-Commits sind nie „die letzte Änderung“
      { repoId: "nyxos", sha: "ccccccc3333", authorDate: "2026-09-26T08:50:00Z", subject: "Merge branch 'x' into main", branch: "main", parentCount: 2 },
    ]);
    const view = latestActivityView(await loadLatestActivity(t.db, { sessions: 3, commits: 3 }), new Date("2026-09-26T09:20:00Z"));
    expect(view.letzte_session?.titel).toBe("Nyx-Denken");
    expect(view.letzte_session?.projekt).toBe("NyxOS");
    expect(view.letzte_session?.zuletzt_gefragt).toBe("Denken nie sprechen");
    expect(view.letzte_session?.zuletzt_geantwortet).toBe("AnswerGate ist fertig.");
    expect(view.weitere_sessions.map((s) => s.titel)).toEqual(["Alte Session"]);
    expect(view.letzte_aenderung?.titel).toBe("Bericht");
    expect(view.letzte_aenderung?.autor).toBe("Alex Doe");
    expect(view.letzte_aenderung?.umfang).toBe("2 Dateien, +10 −1");
    expect(view.weitere_commits).toHaveLength(1);
    expect(view.satz_session).toContain("Zuletzt ging es um: „Denken nie sprechen“");
  });
});
