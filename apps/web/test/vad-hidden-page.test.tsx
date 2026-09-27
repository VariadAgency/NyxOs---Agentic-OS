// Dauer-Zuhören nimmt nichts auf, solange NyxOS verborgen ist (anderes Fenster/Tab).
import { afterEach, describe, expect, it, vi } from "vitest";
import { startVad } from "../src/features/nyx/voice/vad";

describe("Stille-Erkennung", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("startet keine Aufnahme, solange die Seite verborgen ist", async () => {
    vi.useFakeTimers();
    const started: unknown[] = [];
    class FakeRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported = () => true;
      start() {
        this.state = "recording";
        started.push(this);
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    class FakeCtx {
      resume = async () => undefined;
      close = async () => undefined;
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
      createAnalyser = () => ({ fftSize: 1024, smoothingTimeConstant: 0, getFloatTimeDomainData: (b: Float32Array) => b.fill(0.6) });
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeCtx);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const onSegment = vi.fn();
    const h = await startVad({ onSegment });
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toHaveLength(0);
    expect(onSegment).not.toHaveBeenCalled();
    h?.stop();
  });
});
