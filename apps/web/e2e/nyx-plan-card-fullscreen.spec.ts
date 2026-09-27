// Nyx-Tab: Plan-Schritte des Kerns (EIN Format, über /live) als Karte im Reiter „Aufgaben live“, echtes Vollbild
// (Leiste + Kopf weg, Esc zurück), kein zweiter Begleiter-Kreis.
//   NYXOS_HAIKU_SCHEDULER=0 pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-plan-card-fullscreen.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.describe.configure({ mode: "serial", timeout: 90_000 });

async function nyxEvent(page: Page, body: unknown) {
  const res = await page.request.post("/api/nyx/events", { data: body, headers: { "x-nyxos-csrf": login?.csrf ?? "" } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!login, "Anmeldung des lokalen Stacks fehlt (.probe/probe-login.json)");
  await context.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Plan des Kerns als Karte, Vollbild ohne Leiste/Kopf, kein zweiter Kreis", async ({ page }) => {
  await page.goto("/nyx");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  // Begleiter-Kreis ist im Nyx-Tab verborgen.
  await expect(page.getByRole("button", { name: /^Nyx – / })).toHaveCount(0);

  await page.getByRole("tab", { name: /Aufgaben live/ }).click();
  const plan = (index: number, label: string, status: string, phase = "step") =>
    nyxEvent(page, { kind: "task", event: { taskId: "plan-4711", phase, title: "Plan: 3 Schritte", tool: "todo", threadId: 4711, step: { index, total: 3, label, status } } });
  await plan(0, "Build auf dem Rechner prüfen", "done", "started");
  await plan(1, "Simulator-Bild machen", "running");
  await plan(2, "Ergebnis in Telegram schicken", "pending");
  const card = page.getByRole("article", { name: "Aufgabe: Plan: 3 Schritte" });
  await expect(card).toBeVisible();
  await expect(card.getByLabel("offen")).toBeVisible();
  await expect(card.getByLabel("erledigt")).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "nyx-plan-card.png") });

  await page.getByRole("button", { name: "Vollbild", exact: true }).click();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.getByTestId("topbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Vollbild verlassen/ })).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "nyx-fullscreen.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("topbar")).toBeVisible();
});
