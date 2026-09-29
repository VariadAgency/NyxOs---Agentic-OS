// Settings page „Mitteilungen“ against a real server (no mocks): page loads · switching the style changes the preview
// and stays saved · an occasion set to „Nie“ survives a reload · history with reasons, 2× „Brauche ich nicht“ → rule
// suggestion → accept · English texts · 390 px without horizontal scrolling and tap targets ≥ 44 px.
// Runs against the probe stack (`pnpm dev`) or a local server + Vite (see helpers/localStack.ts), e.g.:
//   NYXOS_HOME=<tmp> PORT=47900 NYXOS_HAIKU_SCHEDULER=0 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47900 pnpm exec vite --port 5200 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5200 E2E_NYXOS_API=http://127.0.0.1:47900 E2E_NYXOS_HOME=<tmp> \
//     pnpm --filter @nyxos/web exec playwright test e2e/notifications.spec.ts --project chromium-1440 --project webkit-1440
// Optional screenshots (JPEG) with E2E_SHOTS_DIR=<folder> (only in the first project).
// Nyx is never asked here (no model run): the page only shows whether Nyx is ready.
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { apiWrite, prepare } from "./helpers/localStack";

const PAGE = "/settings/mitteilungen";
const SHOTS = process.env.E2E_SHOTS_DIR;

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
});

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  if (!SHOTS || info.project.name !== info.config.projects[0]?.name) return;
  const path = `${SHOTS}/${name}.jpg`;
  if (target) await target.screenshot({ path, type: "jpeg", quality: 70 });
  else await page.screenshot({ path, type: "jpeg", quality: 70 });
}

async function open(page: Page) {
  const errors: string[] = [];
  await page.goto(PAGE);
  // Listen only on the new document: WebKit reports module loads of the previous page that the navigation cancelled
  // ("Importing a module script failed") as page errors.
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("notification-settings")).toBeVisible({ timeout: 30_000 });
  return errors;
}

/** Real occasions through the real pipeline (`POST /api/push/notify`). */
async function seed(page: Page) {
  const stamp = Date.now() % 100_000;
  for (const pct of [61, 66]) {
    const what = `Kontext ${pct} % – Komprimieren empfohlen (${stamp})`;
    const res = await apiWrite(page, "POST", "/api/push/notify", { kind: "context_guard_hinweis", title: "Kontext fast voll", message: what, what });
    expect(res.ok()).toBe(true);
  }
  const sub = await apiWrite(page, "POST", "/api/push/notify", { kind: "session_waiting", title: "Wartet auf dich", message: "wartet auf dich", what: "wartet auf dich", subAgent: true });
  expect(sub.ok()).toBe(true);
}

const preview = (page: Page) => page.getByTestId("notify-preview").locator('[data-part="body"]');
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

test("Seite lädt: Wann, Wie, Nyx, Wege, Verlauf, Erweitert – ohne Fehler; Nyx-Zustand ehrlich", async ({ page }, info) => {
  await seed(page);
  const errors = await open(page);
  for (const name of ["Wann?", "Wie geschrieben?", "Nyx", "Wege", "Verlauf"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Erweitert", { exact: true })).toBeVisible();
  await expect(page.getByTestId("when-context_guard_hinweis")).toBeVisible();
  // Channels speak of the computer, not of a particular device.
  await expect(page.getByRole("switch", { name: "Rechner", exact: true })).toBeVisible();
  // History shows the reasons (sub-agent) from the real pipeline.
  await expect(page.getByText("Unter-Agent – nicht gemeldet", { exact: false }).first()).toBeVisible();
  // Nyx: the hint appears exactly when the server says Nyx cannot run.
  const body = (await (await page.request.get("/api/notifications/settings")).json()) as { nyxReady: boolean };
  await expect(page.getByTestId("nyx-unavailable")).toHaveCount(body.nyxReady ? 0 : 1);
  await shot(page, info, "N-1-mitteilungen-1440");
  expect(errors).toEqual([]);
});

test("Stil wechseln ändert die Vorschau „So kommt es an“ (und bleibt gespeichert)", async ({ page }, info) => {
  await open(page);
  const style = page.getByTestId("style-choice");
  await style.getByRole("radio", { name: /Mit Zusammenhang/ }).click();
  await expect(preview(page)).toContainText("wartet seit");
  const before = await preview(page).innerText();
  await style.getByRole("radio", { name: /^Knapp/ }).click();
  await saved(page);
  await expect(preview(page)).not.toHaveText(before);
  await expect(preview(page)).not.toContainText("wartet seit");
  await page.reload();
  await expect(page.getByTestId("style-choice").getByRole("radio", { name: /^Knapp/ })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("style-choice").getByRole("radio", { name: /Ausführlich/ }).click();
  await expect(preview(page)).toContainText("wartet seit");
  await shot(page, info, "N-2-vorschau-ausfuehrlich", page.getByTestId("notify-preview"));
  // back to the default
  await page.getByTestId("style-choice").getByRole("radio", { name: /Mit Zusammenhang/ }).click();
  await expect(page.getByTestId("style-choice").getByRole("radio", { name: /Mit Zusammenhang/ })).toHaveAttribute("aria-checked", "true");
});

test("Anlass auf „Nie“ speichern, neu laden, bleibt „Nie“", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("when-context_guard_hinweis");
  await row.getByRole("radio", { name: "Nie" }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Nie" })).toHaveAttribute("aria-checked", "true");
  // The server sees it the same way.
  const body = (await (await page.request.get("/api/notifications/settings")).json()) as { rules: { when: Record<string, string> } };
  expect(body.rules.when.context_guard_hinweis).toBe("never");
  await page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Immer" }).click();
  await expect(page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Immer" })).toHaveAttribute("aria-checked", "true");
});

test("Verlauf: 2× „Brauche ich nicht“ beim Kontext-Wächter → Vorschlag „nur, wenn ich weg bin?“ → übernehmen", async ({ page }, info) => {
  await seed(page);
  await open(page);
  const items = page.getByTestId("history-item").filter({ hasText: "Kontext-Wächter" });
  await expect(items.nth(1)).toBeVisible();
  for (let i = 0; i < 2; i++) {
    const btn = items.nth(i).getByRole("button", { name: "Brauche ich nicht" });
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  }
  const suggestion = page.getByTestId("suggestion-context_guard_hinweis");
  await expect(suggestion).toContainText("„Kontext-Wächter“ nur, wenn ich weg bin?");
  await shot(page, info, "N-3-vorschlag", suggestion);
  await suggestion.getByRole("button", { name: "Übernehmen" }).click();
  await expect(page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Wenn weg" })).toHaveAttribute("aria-checked", "true");
  await expect(suggestion).toHaveCount(0);
  // back to the default for further runs
  await page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Immer" }).click();
  await expect(page.getByTestId("when-context_guard_hinweis").getByRole("radio", { name: "Immer" })).toHaveAttribute("aria-checked", "true");
});

test("Englisch: Seite, Vorschau und Gründe in der gewählten Sprache", async ({ page }, info) => {
  await apiWrite(page, "PUT", "/api/app/settings", { lang: "en" });
  try {
    await open(page);
    await expect(page.getByRole("heading", { name: "When?", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How written?", exact: true })).toBeVisible();
    await page.getByTestId("style-choice").getByRole("radio", { name: /With context/ }).click();
    await expect(preview(page)).toContainText("has been waiting for you since");
    await expect(page.getByText("Sub-agent – not reported", { exact: false }).first()).toBeVisible();
    await shot(page, info, "N-4-englisch-1440");
  } finally {
    await apiWrite(page, "PUT", "/api/app/settings", { lang: "de" });
  }
});

test("390 px (Handy): eine Spalte, kein waagerechtes Scrollen, Tipp-Ziele ≥ 44 px", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.getByTestId("notification-settings").evaluate((root) => {
    const bad: string[] = [];
    root.querySelectorAll<HTMLElement>('button, [role="radio"], [role="switch"], select, input, textarea, summary').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (el.closest("details:not([open])") && el.tagName !== "SUMMARY")) return;
      if (r.height < 44) bad.push(`${el.tagName} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)} ${Math.round(r.height)}px`);
    });
    return bad;
  });
  expect(small).toEqual([]);
  await shot(page, info, "N-5-mitteilungen-390");
  await page.getByText("Erweitert", { exact: true }).click();
  await page.locator("#erweitert-vorlagen").scrollIntoViewIfNeeded();
  const overflowOpen = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflowOpen).toBeLessThanOrEqual(0);
  await shot(page, info, "N-6-erweitert-390");
});
