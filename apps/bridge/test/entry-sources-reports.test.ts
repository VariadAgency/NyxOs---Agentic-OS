// Die Brücke schickt zu jeder GOAL.md den BERICHT.md mit, wenn einer direkt daneben liegt — daran
// erkennt der Server fertige Aufträge. Berichte ohne GOAL daneben (oder in versteckten Ordnern) gehen
// nicht raus.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { entrySourceKind, type EntrySourcesIngest } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { EntrySourcesSync, rejectedReportPath, scanEntrySources } from "../src/entry-sources.js";

function project() {
  const root = mkdtempSync(join(tmpdir(), "nyxos-bericht-"));
  const put = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  put("werkzeug/auftraege/P1-fundament/GOAL.md", "# P1\n");
  put("werkzeug/auftraege/P1-fundament/BERICHT.md", "# Bericht P1\n");
  put("werkzeug/auftraege/R2-nyx/GOAL.md", "# R2\n");
  put("werkzeug/auftraege/R2-nyx/pakete/BERICHT.md", "# Teilbericht, keine GOAL daneben\n");
  put("app/docs/feature-a/GOAL.md", "# A\n");
  put("app/docs/lose/BERICHT.md", "# ohne GOAL\n");
  put("doku/x/GOAL.md", "# X\n");
  put(".archiv/alt/GOAL.md", "# Archiv\n");
  put(".archiv/alt/BERICHT.md", "# Archiv-Bericht\n");
  return root;
}

describe("scanEntrySources liefert Berichte neben GOAL.md", () => {
  it("nur BERICHT.md mit GOAL.md im selben Ordner", async () => {
    const scan = await scanEntrySources([project()]);
    expect(scan.complete).toBe(true);
    expect(scan.files.map((f) => f.path).sort()).toEqual([
      "app/docs/feature-a/GOAL.md",
      "doku/x/GOAL.md",
      "werkzeug/auftraege/P1-fundament/BERICHT.md",
      "werkzeug/auftraege/P1-fundament/GOAL.md",
      "werkzeug/auftraege/R2-nyx/GOAL.md",
    ]);
    expect(scan.files.find((f) => f.path.endsWith("P1-fundament/BERICHT.md"))?.content).toContain("Bericht P1");
  });
});

// Deploy-Reihenfolge. Läuft die neue Brücke gegen einen alten Server (kennt BERICHT.md
// nicht, lehnt die ganze Lieferung mit 400 „Pfad nicht erlaubt“ ab), dürfen die Aufträge nicht hängen
// bleiben: sofort ohne Berichte erneut, kein Endlos-Wiederholen derselben Lieferung.
describe("alter Server ohne BERICHT.md", () => {
  it("schickt nach der 400 sofort ohne Berichte, danach bleibt es ruhig", async () => {
    const root = project();
    const bodies: EntrySourcesIngest[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as EntrySourcesIngest;
      bodies.push(body);
      // Wie der alte Server: BERICHT.md ist dort „nicht erlaubt“, die ganze Lieferung fliegt raus.
      const bad = body.files.find((f) => entrySourceKind(f.path) === "report");
      if (bad) return new Response(JSON.stringify({ error: `Pfad nicht erlaubt: ${bad.path}` }), { status: 400 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const sync = new EntrySourcesSync({ projectRoots: [root], serverUrl: "http://srv", token: "t" }, () => {}, fetchImpl, { watch: false, intervalMs: 0, minBackoffMs: 20 });
    try {
      await sync.start();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.files.map((f) => f.path)).not.toContain("werkzeug/auftraege/P1-fundament/BERICHT.md");
      expect(bodies[1]?.files.map((f) => f.path)).toContain("werkzeug/auftraege/P1-fundament/GOAL.md");
      expect(sync.status.lastOkAt).not.toBeNull();
      expect(sync.status.lastError).toContain("Berichte");
      await new Promise((r) => setTimeout(r, 120)); // kein geplanter Wiederholungsversuch
      await sync.syncNow(); // unverändert → nichts Neues
      expect(bodies).toHaveLength(2);
    } finally {
      await sync.stop();
    }
  });

  it("andere 400er bleiben normale Fehler (Backoff), nur BERICHT.md löst das Weglassen aus", () => {
    expect(rejectedReportPath(JSON.stringify({ error: "Pfad nicht erlaubt: werkzeug/auftraege/P1/BERICHT.md" }))).toBe(true);
    expect(rejectedReportPath(JSON.stringify({ error: "Pfad nicht erlaubt: app/docs/x/NOTIZ.md" }))).toBe(false);
    expect(rejectedReportPath(JSON.stringify({ error: "Ungültige Lieferung" }))).toBe(false);
    expect(rejectedReportPath("kaputt")).toBe(false);
  });
});
