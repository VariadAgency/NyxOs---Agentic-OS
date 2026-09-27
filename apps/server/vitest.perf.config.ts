import { defineConfig } from "vitest/config";

// Leistungstests (*.perf.test.ts) in einem eigenen Projekt, das SERIELL läuft. Grund:
// `pnpm test` war nach dem Zusammenführen einmal rot (Vitest-Timeout in einem Perf-Test), drei
// Folgeläufe grün — reproduziert (4 von 5 lokalen Läufen rot). Die eigentlichen, in ABNAHME
// gemessenen Werte (z. B. "erste Seite < 5 s") waren dabei nie das Problem (real gemessen:
// wenige ms) — der Vitest-eigene Test-Timeout (30 s) riss, weil `apps/server/test/*.test.ts`
// mit ~10 Dateien, jede mit einer frisch gestarteten PGlite-Instanz je `it()`, plus die zweite
// Perf-Datei gleichzeitig um dieselben ~10 CPU-Kerne konkurrieren — der 75-MB-Fixture-Aufbau
// (Gzip, Parser) ist CPU-gebunden und wird dann ausgebremst. Fix: Perf-Dateien laufen nicht mehr
// im normalen "server"-Projekt (dort ausgeschlossen, s. vitest.config.ts) und hier `fileParallelism:
// false`, damit sie sich nicht mal gegenseitig Konkurrenz machen. Der Timeout ist bewusst
// großzügiger (60 s statt 30/180 s Voreinstellung) für den verbleibenden Rest an
// Konkurrenz durch die anderen Vitest-Projekte (bridge/web/shared laufen weiter parallel) —
// die fachlichen Grenzwerte in den Tests selbst (5000 ms / 500 ms / 2000 ms) bleiben unverändert
// scharf, nur der Rahmen ums Fixture-Bauen bekommt mehr Luft.
export default defineConfig({
  test: {
    name: "server-perf",
    include: ["test/**/*.perf.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
