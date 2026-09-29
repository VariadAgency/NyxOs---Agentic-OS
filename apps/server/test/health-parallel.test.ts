// `/health` meldete früher auf der Probe sporadisch 503, sobald zwei Prüfungen gleichzeitig
// liefen (Kopfleiste `GET /health` + Server-Seite `GET /api/server` rufen beide `checkHealth`). Die
// Archiv-Probe-Datei hieß `.health-<pid>-<Date.now()>` — in derselben Millisekunde schreiben beide in
// DIESELBE Datei, eine liest den Inhalt der anderen bzw. findet sie schon gelöscht → „Archiv kaputt".
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Health parallel", () => {
  it("gleichzeitige Prüfungen in derselben Millisekunde stören sich nicht", async () => {
    const t = await setup();
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => t.app.request("/health")));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { checks: { archive: { ok: boolean; error?: string } } }[];
    expect(bodies.map((b) => b.checks.archive.error ?? "ok")).toEqual(Array.from({ length: 8 }, () => "ok"));
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 200));
  });
});
