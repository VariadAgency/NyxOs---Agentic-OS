// Nyx gegen den lokalen Stack (echte Daten, echter Haiku): Briefing, Leichter Tag, Panel mit Quellen,
// Entscheidungen (Freigabe → einmal), Ideen-Link bis zur Mini-Seite. Screenshots → .probe/shots/.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-panel-briefing.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const shot = (name: string) => resolve(SHOTS, name);

const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeEach(async ({ context, baseURL }) => {
  // Probe-Anmeldung (dev.ts schreibt sie, 0600) statt Passkey – nur auf der Probe. Ohne sie antworten
  // Panel-Chat (CSRF/Anmeldung) und Ideen-Link-Anlage mit 401 → Spec lief nur mit Vorwissen (wie p7-start).
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Briefing mit echten Daten + Leichter Tag", async ({ page }) => {
  await page.goto("/briefing");
  await expect(page.getByRole("heading", { name: /^(Guten (Morgen|Tag|Abend)|Noch wach)/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Braucht dich")).toBeVisible();
  await page.screenshot({ path: shot("01-briefing.png"), fullPage: true });
  await page.getByRole("button", { name: /Leichter Tag/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot("02-leichter-tag.png"), fullPage: true });
  await page.getByRole("button", { name: /Leichter Tag/ }).click();
});

test("Panel: ⌘J, Kontext, Streaming, Quellen (echter Haiku)", async ({ page }) => {
  await page.goto("/sessions");
  await page.waitForTimeout(1500);
  await page.keyboard.press("ControlOrMeta+j");
  const input = page.getByLabel("Frage an Haiku");
  await expect(input).toBeVisible();
  await page.screenshot({ path: shot("03-panel-offen.png") });
  await input.fill("Welche Sessions warten gerade auf mich? Kurz, mit Quellen.");
  const chat = page.waitForResponse((r) => r.url().includes("/api/haiku/chat"));
  await input.press("Enter");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("04-panel-denkt.png") });
  await chat;
  // Quellen-Chips erscheinen erst mit dem done-Ereignis (Strom komplett, Marker geprüft).
  await expect(page.getByLabel("Nyx", { exact: true }).locator('ul[aria-label="Quellen"] a').first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("05-panel-antwort-quellen.png") });
});

test("Entscheidungen: Freigabe-Karten", async ({ page }) => {
  await page.goto("/inbox");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot("06-entscheidungen.png"), fullPage: true });
});

test("Ideen-Link: anlegen, Mini-Seite, echte Idee", async ({ page, context }) => {
  await page.goto("/einstellungen/ideen-links");
  await page.getByPlaceholder("z. B. Lena").fill("Probe-Freund");
  await page.getByRole("button", { name: /(Link erzeugen|Anlegen|erstellen)/i }).first().click();
  const urlText = page.locator("text=/\\/i\\/[A-Za-z0-9_-]{43}/").first();
  await expect(urlText).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: shot("07-ideen-link-angelegt.png"), fullPage: true });
  const url = ((await urlText.textContent()) ?? "").match(/https?:\/\/[^\s]+\/i\/[A-Za-z0-9_-]{43}|\/i\/[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  expect(url).not.toBe("");
  const mini = await context.newPage();
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.goto(url.startsWith("http") ? url : url);
  await expect(mini.getByRole("heading", { name: /Hallo Probe-Freund/ })).toBeVisible();
  await mini.getByLabel("Deine Idee").fill("Eine Warteliste, wenn ein Club voll ist, wäre super.");
  await mini.getByLabel("Senden").click();
  await expect(mini.locator(".msg.bot").last()).not.toHaveText("", { timeout: 90_000 });
  await mini.waitForTimeout(1500);
  await mini.screenshot({ path: shot("08-ideen-link-seite-handy.png") });
});

test("Nyx-Einstellungen + Verbrauch", async ({ page }) => {
  await page.goto("/einstellungen/haiku");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot("09-haiku-einstellungen.png"), fullPage: true });
});
