// Die Nyx-Aura bewegt sich mit der Vorlese-Stimme des Briefings. Solange ein Satz spielt, meldet der Vorleser
// einen Pegel am gemeinsamen Pegel-Bus an; ist der Satz zu Ende, meldet er ihn wieder ab.
// Ohne Web-Audio (jsdom) liefert der Leser einen ruhigen Ersatz-Pegel, solange das Element spielt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserReaderDeps } from "../src/features/haiku/briefingReader";
import { FALLBACK_LEVEL, playbackLevelReader } from "../src/features/nyx/voice/playbackLevel";
import { nyxLevelSnapshot } from "../src/features/nyx/voice/levelBus";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("Vorlese-Pegel fürs Nyx-Logo", () => {
  it("während ein Satz spielt, ist eine Pegel-Quelle angemeldet; nach dem Satz wieder weg", async () => {
    const deps = createBrowserReaderDeps();
    const before = nyxLevelSnapshot().sources;
    const h = deps.play(new Blob(["x"]));
    await h.started;
    expect(nyxLevelSnapshot().sources).toBe(before + 1);
    h.stop();
    await h.done;
    expect(nyxLevelSnapshot().sources).toBe(before);
    deps.dispose?.();
  });

  it("ohne Web-Audio: Ersatz-Pegel nur, solange das Element spielt", () => {
    const el = document.createElement("audio");
    const read = playbackLevelReader(el);
    Object.defineProperty(el, "paused", { configurable: true, get: () => false });
    expect(read()).toBe(FALLBACK_LEVEL);
    Object.defineProperty(el, "paused", { configurable: true, get: () => true });
    expect(read()).toBe(0);
  });
});
