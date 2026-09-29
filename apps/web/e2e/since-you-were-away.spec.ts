// „Seit du weg warst“ gegen den lokalen Stack (echte Verläufe über die Brücke, echte DB-Zahlen):
// Karte ganz oben auf Überblick und Briefing, Gruppen = Antwort von `/api/changes`, jede Zahl = Zeilen der Gruppe,
// Klick auf eine Zeile springt zur Quelle.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/since-you-were-away.spec.ts --project chromium-1440 --workers=1
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");

test.describe.configure({ timeout: 180_000, mode: "serial" });

async function signIn(context: BrowserContext, url: string) {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url }]);
  return { cookie: `nyxos_session=${login.token}` };
}

type Changes = { since: string; groups: { kind: string; title: string; count: number; items: unknown[] }[] };

test("„Seit du weg warst“ oben auf Überblick und Briefing, Zahlen = Server, Zeilen springen zur Quelle", async ({ page, context, request, baseURL }) => {
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(context, baseURL ?? "http://127.0.0.1:47890");

  const api = (await (await request.get("/api/changes?since=24h", { headers })).json()) as Changes;
  for (const g of api.groups) expect(g.count, g.title).toBe(g.items.length);

  await page.goto("/overview");
  const card = page.getByTestId("since-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // ganz oben: direkt nach dem Gruß
  expect(await card.evaluate((el) => el.previousElementSibling?.tagName)).toBe("HEADER");
  await card.getByRole("button", { name: "24 Std" }).click();
  await expect(card.getByRole("button", { name: "24 Std" })).toHaveAttribute("aria-pressed", "true");

  if (api.groups.length === 0) {
    await expect(card.getByText(/Nichts Neues seit/)).toBeVisible();
  } else {
    for (const g of api.groups) {
      const region = card.getByRole("region", { name: g.title, exact: true });
      await expect(region).toBeVisible();
      if (g.kind !== "usage") await expect(region.getByTestId("since-count")).toHaveText(String(g.count));
    }
  }
  // Die App scrollt im Inhaltsbereich: für ein ganzes Bild die Fensterhöhe auf die Inhaltshöhe setzen.
  const fullH = await page.evaluate(() => Math.max(...[...document.querySelectorAll("*")].map((el) => (el as HTMLElement).scrollHeight)));
  await page.setViewportSize({ width: 1440, height: Math.min(7000, fullH + 80) });
  await page.waitForTimeout(500);
  await card.screenshot({ path: resolve(SHOTS, "since-away-card.png") });
  await page.screenshot({ path: resolve(SHOTS, "since-away-overview.png") });

  // Schmal (Handy): einspaltig, ohne seitliches Scrollen.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await card.screenshot({ path: resolve(SHOTS, "since-away-390.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Klick auf eine Zeile springt zur Quelle.
  const firstLink = card.getByRole("link").first();
  if (api.groups.length > 0) {
    const href = await firstLink.getAttribute("href");
    await firstLink.click();
    await expect(page).toHaveURL((u) => `${u.pathname}${u.search}${u.hash}` === href);
  }

  await page.goto("/briefing");
  const bCard = page.getByTestId("since-card");
  await expect(bCard).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("briefing-head")).toBeVisible({ timeout: 60_000 });
  const cardTop = (await bCard.boundingBox())?.y ?? 0;
  const headTop = (await page.getByTestId("briefing-head").boundingBox())?.y ?? 0;
  // Auf dem Briefing steht die Karte unter der Kernaussage, nicht mehr darüber.
  expect(cardTop).toBeGreaterThan(headTop);
  await page.screenshot({ path: resolve(SHOTS, "since-away-briefing.png") });
});
