// Konflikte-Seite: 3.200 künstliche Konflikte ohne Hänger (Grenze für Long Tasks), nichts ragt aus einer
// Kachel (Element-Grenzen), „Was muss ich entscheiden?“ und „Vergleichen“ mit den Daten des lokalen Stacks.
// Screenshots: `.probe/shots/`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/conflicts-page.spec.ts --project chromium-1440 --project chromium-1024
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { manyConflicts } from "./fixtures/manyConflicts";
import { stressRoutes } from "./fixtures/stressRoutes";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
/** Längste erlaubte Blockade des Haupt-Threads (ms) — darüber „hängt“ die Seite spürbar. */
const LONG_TASK_LIMIT = 200;

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

function only(name: string, project: string) {
  test.skip(project !== name, `nur ${name}`);
}

async function watchLongTasks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __lt: number[] };
    w.__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  return () => page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
}

/** Alle sichtbaren Elemente einer Kachel müssen innerhalb der Kachel liegen (außer in eigenen Scroll-/Schnittbereichen). */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const main = document.querySelector("main.cc-scroll");
    if (main && main.scrollWidth > main.clientWidth + 1) bad.push(`main: ${main.scrollWidth} > ${main.clientWidth}`);
    for (const tile of document.querySelectorAll('main [data-tile], main [data-testid="decision"]')) {
      const r = tile.getBoundingClientRect();
      for (const el of tile.querySelectorAll("*")) {
        const e = el.getBoundingClientRect();
        if (e.width === 0 || e.height === 0) continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== tile; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== "visible") {
            clipped = true;
            break;
          }
        }
        if (clipped) continue;
        if (e.right > r.right + 1 || e.left < r.left - 1) bad.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 40)} „${(el.textContent ?? "").slice(0, 40)}“ ragt ${Math.round(e.right - r.right)} px heraus`);
      }
    }
    return bad;
  });
}

test("3.200 Konflikte — bedienbar ohne Hänger, Liste virtualisiert", async ({ page }, testInfo) => {
  only("chromium-1440", testInfo.project.name);
  const longTasks = await watchLongTasks(page);
  await stressRoutes(page, manyConflicts(3200, 800));
  await page.goto("/conflicts");
  await expect(page.getByRole("heading", { name: "Was muss ich entscheiden?" })).toBeVisible();
  await expect(page.getByTestId("decision").first()).toBeVisible();
  // Viele Ordner → eigener, virtualisierter Scrollbereich; nur ein Bruchteil ist im DOM.
  const groupsInDom = await page.getByTestId("group-toggle").count();
  expect(groupsInDom).toBeLessThan(60);
  await page.getByTestId("group-toggle").first().click();
  await expect(page.locator("button[data-path]").first()).toBeVisible();
  expect(await page.locator("button[data-path]").count()).toBeLessThanOrEqual(50);
  // Nach „Weitere laden“ (100 Dateien) eigener, virtualisierter Bereich — nicht alle im DOM.
  await page.getByRole("button", { name: /^Weitere 50 von/ }).first().click();
  await expect(page.getByTestId("entries-virtual")).toBeVisible();
  expect(await page.locator("[data-testid=entries-virtual] button[data-path]").count()).toBeLessThan(60);
  await page.getByTestId("groups-virtual").evaluate(async (el) => {
    for (let i = 0; i < 30; i++) {
      el.scrollBy(0, 400);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForTimeout(6_000); // Leerlauf: früher lud die Seite hier alle 5 s die ganze Karte neu
  const lt = await longTasks();
  console.log(`[conflicts] Long Tasks: ${lt.length}, längste ${Math.round(Math.max(0, ...lt))} ms`);
  expect(Math.max(0, ...lt), `längste Blockade < ${LONG_TASK_LIMIT} ms`).toBeLessThan(LONG_TASK_LIMIT);
  await page.getByTestId("groups-virtual").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: join(SHOTS, "conflicts-stress.png") });
});

test("Nichts ragt aus einer Kachel (1024 px, lange Namen)", async ({ page }, testInfo) => {
  only("chromium-1024", testInfo.project.name);
  await stressRoutes(page, manyConflicts(3200, 800));
  await page.goto("/conflicts");
  await expect(page.getByTestId("decision").first()).toBeVisible();
  await page.getByTestId("group-toggle").first().click();
  await expect(page.locator("button[data-path]").first()).toBeVisible();
  expect(await overflowingElements(page)).toEqual([]);
  await page.screenshot({ path: join(SHOTS, "conflicts-long-names-1024.png") });
});

test("Daten des lokalen Stacks, 1024 px — nichts ragt heraus", async ({ page }, testInfo) => {
  only("chromium-1024", testInfo.project.name);
  await page.goto("/conflicts");
  await expect(page.getByRole("heading", { name: "Was muss ich entscheiden?" })).toBeVisible();
  const toggle = page.getByTestId("group-toggle").first();
  if (await toggle.count()) {
    await toggle.click();
    await page.locator("button[data-path]").first().click();
    await expect(page.getByTestId("collision-detail")).toBeVisible();
  }
  expect(await overflowingElements(page)).toEqual([]);
  await page.screenshot({ path: join(SHOTS, "conflicts-real-1024.png"), fullPage: false });
});

test("„Was muss ich entscheiden?“ mit den Daten des lokalen Stacks", async ({ page }, testInfo) => {
  only("chromium-1440", testInfo.project.name);
  await page.goto("/conflicts");
  await expect(page.getByRole("heading", { name: "Was muss ich entscheiden?" })).toBeVisible();
  const cards = page.getByTestId("decision");
  if ((await cards.count()) > 0) {
    const first = cards.first();
    await expect(first.getByRole("button", { name: "Ignorieren" })).toBeVisible();
    await expect(first.getByRole("button", { name: /pausieren/ })).toBeVisible();
    await expect(first.getByText(/Was kann passieren/)).toBeVisible();
  }
  await page.screenshot({ path: join(SHOTS, "conflicts-decisions.png") });
});

test("Vergleichen — Änderungen beider Sessions nebeneinander + Git-Stände", async ({ page }, testInfo) => {
  only("chromium-1440", testInfo.project.name);
  await page.goto("/conflicts");
  const card = page.getByTestId("decision").first();
  await expect(card).toBeVisible();
  // „Vergleichen: <Datei>“ im Entscheidungsblock öffnet die Großansicht der Datei.
  await card.locator("button[title^='/']").first().click();
  const detail = page.getByTestId("collision-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("session-changes").first()).toBeVisible({ timeout: 60_000 });
  await detail.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "conflicts-compare.png") });

  await detail.getByRole("tab", { name: "Git-Stände vergleichen" }).click();
  await detail.getByRole("button", { name: "Was ist noch nicht gespeichert?" }).click();
  await expect(detail.getByTestId("diff-view").or(detail.getByText(/Keine Unterschiede|Mac|Git-Ordner/)).first()).toBeVisible({ timeout: 60_000 });
  await detail.getByRole("tab", { name: "Git-Stände vergleichen" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, "conflicts-compare-git.png") });
});
