// Zu jeder Nachricht ein Knopf, damit Nyx alles noch einmal vorliest.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithClient } from "./helpers";

const pushed: string[] = [];
const cancels: number[] = [];
vi.mock("../src/features/nyx/voice/speaker", () => ({
  createSpeaker: () => {
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    return {
      push: (t: string) => pushed.push(t),
      say: () => {},
      end: () => done,
      cancel: () => {
        cancels.push(1);
        resolve();
      },
      level: () => 0,
    };
  },
}));

const { ReadAloudMessageButton, speakableText } = await import("../src/components/nyx/ReadAloudMessageButton");
const { NyxAskChip, NyxSummaryPanel, useDecisionNyx } = await import("../src/features/inbox/DecisionNyx");

function DecisionProbe() {
  const nyx = useDecisionNyx("inbox", 8);
  return (
    <>
      <NyxAskChip nyx={nyx} />
      <NyxSummaryPanel nyx={nyx} />
    </>
  );
}

describe("Vorlesen an jeder Nachricht", () => {
  it("liest den ganzen Text ohne Markdown-Zeichen; zweiter Klick stoppt", async () => {
    render(<ReadAloudMessageButton text={"## Wer ich bin\n\nIch bin **Nyx**.\n\n- Sessions\n- [Git](/git)\n\n---\nEnde."} />);
    fireEvent.click(screen.getByRole("button", { name: "Diese Antwort vorlesen" }));
    expect(pushed.at(-1)).toBe("Wer ich bin.\nIch bin Nyx.\nSessions\nGit.\nEnde.".replace(/\n(?=Git)/, "\n"));
    fireEvent.click(await screen.findByRole("button", { name: "Vorlesen stoppen" }));
    expect(cancels.length).toBe(1);
    expect(await screen.findByRole("button", { name: "Diese Antwort vorlesen" })).toBeInTheDocument();
  });

  it("speakableText entfernt Code, Links, Überschriften", () => {
    expect(speakableText("# Titel\n`x` und [Link](https://a.b) und ```\ncode\n```")).toBe("Titel.\nx und Link und");
  });

  it("nur EINE Stimme – „Vorlesen“ in Nyx' Einschätzung beendet ein laufendes Vorlesen einer Nachricht und umgekehrt", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ summary: { worum: "W", empfehlung: { wahl: "Nein", grund: "G" }, wichtig: ["I"], at: new Date().toISOString(), cached: false } })));
    renderWithClient(
      <>
        <ReadAloudMessageButton text="Eine lange Antwort." />
        <DecisionProbe />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Diese Antwort vorlesen" }));
    expect(await screen.findByRole("button", { name: "Vorlesen stoppen" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("decision-ask-nyx"));
    fireEvent.click(await screen.findByRole("button", { name: "▶ Vorlesen" }));
    // Die Nachricht ist verstummt, die Einschätzung spricht.
    expect(await screen.findByRole("button", { name: "Diese Antwort vorlesen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "■ Stopp" })).toBeInTheDocument();
    // Umgekehrt: die Nachricht wieder starten beendet die Einschätzung.
    fireEvent.click(screen.getByRole("button", { name: "Diese Antwort vorlesen" }));
    expect(await screen.findByRole("button", { name: "▶ Vorlesen" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
