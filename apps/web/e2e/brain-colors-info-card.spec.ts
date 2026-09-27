// Gehirn gegen den lokalen Stack mit Vault: Farben für Code nach Unterordner/Bibliothek, Legende mit
// Familien, Info-Karte ohne Markdown-Zeichen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/brain-colors-info-card.spec.ts --project chromium-1440
// Screenshots: `.probe/shots/brain-colors-families.png`, `brain-info-card.png`
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openBrainPanel } from "./helpers/brainPanel";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });

async function openBrain(page: Page) {
  await page.goto("/gehirn");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.")) localStorage.removeItem(k);
  });
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-canvas"] canvas', { timeout: 30_000 });
  await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0);
}

/** Farbton-Verteilung der gezeichneten Punkte (bunte Pixel, 30°-Fächer) — misst „wirkt einfarbig". */
async function hueShares(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"] canvas');
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Array<number>(12).fill(0);
    let n = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = (data[i] ?? 0) / 255;
      const g = (data[i + 1] ?? 0) / 255;
      const b = (data[i + 2] ?? 0) / 255;
      const a = (data[i + 3] ?? 0) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (a < 0.5 || mx < 0.35 || mx - mn < 0.25) continue; // Hintergrund/Linien/Schrift
      const d = mx - mn;
      const sector = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const h = (sector * 60 + 360) % 360;
      buckets[Math.floor(h / 30)] = (buckets[Math.floor(h / 30)] ?? 0) + 1;
      n++;
    }
    return { n, shares: buckets.map((c) => Math.round((c / Math.max(1, n)) * 1000) / 1000) };
  });
}

test.describe("Gehirn: Farben und Info-Karte", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Messungen/Screenshots nur in Chromium");

  test("Code nach Unterordner/Bibliothek, Legende mit Familien, Palette kräftig, nichts unter den Kacheln", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openBrain(page);
    await page.waitForFunction(() => (window.__brainPerf?.alpha ?? 1) < 0.05, undefined, { timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);

    const legend = page.getByTestId("brain-legend");
    // Legende ist standardmäßig eingeklappt
    const legendToggle = legend.getByRole("button", { name: /^Legende/ });
    if ((await legendToggle.getAttribute("aria-expanded")) === "false") await legendToggle.click();
    await expect(legend).toBeVisible();
    // Familien: eigener Code und Bibliotheken getrennt (echter Vault: ~3.600 Notizen aus Swift-Paketen)
    const code = legend.getByTestId("legend-family-note.code");
    const libs = legend.getByTestId("legend-family-note.bibliothek");
    await expect(code).toBeVisible();
    await expect(libs).toBeVisible();
    await code.getByRole("button", { name: "Eigener Code aufklappen" }).click();
    await libs.getByRole("button", { name: "Bibliotheken aufklappen" }).click();
    const leaves = legend.locator('[data-testid^="legend-leaf-"]');
    expect(await leaves.count()).toBeGreaterThanOrEqual(7);

    // Jede gezeigte Farbe kräftig: gesättigt und nicht fast weiß
    const colors = await legend.locator("[data-color]").evaluateAll((els) => els.map((e) => e.getAttribute("data-color") ?? ""));
    expect(colors.length).toBeGreaterThanOrEqual(12);
    for (const c of colors) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const l = (mx + mn) / 2;
      const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
      expect({ c, kräftig: s > 0.5 && l <= 0.72 }).toEqual({ c, kräftig: true });
    }

    // Wirkt nicht mehr einfarbig: kein Farbton-Fächer über 40 % der bunten Pixel, mindestens 5 Fächer ≥ 2 %
    const hues = await hueShares(page);
    expect(hues).not.toBeNull();
    const shares = hues?.shares ?? [];
    test.info().annotations.push({ type: "Farbtöne (30°-Fächer, Anteil bunter Pixel)", description: JSON.stringify(hues) });
    expect(Math.max(...shares)).toBeLessThan(0.4);
    expect(shares.filter((x) => x >= 0.02).length).toBeGreaterThanOrEqual(5);

    // Einpassen: die meisten Punkte liegen NICHT unter Legende/Steuerung/Kopf
    await openBrainPanel(page);
    await page.getByRole("button", { name: /Darstellung/i }).click();
    await page.getByRole("button", { name: "Alles einpassen" }).click();
    await page.waitForTimeout(900);
    const under = await page.evaluate(() => {
      const p = window.__brainPerf;
      const host = document.querySelector('[data-testid="brain-view"]');
      if (!p || !host) return null;
      const hb = host.getBoundingClientRect();
      const tiles = [...host.querySelectorAll("[data-brain-overlay]")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      const ids = p.topNodes(400);
      let covered = 0;
      let total = 0;
      for (const id of ids) {
        const s = p.screenPos(id);
        if (!s) continue;
        total++;
        const x = hb.left + s.x;
        const y = hb.top + s.y;
        if (tiles.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) covered++;
      }
      return { covered, total };
    });
    expect(under).not.toBeNull();
    test.info().annotations.push({ type: "Punkte unter Kacheln nach „Einpassen“", description: JSON.stringify(under) });
    expect((under?.covered ?? 0) / Math.max(1, under?.total ?? 1)).toBeLessThan(0.05);
    await page.getByRole("button", { name: /Darstellung/i }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "brain-colors-families.png") });
    expect(errors).toEqual([]);
  });

  test("Info-Karte zeigt Text ohne Markdown-Zeichen und schließt beim Wechsel der Session", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/sessions");
    const list = page.getByRole("list").first();
    await expect(list).toBeVisible({ timeout: 15_000 });
    const cards = list.getByRole("button");
    test.skip((await cards.count()) === 0, "keine Sessions im lokalen Stack");
    await cards.first().click();
    await page.getByRole("tab", { name: /Bezüge/ }).click();
    const lg = page.getByTestId("local-graph");
    await expect(lg).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Number(await lg.getAttribute("data-node-count")), { timeout: 15_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(2500);
    const center = await page.evaluate(() => {
      const p = window.__localGraphPerf;
      const id = p?.topNodes(20).find((x) => x.startsWith("session:"));
      return id ? { id, pos: p?.screenPos(id) } : null;
    });
    test.skip(!center?.pos, "kein Session-Punkt im lokalen Graphen");
    const box = await lg.getByTestId("graph-canvas").boundingBox();
    if (!box || !center?.pos) throw new Error("kein Graph");
    await page.mouse.click(box.x + center.pos.x, box.y + center.pos.y);
    const card = lg.getByTestId("node-card");
    await expect(card).toBeVisible();
    await expect(card.locator("dl")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(600);
    const text = (await card.textContent()) ?? "";
    expect(text).not.toMatch(/`|\*\*|^#+\s|<\/?[a-z]/m);
    expect(await card.locator("img").count()).toBe(0);
    // Auszug (letzte Nachricht/Auftrag) ins Bild holen — dort stand vorher rohes Markdown
    const excerpt = card.locator("section").first();
    if ((await excerpt.count()) > 0) await excerpt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "brain-info-card.png") });

    // Zu einer anderen Session wechseln (Link „Dieselben Dateien geschrieben" im selben Reiter —
    // der lokale Graph bleibt dabei eingehängt) → die Karte der alten Session ist weg.
    const before = new URL(page.url()).pathname;
    const other = page.locator('main a[href^="/sessions/"]').filter({ hasNot: page.locator("[data-testid=node-card]") });
    const hrefs = await other.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    const key = (path: string) => decodeURIComponent(path.split("/")[4] ?? "").replace(/^(claude|codex):/, "");
    const idx = hrefs.findIndex((h) => h.split("/").length >= 5 && key(h) !== key(before));
    test.info().annotations.push({ type: "Wechsel", description: `${before} → ${hrefs[idx] ?? "-"}` });
    test.skip(idx < 0, "keine verknüpfte andere Session");
    await other.nth(idx).click();
    await expect.poll(() => key(new URL(page.url()).pathname), { timeout: 10_000 }).not.toBe(key(before));
    const tab = page.getByRole("tab", { name: /Bezüge/ });
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect(page.getByTestId("local-graph")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("node-card")).toHaveCount(0);
  });
});
