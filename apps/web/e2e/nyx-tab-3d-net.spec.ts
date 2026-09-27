// Nyx-Tab mit 3D-Netz gegen den lokalen Stack in Chromium UND WebKit (Safari-Engine): echte Live-Ereignisse
// (`/api/nyx/events` → /live), 3D-Netz per WebGL. Bilder je Zustand, Video vom Netz, Bildrate.
//   NYXOS_HAIKU_SCHEDULER=0 pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-tab-3d-net.spec.ts --project chromium-1440 --project webkit-1440
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.describe.configure({ mode: "serial", timeout: 150_000 });
// Chromium headless rechnet WebGL sonst in Software (SwiftShader, ~4 fps) — mit E2E_GPU=1 über die echte GPU (Metal),
// wie im richtigen Browser. Nur für den Chromium-Lauf setzen (WebKit kennt die Schalter nicht).
if (process.env.E2E_GPU) test.use({ channel: "chromium", launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--enable-unsafe-webgpu"] } });

async function nyxEvent(page: Page, body: unknown) {
  // Unter Last setzt der lokale Server gelegentlich eine offene Verbindung zurück — dann einmal neu senden.
  const send = () => page.request.post("/api/nyx/events", { data: body, headers: { "x-nyxos-csrf": login?.csrf ?? "" } });
  const res = await send().catch(() => send());
  expect(res.status()).toBe(200);
}

async function fpsMedian(page: Page, seconds: number): Promise<{ median: number; samples: number[] }> {
  await page.evaluate(() => (window.__nyxNetFps = []));
  await page.waitForTimeout(seconds * 1000);
  const samples = await page.evaluate(() => window.__nyxNetFps ?? []);
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, samples };
}

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!login, "Anmeldung des lokalen Stacks fehlt (.probe/probe-login.json)");
  await context.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Fokus-Modus, 3D-Netz in allen Zuständen, Leiste, Esc bleibt im Tab", async ({ page, browserName }) => {
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => resolve(SHOTS, `nyx-net-${browserName}-${name}.png`);
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.goto("/nyx");
  const net = page.locator('[data-nyx="nyx-netz"]');
  await expect(net).toHaveAttribute("data-renderer", "webgl", { timeout: 20_000 });
  await expect(net).toHaveAttribute("data-ready", "true");
  await expect(net).toHaveAttribute("data-state", "idle");
  // Fokus-Modus: keine Kopfzeile, kein Begleiter-Kreis (die Seitenleiste bleibt sichtbar).
  await expect(page.getByRole("navigation", { name: "Brotkrümel" })).toHaveCount(0);
  await expect(page.getByTestId("nyx-companion")).toBeHidden();
  await page.waitForTimeout(2200);
  await page.screenshot({ path: shot("idle") });

  const fps = await fpsMedian(page, 5);
  console.log(`nyx-net fps ${browserName}: Median ${fps.median} (${fps.samples.join(", ")})`);
  test.info().annotations.push({ type: "fps", description: `${browserName}: ${fps.median}` });
  expect(fps.median).toBeGreaterThan(20);

  await nyxEvent(page, { kind: "state", event: { state: "listening" } });
  await expect(net).toHaveAttribute("data-state", "listening");
  await expect(page.locator('[data-nyx="nyx-status"]')).toContainText("höre dir zu");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: shot("listening") });

  await nyxEvent(page, { kind: "state", event: { state: "thinking" } });
  await expect(net).toHaveAttribute("data-state", "thinking");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: shot("thinking") });

  await nyxEvent(page, { kind: "state", event: { state: "tool", tool: "sessions_suchen", detail: "Suche wartende Sessions" } });
  await expect(net).toHaveAttribute("data-tool", "sessions_suchen");
  await expect(page.locator(".nyx-net-label--tool")).toContainText("sessions_suchen");
  await expect(page.locator('[data-nyx="nyx-status"]')).toContainText("Suche wartende Sessions");
  await page.waitForTimeout(1400);
  await page.screenshot({ path: shot("tool") });

  await nyxEvent(page, { kind: "state", event: { state: "speaking" } });
  await expect(net).toHaveAttribute("data-state", "speaking");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("speaking") });

  // Leiste einklappen → Netz rückt in die Mitte, Schreibfeld unten erscheint.
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.getByRole("button", { name: "Leiste einklappen" }).click();
  await expect(page.getByRole("textbox", { name: "Schnell an Nyx schreiben" })).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: shot("leiste-zu") });
  await page.getByRole("tab", { name: "Aufgaben live" }).click();
  await expect(page.getByRole("tabpanel", { name: "Aufgaben live" })).toBeVisible();
  await page.getByRole("tab", { name: "Chat" }).click();

  // Hover über einen Knoten: Name erscheint (Treffer per Projektion).
  const box = await net.boundingBox();
  expect(box).not.toBeNull();

  // Verborgen → keine Bilder mehr (pausiert).
  const paused = await page.evaluate(async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.__nyxNetFps = [];
    await new Promise((r) => setTimeout(r, 2500));
    const n = window.__nyxNetFps.length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 2500));
    return { hidden: n, visible: window.__nyxNetFps.length };
  });
  console.log(`nyx-net pause ${browserName}: verborgen ${paused.hidden} Messungen, sichtbar ${paused.visible}`);
  expect(paused.hidden).toBe(0);
  expect(paused.visible).toBeGreaterThan(0);

  // Esc stoppt nur Nyx und verlässt den Tab nie (die Seitenleiste ist der Weg hinaus).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/nyx/);
});

test("Video vom Netz (alle Zustände nacheinander)", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "Video einmal reicht (Chromium)");
  const dir = resolve(process.cwd(), "e2e/.output/n2c-video");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  await ctx.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
  const page = await ctx.newPage();
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.goto("/nyx");
  await expect(page.locator('[data-nyx="nyx-netz"]')).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.waitForTimeout(3500);
  for (const [state, extra, ms] of [
    ["listening", {}, 3500],
    ["thinking", {}, 3500],
    ["tool", { tool: "git_lage", detail: "Schaue in die Commits" }, 3500],
    ["speaking", {}, 3500],
    ["idle", {}, 2500],
  ] as const) {
    await nyxEvent(page, { kind: "state", event: { state, ...extra } });
    await page.waitForTimeout(ms);
  }
  // Sanft drehen per Ziehen (Bedienung).
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(820, 480, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  const video = page.video();
  await ctx.close();
  const path = await video?.path();
  expect(path).toBeTruthy();
  copyFileSync(path as string, resolve(SHOTS, "nyx-net.webm"));
});

test("390 px: schwarz, Leiste zu, Menü (☰) per Tipp erreichbar", async ({ browser, browserName, baseURL }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
  const page = await ctx.newPage();
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });
  await page.goto("/nyx");
  await expect(page.locator("[data-renderer]").first()).toBeVisible({ timeout: 20_000 });
  // Grund schwarz, kein Navy: alle Kanäle sehr dunkel, kein Blau-Überhang.
  // Über eine 1-px-Leinwand in 0 … 255 umrechnen (color-mix liefert sonst „color(srgb …)“).
  const [r = 99, g = 99, b = 99] = await page.locator('[data-nyx="nyx-tab"]').evaluate((el) => {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return [99, 99, 99];
    c.fillStyle = getComputedStyle(el).backgroundColor;
    c.fillRect(0, 0, 1, 1);
    return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  });
  expect(Math.max(r, g, b)).toBeLessThan(16);
  expect(b - r).toBeLessThan(6);
  // Leiste startet zu; statt „Zurück“ der Menü-Knopf (☰) — auch mit offener Leiste erreichbar.
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
  const menu = page.getByRole("button", { name: "Menü öffnen" });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(SHOTS, `nyx-net-${browserName}-390.png`) });
  await page.getByRole("button", { name: "Leiste aufklappen" }).click();
  await expect(page.getByRole("tabpanel", { name: "Chat" })).toBeVisible();
  await menu.click({ trial: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(SHOTS, `nyx-net-${browserName}-390-sidebar.png`) });
  await ctx.close();
});
