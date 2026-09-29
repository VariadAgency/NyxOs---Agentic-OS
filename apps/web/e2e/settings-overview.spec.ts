// Settings as overview + subpages in the real browser. Overview → subpage → back (button and browser back), search
// with the keyboard, old anchors redirect, local mode leaves out areas without a counterpart, „Feedback &
// Unterstützen“ opens the sheet, 390 px without horizontal scrolling.
// Runs against the probe stack (`pnpm dev`) or a local server + Vite (see helpers/localStack.ts), e.g.:
//   NYXOS_HOME=<tmp> PORT=47899 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47899 pnpm exec vite --port 5199 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5199 E2E_NYXOS_API=http://127.0.0.1:47899 E2E_NYXOS_HOME=<tmp> \
//     pnpm --filter @nyxos/web exec playwright test e2e/settings-overview.spec.ts --project chromium-1440 --project webkit-1440
// Read-only after the preparation: every writing API request from the page is aborted.
import { expect, test, type Page } from "@playwright/test";
import { prepare } from "./helpers/localStack";

test.describe.configure({ mode: "serial", timeout: 60_000 });

let mode: "local" | "server" = "server";

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  mode = ((await (await page.request.get("/api/app/info")).json()) as { mode: "local" | "server" }).mode;
  await page.route(/\/api\//, (route) => {
    const m = route.request().method();
    return m === "GET" || m === "HEAD" || m === "OPTIONS" ? route.continue() : route.abort();
  });
});

async function noSideScroll(page: Page) {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    return { doc: document.documentElement.scrollWidth, win: window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(m.doc).toBeLessThanOrEqual(m.win);
  expect(m.main).toBeLessThanOrEqual(0);
}

test("Übersicht → Unterseite → zurück (Knopf und Browser-Zurück)", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Einstellungen", level: 1 })).toBeVisible();
  // 12 areas in both run modes (local mode only changes texts, e.g. „Konto & Anmeldung“ without passkeys).
  await expect(page.locator('[data-nyx^="settings:"]')).toHaveCount(12);

  await page.locator('[data-nyx="settings:sessions"]').click();
  await expect(page).toHaveURL(/\/settings\/sessions$/);
  await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
  await expect(page.locator("#kontext-waechter")).toBeVisible();
  await page.getByRole("button", { name: "Zurück zu Einstellungen" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.locator('[data-nyx="settings:lernbuch"]').click();
  await expect(page.getByRole("heading", { name: "Lernbuch", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Einstellungen", level: 1 })).toBeVisible();

  // Row „Nyx“ → Nyx overview with preview → subpage → „‹ Nyx“.
  await page.locator('[data-nyx="settings:nyx"]').click();
  await expect(page).toHaveURL(/\/einstellungen\/nyx$/);
  await expect(page.getByText("So spricht Nyx")).toBeVisible();
  await page.locator('[data-nyx="settings:stimme"]').click();
  await expect(page.getByRole("heading", { name: "Stimme", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Zurück zu Nyx" }).click();
  await expect(page).toHaveURL(/\/einstellungen\/nyx$/);

  // Row „Info & Hilfe“ → the info page (tabs stay on top).
  await page.goto("/settings");
  await page.locator('[data-nyx="settings:info"]').click();
  await expect(page).toHaveURL(/\/einstellungen\/info$/);
  await expect(page.getByRole("heading", { name: "Info & Hilfe", level: 1 })).toBeVisible();
});

test("Suche: „/“ fokussiert, Enter springt auf die Stelle", async ({ page }) => {
  await page.goto("/settings");
  const box = page.getByRole("searchbox", { name: "Einstellungen durchsuchen" });
  await expect(box).toBeVisible();
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
  await page.keyboard.type("ruhezeit");
  const options = page.getByRole("listbox", { name: "Treffer" }).getByRole("option");
  await expect(options.first()).toContainText("Ruhezeit");
  await page.keyboard.press("Enter");
  // Jumps exactly to the spot (quiet hours sit behind „Erweitert“, which opens on the way).
  await expect(page).toHaveURL(/\/settings\/mitteilungen#erweitert-ruhezeit$/);
  await expect(page.locator("#erweitert-ruhezeit")).toBeInViewport();

  await page.goto("/settings");
  await box.fill("konnektor");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/modelle#konnektoren$/);
  // Connectors sit behind „Erweitert“ – a jump there opens it.
  await expect(page.locator('[data-testid="advanced-bereich-modelle"]')).toHaveAttribute("open", "");

  // Local mode knows no passkeys – the search does not offer them either.
  await page.goto("/settings");
  await box.fill("passkey");
  if (mode === "local") await expect(page.getByText("Nichts gefunden. Versuch ein anderes Wort.")).toBeVisible();
  else await expect(page.getByRole("listbox", { name: "Treffer" }).getByRole("option").first()).toContainText(/Passkey/);
});

test("alte Links leiten auf die richtige Unterseite", async ({ page }) => {
  await page.goto("/settings#verbindungen");
  await expect(page).toHaveURL(/\/settings\/verbindungen$/);
  await expect(page.getByRole("heading", { name: "Verbindungen", level: 1 })).toBeVisible();

  await page.goto("/settings/betrieb#verbindungen");
  await expect(page).toHaveURL(/\/settings\/verbindungen$/);

  await page.goto("/settings#telegram");
  await expect(page).toHaveURL(/\/settings\/telegram$/);

  await page.goto("/settings#push");
  await expect(page).toHaveURL(/\/settings\/mitteilungen#push$/);

  await page.goto("/einstellungen/haiku");
  await expect(page).toHaveURL(/\/einstellungen\/nyx\/motor$/);
  await expect(page.getByRole("heading", { name: "Motor & Verbrauch", level: 1 })).toBeVisible();

  await page.goto("/einstellungen/nyx#stimme");
  await expect(page).toHaveURL(/\/einstellungen\/nyx\/stimme$/);

  await page.goto("/einstellungen/ideen-links");
  await expect(page).toHaveURL(/\/settings\/ideen-links$/);
});

test("Statuszeile → Verbindungen; Feedback & Unterstützen öffnet das Blatt", async ({ page }) => {
  await page.goto("/overview");
  await page.getByRole("link", { name: /Alle Verbindungen ansehen/ }).first().click();
  await expect(page).toHaveURL(/\/settings\/verbindungen$/);
  await expect(page.locator("#verbindungen")).toBeVisible();

  await page.goto("/settings");
  await page.locator('[data-nyx="settings:unterstuetzen"]').click();
  await expect(page).toHaveURL(/\/settings\/unterstuetzen$/);
  await expect(page.getByRole("heading", { name: "Feedback & Unterstützen", level: 1 })).toBeVisible();
  await page.locator('[data-nyx="support-open:idea"]').click();
  await expect(page).toHaveURL(/support=idea/);
  await expect(page.getByRole("dialog", { name: "Feedback & Unterstützen" })).toBeVisible();
  // Back closes the sheet and stays on the subpage.
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Feedback & Unterstützen" })).toBeHidden();
  await expect(page).toHaveURL(/\/settings\/unterstuetzen$/);
});

test.describe("390 px (iPhone)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Liste → Unterseite wie am iPhone, ohne waagerechtes Scrollen, Zurück groß genug", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('[data-nyx="settings:konto"]')).toBeVisible();
    await noSideScroll(page);
    const row = await page.locator('[data-nyx="settings:mitteilungen"]').boundingBox();
    expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);

    for (const path of ["/settings/konto", "/settings/mitteilungen", "/settings/modelle", "/settings/sessions", "/settings/zugaenge", "/settings/betrieb", "/settings/unterstuetzen", "/einstellungen/nyx", "/einstellungen/nyx/persoenlichkeit", "/einstellungen/nyx/stimme", "/einstellungen/info"]) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      await noSideScroll(page);
    }

    await page.goto("/settings");
    await page.locator('[data-nyx="settings:konto"]').click();
    const back = page.getByRole("button", { name: "Zurück zu Einstellungen" });
    const box = await back.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(page).toHaveURL(/\/settings$/);
  });
});
