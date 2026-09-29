import { defineConfig, devices } from "@playwright/test";

// Browser tests run against the local development stack from `pnpm dev` (scripts/dev.mjs): it builds the
// web app and serves web + API on http://127.0.0.1:${PROBE_PORT:-47890} (PGlite instead of Postgres, a
// separate bridge instance, login file under `.probe/probe-login.json`).
//
// Without E2E_BASE_URL Playwright starts that stack itself (or reuses one that is already running on the
// port). With E2E_BASE_URL the tests run against any other instance instead (e.g. `vite preview`) and no
// server is started. Specs that mock every API call via `page.route` work against either.
const port = Number(process.env.PROBE_PORT ?? 47890);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.output",
  fullyParallel: true,
  // The target is ONE local Node process, not a horizontally scaling server. Several Playwright workers at
  // once (default: ~CPU/2) mostly slow each other down and distort the timing checks (e.g. "first chat
  // message visible < 2 s" was 3–11 s with four parallel browser projects and 1.4 s with one worker).
  // So all projects run one after another, like a single real user.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node ../../scripts/dev.mjs",
        url: `${baseURL}/health`,
        reuseExistingServer: true,
        // dev.mjs builds the web app first and then waits for the server and the bridge.
        timeout: 300_000,
        stdout: "pipe",
        stderr: "pipe",
      },
  projects: [
    { name: "chromium-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "chromium-1024", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 800 } } },
    { name: "webkit-1440", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
    { name: "webkit-1024", use: { ...devices["Desktop Safari"], viewport: { width: 1024, height: 800 } } },
  ],
});
