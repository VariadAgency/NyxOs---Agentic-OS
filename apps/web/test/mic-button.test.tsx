// jsdom kennt weder MediaRecorder noch AudioContext/getUserMedia — dieselbe Art Stub wie
// `WebSocketStub` in test/setup.ts, hier lokal, weil nur dieser Test sie braucht.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicButton } from "../src/features/voice/MicButton";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse } from "./helpers";

class FakeTrack {
  stop() {}
}
class FakeStream {
  getTracks() {
    return [new FakeTrack()];
  }
}
class FakeAnalyser {
  fftSize = 256;
  frequencyBinCount = 128;
  getByteTimeDomainData(arr: Uint8Array) {
    arr.fill(128);
  }
}
class FakeAudioContext {
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    return Promise.resolve();
  }
}
class FakeMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  constructor(public stream: unknown) {}
  start() {
    this.ondataavailable?.({ data: new Blob(["x"]) });
  }
  stop() {
    this.onstop?.();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MicButton", () => {
  it("nimmt bei gedrückter Leertaste auf und schickt das Ergebnis nach Loslassen", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn().mockResolvedValue(new FakeStream()) }, configurable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ text: "Testdiktat", engine: "server", tookMs: 400, audioSeconds: 1.2 })),
    );
    // das Diktat ist eine Schreibaktion (POST /api/voice/transcribe) und trägt das Anmelde-Token.
    __primeAuthForTests();
    const onResult = vi.fn();
    render(<MicButton onResult={onResult} />);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    await waitFor(() => expect(screen.getByText("nimmt auf …")).toBeInTheDocument());

    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ text: "Testdiktat" })));
  });
});
