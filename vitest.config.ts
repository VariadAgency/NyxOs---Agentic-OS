import { defineConfig } from "vitest/config";

// Die Tests rechnen mit Wanduhr-Zeiten („Briefing von 06:30“, Sommerzeit-Wechsel). Ohne feste Zeitzone
// laufen sie nur auf Rechnern in Berlin grün – auf GitHub (UTC) lagen alle Uhrzeiten 2 Std daneben und
// kein Release kam je durch. Die Test-Prozesse erben diese Zeitzone.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  test: {
    // "apps/server/vitest.perf.config.ts" ist ein eigenes Projekt (nicht der Ordner "apps/server" —
    // der lädt bereits dessen vitest.config.ts für die normalen Tests): die Leistungstests laufen
    // seriell und für sich, s. Begründung dort (P2-6, wackliger Testlauf).
    projects: ["packages/shared", "apps/server", "apps/server/vitest.perf.config.ts", "apps/bridge", "apps/web", "apps/cli", "scripts"],
  },
});
