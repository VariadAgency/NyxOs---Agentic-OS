// Schmale Layouts: Gehirn-Hilfe bei 390 px, Nyx-Tab schmal, Auswahl ohne Kanten-Fächer, Achsen-Schrift in Nutzung.
// Nur lesend: alle nicht-GET-Aufrufe werden abgebrochen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/narrow-layouts.spec.ts --project chromium-1440
// Optional `E2E_DATA_FROM=<URL einer anderen Instanz>`: die Oberfläche holt ihre Daten (nur GET) von dort,
// z. B. um eine gebaute Oberfläche (`vite preview`, dann E2E_BASE_URL setzen) mit vorhandenen Daten zu prüfen.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, ".probe", "shots");
const DATA_FROM = process.env.E2E_DATA_FROM ?? "";
mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: "serial", timeout: 180_000 });
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

async function openBrain3d(page: Page) {
  await page.goto("/gehirn");
  await page.evaluate(() => localStorage.setItem("nyxos.brain.settings.v1", JSON.stringify({ schema: 2, mode: "3d" })));
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 60_000 });
  await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

test("1 · Gehirn 390 px: Hilfe-Leiste bricht um, nichts rechts außerhalb", async ({ page }) => {
  await readOnly(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBrain3d(page);
  // Groß geladen, dann schmal gezogen → die Tastenhilfe klappt von selbst ein.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await expect(page.getByTestId("brain-3d-keys")).toHaveCount(0);
  await page.screenshot({ path: join(OUT, "narrow-brain-390-collapsed.png") });
  // Aufklappen: alle Hinweise vollständig im Bild.
  await page.getByRole("button", { name: "Tastenhilfe zeigen" }).click();
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    const keys = document.querySelector('[data-testid="brain-3d-keys"]');
    const bar = document.querySelector('[data-testid="brain-3d-bar"]');
    const hints = [...(keys?.children ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { text: (el.textContent ?? "").trim(), left: Math.round(r.left), right: Math.round(r.right) };
    });
    const b = bar?.getBoundingClientRect();
    return { hints, bar: b ? { left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) } : null, scrollX: bar ? bar.scrollWidth - bar.clientWidth : null, pageOverflow: document.documentElement.scrollWidth - innerWidth };
  });
  console.log(`narrow brain-390: ${JSON.stringify(out)}`);
  expect(out.hints.length).toBe(5);
  for (const h of out.hints) expect(h.right, h.text).toBeLessThanOrEqual(390);
  expect(out.scrollX).toBe(0);
  expect(out.pageOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(OUT, "narrow-brain-390.png") });
});

test("1b · Gehirn: Auswahl eines Riesen-Knotens – höchstens 60 Kanten, Nachbarfarbe", async ({ page }) => {
  await readOnly(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBrain3d(page);
  const box = await page.getByTestId("graph-3d").boundingBox();
  if (!box) throw new Error("kein 3D-Bereich");
  // Der Knoten mit den meisten Verbindungen, der nicht der allergrößte ist (typisch: einige hundert Kanten).
  const hubs = await page.evaluate(() => window.__brain3dPerf?.topNodes(8) ?? []);
  const hub = hubs[3] ?? hubs[0] ?? "";
  await page.evaluate((id) => window.__brain3dPerf?.placeNear(id, 520), hub);
  await page.waitForTimeout(600);
  const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id), hub);
  if (!sp) throw new Error("Knoten nicht im Bild");
  await page.mouse.click(box.x + sp.x, box.y + sp.y);
  await page.waitForTimeout(3500); // Impuls abklingen lassen – das Bild zeigt nur die Auswahl
  const hl = await page.evaluate(() => window.__brain3dPerf?.highlight);
  console.log(`narrow selection: hub=${hub} ${JSON.stringify(hl)}`);
  expect(hl?.edges ?? 0).toBeGreaterThan(0);
  expect(hl?.edges ?? 99).toBeLessThanOrEqual(60);
  await page.screenshot({ path: join(OUT, "narrow-brain-selection.png") });
});

test("2 · Nyx-Tab: 1440 → 390 klappt die Chat-Leiste zu, zurück auf 1440 wieder auf", async ({ page }) => {
  await readOnly(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/nyx");
  await page.evaluate(() => localStorage.setItem("nyx.tab.panel", "open"));
  await page.goto("/nyx");
  const stage = page.locator('[data-nyx="nyx-tab"]');
  await expect(stage).toHaveAttribute("data-panel", "open", { timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stage).toHaveAttribute("data-panel", "closed");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, "narrow-nyx-tab-390.png") });
  expect(await page.evaluate(() => localStorage.getItem("nyx.tab.panel"))).toBe("open");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(stage).toHaveAttribute("data-panel", "open");
  // „Leertaste“ in der Skala (11 px statt 10,5).
  const kbd = await page.locator(".nyx-kbd").first().evaluate((el) => getComputedStyle(el).fontSize).catch(() => null);
  console.log(`narrow nyx-kbd: ${kbd}`);
  if (kbd) expect(parseFloat(kbd)).toBeGreaterThanOrEqual(11);
});

test("3 · Nutzung: Achsen-Beschriftungen ≥ 11 px", async ({ page }) => {
  await readOnly(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage");
  await expect(page.locator("main").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  const sizes = await page.evaluate(() => [...document.querySelectorAll("svg text")].map((t) => parseFloat(getComputedStyle(t).fontSize)));
  console.log(`narrow axes: ${sizes.length} Beschriftungen, kleinste ${Math.min(...sizes)} px`);
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
  await page.screenshot({ path: join(OUT, "narrow-usage-axes.png") });
});
