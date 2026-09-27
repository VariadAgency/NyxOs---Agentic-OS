// Gehirn 3D gegen den lokalen Stack (echte Daten, echte GPU): schlanker Kopf, Steuer-Leiste zugeklappt und
// ausfahrbar (390 px als Blatt von unten), Lichtimpuls, Knoten ziehen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_GPU=1 pnpm --filter @nyxos/web exec playwright test e2e/brain-3d-panel-impulse.spec.ts --project chromium-1440
// Screenshots/Videos: `.probe/shots/brain-3d-*.png`, `brain-3d-pulse.webm`, `brain-3d-drag.webm`
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });
const GPU = Boolean(process.env.E2E_GPU);
if (GPU) test.use({ channel: "chrome", headless: false });

/** Gehirn in 3D öffnen, ohne die (zugeklappte) Leiste anzufassen. */
async function open3d(page: Page, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet|status of 503/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/gehirn");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.") && k !== "nyxos.brain.positions3d.v1") localStorage.removeItem(k);
    // Älterer gespeicherter Stand: Leiste offen gemerkt — muss trotzdem zugeklappt starten.
    localStorage.setItem("nyxos.brain.settings.v1", JSON.stringify({ schema: 2, mode: "3d", panelOpen: true }));
  });
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 40_000 });
  await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 40_000 }).catch(() => undefined);
}

async function box3d(page: Page) {
  const b = await page.getByTestId("graph-3d").boundingBox();
  if (!b) throw new Error("kein 3D-Bereich");
  return b;
}

async function recorded(browser: import("@playwright/test").Browser, baseURL: string | undefined) {
  const dir = join(SHOTS, ".video");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } }, baseURL });
  return { context, page: await context.newPage() };
}

test.describe("Gehirn 3D: Leiste, Impuls, Ziehen", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Messungen/Videos nur in Chromium");

  test("Kopf schlank in einer Zeile, Leiste rechts zugeklappt und ausfahrbar", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    await open3d(page, errors);
    const stats = page.getByTestId("brain-stats");
    await expect(stats).toBeVisible();
    const sb = await stats.boundingBox();
    expect(sb?.height ?? 99).toBeLessThan(32); // eine Zeile
    await expect(stats).not.toContainText("Gehirn");
    const panel = page.getByTestId("brain-panel");
    await expect(panel).toHaveAttribute("data-open", "0");
    const handle = page.getByRole("button", { name: "Steuerung öffnen" });
    const hb = await handle.boundingBox();
    expect(hb?.width ?? 99).toBeLessThan(44); // schmaler Griff statt 312-px-Leiste
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "brain-3d-header.png") });
    await handle.click();
    await expect(panel).toHaveAttribute("data-open", "1");
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: /Darstellung/ })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "brain-3d-panel-open.png") });
    await page.getByRole("button", { name: "Steuerung schließen" }).click();
    await expect(page.getByTestId("brain-panel")).toHaveAttribute("data-open", "0");
    // „immer zugeklappt“: auch wenn sie zuletzt offen war, startet das Gehirn mit zugeklappter Leiste
    await handle.click();
    await expect(panel).toHaveAttribute("data-open", "1");
    await page.reload();
    await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 40_000 });
    await expect(page.getByTestId("brain-panel")).toHaveAttribute("data-open", "0");
    expect(errors).toEqual([]);
  });

  test("390 px: ausgefahrene Leiste ist ein Blatt von unten (≤ 45 %), das Gehirn bleibt oben frei", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/gehirn");
    await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0, undefined, { timeout: 30_000 });
    const panel = page.getByTestId("brain-panel");
    await expect(panel).toHaveAttribute("data-open", "0");
    await page.getByRole("button", { name: "Steuerung öffnen" }).click();
    await expect(panel).toHaveAttribute("data-open", "1");
    await page.waitForTimeout(500);
    const view = await page.getByTestId("brain-view").boundingBox();
    const body = await page.getByTestId("brain-panel-body").boundingBox();
    if (!view || !body) throw new Error("keine Maße");
    expect(body.height).toBeLessThanOrEqual(view.height * 0.46);
    expect(view.y + view.height - (body.y + body.height)).toBeLessThan(24); // unten angedockt
    expect(body.y).toBeGreaterThan(view.y + view.height * 0.5); // obere Hälfte frei
    await page.screenshot({ path: join(SHOTS, "brain-3d-panel-390.png") });
  });

  test("Lichtimpuls ohne Feuerwerk, fps gemessen", async ({ browser }, info) => {
    test.setTimeout(120_000);
    const { context, page } = await recorded(browser, info.project.use.baseURL);
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await box3d(page);
    await page.mouse.move(box.x + box.width - 20, box.y + 20);
    await page.waitForTimeout(2500); // Aufbau/Einpassen vorbei
    const idle = await page.evaluate(async () => window.__brain3dPerf?.measure(2500));
    // ein stark verbundener Knoten (wie „Option“ mit ~70 Verbindungen)
    const [hub] = await page.evaluate(() => window.__brain3dPerf?.topNodes(8).slice(3) ?? []);
    await page.evaluate((id) => window.__brain3dPerf?.placeNear(id ?? "", 520), hub);
    await page.waitForTimeout(600);
    const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    if (!sp) throw new Error("Knoten nicht im Bild");
    const pulseP = page.evaluate(async () => window.__brain3dPerf?.measure(2400));
    await page.mouse.click(box.x + sp.x, box.y + sp.y);
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.pulse.active)).toBe(true);
    const pulse = await page.evaluate(() => window.__brain3dPerf?.pulse);
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(SHOTS, "brain-3d-pulse-mid.png") });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(SHOTS, "brain-3d-pulse-end.png") });
    const during = await pulseP;
    await page.waitForTimeout(1500);
    const m = { idle, during, pulse };
    info.annotations.push({ type: "brain-3d", description: JSON.stringify(m) });
    console.log("[brain-3d pulse]", JSON.stringify(m));
    const video = page.video();
    await context.close();
    const src = await video?.path();
    if (src) renameSync(src, join(SHOTS, "brain-3d-pulse.webm"));
    expect(pulse?.edges ?? 0).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    if (GPU) {
      expect(idle?.fps ?? 0).toBeGreaterThanOrEqual(100);
      expect(during?.fps ?? 0).toBeGreaterThanOrEqual(100);
    }
  });

  test("Knoten greifen und in 3D ziehen, Loslassen federt zurück", async ({ browser }, info) => {
    test.setTimeout(120_000);
    const { context, page } = await recorded(browser, info.project.use.baseURL);
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await box3d(page);
    const [node] = await page.evaluate(() => window.__brain3dPerf?.topNodes(30).slice(20) ?? []);
    await page.evaluate((id) => window.__brain3dPerf?.placeNear(id ?? "", 700), node);
    await page.waitForTimeout(800);
    const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), node);
    if (!sp) throw new Error("Knoten nicht im Bild");
    const view0 = await page.evaluate(() => window.__brain3dPerf?.viewDistance() ?? 0);
    const p0 = await page.evaluate((id) => window.__brain3dPerf?.nodePos(id ?? ""), node);
    const dragP = page.evaluate(async () => window.__brain3dPerf?.measure(1800));
    const x0 = box.x + sp.x;
    const y0 = box.y + sp.y;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(x0 + i * 6, y0 - i * 3);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const spDrag = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), node);
    const pDrag = await page.evaluate((id) => window.__brain3dPerf?.nodePos(id ?? ""), node);
    const viewDrag = await page.evaluate(() => window.__brain3dPerf?.viewDistance() ?? 0);
    await page.screenshot({ path: join(SHOTS, "brain-3d-drag.png") });
    await page.mouse.up();
    const drag = await dragP;
    await page.waitForTimeout(2500);
    const pAfter = await page.evaluate((id) => window.__brain3dPerf?.nodePos(id ?? ""), node);
    const dist = (a?: number[] | null, b?: number[] | null) => Math.hypot((a?.[0] ?? 0) - (b?.[0] ?? 0), (a?.[1] ?? 0) - (b?.[1] ?? 0), (a?.[2] ?? 0) - (b?.[2] ?? 0));
    const m = { node, moved: Math.round(dist(pDrag, p0)), back: Math.round(dist(pAfter, pDrag)), cursor: [x0 + 240 - box.x, y0 - 120 - box.y], spDrag, drag, view0, viewDrag };
    info.annotations.push({ type: "brain-3d", description: JSON.stringify(m) });
    console.log("[brain-3d drag]", JSON.stringify(m));
    const video = page.video();
    await context.close();
    const src = await video?.path();
    if (src) renameSync(src, join(SHOTS, "brain-3d-drag.webm"));
    expect(m.moved).toBeGreaterThan(20); // der Knoten wurde bewegt …
    expect(Math.hypot((spDrag?.x ?? 0) - m.cursor[0], (spDrag?.y ?? 0) - m.cursor[1])).toBeLessThan(40); // … und klebt an der Maus
    expect(Math.abs(viewDrag - view0) / view0).toBeLessThan(0.02); // Ziehen am Knoten bewegt die Kamera nicht
    expect(m.back).toBeGreaterThan(3); // federt nach dem Loslassen zurück
    expect(errors).toEqual([]);
  });
});
