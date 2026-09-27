// Nyx bricht nicht mehr bei Geräuschen ab.
// - Unterbrechen nur bei echten Worten (≥ 2 Wörter bzw. „Stopp“), nie bei Phantom-Texten der Erkennung oder Echo.
// - Stille-Erkennung: Sprache erst nach 350 ms, nur im Sprachband (Straße tief, Vogel hoch zählen nicht).
// - Tempo nur beim Server (speed), die Wiedergabe bleibt bei playbackRate 1 (Safari dehnte doppelt).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLevelDrive } from "../src/features/nyx/tab/voice/level";
import { createSpeaker } from "../src/features/nyx/tab/voice/speaker";
import { isPhantom, isRealSpeech } from "../src/features/nyx/voice/turn";
import { createVadGate, voiceBandRatio } from "../src/features/nyx/voice/vadGate";

describe("Unterbrechen nur bei echten Worten", () => {
  it("Phantom-Texte und Einzelgeräusche unterbrechen nie", () => {
    for (const t of ["", "  ", "Untertitel der Amara.org-Community", "Vielen Dank.", "Danke.", "[Musik]", "*Applaus*", "Hm.", "Äh", "Tschüss!", "Ja."]) {
      expect(isRealSpeech(t), t).toBe(false);
    }
    expect(isPhantom("Untertitel im Auftrag des ZDF")).toBe(true);
  });

  it("echte Worte und klare Befehle unterbrechen", () => {
    expect(isRealSpeech("Warte mal kurz")).toBe(true);
    expect(isRealSpeech("Stopp.")).toBe(true);
    expect(isRealSpeech("Nyx, stopp")).toBe(true);
    expect(isRealSpeech("Öffne die Sessions")).toBe(true);
  });

  it("das eigene Echo unterbricht nicht", () => {
    const spoken = "Der Build auf dem Rechner ist grün und alle Tests laufen.";
    expect(isRealSpeech("der Build auf dem Rechner ist grün", spoken)).toBe(false);
  });
});

describe("Stille-Erkennung robuster", () => {
  it("Sprache erst nach 350 ms bestätigt; ein kurzer Knall (200 ms) nicht", () => {
    const g = createVadGate({ initialFloor: 0.01 });
    const loud = 0.2;
    expect(g.push(loud, 0)).toBe("arm");
    expect(g.push(loud, 200)).toBeNull();
    // Pegel ist geglättet: nach ein paar leisen Takten fällt er unter die Schwelle → verworfen.
    expect([220, 236, 252, 268, 284].map((t) => g.push(0.001, t))).toContain("discard");
    expect(g.push(loud, 1000)).toBe("arm");
    expect(g.push(loud, 1200)).toBeNull();
    expect(g.push(loud, 1360)).toBe("start");
  });

  it("laut, aber außerhalb des Sprachbands (Straße/Vogel) → kein Vorlauf", () => {
    const g = createVadGate({ initialFloor: 0.01 });
    expect(g.push(0.3, 0, 0.1)).toBeNull();
    expect(g.push(0.3, 400, 0.2)).toBeNull();
    expect(g.push(0.3, 800, 0.8)).toBe("arm");
  });

  it("Sprachband-Anteil aus dem Spektrum: Stimme hoch, Rumpeln/Zwitschern niedrig", () => {
    const bins = 1024;
    const rate = 48_000;
    const spectrum = (loHz: number, hiHz: number) => {
      const f = new Float32Array(bins).fill(-120);
      for (let i = 0; i < bins; i++) {
        const hz = (i * rate) / (2 * bins);
        if (hz >= loHz && hz <= hiHz) f[i] = -30;
      }
      return f;
    };
    expect(voiceBandRatio(spectrum(300, 3000), rate)).toBeGreaterThan(0.9);
    expect(voiceBandRatio(spectrum(80, 200), rate)).toBeLessThan(0.1);
    expect(voiceBandRatio(spectrum(4000, 8000), rate)).toBeLessThan(0.1);
  });
});

describe("Tempo nur einmal", () => {
  const created: { playbackRate: number; volume: number }[] = [];
  class FakeAudio {
    playbackRate = 1;
    volume = 1;
    preload = "";
    src = "";
    duration = 0;
    currentTime = 0;
    onended: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      created.push(this);
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  }
  afterEach(() => vi.unstubAllGlobals());

  it("setRate ändert die Wiedergabe-Geschwindigkeit NICHT (der Server spricht schon im Tempo)", () => {
    vi.stubGlobal("Audio", FakeAudio);
    const sp = createSpeaker(async () => new Blob(), createLevelDrive());
    sp.setRate(1.4);
    expect(created.at(-1)?.playbackRate).toBe(1);
    sp.duck(true);
    expect(created.at(-1)?.volume).toBeLessThan(1);
    sp.duck(false);
    expect(created.at(-1)?.volume).toBe(1);
    sp.dispose();
  });
});
