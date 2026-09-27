// Nutzung: Vergleiche und Einstellungen im echten Browser mit echten Nutzungsdaten (die Brücke des lokalen
// Stacks liest ~/.claude und ~/.codex ein). Prüft Vergleiche, Klick zur Baustelle und — mit virtuellem
// Passkey (nur Chromium) — Ziel/Warnschwelle speichern, Hochrechnung, Neuladen.
//
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_SETUP_CODE=… pnpm --filter @nyxos/web exec playwright test e2e/usage-comparisons-goals.spec.ts --project=chromium-1440 --workers=1
// Screenshots: `.probe/shots/usage-*.png` (Ordner per E2E_SHOT_DIR änderbar).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? join(ROOT, ".probe", "shots");

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ browserName }) => browserName !== "chromium", "ein Browser genügt (virtueller Passkey nur in Chromium)");

async function openUsage(page: Page, query = "") {
  await page.goto(`/usage${query}`);
  await expect(page.getByRole("heading", { name: "Nutzung", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Zeitraum im Vergleich" }).locator("[data-chart='compare']")).toBeVisible({ timeout: 30_000 });
}

test("Vergleiche mit echten Daten: Woche/Woche, Monat/Monat, Claude/Codex, Modelle, Baustellen", async ({ page }) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const api = (await (await page.request.get("/api/usage/compare")).json()) as { week: { current: { tokens: number } }; month: { current: { tokens: number } } };
  expect(api.month.current.tokens, "echte Nutzung im laufenden Monat").toBeGreaterThan(0);

  await openUsage(page);
  const cmp = page.getByRole("region", { name: "Zeitraum im Vergleich" });
  await expect(cmp.getByText("diese Woche", { exact: true }).first()).toBeVisible();
  await expect(cmp.getByText(/Vorwoche bis zum gleichen Stand:/)).toBeVisible();
  const tools = page.getByRole("region", { name: "Claude und Codex" });
  await expect(tools.locator("[data-tool-side='claude']")).toBeVisible();
  await expect(tools.locator("[data-tool-side='codex']")).toBeVisible();
  await cmp.scrollIntoViewIfNeeded();
  // Mauszeiger auf den heutigen Tag → Tooltip „jetzt gegen vorher“.
  const chart = cmp.locator("[data-chart='compare']");
  const box = await chart.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  // Die Seite scrollt in einem inneren Bereich (ganze Seite als Bild wäre abgeschnitten) → Bereiche einzeln.
  await cmp.screenshot({ path: join(SHOT_DIR, "usage-compare.png") });
  await tools.scrollIntoViewIfNeeded();
  await tools.screenshot({ path: join(SHOT_DIR, "usage-claude-codex.png") });

  await cmp.getByRole("button", { name: "Monat" }).click();
  await expect(cmp.getByText("dieser Monat", { exact: true }).first()).toBeVisible();
  await expect(cmp.getByText(/Vormonat bis zum gleichen Stand:/)).toBeVisible();
  await cmp.screenshot({ path: join(SHOT_DIR, "usage-month.png") });

  const trend = page.getByRole("region", { name: "Modelle im Verlauf" });
  await trend.scrollIntoViewIfNeeded();
  await expect(trend.locator("[data-chart='area']")).toBeVisible();
  await trend.screenshot({ path: join(SHOT_DIR, "usage-models.png") });

  const baustellen = page.getByRole("region", { name: "Nach Baustelle" });
  await baustellen.scrollIntoViewIfNeeded();
  await baustellen.screenshot({ path: join(SHOT_DIR, "usage-projects.png") });
  const first = baustellen.getByRole("link").first();
  if ((await first.count()) > 0) {
    const href = await first.getAttribute("href");
    expect(href).toMatch(/^\/sessions\/[^/]+\/[^/]+$/);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${(href ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("Ziel und Warnschwelle speichern (angemeldet), Hochrechnung, bleibt nach Neuladen", async ({ browser }) => {
  test.skip(!process.env.E2E_SETUP_CODE, "E2E_SETUP_CODE fehlt (steht im Log von pnpm dev)");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto("/settings");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nyxos:login-required", { detail: { newDevice: true } })));
  const dlg = page.getByRole("dialog", { name: "Anmelden" });
  await dlg.getByLabel(/Einrichtungs-Code/).fill(process.env.E2E_SETUP_CODE ?? "");
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });

  await openUsage(page);
  await page.getByRole("button", { name: "Nutzung einstellen" }).click();
  const sheet = page.getByRole("region", { name: "Nutzung einstellen" });
  await sheet.getByLabel("Ziel je Monat").fill("10 Mrd.");
  await sheet.getByLabel("Ziel je Woche").fill("");
  await sheet.getByLabel("Warnen ab Anteil am 5-Std-Fenster (%)").fill("80");
  await sheet.getByLabel("Warnen ab Tagesverbrauch (Tokens)").fill("5 Mrd.");
  await sheet.getByRole("button", { name: "Speichern" }).click();
  await expect(sheet.getByText("Gespeichert.")).toBeVisible({ timeout: 15_000 });
  await sheet.screenshot({ path: join(SHOT_DIR, "usage-settings.png") });

  const goals = page.getByRole("region", { name: "Ziele" });
  await expect(goals.getByText(/von 10\sMrd\./)).toBeVisible({ timeout: 15_000 });
  await expect(goals.getByText(/Hochrechnung: schaffst du bis/)).toBeVisible();
  await expect(goals.getByText(/Warnung ab 80 %/)).toBeVisible();
  await goals.scrollIntoViewIfNeeded();
  await goals.screenshot({ path: join(SHOT_DIR, "usage-goals.png") });

  // Serverseitig gespeichert: nach Neuladen (ohne `?einstellen`) sind die Werte noch da.
  await page.goto("/usage?einstellen=1");
  await expect(page.getByRole("region", { name: "Nutzung einstellen" }).getByLabel("Ziel je Monat")).toHaveValue(/10\sMrd\./, { timeout: 15_000 });
  const saved = (await (await page.request.get("/api/usage/settings")).json()) as { goalMonthTokens: number; warnWindowPct: number };
  expect(saved).toMatchObject({ goalMonthTokens: 10_000_000_000, warnWindowPct: 80 });
  await ctx.close();
});
