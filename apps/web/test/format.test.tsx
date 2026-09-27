import { describe, expect, it } from "vitest";
import { duration, relativeTime } from "../src/lib/format";

const NOW = Date.parse("2026-09-24T12:00:00Z");

describe("relativeTime", () => {
  it("rundet auf Minuten unter einer Stunde", () => {
    expect(relativeTime("2026-09-24T11:56:00Z", NOW)).toBe("vor 4 Min");
  });
  it("rundet auf Stunden unter einem Tag", () => {
    expect(relativeTime("2026-09-24T09:00:00Z", NOW)).toBe("vor 3 Std");
  });
  it("gibt null ohne Zeitpunkt zurück (nie erfunden)", () => {
    expect(relativeTime(null, NOW)).toBeNull();
  });
});

describe("duration", () => {
  it("zeigt Minuten für kurze Spannen", () => {
    expect(duration("2026-09-24T11:50:00Z", "2026-09-24T12:00:00Z")).toBe("10 min");
  });
  it("zeigt Stunden + Minuten", () => {
    expect(duration("2026-09-24T09:30:00Z", "2026-09-24T12:00:00Z")).toBe("2 h 30 min");
  });
  it("ohne Start: Gedankenstrich", () => {
    expect(duration(null, null)).toBe("–");
  });
});
