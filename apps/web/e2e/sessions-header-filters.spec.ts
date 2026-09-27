// Sessions-Seitenkopf + Filter: eine Kopfzeile, gleich hohe Bedienelemente, Aktiv-Stil, Codex-Filter,
// „Zuletzt geöffnet“. Breiten 1280 und 1920 (per `test.use`) plus 1024, Screenshots nach `.probe/shots/`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/sessions-header-filters.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

type Box = { x: number; y: number; width: number; height: number };

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error("Element ohne Box");
  return b;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoPairOverlaps(boxes: Box[]): void {
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
}

async function openSessions(page: Page, path = "/sessions") {
  await page.goto(path);
  await page.waitForSelector('[role="tablist"][aria-label="Art der Arbeit"]');
  await page.waitForTimeout(600);
}

/** Alle sichtbaren Bedienelemente rechts in der Kopfleiste. */
function controls(page: Page) {
  const bar = page.getByTestId("topbar");
  return {
    bar,
    crumbs: bar.getByRole("navigation", { name: "Brotkrümel" }),
    search: bar.locator('input[type="search"]').locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]"),
    recent: bar.getByRole("button", { name: "Zuletzt geöffnet" }),
    rules: bar.getByRole("button", { name: "Regeln" }),
    tools: bar.getByRole("group", { name: "Werkzeug" }),
  };
}

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

for (const width of [1280, 1920]) {
  test.describe(`Sessions-Kopf bei ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    const suffix = width === 1280 ? "" : `-${width}`;

    test("Eine Kopfzeile, alle Bedienelemente gleich hoch und auf einer Linie", async ({ page }) => {
      await openSessions(page);
      const c = controls(page);
      const items = [c.search, c.recent, c.rules, c.tools];
      const boxes = await Promise.all(items.map(box));
      const heights = boxes.map((b) => Math.round(b.height * 10) / 10);
      const centers = boxes.map((b) => b.y + b.height / 2);
      expect(new Set(heights).size, `Höhen: ${heights.join(", ")}`).toBe(1);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(0.5);

      // Eine Zeile: Brotkrümel und Knöpfe auf derselben Höhe, die Leiste nicht höher als eine Zeile.
      const barBox = await box(c.bar);
      const crumbBox = await box(c.crumbs);
      expect(barBox.height).toBeLessThan(56);
      expect(Math.abs(crumbBox.y + crumbBox.height / 2 - (centers[0] ?? 0))).toBeLessThanOrEqual(2);
      // Nichts überlappt.
      for (const b of boxes) expect(overlaps(crumbBox, b)).toBe(false);
      expectNoPairOverlaps(boxes);
      // Keine alte Extra-Zeile mehr zwischen Kopfleiste und ART.
      const artRow = await box(page.getByRole("tablist", { name: "Art der Arbeit" }));
      expect(artRow.y - (barBox.y + barBox.height)).toBeLessThanOrEqual(1);
      // Leere Brotkrümel-Stufen weg.
      await expect(c.crumbs).not.toContainText("–");

      await page.screenshot({ path: `${SHOTS}/sessions-header${suffix}.png`, clip: { x: 0, y: 0, width, height: 230 } });
      await page.screenshot({ path: `${SHOTS}/sessions-header-controls${suffix}.png`, clip: { x: Math.max(0, width - 780), y: 0, width: Math.min(780, width), height: 56 } });
    });

    test("Flacher Aktiv-Stil ohne Schatten, Tooltip unter dem Tab verdeckt nichts", async ({ page }) => {
      await openSessions(page);
      const rows = ["Art der Arbeit", "Baustelle", "Sessions"];
      for (const name of rows) {
        const active = page.getByRole("tablist", { name }).getByRole("tab", { selected: true });
        await expect(active).toHaveCount(1);
        expect(await active.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
      }
      // Am Anfang der ART-Zeile keine Ausblend-Maske (sie machte die Kante von „Coding“ weich).
      await expect(page.getByTestId("art-tabs-scroll")).toHaveAttribute("data-fade-left", "false");

      const sessionTabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
      test.skip((await sessionTabs.count()) < 2, "keine offene Session im lokalen Stack");
      const tab = sessionTabs.nth(1);
      await expect(tab).not.toHaveAttribute("title", /.+/);
      await tab.hover();
      const tip = page.getByRole("tooltip");
      await expect(tip).toBeVisible();
      const tipBox = await box(tip);
      const tabBox = await box(tab);
      expect(tipBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
      for (const other of [page.getByTestId("topbar"), page.getByRole("tablist", { name: "Art der Arbeit" }), page.getByRole("tablist", { name: "Baustelle" })]) {
        expect(overlaps(tipBox, await box(other))).toBe(false);
      }
      await page.screenshot({ path: `${SHOTS}/sessions-active-tab${suffix}.png`, clip: { x: 0, y: 0, width, height: Math.min(900, Math.ceil(tipBox.y + tipBox.height + 24)) } });
    });

    test("Codex-Filter wirkt auf Art und Baustelle, Zähler stimmen mit dem Server", async ({ page, request }) => {
      await openSessions(page, "/sessions/coding/_");
      await controls(page).tools.getByRole("button", { name: "Codex" }).click();
      await page.waitForURL(/tool=codex/);
      const body = (await (await request.get("/api/categories?tool=codex")).json()) as { categories: { art: string; count: number }[] };
      const artRow = page.getByRole("tablist", { name: "Art der Arbeit" });
      for (const [art, label] of [["coding", "Coding"], ["audit", "Audit"], ["server", "Server & Deploy"]] as const) {
        const expected = body.categories.find((c) => c.art === art)?.count ?? 0;
        await expect(artRow.getByRole("tab", { name: new RegExp(`^${label.replace(/[&]/g, "\\$&")}`) })).toContainText(String(expected));
      }
      const coding = body.categories.find((c) => c.art === "coding")?.count ?? 0;
      await expect(page.getByRole("tablist", { name: "Baustelle" }).getByRole("tab", { name: /^Alle/ })).toContainText(String(coding));
      await page.screenshot({ path: `${SHOTS}/sessions-codex-filter${suffix}.png`, clip: { x: 0, y: 0, width, height: 230 } });
    });

    test("„Zuletzt geöffnet“ zeigt die zuletzt geöffnete Session oben", async ({ page }) => {
      await openSessions(page);
      const sessionTabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
      test.skip((await sessionTabs.count()) < 2, "keine offene Session im lokalen Stack");
      const target = sessionTabs.nth(1);
      const title = ((await target.locator("span.truncate").textContent()) ?? "").trim();
      await target.click();
      await page.waitForTimeout(800);
      await controls(page).recent.click();
      const dialog = page.getByRole("dialog", { name: "Zuletzt geöffnet" });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(400); // Einblenden (120 ms) abwarten, sonst scheint die Zeile darunter durch
      await expect(dialog.getByRole("link").first()).toContainText(title);
      // Der Knopf ist genauso hoch wie die anderen und das Blatt überdeckt keine Kopf-Knöpfe.
      const dBox = await box(dialog);
      const barBox = await box(page.getByTestId("topbar"));
      expect(dBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 12);
      await page.screenshot({ path: `${SHOTS}/sessions-recent${suffix}.png`, clip: { x: Math.max(0, width - 720), y: 0, width: Math.min(720, width), height: Math.min(900, Math.ceil(dBox.y + dBox.height + 20)) } });
    });
  });
}

test.describe("Sessions-Kopf bei 1024 px (schmal)", () => {
  test.use({ viewport: { width: 1024, height: 800 } });
  test("Suche klappt zum Symbol ein, nichts überlappt", async ({ page }) => {
    await openSessions(page);
    const bar = page.getByTestId("topbar");
    const searchIcon = bar.getByRole("button", { name: "Suchen" });
    await expect(searchIcon).toBeVisible();
    const c = controls(page);
    const boxes = await Promise.all([searchIcon, c.recent, c.rules, c.tools].map(box));
    const crumbBox = await box(c.crumbs);
    for (const b of boxes) expect(overlaps(crumbBox, b)).toBe(false);
    expectNoPairOverlaps(boxes);
    expect(new Set(boxes.map((b) => Math.round(b.height))).size).toBe(1);
    await searchIcon.click();
    await expect(bar.locator('input[type="search"]')).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/sessions-header-1024.png`, clip: { x: 0, y: 0, width: 1024, height: 230 } });
  });
});
