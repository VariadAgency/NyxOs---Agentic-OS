import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { searchDocs, sessions } from "../src/db/schema.js";
import { search } from "../src/search.js";
import { setup } from "./helpers.js";

// Leistungstest: "Suche < 300 ms bei allen vorhandenen Sessions" — der echte
// Bestand hatte 47 Sessions/~650 MB Archiv. Diese Datei baut direkt `search_docs`-Zeilen
// (kein Umweg über echte Archiv-Dateien/Parser — der ist bereits in transcript.perf.test.ts
// gemessen) in derselben Größenordnung wie ein realistischer Vollausbau: ≥ 50 Sessions,
// ≥ 200.000 Chat-Abschnitte. Grenzwert hier ist großzügig für CI (langsamere/geteilte Runner); der
// tatsächlich lokal gemessene Wert liegt deutlich darunter. Die echte Messung gegen die
// Produktions-DB (47 Sessions, größter Verlauf 75 MB) erfolgt nach dem Deploy.
const SESSION_COUNT = 50;
const CHAT_ROWS_PER_SESSION = 4000; // 50 * 4000 = 200.000
const NEEDLE_SESSION_IDX = 7;
const NEEDLE_ROW_IDX = 1234;

function docRow(sessionKey: string, field: "title" | "chat", position: number | null, text: string) {
  return {
    sessionKey,
    field,
    position,
    text,
    tsvGerman: sql`to_tsvector('german', ${text})`,
    tsvSimple: sql`to_tsvector('simple', ${text})`,
  } as unknown as typeof searchDocs.$inferInsert;
}

describe("Leistung: großer Bestand", () => {
  it(
    "Suche über 50 Sessions / 200.000 Chat-Abschnitte < 2000 ms (Grenzwert großzügig für CI, echter Wert im Bericht)",
    async () => {
      const t = await setup();
      const now = new Date("2026-09-24T20:00:00.000Z");

      const sessionRows = Array.from({ length: SESSION_COUNT }, (_, s) => ({
        id: `claude:perf-session-${s}`,
        tool: "claude" as const,
        sessionId: `perf-session-${s}`,
        title: `Perf-Session ${s} Konfiguration`,
        categoryArt: "coding",
        categoryBaustelleSlug: "nyxos",
        categoryBaustelleLabel: "NyxOS",
        state: "idle",
        startedAt: now.toISOString(),
        lastActivityAt: new Date(now.getTime() - s * 60_000).toISOString(),
      }));
      await t.db.insert(sessions).values(sessionRows);

      const rows: ReturnType<typeof docRow>[] = [];
      for (let s = 0; s < SESSION_COUNT; s++) {
        const sessionKey = `claude:perf-session-${s}`;
        rows.push(docRow(sessionKey, "title", null, sessionRows[s]?.title ?? ""));
        for (let i = 0; i < CHAT_ROWS_PER_SESSION; i++) {
          // Jeder 50. Eintrag trägt zusätzlich "Konfiguration" (mittelhäufiger Begriff, ~4000
          // Treffer insgesamt — stresst Rang/Fenster-Funktion über viele Sessions hinweg).
          const withKonfig = i % 50 === 0 ? " zur Konfiguration" : "";
          const isNeedle = s === NEEDLE_SESSION_IDX && i === NEEDLE_ROW_IDX;
          const text = isNeedle
            ? "Bitte die Zylinderkopfdichtung im Protokoll vermerken"
            : `Eintrag Nummer ${i} in Session ${s} über den Stand der Dinge und offene Punkte${withKonfig}`;
          rows.push(docRow(sessionKey, "chat", i, text));
        }
      }
      expect(rows.length).toBeGreaterThanOrEqual(SESSION_COUNT * CHAT_ROWS_PER_SESSION);

      const CHUNK = 1000;
      const insertStart = performance.now();
      for (let i = 0; i < rows.length; i += CHUNK) await t.db.insert(searchDocs).values(rows.slice(i, i + CHUNK));
      const insertMs = performance.now() - insertStart;

      // Mittelhäufiger Begriff, über alle Sessions verteilt (~4000 Treffer vor der 3er-Kappung je Session).
      const t0 = performance.now();
      const common = await search(t.db, "Konfiguration", 20);
      const commonMs = performance.now() - t0;
      expect(common.hits.length).toBeGreaterThan(0);
      expect(common.hits.some((h) => h.field === "title")).toBe(true);

      // Nadel im Heuhaufen: genau ein Treffer unter 200.000 Zeilen.
      const t1 = performance.now();
      const needle = await search(t.db, "Zylinderkopfdichtung", 20);
      const needleMs = performance.now() - t1;
      expect(needle.hits).toHaveLength(1);
      expect(needle.hits[0]?.sessionId).toBe(`perf-session-${NEEDLE_SESSION_IDX}`);
      expect(needle.hits[0]?.position).toBe(NEEDLE_ROW_IDX);

      console.log(
        `[search-perf] ${SESSION_COUNT} Sessions, ${rows.length} search_docs-Zeilen, Einfügen ${insertMs.toFixed(0)} ms, ` +
          `häufiger Begriff ${commonMs.toFixed(0)} ms (server-seitig ${common.tookMs} ms), Nadel ${needleMs.toFixed(0)} ms (server-seitig ${needle.tookMs} ms)`,
      );
      // Großzügige CI-Grenze; der tatsächliche Wert steht im Bericht (Ziel < 300 ms, echte Messung nach Deploy auf dem Server).
      expect(commonMs).toBeLessThan(2000);
      expect(needleMs).toBeLessThan(2000);
    },
    180_000,
  );
});
