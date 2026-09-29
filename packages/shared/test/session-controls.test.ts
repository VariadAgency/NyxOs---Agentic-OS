// Session-Steuerung – je Werkzeug die richtige Modell-Liste, der richtige Befehl und nichts,
// was das Werkzeug nicht kann.
import { describe, expect, it } from "vitest";
import { buildControlCommand, claudeEffortLevels, sessionControlsFor } from "../src/session-controls.js";

describe("Session-Steuerung", () => {
  it("Claude: nur Anthropic-Modelle, das aktuelle ist markiert", () => {
    const v = sessionControlsFor("claude", "claude-opus-5-5");
    expect(v.model.canSwitch).toBe(true);
    expect(v.model.options.length).toBeGreaterThan(3);
    expect(v.model.options.every((m) => m.id.startsWith("claude-"))).toBe(true);
    expect(v.model.options.filter((m) => m.current).map((m) => m.id)).toEqual(["claude-opus-5-5"]);
    // Haiku mit Datum im Transkript = derselbe Eintrag
    expect(sessionControlsFor("claude", "claude-haiku-4-5-20251001").model.options.find((m) => m.current)?.name).toBe("Claude Haiku 4.5");
  });

  it("Claude: Denkaufwand-Stufen wie im Programm (ältere Modelle weniger oder keine)", () => {
    expect(claudeEffortLevels("claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
    expect(claudeEffortLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max", "auto"]);
    expect(claudeEffortLevels("claude-opus-4-5")).toEqual(["low", "medium", "high", "auto"]);
    expect(claudeEffortLevels("claude-haiku-4-5-20251001")).toEqual([]);
    expect(claudeEffortLevels("claude-3-5-sonnet-20241022")).toEqual([]);
    expect(claudeEffortLevels(null)).toEqual([]);
    const haiku = sessionControlsFor("claude", "claude-haiku-4-5");
    expect(haiku.effort.canSet).toBe(false);
    expect(haiku.effort.levels).toEqual([]);
  });

  it("Claude: Befehle `/model <id>` und `/effort <stufe>`", () => {
    expect(buildControlCommand("claude", "claude-opus-5-5", { kind: "model", model: "claude-sonnet-5" })).toEqual({ ok: true, command: "/model claude-sonnet-5" });
    expect(buildControlCommand("claude", "claude-opus-5-5", { kind: "effort", level: "xhigh" })).toEqual({ ok: true, command: "/effort xhigh" });
    expect(buildControlCommand("claude", "claude-opus-5-5", { kind: "effort", level: "auto" })).toEqual({ ok: true, command: "/effort auto" });
  });

  it("nie etwas anbieten/senden, was das Werkzeug nicht kann", () => {
    // fremdes Modell in einer Claude-Session
    expect(buildControlCommand("claude", "claude-opus-5-5", { kind: "model", model: "gpt-5" }).ok).toBe(false);
    // schon aktiv
    expect(buildControlCommand("claude", "claude-opus-5-5", { kind: "model", model: "claude-opus-5-5" }).ok).toBe(false);
    // Stufe, die das Modell nicht kennt
    expect(buildControlCommand("claude", "claude-opus-4-5", { kind: "effort", level: "max" }).ok).toBe(false);
    expect(buildControlCommand("claude", "claude-haiku-4-5", { kind: "effort", level: "low" }).ok).toBe(false);
    // Codex: `/model gpt-5.5` ginge als Nachricht an das Modell → weder Liste noch Befehl
    const codex = sessionControlsFor("codex", "gpt-6-astra");
    expect(codex.model.canSwitch).toBe(false);
    expect(codex.model.options).toEqual([]);
    expect(codex.effort.canSet).toBe(false);
    expect(codex.compact.available).toBe(true);
    expect(buildControlCommand("codex", "gpt-6-astra", { kind: "model", model: "gpt-5.5" }).ok).toBe(false);
    expect(buildControlCommand("codex", "gpt-6-astra", { kind: "effort", level: "high" }).ok).toBe(false);
    // Unbekanntes Werkzeug: gar nichts
    const other = sessionControlsFor("opencode", "anthropic/claude-sonnet-5");
    expect(other.model.canSwitch || other.effort.canSet || other.compact.available).toBe(false);
  });
});
