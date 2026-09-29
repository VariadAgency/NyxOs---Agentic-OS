// Ideen-Tab wie das Postfach — Liste/Filter, Detail, Rückfragen beantworten, Status ändern,
// Nyx-Anweisung (Vorschau → Übernehmen), Löschen mit Rückfrage. Braucht die vier Beispiel-Ideen im
// Ideen-Postfach des lokalen Stacks (u. a. „Karte stürzt beim Öffnen ab“); ohne sie wird übersprungen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/ideas-tab.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const OUT = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) throw new Error("probe-login.json fehlt – läuft `pnpm dev`?");
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Ideen-Tab: Liste, Filter, Detail, Rückfragen, Status, Nyx-Anweisung, Löschen", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/ideas");
  const cards = page.getByTestId("idea-card");
  await cards.first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  test.skip((await cards.filter({ hasText: "Karte stürzt beim Öffnen ab" }).count()) === 0, "Beispiel-Ideen fehlen im Ideen-Postfach.");
  // Standard = aktiv (Archiv ausgeblendet), nach Priorität: der P0-Bug zuerst.
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toContainText("Karte stürzt beim Öffnen ab");
  await expect(page.getByText("2 Rückfragen offen – jetzt beantworten")).toBeVisible();
  await page.getByTestId("status-archived").click();
  await expect(cards).toHaveCount(1);
  await page.getByTestId("status-active").click();
  await page.getByPlaceholder("Ideen durchsuchen (Titel und Text) …").fill("techno");
  await expect(cards).toHaveCount(1);
  await page.screenshot({ path: `${OUT}/ideas-list.png`, fullPage: true });

  // Detail: alle Felder, offene Rückfragen beantworten → Brief fertig, Status „Bereit für Claude“.
  await cards.first().click();
  await expect(page.getByTestId("idea-title")).toHaveText("Feed nach Musikrichtung filtern");
  await expect(page.getByTestId("idea-brief")).toContainText("Akzeptanzkriterien");
  await expect(page.getByTestId("idea-facts")).toContainText("Privatkunde");
  const qs = page.getByTestId("idea-questions");
  await qs.getByRole("button", { name: "Nur Events" }).click();
  await qs.getByLabel("Eigene Antwort auf Frage 2").fill("Ja, pro Gerät merken");
  await qs.getByTestId("send-answers").click();
  await expect(page.getByTestId("idea-questions")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("idea-head")).toContainText("Bereit für Claude");

  // Status ändern (Verwalten).
  await page.getByTestId("set-status-reviewed").click();
  await expect(page.getByTestId("idea-head")).toContainText("Geprüft");

  // Nyx-Anweisung: Vorschau, dann Übernehmen (echter Haiku-Motor des lokalen Stacks; ohne Motor ehrlicher Satz).
  await page.getByLabel("Anweisung an Nyx").fill("Nimm zusätzlich einen Filter nach Wochentag dazu.");
  await page.getByTestId("ask-nyx").click();
  const preview = page.getByTestId("nyx-preview");
  const failed = page.getByTestId("idea-instruct").getByRole("alert");
  await expect(preview.or(failed)).toBeVisible({ timeout: 150_000 });
  if (await preview.isVisible()) {
    await page.getByTestId("idea-instruct").screenshot({ path: `${OUT}/ideas-nyx-preview.png` });
    // Die App scrollt einen inneren Bereich (fullPage sähe nur den sichtbaren Teil) — darum hoch aufziehen.
    await page.setViewportSize({ width: 1440, height: 3400 });
    await page.screenshot({ path: `${OUT}/ideas-detail.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("apply-nyx").click();
    await expect(preview).toHaveCount(0, { timeout: 60_000 });
  } else {
    await page.setViewportSize({ width: 1440, height: 3400 });
    await page.screenshot({ path: `${OUT}/ideas-detail.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // Löschen mit Rückfrage im Tab.
  await page.goto("/ideas");
  await page.getByTestId("idea-card").filter({ hasText: "Club-Pass als Wallet-Karte" }).click();
  await page.getByTestId("delete").click();
  await expect(page.getByText("wirklich löschen?")).toBeVisible();
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/ideas$/);
  await expect(page.getByTestId("idea-card").filter({ hasText: "Club-Pass als Wallet-Karte" })).toHaveCount(0);
});
