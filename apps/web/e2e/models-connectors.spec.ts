// Einstellungen → Modelle (eigener Endpunkt anlegen, testen, Rolle Nyx · Chat zuordnen, LM Studio über die
// Brücke ehrlich) und → Konnektoren (Higgsfield-Vorlage „Anmeldung nötig“, eigener Konnektor mit Token →
// Test listet Werkzeuge, an/aus). Danach antwortet Nyx im Panel über das gewählte Modell.
// Braucht einen selbst gestarteten OpenAI-kompatiblen Test-Anbieter (mit /v1 und /mcp) unter E2E_FAKE_MODEL_URL:
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_FAKE_MODEL_URL=http://127.0.0.1:47936 pnpm --filter @nyxos/web exec playwright test e2e/models-connectors.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const DIR = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const FAKE = process.env.E2E_FAKE_MODEL_URL ?? "http://127.0.0.1:47936";

test.describe.configure({ timeout: 180_000, mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Modelle: eigener Endpunkt, Test, Rolle zuordnen; LM Studio ehrlich über die Brücke", async ({ page }) => {
  await page.goto("/settings#modelle");
  const section = page.locator("#modelle");
  await expect(section.getByRole("heading", { name: "Modelle" })).toBeVisible();
  await expect(section.getByLabel("Wer antwortet")).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("active-skills.create")).toHaveText(/Opus 5\.5 \(Claude Code\)/);

  // Eigener Endpunkt (OpenAI-kompatibel) anlegen.
  const existing = section.locator('[data-provider^="custom-"]');
  if ((await existing.count()) === 0) {
    await section.getByRole("button", { name: /Eigener Endpunkt/ }).click();
    const card = section.locator('[data-provider="neu"]');
    await card.getByPlaceholder("z. B. Mein Server").fill("Probe-Endpunkt");
    await card.getByPlaceholder("https://…/v1").fill(`${FAKE}/v1`);
    await card.getByPlaceholder("hier einfügen").fill("sk-probe-test-1234567890NYX5");
    await card.getByRole("button", { name: "Anlegen" }).click();
  }
  const custom = section.locator('[data-provider^="custom-"]').first();
  await expect(custom).toBeVisible({ timeout: 15_000 });
  await expect(custom.getByText("Schlüssel ••••NYX5")).toBeVisible();
  await expect(page.getByText("sk-probe-test-1234567890NYX5")).toHaveCount(0);
  if (!(await custom.getByPlaceholder("leer = nur Modelle laden").isVisible())) await custom.getByRole("button", { name: /Bearbeiten|Einrichten/ }).click();
  await custom.getByPlaceholder("leer = nur Modelle laden").fill("nyx-probe-mini");
  await custom.getByRole("button", { name: "Test", exact: true }).click();
  await expect(custom.getByText(/Verbunden – 2 Modelle, nyx-probe-mini antwortet und kann Werkzeuge/)).toBeVisible({ timeout: 30_000 });

  // Rolle „Nyx · Chat“ → Probe-Endpunkt / nyx-probe-mini.
  const chatRole = section.locator('[data-role="nyx.chat"]');
  await chatRole.getByLabel("Anbieter für Nyx · Chat").selectOption({ label: "Probe-Endpunkt" });
  await chatRole.getByLabel("Modell für Nyx · Chat").fill("nyx-probe-mini");
  const apply = chatRole.getByRole("button", { name: "Übernehmen" });
  if (await apply.isEnabled()) await apply.click();
  await expect(section.getByTestId("active-nyx.chat")).toHaveText(/nyx-probe-mini · Probe-Endpunkt/, { timeout: 15_000 });

  // LM Studio auf dem Rechner (Server dort aus): über die Brücke, ehrliche Meldung.
  const lm = section.locator('[data-provider="lmstudio"]');
  await lm.getByRole("button", { name: /Einrichten|Bearbeiten/ }).click();
  await lm.getByRole("button", { name: /Speichern|Anlegen/ }).click();
  await lm.getByRole("button", { name: "Test", exact: true }).click();
  await expect(lm.getByTestId("test-lmstudio")).toBeVisible({ timeout: 60_000 });

  // Keine hängenden „Speichere …/Teste …“-Zustände.
  await expect(lm.getByRole("button", { name: "Test", exact: true })).toBeEnabled({ timeout: 15_000 });
  await expect(custom.getByRole("button", { name: "Test", exact: true })).toBeEnabled({ timeout: 15_000 });
  await expect(lm.getByRole("button", { name: "Speichern" })).toBeEnabled({ timeout: 15_000 });
  await page.setViewportSize({ width: 1440, height: 3600 });
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await section.screenshot({ path: resolve(DIR, "models.png") });
});

test("Konnektoren: Higgsfield-Vorlage (Anmeldung nötig), eigener Konnektor mit Token → Werkzeuge, an/aus", async ({ page }) => {
  await page.goto("/settings#konnektoren");
  const section = page.locator("#konnektoren");
  await expect(section.getByRole("heading", { name: "Konnektoren" })).toBeVisible();
  await expect(section.getByRole("button", { name: /Konnektor hinzufügen/ })).toBeVisible({ timeout: 30_000 });

  if ((await section.locator('[data-connector="higgsfield"]').count()) === 0) {
    await section.getByRole("button", { name: /Konnektor hinzufügen/ }).click();
    await section.getByRole("button", { name: "Higgsfield" }).click();
    await expect(section.getByText(/normale Higgsfield-Credits/)).toBeVisible();
    await section.getByRole("button", { name: "Anlegen" }).click();
  }
  const higgs = section.locator('[data-connector="higgsfield"]');
  await expect(higgs.getByText("Anmeldung nötig")).toBeVisible({ timeout: 15_000 });
  await expect(higgs.getByRole("button", { name: "Anmelden" })).toBeVisible();

  if ((await section.locator('[data-connector="bilder"]').count()) === 0) {
    await section.getByRole("button", { name: /Konnektor hinzufügen/ }).click();
    await section.getByRole("button", { name: "Eigener Konnektor" }).click();
    await section.getByPlaceholder("z. B. Mein Werkzeug").fill("Bilder-Dienst");
    await section.getByPlaceholder("mein-werkzeug").fill("bilder");
    await section.getByPlaceholder("https://…/mcp").fill(`${FAKE}/mcp`);
    await section.getByPlaceholder("hier einfügen").fill("mcp-probe-token-ABCD");
    await section.getByRole("button", { name: "Anlegen" }).click();
  }
  const bilder = section.locator('[data-connector="bilder"]');
  await expect(bilder).toBeVisible({ timeout: 15_000 });
  await bilder.getByRole("button", { name: "Öffnen" }).click();
  await bilder.getByRole("button", { name: /Test \(Werkzeuge auflisten\)/ }).click();
  await expect(bilder.getByTestId("mcp-test-bilder")).toHaveText(/Verbunden – 2 Werkzeuge/, { timeout: 30_000 });
  await expect(bilder.getByLabel("Werkzeug bild_erzeugen")).toBeChecked();
  const toggle = bilder.getByLabel("Bilder-Dienst an/aus");
  if (!(await toggle.isChecked())) await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("mcp-probe-token-ABCD")).toHaveCount(0);

  await expect(bilder.getByRole("button", { name: /Test \(Werkzeuge auflisten\)/ })).toBeEnabled({ timeout: 15_000 });
  await page.setViewportSize({ width: 1440, height: 2600 });
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await section.screenshot({ path: resolve(DIR, "connectors.png") });
});

test("Nyx-Panel zeigt das aktive Modell und antwortet darüber", async ({ page }) => {
  await page.goto("/overview");
  await page.getByRole("button", { name: /Haiku öffnen/ }).click();
  const panel = page.getByRole("complementary", { name: "Nyx" }).or(page.getByLabel("Nyx", { exact: true })).first();
  await expect(panel.getByText(/nyx-probe-mini/)).toBeVisible({ timeout: 30_000 });
  await panel.getByLabel("Frage an Haiku").fill("Wie ist die Lage?");
  await panel.getByLabel("Frage an Haiku").press("Enter");
  await expect(panel.getByText(/hier antwortet nyx-probe-mini über den eigenen Endpunkt/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(400);
  await panel.screenshot({ path: resolve(DIR, "models-nyx-panel.png") });
});
