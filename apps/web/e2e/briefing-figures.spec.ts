// Briefing gegen den lokalen Stack (echte Verläufe, echte DB-Zahlen): nutzt die volle Breite, zeigt
// Kennzahl-Kacheln und mindestens 3 Graphen aus `figures`; schmal einspaltig ohne seitliches Scrollen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/briefing-figures.spec.ts --project chromium-1440
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { BRIEFING_FIGURES, BRIEFING_REPORT_PARTS } from "./fixtures/briefingFigures";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");

test.describe.configure({ timeout: 180_000, mode: "serial" });

async function signIn(context: BrowserContext, url: string) {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url }]);
  return { cookie: `nyxos_session=${login.token}`, "x-nyxos-csrf": login.csrf, "content-type": "application/json" };
}

type Figures = { commits: { week: number }; tasks: { open: number }; charts: { usage7d: unknown[]; sessionsHourly: unknown[] } };

/** Die App scrollt im Inhaltsbereich, nicht im Dokument — für ein ganzes Bild die Fensterhöhe auf die Inhaltshöhe setzen. */
async function shootFull(page: Page, width: number, file: string) {
  const h = await page.evaluate(() => Math.max(...[...document.querySelectorAll("*")].map((el) => (el as HTMLElement).scrollHeight)));
  await page.setViewportSize({ width, height: Math.min(7000, h + 80) });
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(SHOTS, file) });
}

async function openBriefing(page: Page) {
  await page.goto("/briefing");
  // Ab 18 Uhr zeigt die Seite zuerst den Recap — geprüft wird das eben erstellte Briefing.
  await page.getByRole("group", { name: "Bericht wählen" }).getByRole("button", { name: "Briefing" }).click();
  await expect(page.getByTestId("briefing-headline")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("briefing-kpis")).toBeVisible();
  // Einzeichnen/Hochzählen abwarten (≤ 600 ms).
  await page.waitForTimeout(900);
}

test("Briefing wie ein Artefakt — volle Breite, Kacheln und Graphen aus echten Daten (1440 und 390 px)", async ({ page, context, request, baseURL }) => {
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(context, baseURL ?? "http://127.0.0.1:47890");
  const created = await request.post("/api/haiku/report", { headers, data: { kind: "briefing" } });
  expect(created.status(), await created.text()).toBe(200);
  const report = ((await created.json()) as { report: { figures: Figures | null } }).report;
  expect(report.figures).toBeTruthy();
  // E2E_BRIEFING_FIXTURE=1: echter Bericht vom lokalen Server, nur `figures` durch einen festen Beispiel-Stand ersetzt
  // (Stack ohne Brücke/Verläufe). Ohne die Variable kommen alle Zahlen echt vom Server.
  const useFixture = process.env.E2E_BRIEFING_FIXTURE === "1";
  if (useFixture) {
    const full = { ...report, ...BRIEFING_REPORT_PARTS, figures: BRIEFING_FIGURES, stale: false };
    await page.route((url) => url.pathname === "/api/haiku/report" && url.searchParams.get("kind") === "briefing", (route) => route.fulfill({ json: { report: full, facts: [] } }));
  }
  const f = (useFixture ? BRIEFING_FIGURES : report.figures) as Figures;
  expect(f.charts.usage7d).toHaveLength(7);
  expect(f.charts.sessionsHourly).toHaveLength(24);

  // Breit: Inhalt nutzt fast die ganze Fläche neben der Seitenleiste.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBriefing(page);
  const kpis = page.getByTestId("briefing-kpis");
  await expect(kpis.locator("[data-brief-tile]")).toHaveCount(9);
  await expect(kpis.locator('[data-brief-tile="commits"]')).toHaveAttribute("data-value", new Intl.NumberFormat("de-DE").format(f.commits.week));
  await expect(kpis.locator('[data-brief-tile="tasks_open"]')).toHaveAttribute("data-value", new Intl.NumberFormat("de-DE").format(f.tasks.open));
  const charts = page.getByTestId("briefing-charts").locator("figure");
  expect(await charts.count()).toBeGreaterThanOrEqual(3);
  const head = await page.getByTestId("briefing-head").boundingBox();
  expect(head?.width ?? 0).toBeGreaterThan(1100);
  // Zwei Graphen nebeneinander (Raster), jeder deutlich breiter als die alte 880-px-Spalte halb.
  const first = await charts.nth(0).boundingBox();
  const second = await charts.nth(1).boundingBox();
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 1))).toBeLessThan(4);
  // Nichts ragt rechts über den Kopf hinaus (kein verstecktes seitliches Scrollen im Inhaltsbereich).
  expect((second?.x ?? 0) + (second?.width ?? 0)).toBeLessThanOrEqual((head?.x ?? 0) + (head?.width ?? 0) + 1);
  // Kein Diagramm ist breiter als seine Karte (Diagramm misst die Kartenbreite, nicht seine Vorgabe von 640 px).
  const spill = await page.getByTestId("briefing-charts").evaluate((el) => [...el.querySelectorAll("figure")].map((f) => f.scrollWidth - f.clientWidth));
  expect(Math.max(...spill)).toBeLessThanOrEqual(1);
  await shootFull(page, 1440, "briefing-wide.png");

  // Schmal: alles untereinander, kein seitliches Scrollen.
  await page.setViewportSize({ width: 390, height: 844 });
  await openBriefing(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const a = await charts.nth(0).boundingBox();
  const b = await charts.nth(1).boundingBox();
  expect((b?.y ?? 0) > (a?.y ?? 0) + (a?.height ?? 0) - 1).toBe(true);
  // Nichts wird abgeschnitten: Kacheln, Knöpfe und Graphen passen in die schmale Spalte.
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('[data-brief-tile], [data-testid="briefing-needs"] li, [data-brief-chart]')].filter((el) => el.scrollWidth - el.clientWidth > 1).length,
  );
  expect(cut).toBe(0);
  await shootFull(page, 390, "briefing-narrow.png");
});
