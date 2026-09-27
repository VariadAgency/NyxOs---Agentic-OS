// Session-Anzeige: EIN Name je Session (Server + Web), EINE Regel für „verwaist“,
// gebündelte Sortier-Vorschläge.
import { describe, expect, it } from "vitest";
import { bundleInboxItems, isOrphanedSession, openQuestionsCaption, ORPHANED_AFTER_MS, parseSortSuggestion, sessionLabel } from "../src/index.js";

const START = "2026-09-24T18:02:00.000Z"; // 20:02 in Berlin

describe("sessionLabel: nie leer, nie eine Kennung", () => {
  it.each([
    [
      "eigener Titel",
      {
        title: "Tunnel start problem",
        titleSource: "ai",
        cwd: "/x/NyxOS",
        startedAt: START,
      },
      "Tunnel start problem",
    ],
    [
      "Titel aus dem Auftrag",
      {
        title: "/goal lies auftraege/P3-terminal/GOAL.md und arbeite",
        titleSource: "prompt",
        startedAt: START,
      },
      "P3 · Terminal",
    ],
    [
      "erste Nutzer-Nachricht gekürzt",
      {
        title: "Bevor wir mit Shop arbeiten, richte dich selbst ein: 1. Lies CLAUDE.md 2. Lies memory.md und dann noch viel mehr",
        titleSource: "prompt",
        startedAt: START,
      },
      "Bevor wir mit Shop arbeiten, richte dich selbst ein: 1 …",
    ],
    [
      "Baustelle + Startzeit",
      {
        title: null,
        baustelleLabel: "NyxOS",
        cwd: "/Users/c/NyxOS",
        startedAt: START,
      },
      "NyxOS · Session vom 24.09., 20:02",
    ],
    [
      "Ordner aus einer Worktree + Startzeit",
      {
        title: null,
        cwd: "/Users/c/projects/tools/NyxOS/.claude/worktrees/agent-abc",
        startedAt: START,
      },
      "NyxOS · Session vom 24.09., 20:02",
    ],
    ["ohne Ort nur die Zeit", { title: null, startedAt: START }, "Session vom 24.09., 20:02"],
    [
      "rohe UUID als Titel zählt nicht",
      {
        title: "8dcb7b0e-e737-4168-b084-d6eb5262ec7c",
        tool: "claude",
        startedAt: START,
      },
      "Session vom 24.09., 20:02",
    ],
    ["gar nichts bekannt", { title: null, tool: "codex" }, "Codex-Session"],
    [
      "Müll-Titel „OK“ zählt nicht",
      {
        title: "OK",
        titleSource: "ai",
        baustelleLabel: "NyxOS",
        startedAt: START,
      },
      "NyxOS · Session vom 24.09., 20:02",
    ],
  ])("%s", (_name, input, expected) => {
    expect(sessionLabel(input)).toBe(expected);
  });

  it("nie länger als 64 Zeichen, nie eine UUID", () => {
    const long = sessionLabel({
      title: "x".repeat(300),
      titleSource: "prompt",
    });
    expect(long.length).toBeLessThanOrEqual(64);
    expect(sessionLabel({ title: "00903b73-2f1a-4fdd-8d68-5f247359b598" })).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe("isOrphanedSession: leere Geister-Session", () => {
  const now = Date.parse("2026-09-26T01:00:00.000Z");
  const ghost = {
    state: "waiting",
    parsedEventCount: 0,
    tokensTotal: 0,
    lastActivityAt: "2026-09-24T18:02:03.136Z",
    startedAt: "2026-09-24T18:02:03.136Z",
  };

  it("wartet > 1 Tag ohne Nachrichten → verwaist", () => {
    expect(isOrphanedSession(ghost, now)).toBe(true);
  });
  it("jünger als 1 Tag → wartet noch normal", () => {
    expect(
      isOrphanedSession(
        {
          ...ghost,
          lastActivityAt: new Date(now - ORPHANED_AFTER_MS + 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });
  it("mit Nachrichten oder Tokens → nie verwaist", () => {
    expect(isOrphanedSession({ ...ghost, parsedEventCount: 3 }, now)).toBe(false);
    expect(isOrphanedSession({ ...ghost, tokensTotal: 10 }, now)).toBe(false);
  });
  it("nur „wartet“ kann verwaisen", () => {
    expect(isOrphanedSession({ ...ghost, state: "running" }, now)).toBe(false);
    expect(isOrphanedSession({ ...ghost, state: "idle" }, now)).toBe(false);
  });
});

describe("Sortier-Vorschläge bündeln", () => {
  const base = {
    kind: "frage" as const,
    createdBy: "haiku" as const,
    yesNo: true,
    status: "open" as const,
    createdAt: "2026-09-25T17:00:00Z",
  };
  it("erkennt Nyx- und Haiku-Vorschläge", () => {
    expect(parseSortSuggestion("Sortier-Vorschlag von Haiku: „Wie steht der Build?“ → Server & Deploy?")).toEqual({ subject: "Wie steht der Build?", target: "Server & Deploy" });
    expect(parseSortSuggestion("Sortier-Vorschlag von Nyx: „Wie steht der Build?“ → Coding?")).toEqual({ subject: "Wie steht der Build?", target: "Coding" });
    expect(parseSortSuggestion("Soll ich deployen?")).toBeNull();
  });
  it("gleiches Ziel + gleicher Wortlaut → eine Karte, andere bleiben einzeln", () => {
    const items = [
      {
        ...base,
        id: 8,
        title: "Sortier-Vorschlag von Haiku: „Wie steht der Build?“ → Server & Deploy?",
        sessionKey: "claude:b",
      },
      {
        ...base,
        id: 7,
        title: "Sortier-Vorschlag von Nyx: „wie steht der Build“ → Server & Deploy?",
        sessionKey: "claude:a",
      },
      {
        ...base,
        id: 9,
        title: "Sortier-Vorschlag von Nyx: „Wie steht der Build?“ → Coding?",
        sessionKey: "claude:c",
      },
      { ...base, id: 3, title: "Soll ich deployen?", sessionKey: null },
    ];
    const out = bundleInboxItems(items);
    expect(out.map((b) => (b.type === "sort" ? `sort:${b.items.map((i) => i.id).join("+")}` : `item:${b.item.id}`))).toEqual(["sort:8+7", "sort:9", "item:3"]);
    const first = out[0];
    expect(first?.type === "sort" && first.target).toBe("Server & Deploy");
  });
});

describe("Randfälle: sauber kürzen, Berliner Zeit, verwaist, Zähler-Text", () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("schneidet nie ein Emoji oder einen Umlaut (zwei Code-Punkte) mittendurch", () => {
    const emoji = sessionLabel({ title: `a${"🎉".repeat(80)}`, titleSource: "prompt" });
    expect(emoji).not.toMatch(LONE_SURROGATE);
    expect(emoji.endsWith(" …")).toBe(true);
    const family = sessionLabel({ title: "👩‍💻".repeat(80), titleSource: "prompt" });
    expect(family.replace(" …", "").split("👩‍💻").join("")).toBe("");
    const nfd = sessionLabel({ title: "ä".repeat(80), titleSource: "prompt" });
    expect(nfd.replace(" …", "").split("ä").join("")).toBe("");
  });

  it("kürzt am Wort-Ende und ohne Komma vor „…“", () => {
    const label = sessionLabel({
      title: "Bitte prüfe den Build der NyxOS, danach schau dir die Überblick-Kacheln genau an und berichte",
      titleSource: "prompt",
    });
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toMatch(/\p{L} …$/u);
    expect(label).not.toMatch(/[,;:] …$/);
  });

  it("Startzeit in Berliner Zeit – Sommer- und Winterzeit", () => {
    expect(sessionLabel({ title: null, startedAt: "2026-07-01T22:30:00.000Z" })).toBe("Session vom 02.07., 00:30");
    expect(sessionLabel({ title: null, startedAt: "2026-12-24T19:02:00.000Z" })).toBe("Session vom 24.12., 20:02");
  });

  it("eine Session mit Titel ist nie verwaist (auch wenn der Verlauf noch nicht eingelesen ist)", () => {
    const ghost = { state: "waiting", parsedEventCount: 0, tokensTotal: 0, lastActivityAt: "2026-09-20T10:00:00.000Z" };
    const now = Date.parse("2026-09-26T10:00:00.000Z");
    expect(isOrphanedSession(ghost, now)).toBe(true);
    expect(isOrphanedSession({ ...ghost, title: "Echte Frage" }, now)).toBe(false);
    expect(isOrphanedSession({ ...ghost, title: "  " }, now)).toBe(true);
    // Uhr des Macs vorgestellt: Aktivität „in der Zukunft“ ist nie verwaist.
    expect(isOrphanedSession({ ...ghost, lastActivityAt: "2026-09-27T10:00:00.000Z" }, now)).toBe(false);
    // Gerade gestartet, noch keine Aktivität: startedAt zählt.
    expect(isOrphanedSession({ ...ghost, lastActivityAt: null, startedAt: "2026-09-26T09:59:00.000Z" }, now)).toBe(false);
  });

  it("Überblick-Text nennt Sortier-Vorschläge, ohne sie rot zu zählen", () => {
    expect(openQuestionsCaption({ approvals: 0, inbox: 0, conflicts: 0, sorting: 1, total: 0 })).toBe("1 Sortier-Vorschlag");
    expect(openQuestionsCaption({ approvals: 1, inbox: 0, conflicts: 0, sorting: 2, total: 1 })).toBe("1 Freigabe · 2 Sortier-Vorschläge");
    // alter Server ohne `sorting`
    expect(openQuestionsCaption({ approvals: 0, inbox: 0, conflicts: 0, total: 0 })).toBe("Nichts zu entscheiden");
  });
});
