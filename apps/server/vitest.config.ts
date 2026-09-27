import { defaultExclude, defineConfig } from "vitest/config";

// Leistungstests (*.perf.test.ts) laufen NICHT hier mit (Konkurrenz um CPU/PGlite mit den
// restlichen ~8 Dateien war die Ursache des wackligen Laufs, s. vitest.perf.config.ts) —
// eigenes, seriell laufendes Projekt. `exclude` ersetzt Vitests Vorgabe komplett statt sie zu
// ergänzen, deshalb `defaultExclude` explizit mit übernehmen (node_modules/dist/… bleiben draußen).
//
// `fileParallelism: false`: die ~8 verbliebenen Dateien starten hier trotzdem noch je `it()` eine
// frische PGlite-Instanz (In-Memory-Postgres über WASM, CPU-/speicherlastig). Parallel zu den
// anderen Vitest-Projekten (bridge/web/shared) lief das bisher gleichzeitig mit bis zu ~9 weiteren
// Worker-Prozessen und hat reale Zeitgrenzen in `apps/bridge/test/e2e.test.ts`
// ("neue Session erscheint in unter 2 s") wiederholt knapp reißen lassen (2044–2062 ms gemessen,
// 3 von 5 lokalen Läufen rot — reines CPU-Gerangel, kein Logikfehler). Seriell statt parallel kostet
// etwas Laufzeit, macht das Gerangel aber deutlich kleiner, ohne irgendeine Prüfung abzuschwächen.
export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts"],
    exclude: [...defaultExclude, "test/**/*.perf.test.ts"],
    testTimeout: 20000,
    // (Diagnose-Paket): `testTimeout` allein schützte die Hooks nicht — unser neuer PGlite-Schluss
    // läuft jetzt in `afterEach` (s. test/helpers.ts und test/assistant/assistant-helpers.ts). Gleiche Frist wie `testTimeout`, damit
    // ein hängender Hook (nicht nur ein hängender Testkörper) die Datei genauso rot statt still macht.
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
