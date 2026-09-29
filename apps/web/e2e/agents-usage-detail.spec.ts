// Agenten & Skills, Nutzung: Screenshots + Klickbarkeits-Nachweis (Tag, Modell, Agent, Skill öffnen ihre
// Großansicht) gegen den lokalen Stack mit echten Daten.
// Screenshots liegen unter `.probe/shots/`, nicht im normalen `e2e/.output`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/agents-usage-detail.spec.ts --project chromium-1440 --project chromium-1024
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const OUT = join(process.cwd(), "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });
const shot = (name: string, project: string) => join(OUT, `${name}-${project}.png`);

test.describe("Agenten & Skills", () => {
  test("Übersicht + Großansicht eines Agenten-Laufs per Klick", async ({ page }, testInfo) => {
    const res = await page.request.get(`${testInfo.project.use.baseURL ?? ""}/api/agents/runs?limit=5`);
    const body = (await res.json()) as { runs: { id: string; agentName: string | null }[] };
    test.skip(body.runs.length === 0, "Kein Agenten-Lauf im Bestand — pnpm dev zuerst laufen lassen.");

    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agenten" })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("agents-uebersicht", testInfo.project.name), fullPage: true });

    const row = page.locator(`[data-run-id="${body.runs[0]?.id ?? ""}"], [data-agent-name]`).first();
    await row.click();
    await expect(page.getByTestId("agent-detail")).toBeVisible();
    await page.screenshot({ path: shot("agents-grossansicht-lauf", testInfo.project.name), fullPage: true });
  });

  test("Skill-Großansicht per Klick, falls ein Skill genutzt wurde", async ({ page }, testInfo) => {
    const res = await page.request.get(`${testInfo.project.use.baseURL ?? ""}/api/agents/skills/usage`);
    const body = (await res.json()) as { skills: { skill: string }[] };
    test.skip(body.skills.length === 0, "Keine Skill-Nutzung in den letzten 7 Tagen im Bestand.");

    await page.goto("/agents");
    await page.locator(`[data-skill-name="${body.skills[0]?.skill ?? ""}"]`).click();
    await expect(page.getByTestId("agent-detail")).toBeVisible();
    await page.screenshot({ path: shot("agents-grossansicht-skill", testInfo.project.name), fullPage: true });
  });
});

test.describe("Nutzung", () => {
  test("Übersicht, Tag- und Modell-Großansicht per Klick", async ({ page }, testInfo) => {
    const res = await page.request.get(`${testInfo.project.use.baseURL ?? ""}/api/usage/daily?range=all`);
    const body = (await res.json()) as { days: { day: string; model: string }[] };
    test.skip(body.days.length === 0, "Keine Nutzung im Bestand — pnpm dev zuerst laufen lassen.");

    await page.goto("/usage");
    await expect(page.getByRole("heading", { name: "Nutzung" })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("nutzung-uebersicht", testInfo.project.name), fullPage: true });

    // Der Tagesverlauf ist ein Flächen-Diagramm (components/charts/AreaChart) statt
    // einzelner [data-day]-Balken: Tag wählen = Diagramm fokussieren, letzten Tag (Ende), Enter.
    const chart = page.locator("[data-chart='area']").first();
    await expect(chart).toBeVisible({ timeout: 15_000 });
    await chart.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("usage-detail")).toBeVisible();
    await page.screenshot({ path: shot("nutzung-grossansicht-tag", testInfo.project.name), fullPage: true });

    await page.locator("[data-model]").first().click();
    await expect(page.getByTestId("usage-detail")).toBeVisible();
    await page.screenshot({ path: shot("nutzung-grossansicht-modell", testInfo.project.name), fullPage: true });
  });
});
