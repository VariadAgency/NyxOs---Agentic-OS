import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx"],
    // R1 · FX: ganze App im jsdom braucht unter Volllast (alle Pakete parallel) mehr als die 5 s Vorgabe.
    // Die Tests warten auf Bedingungen — die Frist ist nur das Sicherheitsnetz, grüne Läufe werden nicht langsamer.
    testTimeout: 20_000,
  },
});
