import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "apps/server/vitest.perf.config.ts" ist ein eigenes Projekt (nicht der Ordner "apps/server" —
    // der lädt bereits dessen vitest.config.ts für die normalen Tests): die Leistungstests laufen
    // seriell und für sich, s. Begründung dort (P2-6, wackliger Testlauf).
    projects: ["packages/shared", "apps/server", "apps/server/vitest.perf.config.ts", "apps/bridge", "apps/web", "apps/cli", "scripts"],
  },
});
