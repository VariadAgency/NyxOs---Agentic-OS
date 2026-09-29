// Schrift-Skala: Bilder von Überblick, Sessions und Einstellungen bei 1440 px; je Seite wird die Verteilung
// der sichtbaren Schriftgrößen protokolliert (Ziel: ≥ 11 px außer bewussten Glyphen).
// NUR LESEND: alle nicht-GET-Aufrufe werden abgebrochen. Optional holt die Oberfläche ihre Daten (GET) von
// einer anderen NyxOS-Instanz: E2E_DATA_FROM=http://127.0.0.1:<port>.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/typography-scale.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, ".probe", "shots");
const DATA_FROM = process.env.E2E_DATA_FROM ?? "";
mkdirSync(OUT, { recursive: true });

const PAGES: [string, string][] = [
  ["ueberblick", "/overview"],
  ["sessions", "/sessions"],
  ["einstellungen", "/settings"],
];

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(({ browserName }) => browserName !== "chromium", "nur Chromium");

async function readOnly(page: Page) {
  await page.route(/\/(api\/|health)/, async (route) => {
    const req = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.abort();
    if (!DATA_FROM) return route.continue();
    const u = new URL(req.url());
    try {
      const res = await route.fetch({ url: `${DATA_FROM}${u.pathname}${u.search}`, headers: { accept: req.headers().accept ?? "*/*" } });
      return route.fulfill({ response: res });
    } catch {
      return route.abort();
    }
  });
}

test("Schriftgrößen bei 1440 px", async ({ page }) => {
  await readOnly(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [name, path] of PAGES) {
    await page.goto(path);
    await expect(page.locator("main").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: join(OUT, `typography-${name}.png`) });
    // Kleinste sichtbare Schrift im Hauptbereich (Textknoten mit Inhalt, sichtbar im Viewport).
    const sizes = await page.evaluate(() => {
      const hist: Record<string, number> = {};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const px = cs.fontSize;
        hist[px] = (hist[px] ?? 0) + 1;
      }
      return hist;
    });
    console.log(`${name}: ${JSON.stringify(Object.fromEntries(Object.entries(sizes).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))))}`);
  }
});
