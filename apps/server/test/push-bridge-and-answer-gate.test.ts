// Grenzfälle: Mac-Mitteilung mit langen/leeren Texten, Push-Thema nur mit Anmeldung, zurückgenommene Gedanken.
import { describe, expect, it } from "vitest";
import { AnswerGate } from "../src/nyx/answerGate.js";
import { MultiChannelSender, type BridgeNotifier, type LiveBroadcaster } from "../src/push/channels.js";
import { needsAuth } from "../src/terminal/auth.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { MacNotifyRequestSchema } from "@nyxos/shared";

class Bridge implements BridgeNotifier {
  calls: unknown[] = [];
  online = true;
  supports(): boolean {
    return true;
  }
  async rpc(_m: "notify", params: unknown) {
    // wie die echte Brücke: Parameter gegen das Schema prüfen
    const ok = MacNotifyRequestSchema.safeParse(params).success;
    this.calls.push(params);
    return ok ? { ok: true } : { ok: false, error: "ungültig" };
  }
}
const live: LiveBroadcaster = { size: 0, broadcast() {} };

describe("Mitteilung über den Mac-Weg", () => {
  it("lange oder leere Texte scheitern nicht an der Prüfung der Brücke", async () => {
    const bridge = new Bridge();
    const s = new MultiChannelSender({ ntfy: () => new FakeNtfySender(), bridge, live });
    const long = await s.send({ topic: "t", title: "T".repeat(500), message: "x".repeat(5000), priority: "default", clickUrl: null, kind: "test" });
    expect(long.channels?.find((c) => c.channel === "mac")?.ok).toBe(true);
    const empty = await s.send({ topic: "t", title: "Wartet", message: "   ", priority: "default", clickUrl: null, kind: "test" });
    expect(empty.channels?.find((c) => c.channel === "mac")?.ok).toBe(true);
  });
});

describe("Push-Thema nur mit Anmeldung", () => {
  it("GET /api/push/subscribe ist immer geschützt", async () => {
    expect(needsAuth("GET", "/api/push/subscribe", false)).toBe(true);
  });
});

describe("AnswerGate", () => {
  it("ein langer, schon gestreamter Gedanke wird mit retract zurückgenommen, die Antwort danach bleibt sauber", () => {
    const g = new AnswerGate({ filler: "Ich schau mal.", releaseChars: 10 });
    expect(g.push("Ich prüfe erst die Sessions und dann die Commits.")).toEqual([{ type: "delta", text: "Ich prüfe erst die Sessions und dann die Commits." }]);
    expect(g.tool()).toEqual([
      { type: "thought", text: "Ich prüfe erst die Sessions und dann die Commits.", retract: true },
      { type: "filler", text: "Ich schau mal." },
    ]);
    g.push("Zweite Runde.");
    expect(g.tool()).toEqual([{ type: "thought", text: "Zweite Runde.", retract: true }]);
    expect(g.push("Kurz")).toEqual([]);
    expect(g.end()).toEqual([{ type: "delta", text: "Kurz" }]);
    expect(g.answer("Ich prüfe erst die Sessions und dann die Commits.Zweite Runde.Kurz")).toBe("Kurz");
  });
});
