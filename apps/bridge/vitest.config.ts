import { defineConfig } from "vitest/config";

export default defineConfig({ test: { name: "bridge", include: ["test/**/*.test.ts"], testTimeout: 20000 } });
