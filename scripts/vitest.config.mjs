import { defineConfig } from "vitest/config";

// Tests der Mac-Skripte (reines Node, kein Build).
export default defineConfig({
  test: {
    name: "scripts",
    include: ["test/**/*.test.mjs"],
  },
});
