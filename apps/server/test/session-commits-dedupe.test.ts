// Commits je Session nur einmal zählen (früher zeigten „Erledigt“/„Behoben“ denselben Commit doppelt).
import { describe, expect, it } from "vitest";
import { uniqueCommits } from "../src/session-panels.js";

const c = (sha: string, subject: string, ts: string, branch: string | null = "main") => ({ sha, subject, branch, ts });

describe("Commits je Session nur einmal", () => {
  it("Kurz- und Langkennung desselben Commits → einmal", () => {
    expect(uniqueCommits([c("5285a56", "ENDE: letztes Paket", "1"), c("5285a56f00d1", "ENDE: letztes Paket", "1")])).toHaveLength(1);
  });
  it("gleiche Nachricht, gleicher Zweig, neue Kennung (amend) → einmal, jüngste gewinnt", () => {
    const r = uniqueCommits([c("aaaaaaa", "P6: ccusage", "2026-09-25T10:00:00Z"), c("bbbbbbb", "P6: ccusage", "2026-09-25T10:05:00Z")]);
    expect(r.map((x) => x.sha)).toEqual(["bbbbbbb"]);
  });
  it("verschiedene Commits bleiben getrennt", () => {
    expect(uniqueCommits([c("aaaaaaa", "A", "1"), c("bbbbbbb", "B", "2"), c("ccccccc", "A", "3", "anderer-zweig")])).toHaveLength(3);
  });
});
