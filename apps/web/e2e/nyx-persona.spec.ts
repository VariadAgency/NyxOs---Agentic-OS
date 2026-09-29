// Einstellungen → Nyx im echten Browser. Regler + Vorlagen ändern den Beispielsatz sofort; angemeldet
// (virtueller Passkey, nur Chromium) wird das Profil gespeichert und ist nach Neuladen noch da.
//
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_SETUP_CODE=… pnpm --filter @nyxos/web exec playwright test e2e/nyx-persona.spec.ts --project=chromium-1440 --workers=1
// Screenshots: `.probe/shots/nyx-persona*.png` (Ordner per E2E_SHOT_DIR änderbar).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? join(ROOT, ".probe", "shots");

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ browserName }) => browserName !== "chromium", "ein Browser genügt (virtueller Passkey nur in Chromium)");

test("Nyx-Einstellungen: Vorlage, Regler, Beispielsatz, Speichern bleibt nach Neuladen", async ({ browser }) => {
  test.skip(!process.env.E2E_SETUP_CODE, "E2E_SETUP_CODE fehlt (steht im Log von pnpm dev)");
  mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto("/settings");
  // Reiter „Nyx“ oben in den Einstellungen.
  await expect(page.getByRole("navigation", { name: "Einstellungen" }).getByRole("link", { name: "Nyx" })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nyxos:login-required", { detail: { newDevice: true } })));
  const dlg = page.getByRole("dialog", { name: "Anmelden" });
  await dlg.getByLabel(/Einrichtungs-Code/).fill(process.env.E2E_SETUP_CODE ?? "");
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });

  await page.getByRole("navigation", { name: "Einstellungen" }).getByRole("link", { name: "Nyx" }).click();
  await expect(page).toHaveURL(/\/einstellungen\/nyx$/);
  await expect(page.getByRole("heading", { name: "Nyx", level: 1 })).toBeVisible();
  const preview = page.getByTestId("nyx-preview");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  const start = await preview.textContent();
  await page.waitForTimeout(300); // Einblenden fertig
  await page.screenshot({ path: join(SHOT_DIR, "nyx-persona.png") });

  // Vorlage „Gründlich“ → Regler springen, Beispielsatz wird länger.
  await page.getByRole("group", { name: "Vorlagen" }).getByRole("button", { name: "Gründlich" }).click();
  await expect(page.getByRole("slider", { name: "Tempo" })).toHaveValue("95");
  await expect(preview).not.toHaveText(start ?? "");
  const thorough = (await preview.textContent()) ?? "";
  expect(thorough.length).toBeGreaterThan((start ?? "").length);

  // Regler von Hand: „Erklären“ ganz nach links (fachlich) → Technik im Satz, Vorlage nicht mehr aktiv.
  const expertise = page.getByRole("slider", { name: "Erklären" });
  await expertise.focus();
  await expertise.press("Home");
  await expect(preview).toContainText("Tests");
  await expect(page.getByRole("group", { name: "Vorlagen" }).getByRole("button", { name: "Gründlich" })).toHaveAttribute("aria-pressed", "false");

  await page.getByLabel("Sonst noch").fill("Mag Techno und kurze Wege.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOT_DIR, "nyx-persona-saved.png") });

  // Serverseitig gespeichert: Neuladen zeigt dieselben Werte.
  await page.reload();
  await expect(page.getByTestId("nyx-preview")).toContainText("Tests", { timeout: 15_000 });
  await expect(page.getByLabel("Sonst noch")).toHaveValue("Mag Techno und kurze Wege.");
  const saved = (await (await page.request.get("/api/nyx/profile")).json()) as { profile: { sliders: { speed: number; expertise: number }; user: { notes: string } } };
  expect(saved.profile.sliders).toMatchObject({ speed: 95, expertise: 0 });
  expect(saved.profile.user.notes).toBe("Mag Techno und kurze Wege.");

  // Eigene Vorlage speichern und wieder löschen.
  await page.getByRole("button", { name: "Als Vorlage speichern" }).click();
  await page.getByLabel("Name der Vorlage").fill("Nachtschicht");
  await page.getByRole("button", { name: "Vorlage anlegen" }).click();
  const chip = page.getByRole("group", { name: "Vorlagen" }).getByRole("button", { name: "Nachtschicht", exact: true });
  await expect(chip).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await page.screenshot({ path: join(SHOT_DIR, "nyx-persona-preset.png") });
  await page.getByRole("button", { name: "Vorlage „Nachtschicht“ löschen" }).click();
  await expect(chip).toBeHidden({ timeout: 15_000 });

  // Zurücksetzen + Speichern → Startwerte.
  await page.getByRole("button", { name: "Zurücksetzen" }).click();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Sonst noch")).toHaveValue("");
  await ctx.close();
});
