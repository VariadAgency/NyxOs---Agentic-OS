// Gehirn: Aufräumen (Worker/WebGL), Live-Delta in 3D, Info-Karte sicher (Text statt HTML), nichts überlappt.
// Gegen den lokalen Stack (echte Daten), wie brain-views.spec.ts:
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/brain-cleanup-live-delta.spec.ts --project chromium-1440
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openBrainPanel } from "./helpers/brainPanel";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");

if (process.env.E2E_GPU) test.use({ channel: "chrome", headless: false });

const VAULT_ROOT = process.env.E2E_VAULT_ROOT ?? "/tmp/nyxos-e2e/vault";
const TOKEN = process.env.E2E_BRIDGE_TOKEN ?? "dev-token";

async function openBrain(page: Page) {
  await page.goto("/gehirn");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.")) localStorage.removeItem(k);
  });
  await page.goto("/gehirn");
  await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0, undefined, { timeout: 30_000 });
}

async function to3d(page: Page) {
  await openBrainPanel(page);
  const disp = page.getByRole("button", { name: /Darstellung/i });
  if ((await disp.getAttribute("aria-expanded")) !== "true") await disp.click();
  await page.getByLabel("Ansicht", { exact: true }).getByRole("radio", { name: "3D", exact: true }).click();
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 20_000 });
}
async function to2d(page: Page) {
  await openBrainPanel(page);
  await page.getByLabel("Ansicht", { exact: true }).getByRole("radio", { name: "2D", exact: true }).click();
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test.describe("Gehirn: Aufräumen, Live-Delta, Überlappung", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "nur Chromium");

  test("Aufräumen: 2D↔3D ohne doppelte Worker, beim Verlassen keine Worker und keine WebGL-Kontexte übrig", async ({ page }) => {
    test.setTimeout(240_000); // 18× Seite verlassen und wiederkommen
    const warnings: string[] = [];
    page.on("console", (m) => {
      if (/too many active webgl contexts|context lost/i.test(m.text())) warnings.push(m.text());
    });
    await openBrain(page);
    await to3d(page);
    expect(page.workers().length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 4; i++) {
      await to2d(page);
      await to3d(page);
    }
    // Umschalten baut nichts doppelt auf: höchstens ein Worker für 2D und einer für 3D
    expect(page.workers().length).toBeLessThanOrEqual(2);
    // Seite (per App-Navigation) verlassen und wiederkommen — 18× (Chrome erlaubt ~16 Kontexte)
    for (let i = 0; i < 18; i++) {
      await page.getByRole("link", { name: "Sessions", exact: true }).first().click();
      await expect(page.getByTestId("brain-view")).toHaveCount(0);
      await expect.poll(() => page.workers().length).toBe(0);
      await page.getByRole("link", { name: "Gehirn", exact: true }).first().click();
      await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 20_000 });
    }
    expect(warnings).toEqual([]);
  });

  test("Live-Delta in 3D: neue Notiz erscheint als Punkt, Info-Karte zeigt ihren Anfang als Text (kein HTML)", async ({ page, request }) => {
    test.setTimeout(90_000);
    await openBrain(page);
    await to3d(page);
    await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 30_000 }).catch(() => undefined);
    const n0 = await page.evaluate(() => window.__brain3dPerf?.nodes ?? 0);
    const stamp = Date.now();
    const path = `99 Test/Live-Notiz-${stamp}.md`;
    const note = {
      path,
      title: `Live-Notiz-${stamp}`,
      heading: null,
      folder: "99 Test",
      tags: [],
      links: ["03 Architektur"],
      mentions: [],
      mtime: new Date().toISOString(),
      size: 10,
      excerpt: `<img src=x onerror="window.__xss=1"> Hallo <b>fett</b>`,
    };
    const post = (body: unknown) => request.post("/ingest/vault", { data: body, headers: { authorization: `Bearer ${TOKEN}` } });
    const r = await post({ root: VAULT_ROOT, syncId: "e2e-live", mode: "delta", notes: [note], deleted: [] });
    expect(r.ok()).toBe(true);
    try {
      const id = `note:${path}`;
      await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.nodes ?? 0), { timeout: 20_000 }).toBeGreaterThan(n0);
      await expect.poll(() => page.evaluate((x) => window.__brain3dPerf?.screenPos(x) ?? null, id), { timeout: 10_000 }).not.toBeNull();
      // Info-Karte/Seitenblatt: Auszug als reiner Text
      const detail = (await (await request.get(`/api/graph/node/${encodeURIComponent(id)}`)).json()) as { excerpt: { text: string } | null };
      expect(detail.excerpt?.text).toContain("<img");
      await page.goto(`/gehirn?focus=${encodeURIComponent(id)}`);
      const sheet = page.getByRole("complementary", { name: `Details: Live-Notiz-${stamp}` });
      await expect(sheet.getByText("Hallo", { exact: false })).toBeVisible({ timeout: 20_000 });
      expect(await sheet.locator("img").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
    } finally {
      await post({ root: VAULT_ROOT, syncId: "e2e-live", mode: "delta", notes: [], deleted: [path] });
    }
  });

  test("2D mit Pfeilen bleibt flüssig (selbst gezeichnete Kanten, ganzes Gehirn im Bild)", async ({ page }) => {
    test.setTimeout(90_000);
    await openBrain(page);
    await page.evaluate(() => localStorage.setItem("nyxos.brain.settings.v1", JSON.stringify({ schema: 2, mode: "2d", arrows: true })));
    await page.goto("/gehirn");
    await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0, undefined, { timeout: 30_000 });
    await page.waitForFunction(() => window.__brainPerf?.firstStableMs != null, undefined, { timeout: 30_000 });
    const box = await page.getByTestId("graph-canvas").boundingBox();
    if (!box) throw new Error("kein Graph");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const worst: number[] = [];
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, i < 3 ? -60 : 60);
      worst.push(await page.evaluate(() => new Promise<number>((r) => { const a = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - a))); })));
    }
    expect(Math.max(...worst)).toBeLessThan(150); // zwei Bilder < 150 ms (vorher ~1 s je Bild)
  });

  test("Seitenblatt und Legende überlappen nicht, das Seitenblatt bleibt im Bild", async ({ page, request }) => {
    const list = (await (await request.get("/api/sessions?limit=50")).json()) as { sessions: Array<{ id: string; parentId: string | null }> };
    const s = list.sessions.find((x) => !x.parentId);
    test.skip(!s, "keine Session im lokalen Stack");
    await openBrain(page);
    await page.goto(`/gehirn?brain=${encodeURIComponent(`session:${s?.id ?? ""}`)}`);
    await expect(page.getByTestId("brain-focus")).toBeVisible({ timeout: 20_000 });
    const sheet = page.getByRole("complementary", { name: /^Details:/ });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(1500); // Auszüge geladen → Blatt ist lang
    for (const mode of ["2d", "3d"] as const) {
      if (mode === "3d") await to3d(page);
      const view = await page.getByTestId("brain-view").boundingBox();
      const a = await sheet.boundingBox();
      const b = await page.getByTestId("brain-legend").boundingBox();
      if (!view || !a || !b) throw new Error("fehlt");
      expect({ mode, overlap: overlaps(a, b) }).toEqual({ mode, overlap: false });
      expect(a.y + a.height).toBeLessThanOrEqual(view.y + view.height + 1);
      await page.screenshot({ path: join(SHOTS, `E-kritik-blatt-${mode}.png`) });
    }
  });

  test("3D im eigenen Gehirn: die gezeigten Punkte bleiben im Bild, während sich die 3D-Form aufbaut", async ({ page, request }) => {
    test.setTimeout(90_000);
    const list = (await (await request.get("/api/sessions?limit=50")).json()) as { sessions: Array<{ id: string; parentId: string | null }> };
    const s = list.sessions.find((x) => !x.parentId);
    test.skip(!s, "keine Session im lokalen Stack");
    const id = `session:${s?.id ?? ""}`;
    await openBrain(page);
    await page.goto(`/gehirn?brain=${encodeURIComponent(id)}`);
    await expect(page.getByTestId("brain-focus")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Info schließen" }).or(page.getByRole("button", { name: /Details schließen|Schließen/ })).first().click().catch(() => undefined);
    await to3d(page);
    const box = await page.getByTestId("graph-3d").boundingBox();
    if (!box) throw new Error("kein 3D");
    const inView = async () => {
      const p = await page.evaluate((x) => window.__brain3dPerf?.screenPos(x) ?? null, id);
      return !!p && p.x > 0 && p.y > 0 && p.x < box.width && p.y < box.height;
    };
    for (const ms of [800, 1500, 3000]) {
      await page.waitForTimeout(ms === 800 ? 800 : ms === 1500 ? 700 : 1500);
      expect({ ms, inView: await inView() }).toEqual({ ms, inView: true });
    }
    await page.screenshot({ path: join(SHOTS, "brain-3d-own-brain.png") });
  });
});
