import { describe, expect, it } from "vitest";
import { ArchiveMetaSchema, IngestBatchSchema } from "../src/events.js";

const sha = "a".repeat(64);

describe("Archiv-Metadaten", () => {
  it("akzeptiert einen relativen Pfad", () => {
    const m = ArchiveMetaSchema.parse({ tool: "claude", sessionId: "abc-1", path: "-Users-alex-projects/abc-1.jsonl", sha256: sha, size: "12" });
    expect(m.size).toBe(12);
  });

  it.each(["/etc/passwd", "../x.jsonl", "a/../../x", "a//b", "./a"])("weist den Pfad %s ab", (path) => {
    expect(ArchiveMetaSchema.safeParse({ tool: "claude", sessionId: "abc", path, sha256: sha, size: 1 }).success).toBe(false);
  });

  it("weist Session-IDs mit Pfadzeichen und falsche Prüfsummen ab", () => {
    expect(ArchiveMetaSchema.safeParse({ tool: "claude", sessionId: "../x", path: "a.jsonl", sha256: sha, size: 1 }).success).toBe(false);
    expect(ArchiveMetaSchema.safeParse({ tool: "claude", sessionId: "x", path: "a.jsonl", sha256: "XYZ", size: 1 }).success).toBe(false);
    expect(ArchiveMetaSchema.safeParse({ tool: "gemini", sessionId: "x", path: "a.jsonl", sha256: sha, size: 1 }).success).toBe(false);
  });
});

describe("Ingest-Paket", () => {
  const ev = { id: "claude:s:u1", tool: "claude", sessionId: "s", ts: "2026-09-24T10:00:00.000Z", kind: "prompt", source: "file", data: {} };

  it("akzeptiert ein gültiges Event", () => {
    expect(IngestBatchSchema.safeParse({ items: [{ type: "event", event: ev }] }).success).toBe(true);
  });

  it("weist leere Pakete, unbekannte Arten und fehlende Zeitstempel ab", () => {
    expect(IngestBatchSchema.safeParse({ items: [] }).success).toBe(false);
    expect(IngestBatchSchema.safeParse({ items: [{ type: "event", event: { ...ev, kind: "irgendwas" } }] }).success).toBe(false);
    expect(IngestBatchSchema.safeParse({ items: [{ type: "event", event: { ...ev, ts: "gestern" } }] }).success).toBe(false);
    expect(IngestBatchSchema.safeParse({ items: [{ type: "sonstwas" }] }).success).toBe(false);
  });
});
