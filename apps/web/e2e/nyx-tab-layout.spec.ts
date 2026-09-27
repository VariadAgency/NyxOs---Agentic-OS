// Nyx-Tab-Layout gegen den lokalen Stack in Chromium UND WebKit, 1440 + 390 px: Seitenleiste sichtbar
// (390: ☰-Menü im Tab), Layout (Netz-Mitte, Glas-Leiste rechts, Dock unten) sauber, Esc bleibt im Tab, mehr
// Datenpunkte/Kabel um den Kern, Schwenken weich. Bildrate wird gemessen und protokolliert.
//   NYXOS_HAIKU_SCHEDULER=0 pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-tab-layout.spec.ts --project chromium-1440 --project webkit-1440
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.describe.configure({ mode: "serial", timeout: 150_000 });
// Chromium headless rechnet WebGL sonst in Software (SwiftShader, ~12 fps) — mit E2E_GPU=1 über die echte GPU (Metal).
if (process.env.E2E_GPU) test.use({ channel: "chromium", launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] } });

async function nyxEvent(page: Page, body: unknown) {
  const send = () => page.request.post("/api/nyx/events", { data: body, headers: { "x-nyxos-csrf": login?.csrf ?? "" } });
  const res = await send().catch(() => send());
  expect(res.status()).toBe(200);
}

async function fpsMedian(page: Page, seconds: number): Promise<number> {
  await page.evaluate(() => (window.__nyxNetFps = []));
  await page.waitForTimeout(seconds * 1000);
  const samples = await page.evaluate(() => window.__nyxNetFps ?? []);
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!login, "Anmeldung des lokalen Stacks fehlt (.probe/probe-login.json)");
  await context.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("1440: Seitenleiste + Nyx-Bühne, Leiste rechts, Dock unten, Esc bleibt, Schwenken", async ({ page, browserName }) => {
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => resolve(SHOTS, `nyx-layout-${browserName}-1440${name}.png`);
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.goto("/nyx");
  const net = page.locator('[data-nyx="nyx-netz"]');
  await expect(net).toHaveAttribute("data-ready", "true", { timeout: 20_000 });

  // Seitenleiste links sichtbar, keine Kopfzeile, kein Menü-Knopf (breit steht die Leiste fest).
  const nav = page.getByTestId("sidebar");
  await expect(nav).toBeVisible();
  await expect(page.getByTestId("topbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menü öffnen" })).toBeHidden();
  const navBox = await nav.boundingBox();
  const stage = await page.locator('[data-nyx="nyx-tab"]').boundingBox();
  expect(navBox && stage).toBeTruthy();
  if (!navBox || !stage) return;
  // Bühne beginnt rechts neben der Seitenleiste und füllt den Rest (keine Überdeckung, kein Rollbalken).
  expect(stage.x).toBeGreaterThanOrEqual(navBox.x + navBox.width - 1);
  expect(stage.x + stage.width).toBeLessThanOrEqual(1441);
  expect(stage.height).toBeGreaterThan(880);
  const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
  // Dock unten und Glas-Leiste rechts liegen ganz in der Bühne.
  const dock = await page.locator('[data-nyx="nyx-mikro"]').boundingBox();
  const panel = await page.locator(".nyx-panel").boundingBox();
  expect(dock && panel).toBeTruthy();
  if (dock && panel) {
    expect(dock.x).toBeGreaterThanOrEqual(stage.x);
    expect(dock.y + dock.height).toBeLessThanOrEqual(stage.y + stage.height);
    expect(dock.x + dock.width).toBeLessThanOrEqual(panel.x + 1);
    expect(panel.x + panel.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
  }
  await page.waitForTimeout(2600);
  await page.screenshot({ path: shot("") });

  const fps = await fpsMedian(page, 5);
  console.log(`nyx-layout fps ${browserName} 1440: Median ${fps}`);
  test.info().annotations.push({ type: "fps", description: `${browserName}: ${fps}` });
  // Ziel ≥ 55 fps in WebKit (Safari); Chromium nur mit echter GPU aussagekräftig.
  if (browserName === "webkit") expect(fps).toBeGreaterThanOrEqual(55);
  else if (process.env.E2E_GPU) expect(fps).toBeGreaterThan(40);

  // Leiste zu: Netz nutzt die ganze Bühne.
  await page.getByRole("button", { name: "Leiste einklappen" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("-leiste-zu") });

  // Denken: Signale laufen über die Kabel.
  await nyxEvent(page, { kind: "state", event: { state: "thinking" } });
  await expect(net).toHaveAttribute("data-state", "thinking");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: shot("-denkt") });

  // Esc stoppt Nyx und bleibt im Tab.
  await page.keyboard.press("Escape");
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await expect(net).toHaveAttribute("data-state", "idle");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/nyx/);

  // Schwenken: ziehen, loslassen, weich ausgleiten lassen.
  const box = await net.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 180, cy + 30, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("-schwenk") });
  }
});

test("390: Menü (☰) im Tab öffnet die Seitenleiste, Esc schließt sie und bleibt im Tab", async ({ browser, browserName, baseURL }) => {
  mkdirSync(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
  const page = await ctx.newPage();
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.goto("/nyx");
  await expect(page.locator("[data-renderer]").first()).toBeVisible({ timeout: 20_000 });
  const nav = page.getByTestId("sidebar");
  await expect(nav).toHaveAttribute("data-open", "false");
  await expect(nav).toBeHidden();
  const menu = page.getByRole("button", { name: "Menü öffnen" });
  await expect(menu).toBeVisible();
  // Kein Rollbalken quer, Dock ganz im Bild, Menü und Zustand nicht abgeschnitten.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const dock = await page.locator('[data-nyx="nyx-mikro"]').boundingBox();
  expect(dock).toBeTruthy();
  if (dock) {
    expect(dock.x).toBeGreaterThanOrEqual(0);
    expect(dock.x + dock.width).toBeLessThanOrEqual(390);
    expect(dock.y + dock.height).toBeLessThanOrEqual(844);
  }
  const m = await menu.boundingBox();
  const chip = await page.locator('[data-nyx="nyx-zustand"]').boundingBox();
  if (m && chip) expect(m.x + m.width).toBeLessThanOrEqual(chip.x);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(SHOTS, `nyx-layout-${browserName}-390.png`) });

  await menu.click();
  await expect(nav).toHaveAttribute("data-open", "true");
  await expect(nav).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `nyx-layout-${browserName}-390-menu.png`) });
  await page.keyboard.press("Escape");
  await expect(nav).toHaveAttribute("data-open", "false");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/nyx/);

  // Leiste rechts offen: das Menü bleibt erreichbar.
  await page.getByRole("button", { name: "Leiste aufklappen" }).click();
  await expect(page.getByRole("tabpanel", { name: "Chat" })).toBeVisible();
  await menu.click({ trial: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `nyx-layout-${browserName}-390-sidebar.png`) });
  await ctx.close();
});
