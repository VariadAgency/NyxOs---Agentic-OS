// Session controls in the session info (right column + phone sheet "⋯"), against a local server (PGlite):
//   NYXOS_HOME=/tmp/nyxos-controls PORT=47920 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47920 pnpm exec vite --port 5220 --strictPort --host 127.0.0.1)
//   E2E_NYXOS_HOME=/tmp/nyxos-controls E2E_NYXOS_API=http://127.0.0.1:47920 E2E_BASE_URL=http://127.0.0.1:5220 \
//     pnpm --filter @nyxos/web exec playwright test e2e/session-controls.spec.ts --project=chromium-1440
// No bridge is connected → a model switch really lands in the delivery queue (server path).
import { expect, test, type Page } from "@playwright/test";
import { apiBase, prepare } from "./helpers/localStack";
import { MOBILE_LIVE, seedMobileSessions } from "./helpers/mobileSeed";

const LIVE_URL = `/sessions/unsortiert/_/claude:${MOBILE_LIVE.sessionId}`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext();
  await seedMobileSessions(api, apiBase(baseURL));
  await api.dispose();
});

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  await page.route("**/api/terminal/status", (r) => r.fulfill({ json: { online: true, machineId: "dev", since: new Date().toISOString() } }));
});

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
}

test("Desktop: controls in the session info, compact no longer in the header, model switch waits for a pause", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LIVE_URL);
  const head = page.getByTestId("session-head");
  await expect(head).toContainText(MOBILE_LIVE.title, { timeout: 30_000 });
  await expect(head.getByRole("button", { name: /komprimieren/i })).toHaveCount(0);

  const box = page.getByTestId("session-info").getByTestId("session-controls");
  await expect(box.getByText("Opus 5.5")).toBeVisible();
  await expect(box.getByRole("group", { name: "Denkaufwand" }).getByRole("button")).toHaveCount(6);
  await box.getByRole("button", { name: "Wechseln" }).click();
  await expect(box.getByRole("list", { name: "Mögliche Modelle" })).toBeVisible();
  await box.getByRole("button", { name: /^Sonnet 5 – / }).click();
  await expect(box.getByRole("status")).toContainText("sobald die Session auf dich wartet");
  await expect(page.getByRole("button", { name: /Kontext komprimieren/ })).toHaveCount(1);
});

test("Phone 390 px: controls in the sheet, no horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(LIVE_URL);
  await page.getByRole("button", { name: "Session-Aktionen" }).click();
  const sheet = page.getByTestId("session-sheet");
  const box = sheet.getByTestId("session-controls");
  await box.scrollIntoViewIfNeeded();
  await expect(box.getByRole("button", { name: /Kontext komprimieren/ })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Kontext komprimieren/ })).toHaveCount(1);
  await noHorizontalScroll(page);
});
