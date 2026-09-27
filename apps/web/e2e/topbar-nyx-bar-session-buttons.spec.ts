// Die Befehlsleiste von Haiku (`#cc-haiku-slot`) und die Seiten-Knöpfe der Sessions (`TopBarSlot`) teilen
// sich EINE Kopfzeile – nichts überlappt, alles gleich hoch.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/topbar-nyx-bar-session-buttons.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

type Box = { x: number; y: number; width: number; height: number };
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error("Element ohne Box");
  return b;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

for (const width of [1024, 1280, 1920]) {
  test(`Kopfzeile bei ${width} px: Haiku-Leiste + Sessions-Knöpfe ohne Überlappung, gleich hoch`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/sessions");
    await page.waitForSelector('[role="tablist"][aria-label="Art der Arbeit"]');
    const bar = page.getByTestId("topbar");
    const haiku = bar.getByRole("button", { name: /^Haiku öffnen/ });
    await expect(haiku).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);

    // Seiten-Knöpfe: jedes direkte Kind des Slots – Suche/Zuletzt/Regeln/Werkzeug, je nach Breite
    // mit oder ohne Beschriftung.
    const actions = bar.getByTestId("topbar-actions").locator(":scope > *");
    const n = await actions.count();
    expect(n).toBeGreaterThanOrEqual(4);
    const list: [string, Box][] = [
      ["Brotkrümel", await box(bar.getByRole("navigation", { name: "Brotkrümel" }))],
      ["Haiku", await box(haiku)],
    ];
    for (let i = 0; i < n; i++) list.push([`Seiten-Knopf ${i + 1}`, await box(actions.nth(i))]);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [an, a] = list[i] as [string, Box];
        const [bn, b] = list[j] as [string, Box];
        expect(overlaps(a, b), `${an} überlappt ${bn}`).toBe(false);
      }
    }
    // Alles innerhalb der Kopfzeile und in der Seite (kein Überlauf nach rechts).
    const barBox = await box(bar);
    for (const [name, b] of list) {
      expect(b.x + b.width, `${name} ragt rechts heraus`).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
      expect(b.y + b.height, `${name} ragt unten heraus`).toBeLessThanOrEqual(barBox.y + barBox.height + 0.5);
    }
    // Haiku-Leiste so hoch wie die Sessions-Knöpfe.
    const heights = list.filter(([name]) => name !== "Brotkrümel").map(([, b]) => Math.round(b.height * 10) / 10);
    expect(new Set(heights).size, `Höhen: ${heights.join(", ")}`).toBe(1);
    // Ab 1280 px bleibt es EINE Zeile; darunter darf die rechte Gruppe als Ganzes umbrechen.
    if (width >= 1280) expect(barBox.height).toBeLessThan(56);

    if (width === 1280) await page.screenshot({ path: `${SHOTS}/topbar-nyx-bar-session-buttons.png`, clip: { x: 0, y: 0, width, height: 230 } });
  });
}
