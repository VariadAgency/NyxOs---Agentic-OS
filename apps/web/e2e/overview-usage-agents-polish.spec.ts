// Politur Überblick, Nutzung, Agenten: Screenshots + Prüfungen (kein Überlauf, keine Konsolenfehler,
// Diagramm-Hover, Kachel-Link) gegen den lokalen Stack mit echten Daten.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/overview-usage-agents-polish.spec.ts --project chromium-1440 --project chromium-1024
// Screenshots: `.probe/shots/<projekt>-<tab>.png`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUT = join(process.cwd(), "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });
const shot = (project: string, name: string) => join(OUT, `${project}-${name}.png`);

const TABS = [
  { path: "/overview", name: "ueberblick", heading: /Guten (Morgen|Tag|Abend)|Noch wach/ },
  { path: "/usage", name: "nutzung", heading: "Nutzung" },
  { path: "/agents", name: "agenten", heading: "Agenten" },
] as const;

/** Breitestes Element, das über den sichtbaren Hauptbereich hinausragt (0 = kein Überlauf). */
async function horizontalOverflow(page: Page): Promise<{ overflow: number; culprit: string | null }> {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const limit = main.getBoundingClientRect().right + 1;
    let worst = 0;
    let culprit: string | null = null;
    for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).position === "fixed" || el.closest(".sr-only")) continue;
      const over = r.right - limit;
      if (over > worst) {
        worst = over;
        culprit = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`;
      }
    }
    return { overflow: Math.round(worst), culprit };
  });
}

for (const tab of TABS) {
  test(`${tab.name}: Screenshot + kein Überlauf`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(tab.path);
    await expect(page.getByRole("heading", { level: 1, name: tab.heading })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(900); // Einzeichnen/Hochzählen abwarten
    await page.screenshot({ path: shot(testInfo.project.name, tab.name) });
    const { overflow, culprit } = await horizontalOverflow(page);
    expect(overflow, `Überlauf durch ${culprit ?? "?"}`).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    // Ganze Seite: `main` scrollt selbst (nicht `body`), deshalb Fenster auf die Inhaltshöhe ziehen.
    const vp = page.viewportSize();
    const tall = await page.evaluate(() => {
      const main = document.querySelector("main");
      const scroller = main && main.scrollHeight > main.clientHeight ? main : (main?.querySelector<HTMLElement>(".cc-scroll, [class*='overflow-y-auto']") ?? main);
      return Math.min(6000, (scroller?.scrollHeight ?? 0) + 60);
    });
    if (vp && tall > vp.height) {
      await page.setViewportSize({ width: vp.width, height: tall });
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: shot(testInfo.project.name, `${tab.name}-voll`), fullPage: true });
  });
}

test("Diagramm-Hover: Tooltip erscheint, Bildrate grob ≥ 50 fps", async ({ page }, testInfo) => {
  await page.goto("/usage");
  const chart = page.locator("[data-chart='area']").first();
  await expect(chart).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(700);
  const box = await chart.boundingBox();
  if (!box) throw new Error("kein Diagramm");
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(page.locator("[data-chart-tooltip]").first()).toBeVisible();
  await page.screenshot({ path: shot(testInfo.project.name, "nutzung-hover") });

  // Bildrate beim Überstreichen: rAF-Zeitstempel sammeln, während die Maus in 60 Schritten über das
  // Diagramm fährt. Grob, weil Playwright selbst Takt kostet — Ziel ist „kein Einbruch", nicht 60,0.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    const loop = (t: number) => {
      w.__frames.push(t);
      if (w.__frames.length < 400) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (let i = 0; i <= 60; i++) await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height / 2);
  const fps = await page.evaluate(() => {
    const f = (window as unknown as { __frames: number[] }).__frames;
    const deltas = f.slice(1).map((t, i) => t - (f[i] ?? t));
    const sorted = [...deltas].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 16;
    return { median: 1000 / (sorted[Math.floor(sorted.length / 2)] ?? 16), p90Fps: 1000 / p90, n: deltas.length };
  });
  console.log(`[usage] Hover-Bildrate ${testInfo.project.name}: Median ${fps.median.toFixed(0)} fps, p90 ${fps.p90Fps.toFixed(0)} fps (${fps.n} Frames)`);
  expect(fps.median).toBeGreaterThanOrEqual(50);

  // Tastatur: Fokus aufs Diagramm, Pfeiltaste bewegt den Tooltip.
  await chart.focus();
  await page.keyboard.press("End");
  await expect(page.locator("[data-chart-tooltip]").first()).toBeVisible();
});

test("Überblick: Kachel führt zum Tab", async ({ page }) => {
  await page.goto("/overview");
  const tile = page.locator("[data-metric='commits_7d']");
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.click();
  await expect(page).toHaveURL(/\/git/);
});
