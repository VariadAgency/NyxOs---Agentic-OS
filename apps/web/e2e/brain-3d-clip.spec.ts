// Gehirn 3D gegen den lokalen Stack (echte GPU): ein 8-s-Clip — Drehen (Globus um die Mitte),
// Klick = Auswahl + Impuls, Doppelklick = Anfliegen mit geöffnetem Seitenblatt.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_GPU=1 pnpm --filter @nyxos/web exec playwright test e2e/brain-3d-clip.spec.ts --project chromium-1440
// Screenshots/Video: `.probe/shots/brain-clip-*.png`, `brain-clip.webm`
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });
const GPU = Boolean(process.env.E2E_GPU);
if (GPU) test.use({ channel: "chrome", headless: false });

async function open3d(page: Page, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet|status of 503/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/gehirn");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.") && k !== "nyxos.brain.positions3d.v1") localStorage.removeItem(k);
    localStorage.setItem("nyxos.brain.settings.v1", JSON.stringify({ schema: 2, mode: "3d" }));
  });
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 40_000 });
  await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 40_000 }).catch(() => undefined);
}

test.describe("Gehirn 3D: Clip", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Clip nur in Chromium");

  test("Drehen um die Mitte, Impuls, Anfliegen neben dem Seitenblatt", async ({ browser }, info) => {
    test.setTimeout(150_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(SHOTS, ".video"), size: { width: 1440, height: 900 } }, baseURL: info.project.use.baseURL });
    const page = await context.newPage();
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await page.getByTestId("graph-3d").boundingBox();
    if (!box) throw new Error("kein 3D-Bereich");
    await page.waitForTimeout(1500);

    // 1) Drehen im leeren Raum (Globus): Drehpunkt bleibt die Mitte der Wolke.
    const x0 = box.x + box.width * 0.5;
    const y0 = box.y + box.height - 120;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(x0 + i * 10, y0);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(SHOTS, "brain-clip-rotate.png") });
    const pv = await page.evaluate(() => window.__brain3dPerf?.pivot());
    const dist = pv ? Math.hypot(pv.target[0] - pv.center[0], pv.target[1] - pv.center[1], pv.target[2] - pv.center[2]) : 999;

    // 2) Klick auf einen verbundenen Knoten: Auswahl (Seitenblatt links) + Impuls.
    const [hub] = await page.evaluate(() => window.__brain3dPerf?.topNodes(8).slice(3) ?? []);
    await page.evaluate((id) => window.__brain3dPerf?.placeNear(id ?? "", 520), hub);
    await page.waitForTimeout(500);
    const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    if (!sp) throw new Error("Knoten nicht im Bild");
    await page.mouse.click(box.x + sp.x, box.y + sp.y);
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.pulse.active)).toBe(true);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, "brain-clip-select.png") });
    const sheet = page.getByRole("complementary", { name: /^Details:/ });
    await expect(sheet).toBeVisible();

    // 3) Doppelklick = Anfliegen: der Knoten landet in der Mitte der freien Fläche RECHTS vom Blatt.
    const sp2 = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    if (!sp2) throw new Error("Knoten nicht im Bild");
    await page.mouse.dblclick(box.x + sp2.x, box.y + sp2.y);
    await page.waitForTimeout(1400);
    await page.screenshot({ path: join(SHOTS, "brain-clip-fly-to.png") });
    const sb = await sheet.boundingBox();
    const landed = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    const shift = await page.evaluate(() => window.__brain3dPerf?.viewShift());
    const video = page.video();
    await context.close();
    const src = await video?.path();
    if (src) renameSync(src, join(SHOTS, "brain-clip.webm"));

    const m = { pivotToCenter: dist, sheetRight: sb ? sb.x + sb.width - box.x : null, landed, shift };
    info.annotations.push({ type: "brain-clip", description: JSON.stringify(m) });
    console.log("[brain-clip]", JSON.stringify(m));
    expect(dist).toBeLessThan(5); // Drehziel = Mitte der Wolke (nicht seitlich)
    expect(sb).not.toBeNull();
    expect(landed?.x ?? 0).toBeGreaterThan((sb?.x ?? 0) + (sb?.width ?? 0) - box.x + 40); // nicht unter dem Blatt
    expect(shift?.gx ?? 0).toBeLessThan(0); // setViewOffset: negativer Versatz = Bild nach rechts, weg vom Blatt
    expect(errors).toEqual([]);
  });
});
