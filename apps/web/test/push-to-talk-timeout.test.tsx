// Halten zum Sprechen nimmt nie endlos auf (verlorenes Loslassen, z. B. nach Cmd+Tab).
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMicCapture } from "../src/features/nyx/tab/voice/mic";
import { createLevelDrive } from "../src/features/nyx/tab/voice/level";

describe("Halten zum Sprechen", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("beendet die Aufnahme nach spätestens 20 s von selbst und schickt sie ab", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
    class FakeRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported = () => true;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["x"]) });
        this.onstop?.();
      }
    }
    class FakeCtx {
      resume = async () => undefined;
      close = async () => undefined;
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
      createAnalyser = () => ({
        fftSize: 2048,
        frequencyBinCount: 1024,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: (b: Float32Array) => b.fill(0),
        getFloatFrequencyData: (b: Float32Array) => b.fill(-100),
      });
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeCtx);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [] }) } });

    const onSegment = vi.fn();
    const mic = await openMicCapture(createLevelDrive(), { onSpeechStart: vi.fn(), onSegment, onError: vi.fn() }, "ptt");
    expect(mic).not.toBeNull();
    mic?.pttStart();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onSegment).toHaveBeenCalledTimes(1);
    mic?.close();
  });
});
