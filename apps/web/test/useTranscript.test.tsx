// Der Chat-Hook lädt bei einem `/live`-Signal die jüngste Seite neu
// statt sich auf einen einmal berechneten `nextCursor` zu verlassen (der nach dem ersten Aufholen
// dauerhaft `null` bleibt und den Live-Effekt so für immer abschaltet). Diese Tests laufen direkt
// gegen den Hook (statt durch die ganze App), weil sich Zeitpunkt/Reihenfolge der Antworten hier
// exakt steuern lassen — insbesondere der Session-Wechsel MITTEN in einer laufenden Anfrage.
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTranscript } from "../src/hooks/useSessionApi";
import type { TranscriptResponse } from "../src/lib/api";
import { ApiError } from "../src/lib/http";

const fetchTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, fetchTranscript: fetchTranscriptMock };
});

function item(id: string, text: string) {
  return { id, ts: new Date().toISOString(), role: "assistant" as const, text, thinking: false as const };
}

function page(items: ReturnType<typeof item>[]): TranscriptResponse {
  return { items, nextCursor: null, prevCursor: null, archivedAt: null, sha256: "x" };
}

afterEach(() => {
  fetchTranscriptMock.mockReset();
});

describe("useTranscript: Live-Nachwachsen", () => {
  it("hängt bei liveTick neue Einträge an, ohne zu doppeln — auch nach mehreren Malen", async () => {
    fetchTranscriptMock
      .mockResolvedValueOnce(page([item("m1", "eins"), item("m2", "zwei")]))
      .mockResolvedValueOnce(page([item("m1", "eins"), item("m2", "zwei"), item("m3", "drei")]))
      .mockResolvedValueOnce(page([item("m1", "eins"), item("m2", "zwei"), item("m3", "drei"), item("m4", "vier")]));

    const { result, rerender } = renderHook(({ liveTick }: { liveTick: number }) => useTranscript("s1", { liveTick }), {
      initialProps: { liveTick: 0 },
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m1", "m2"]));

    rerender({ liveTick: 1 });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m1", "m2", "m3"]));

    // Ein zweites Signal (nicht nur das erste) hängt weiterhin sauber an — vorher brach der
    // Live-Effekt nach dem ersten Aufholen ab, weil `nextCursor` dann dauerhaft `null` war.
    rerender({ liveTick: 2 });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m1", "m2", "m3", "m4"]));

    expect(fetchTranscriptMock).toHaveBeenCalledTimes(3);
    // Jeder Live-Aufruf lädt die jüngste Seite neu (kein Cursor) statt einem `nextCursor` zu folgen.
    for (const call of fetchTranscriptMock.mock.calls.slice(1)) {
      expect(call[1]).toMatchObject({ direction: "backward" });
      expect((call[1] as { cursor?: unknown }).cursor).toBeUndefined();
    }
  });

  it("verwirft eine Live-Antwort, die erst nach einem Session-Wechsel eintrifft", async () => {
    const late: { resolve: ((v: TranscriptResponse) => void) | null } = { resolve: null };
    fetchTranscriptMock
      .mockImplementationOnce(() => Promise.resolve(page([item("a1", "A eins")]))) // 1: initiale Ladung Session A
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptResponse>((resolve) => {
            late.resolve = resolve; // 2: Live-Nachladen A — bleibt offen, bis der Test es manuell auflöst
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(page([item("b1", "B eins")]))); // 3: initiale Ladung Session B

    const { result, rerender } = renderHook(({ id, liveTick }: { id: string; liveTick: number }) => useTranscript(id, { liveTick }), {
      initialProps: { id: "session-a", liveTick: 0 },
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["a1"]));

    rerender({ id: "session-a", liveTick: 1 }); // löst die (hängende) Live-Anfrage für A aus
    await waitFor(() => expect(fetchTranscriptMock).toHaveBeenCalledTimes(2));

    rerender({ id: "session-b", liveTick: 1 }); // Session-Wechsel, WÄHREND die Live-Anfrage für A noch offen ist
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["b1"]));

    // Die verspätete Antwort für A trifft jetzt erst ein — darf NICHT mehr in den (inzwischen
    // B-)Verlauf einfließen (Session-ID-Prüfung + abgebrochener AbortController).
    late.resolve?.(page([item("a1", "A eins"), item("a2", "A zwei (verspätet)")]));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);
    // Der Wechsel selbst hat keinen weiteren (redundanten) Live-Nachlade-Aufruf für B ausgelöst.
    expect(fetchTranscriptMock).toHaveBeenCalledTimes(3);
  });
});

// Nach einem Such-Sprung (`around`) steht das Fenster NICHT am Ende des
// Verlaufs (`nextCursor !== null`). Ein `/live`-Signal darf dann nicht blind die jüngste Seite
// anhängen (das risse eine Lücke) — nur `newerAvailable` melden; `jumpToLatest()` holt bewusst nach.
describe("useTranscript: Fenster nicht am Ende — kein blindes Anhängen", () => {
  it("setzt `newerAvailable` statt anzuhängen, wenn das Fenster (around) nicht am Ende steht", async () => {
    fetchTranscriptMock.mockResolvedValueOnce({
      items: [item("m3", "drei"), item("m4", "vier")],
      nextCursor: "cursor-mehr-danach", // Fenster steht NICHT am Ende
      prevCursor: "cursor-davor",
      anchorIndex: 0,
      archivedAt: null,
      sha256: "x",
    });

    const { result, rerender } = renderHook(({ liveTick }: { liveTick: number }) => useTranscript("s1", { around: 10, liveTick }), {
      initialProps: { liveTick: 0 },
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m3", "m4"]));
    expect(result.current.newerAvailable).toBe(false);

    rerender({ liveTick: 1 });
    await waitFor(() => expect(result.current.newerAvailable).toBe(true));
    // Kein zusätzlicher Fetch — es wurde bewusst NICHT nachgeladen (keine Lücke riskiert).
    expect(fetchTranscriptMock).toHaveBeenCalledTimes(1);
    expect(result.current.items.map((i) => i.id)).toEqual(["m3", "m4"]); // unverändert, keine Lücke

    // "Zu den neuesten springen" holt bewusst die jüngste Seite nach.
    fetchTranscriptMock.mockResolvedValueOnce({ items: [item("m9", "neu")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "y" });
    result.current.jumpToLatest();
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m9"]));
    expect(result.current.newerAvailable).toBe(false);
  });
});

// `loadOlder` prüfte die Session nicht — eine verspätete Antwort nach
// einem Session-Wechsel MITTEN in der Anfrage durfte fremde Einträge/Cursor VORN einmischen.
describe("useTranscript: loadOlder verwirft eine Antwort nach Session-Wechsel", () => {
  it("mischt eine verspätete `loadOlder`-Antwort NICHT mehr in den (inzwischen gewechselten) Verlauf", async () => {
    const late: { resolve: ((v: TranscriptResponse) => void) | null } = { resolve: null };
    fetchTranscriptMock
      .mockResolvedValueOnce({ items: [item("a2", "A zwei")], nextCursor: null, prevCursor: "cursor-a-alt", archivedAt: null, sha256: "a" }) // initiale Ladung A
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptResponse>((resolve) => {
            late.resolve = resolve; // loadOlder für A — bleibt offen
          }),
      )
      .mockResolvedValueOnce({ items: [item("b1", "B eins")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "b" }); // initiale Ladung B

    const { result, rerender } = renderHook(({ id }: { id: string }) => useTranscript(id), { initialProps: { id: "session-a" } });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["a2"]));

    result.current.loadOlder(); // hängende Anfrage für A
    await waitFor(() => expect(fetchTranscriptMock).toHaveBeenCalledTimes(2));

    rerender({ id: "session-b" }); // Session-Wechsel, WÄHREND loadOlder für A noch offen ist
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["b1"]));

    late.resolve?.({ items: [item("a1", "A eins (verspätet)"), item("a2", "A zwei")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Die verspätete Antwort für A ist NICHT vorn in den (jetzt B-)Verlauf gerutscht.
    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);
  });
});

// Doppelte wurden nur per `id` erkannt — ein Werkzeug-Eintrag, dessen
// Status (oder eine Sub-Agent-Zählung) erst SPÄTER eintrifft, blieb dauerhaft veraltet, weil die
// bekannte `id` beim Live-Nachladen einfach übersprungen statt ersetzt wurde.
describe("useTranscript: bekannte Einträge werden beim Live-Nachladen ERSETZT", () => {
  it("übernimmt einen später eintreffenden Werkzeug-Status für eine schon bekannte id", async () => {
    const toolPending = { id: "t1", ts: new Date().toISOString(), role: "tool" as const, tool: { name: "Bash" }, thinking: false as const };
    const toolDone = { id: "t1", ts: toolPending.ts, role: "tool" as const, tool: { name: "Bash", status: "ok" as const }, thinking: false as const };

    fetchTranscriptMock
      .mockResolvedValueOnce({ items: [toolPending], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" })
      .mockResolvedValueOnce({ items: [toolDone], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "b" });

    const { result, rerender } = renderHook(({ liveTick }: { liveTick: number }) => useTranscript("s1", { liveTick }), {
      initialProps: { liveTick: 0 },
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]?.tool?.status).toBeUndefined();

    rerender({ liveTick: 1 });
    await waitFor(() => expect(result.current.items[0]?.tool?.status).toBe("ok"));
    expect(result.current.items).toHaveLength(1); // ersetzt, nicht dupliziert
  });
});

// Eine gerade in der NyxOS gestartete Session hat noch kein Archiv (404). Der
// Chat zeigte dann dauerhaft „Chat konnte nicht geladen werden“ — auch nachdem Claude längst geantwortet
// hatte, weil ein erfolgreiches Live-Nachladen den Fehler nie zurücksetzte.
describe("useTranscript: neue Session ohne Archiv", () => {
  it("404 = noch kein Verlauf (kein Fehler); das nächste Live-Signal füllt den Chat", async () => {
    fetchTranscriptMock.mockRejectedValueOnce(new ApiError("Server antwortet mit 404", 404)).mockResolvedValueOnce(page([item("m1", "erste Antwort")]));
    const { result, rerender } = renderHook(({ liveTick }: { liveTick: number }) => useTranscript("neu", { liveTick }), { initialProps: { liveTick: 0 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.items).toEqual([]);
    rerender({ liveTick: 1 });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m1"]));
    expect(result.current.isError).toBe(false);
  });

  it("ein anderer Fehler bleibt ein Fehler, bis ein Live-Nachladen klappt", async () => {
    fetchTranscriptMock.mockRejectedValueOnce(new ApiError("Server antwortet mit 500", 500)).mockResolvedValueOnce(page([item("m1", "da")]));
    const { result, rerender } = renderHook(({ liveTick }: { liveTick: number }) => useTranscript("kaputt", { liveTick }), { initialProps: { liveTick: 0 } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    rerender({ liveTick: 1 });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["m1"]));
    expect(result.current.isError).toBe(false);
  });
});
