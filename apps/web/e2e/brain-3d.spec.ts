// Gehirn in 3D gegen den lokalen Stack (echte Daten): Knoten nah sichtbar, Legende, Steuerung (Trackpad,
// Zoom zur Maus, Schwung, F/V), Physik-Regler, Klick-Welle mit Lichtimpulsen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_GPU=1 pnpm --filter @nyxos/web exec playwright test e2e/brain-3d.spec.ts --project chromium-1440
// Mit `E2E_GPU=1` echte GPU (Chrome, sichtbares Fenster) — nur dann gelten die fps-Grenzen.
// Screenshots/Video: `.probe/shots/brain-3d-*.png`, `brain-3d-impulse.webm`
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });
const GPU = Boolean(process.env.E2E_GPU);
if (GPU) test.use({ channel: "chrome", headless: false });

async function open3d(page: Page, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/gehirn");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.") && k !== "nyxos.brain.positions3d.v1") localStorage.removeItem(k);
  });
  await page.goto("/gehirn");
  await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0, undefined, { timeout: 30_000 });
  // Die Leiste rechts startet zugeklappt (Griff am Rand)
  const handle = page.getByRole("button", { name: "Steuerung öffnen" });
  if ((await handle.getAttribute("aria-expanded")) === "false") await handle.click();
  const disp = page.getByRole("button", { name: /Darstellung/i });
  if ((await disp.getAttribute("aria-expanded")) !== "true") await disp.click();
  await page.getByLabel("Ansicht", { exact: true }).getByRole("radio", { name: "3D", exact: true }).click();
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 20_000 });
  await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 40_000 }).catch(() => undefined);
  // Darstellung wieder zu (freie Sicht auf die Wolke)
  if ((await disp.getAttribute("aria-expanded")) === "true") await disp.click();
}

async function box3d(page: Page) {
  const b = await page.getByTestId("graph-3d").boundingBox();
  if (!b) throw new Error("kein 3D-Bereich");
  return b;
}

/** Mittlere Helligkeit (0–255, max. Kanal) eines Bildausschnitts aus einem Screenshot. */
async function brightness(page: Page, png: Buffer, x: number, y: number, r: number): Promise<number> {
  return page.evaluate(
    async ([b64, cx, cy, rr]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) return 0;
      ctx.drawImage(img, 0, 0);
      const s = img.width / window.innerWidth;
      const d = ctx.getImageData(Math.round((Number(cx) - Number(rr)) * s), Math.round((Number(cy) - Number(rr)) * s), Math.round(Number(rr) * 2 * s), Math.round(Number(rr) * 2 * s)).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0);
      return sum / (d.length / 4);
    },
    [png.toString("base64"), x, y, r] as const,
  );
}

test.describe("Gehirn 3D", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Messungen/Screenshots nur in Chromium");

  test("Große Knoten nah kräftig sichtbar", async ({ page }) => {
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await box3d(page);
    const [big] = await page.evaluate(() => window.__brain3dPerf?.topNodes(1) ?? []);
    if (!big) throw new Error("kein Knoten");
    // So nah heran, dass der Knoten groß im Bild ist (wie beim Heranzoomen).
    await page.evaluate((id) => window.__brain3dPerf?.placeNear(id, 140), big);
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2); // kein Hover-Abdunkeln
    await page.waitForTimeout(500);
    const lookBig = await page.evaluate((id) => window.__brain3dPerf?.nodeLook(id), big);
    const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id), big);
    const png = await page.screenshot({ path: join(SHOTS, "brain-3d-near.png") });
    if (!sp || !lookBig) throw new Error("Knoten nicht im Bild");
    const center = await brightness(page, png, box.x + sp.x, box.y + sp.y, 6);
    console.log("[brain-3d near]", JSON.stringify({ big, lookBig, center }));
    expect(lookBig.diameterPx).toBeGreaterThan(200); // wächst nah weiter (vorher bei 180 CSS-px gedeckelt)
    expect(lookBig.alpha).toBeGreaterThan(0.85); // ausgegraut, aber nah kräftig
    expect(center).toBeGreaterThan(90); // deckender Kern statt fast unsichtbar
    expect(errors).toEqual([]);
  });

  test("Legende eingeklappt, gleiche Ebene wie die Bedienleiste, klappt auf", async ({ page }) => {
    const errors: string[] = [];
    await open3d(page, errors);
    const legend = page.getByTestId("brain-legend");
    const toggle = legend.getByRole("button", { name: /^Legende/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const bar = page.getByTestId("brain-3d-help").locator("[data-brain-overlay]").last();
    const lb = await legend.boundingBox();
    const bb = await bar.boundingBox();
    if (!lb || !bb) throw new Error("Legende/Leiste fehlt");
    expect(Math.abs(lb.y + lb.height - (bb.y + bb.height))).toBeLessThan(4); // gleiche Unterkante
    expect(lb.x + lb.width).toBeLessThanOrEqual(bb.x + 1); // nebeneinander, nicht übereinander
    await toggle.click();
    await expect(legend).toHaveAttribute("data-open", "1");
    await page.waitForTimeout(700); // Flug-Animation fertig
    await expect(legend.getByTestId("legend-family-session")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "brain-3d-legend.png") });
    const lb2 = await legend.boundingBox();
    // Aufgeklappt fliegt die Liste ÜBER dem Knopf hoch; Knopf und Leiste bleiben, wo sie sind.
    const body = await legend.locator(".brain-legend-body").boundingBox();
    expect((body?.y ?? 0) + (body?.height ?? 0)).toBeLessThanOrEqual(lb.y);
    expect(Math.abs((lb2?.y ?? 0) - lb.y)).toBeLessThan(2);
    expect((await bar.boundingBox())?.x).toBeCloseTo(bb.x, 0);
    await toggle.click();
    await expect(legend).toHaveAttribute("data-open", "0");
    expect(errors).toEqual([]);
  });

  test("Steuerung: Trackpad dreht, Kneifen/Rad zoomt zur Maus, Ziehen mit Schwung, F zeigt alles, V fliegt", async ({ page }) => {
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await box3d(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cam = () => page.evaluate(() => window.__brain3dPerf?.viewDistance() ?? 0);
    // Wie echte Chrome-Ereignisse am Mac: Trackpad wheelDelta = −3 × delta, Maus-Raste wheelDelta = ±120.
    const wheel = (o: WheelEventInit & { legacy?: [number, number] }) =>
      page.evaluate(({ legacy, ...init }) => {
        const c = document.querySelector('[data-testid="graph-3d"] > canvas:not([aria-hidden])');
        const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
        const [lx, ly] = legacy ?? [-3 * (init.deltaX ?? 0), -3 * (init.deltaY ?? 0)];
        Object.defineProperty(e, "wheelDeltaX", { value: lx });
        Object.defineProperty(e, "wheelDeltaY", { value: ly });
        c?.dispatchEvent(e);
      }, o);
    const shot = async () => page.screenshot();
    await page.waitForTimeout(1200); // Einpassen nach dem Aufbau abwarten
    // Zwei Finger seitlich (Trackpad): dreht — Bild ändert sich, Abstand bleibt.
    const d0 = await cam();
    const s0 = await shot();
    for (let i = 0; i < 20; i++) await wheel({ deltaX: 9, deltaY: 0, clientX: cx, clientY: cy });
    await page.waitForTimeout(500);
    const d1 = await cam();
    expect(Buffer.compare(s0, await shot())).not.toBe(0);
    expect(Math.abs(d1 - d0) / d0).toBeLessThan(0.05);
    // Kneifen (ctrlKey): näher ran, weich.
    for (let i = 0; i < 15; i++) await wheel({ deltaY: -8, ctrlKey: true, clientX: cx, clientY: cy });
    await page.waitForTimeout(600);
    const d2 = await cam();
    expect(d2).toBeLessThan(d1 * 0.8);
    // Maus-Rad (grobe Rasten): weiter weg.
    await page.waitForTimeout(300); // neue Geste
    for (let i = 0; i < 3; i++) await wheel({ deltaY: 100, clientX: cx, clientY: cy, legacy: [0, -120] });
    await page.waitForTimeout(600);
    expect(await cam()).toBeGreaterThan(d2 * 1.3);
    // Ziehen mit Schwung: nach dem Loslassen dreht es noch weiter.
    await page.mouse.move(cx - 200, cy);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(cx - 200 + i * 25, cy, { steps: 1 });
    await page.mouse.up();
    const a = await shot();
    await page.waitForTimeout(250);
    expect(Buffer.compare(a, await shot())).not.toBe(0);
    // F = alles zeigen
    await page.getByTestId("graph-3d").focus();
    await page.keyboard.press("f");
    await page.waitForTimeout(900);
    expect(await cam()).toBeGreaterThan(50);
    // V = Fliegen und zurück
    await page.keyboard.press("v");
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.control)).toBe("fly");
    await page.keyboard.press("v");
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.control)).toBe("orbit");
    expect(errors).toEqual([]);
  });

  test("Physik-Regler wirken in 3D (Worker bekommt die Werte, Wolke bewegt sich)", async ({ page }) => {
    const errors: string[] = [];
    await open3d(page, errors);
    const [id] = await page.evaluate(() => window.__brain3dPerf?.topNodes(1) ?? []);
    const p0 = await page.evaluate((n) => window.__brain3dPerf?.nodePos(n ?? ""), id);
    const forces = page.getByRole("button", { name: /Kräfte/ });
    if ((await forces.getAttribute("aria-expanded")) !== "true") await forces.click();
    const slider = page.getByLabel("Verbindungsabstand");
    await slider.evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(el, "420");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.forces.distance)).toBe(420);
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.simRunning)).toBe(true);
    await page.waitForTimeout(1500);
    const p1 = await page.evaluate((n) => window.__brain3dPerf?.nodePos(n ?? ""), id);
    const moved = Math.hypot((p1?.[0] ?? 0) - (p0?.[0] ?? 0), (p1?.[1] ?? 0) - (p0?.[1] ?? 0), (p1?.[2] ?? 0) - (p0?.[2] ?? 0));
    console.log("[brain-3d physics]", JSON.stringify({ id, p0, p1, moved }));
    expect(moved).toBeGreaterThan(5);
    await expect(page.getByLabel("Schweben")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Klick: Welle + Lichtimpulse, fps gemessen", async ({ browser }, info) => {
    test.setTimeout(120_000);
    const dir = join(SHOTS, ".video");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } }, baseURL: info.project.use.baseURL });
    const page = await context.newPage();
    const errors: string[] = [];
    await open3d(page, errors);
    const box = await box3d(page);
    const idle = await page.evaluate(async () => window.__brain3dPerf?.measure(2000));
    // Maus-Drehen messen
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const orbitP = page.evaluate(async () => window.__brain3dPerf?.measure(2000));
    await page.mouse.move(cx - 160, cy);
    await page.mouse.down();
    for (let i = 0; i < 70; i++) {
      await page.mouse.move(cx - 160 + i * 4, cy + Math.sin(i / 8) * 25);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const orbit = await orbitP;
    await page.keyboard.press("f");
    await page.waitForTimeout(900);
    // Einen gut verbundenen Knoten anklicken
    const [hub] = await page.evaluate(() => window.__brain3dPerf?.topNodes(12).slice(6) ?? []);
    await page.evaluate((id) => window.__brain3dPerf?.placeNear(id ?? "", 420), hub);
    await page.waitForTimeout(400);
    const sp = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    if (!sp) throw new Error("Knoten nicht im Bild");
    const pulseP = page.evaluate(async () => window.__brain3dPerf?.measure(1800));
    await page.mouse.click(box.x + sp.x, box.y + sp.y);
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.pulse.active)).toBe(true);
    const pulse = await page.evaluate(() => window.__brain3dPerf?.pulse);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, "brain-3d-impulse.png") });
    const during = await pulseP;
    await page.waitForTimeout(1200);
    // Doppelklick: hinfliegen (vorher alles zeigen, damit es weit ist)
    await page.keyboard.press("f");
    await page.waitForTimeout(1000);
    const d0 = await page.evaluate(() => window.__brain3dPerf?.viewDistance() ?? 0);
    const sp2 = await page.evaluate((id) => window.__brain3dPerf?.screenPos(id ?? ""), hub);
    if (sp2) await page.mouse.dblclick(box.x + sp2.x, box.y + sp2.y);
    await page.waitForTimeout(1300);
    const d1 = await page.evaluate(() => window.__brain3dPerf?.viewDistance() ?? 0);
    const m = { idle, orbit, during, pulse, d0: Math.round(d0), d1: Math.round(d1) };
    info.annotations.push({ type: "brain-3d", description: JSON.stringify(m) });
    console.log("[brain-3d fps]", JSON.stringify(m));
    const video = page.video();
    await context.close();
    const src = await video?.path();
    if (src) renameSync(src, join(SHOTS, "brain-3d-impulse.webm"));
    expect(pulse?.edges ?? 0).toBeGreaterThan(0);
    expect(pulse?.nodes ?? 0).toBeGreaterThan(1);
    expect(d1).toBeLessThan(d0 * 0.9); // Doppelklick fliegt zum Knoten
    expect(during?.renderMsAvg ?? 99).toBeLessThan(8);
    if (GPU) {
      expect(idle?.fps ?? 0).toBeGreaterThanOrEqual(100);
      expect(during?.fps ?? 0).toBeGreaterThanOrEqual(60);
      expect(orbit?.fps ?? 0).toBeGreaterThanOrEqual(60);
    }
    expect(errors).toEqual([]);
  });
});
