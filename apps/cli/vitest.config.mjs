import { defineConfig } from "vitest/config";

// Tests of the `nyxos` command (plain Node, no build).
export default defineConfig({
  test: {
    name: "cli",
    include: ["test/**/*.test.mjs"],
  },
});
