// „Anmeldung bleibt“ im echten Browser mit virtuellem Passkey (CDP `WebAuthn.addVirtualAuthenticator`,
// darum nur Chromium):
//   anmelden → 10 Tabs wechseln → neu laden → Server neu starten (gleiche DB) → Session starten klappt.
// Dazwischen muss unten links immer „Angemeldet“ stehen, nie „Nicht angemeldet“.
//
// Umgebungsvariablen:
//   E2E_BASE_URL     andere Instanz statt des lokalen Stacks (optional)
//   E2E_SETUP_CODE   Einrichtungs-Code (lokaler Stack: steht im Log von `pnpm dev`; sonst `cli.js passkey-setup`)
//   E2E_RESTART_CMD  Befehl, der den Server neu startet (z. B. `docker restart nyxos-api`). Fehlt er,
//                    wird der Neustart-Schritt übersprungen und im Ergebnis vermerkt.
//   E2E_START_FOLDER Ordner-Beschriftung im „Neue Session“-Dialog (Standard: erster Eintrag)
//   E2E_SCREENSHOT   Pfad für das Bildschirmfoto (Standard: .probe/shots/passkey-signed-in.png)
// Aufruf:
//   pnpm dev
//   E2E_SETUP_CODE=… E2E_RESTART_CMD=… pnpm --filter @nyxos/web exec playwright test e2e/passkey-session-persistence.spec.ts --project=chromium-1440
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOT = process.env.E2E_SCREENSHOT ?? join(ROOT, ".probe", "shots", "passkey-signed-in.png");
const RESULTS = join(ROOT, ".probe", "shots", "passkey-session-results.json");
const TABS = ["Briefing", "Überblick", "Sessions", "Gehirn", "Aufgaben", "Agenten", "Konflikte", "Git", "Server", "Nutzung", "Einstellungen"];

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(({ browserName }) => browserName !== "chromium", "virtueller Passkey nur in Chromium");
test.skip(!process.env.E2E_SETUP_CODE, "E2E_SETUP_CODE fehlt (Log von pnpm dev bzw. cli.js passkey-setup)");

const results: Record<string, unknown> = { baseUrl: process.env.E2E_BASE_URL ?? null, steps: [] as string[] };
const step = (s: string) => (results.steps as string[]).push(`${new Date().toISOString()} ${s}`);
let page: Page;

/** Unten links steht „Angemeldet“ — und nirgends „Nicht angemeldet“. */
async function expectSignedIn(p: Page, where: string) {
  const status = p.locator("aside, nav, body").getByText("Angemeldet", { exact: true }).first();
  await expect(status, `Angemeldet nach: ${where}`).toBeVisible({ timeout: 15_000 });
  await expect(p.getByText("Nicht angemeldet", { exact: true }), `kein „Nicht angemeldet“ nach: ${where}`).toHaveCount(0);
}

async function waitForHealth(p: Page, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await p.request.get("/health", { timeout: 3_000 });
      if (r.ok()) return Date.now() - t0;
    } catch {
      // noch nicht oben
    }
    await p.waitForTimeout(500);
  }
  throw new Error(`Server nach ${timeoutMs / 1000} s nicht wieder erreichbar`);
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});

test.afterAll(() => {
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
});

test("anmelden → 10 Tabs → neu laden → Server-Neustart → Session starten", async () => {
  // 1 · Anmelden: Passkey für diesen (virtuellen) Browser einrichten.
  await page.goto("/settings");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nyxos:login-required", { detail: { newDevice: true } })));
  const dlg = page.getByRole("dialog", { name: "Anmelden" });
  await dlg.getByLabel(/Einrichtungs-Code/).fill(process.env.E2E_SETUP_CODE ?? "");
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
  await expectSignedIn(page, "Passkey einrichten");
  step("angemeldet");

  // 2 · Zehn Tab-Wechsel über die Seitenleiste.
  let switched = 0;
  for (const name of TABS) {
    if (switched === 10) break;
    const link = page.getByRole("link", { name, exact: true }).first();
    if (!(await link.isVisible().catch(() => false))) continue;
    await link.click();
    await page.waitForLoadState("domcontentloaded");
    await expectSignedIn(page, `Tab ${name}`);
    switched++;
  }
  expect(switched).toBe(10);
  results.tabWechsel = switched;
  step("10 Tabs gewechselt");

  // 3 · Neu laden.
  await page.reload();
  await expectSignedIn(page, "Neuladen");
  step("neu geladen");

  // 4 · Server neu starten (gleiche DB). Währenddessen darf die Anzeige nicht auf „Nicht angemeldet“ kippen.
  if (process.env.E2E_RESTART_CMD) {
    execSync(process.env.E2E_RESTART_CMD, { stdio: "inherit", cwd: ROOT, timeout: 120_000 });
    // Aussetzer mitten im Neustart: Fokus/Sichtbarkeit lösen einen Status-Abruf aus, der scheitern kann.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    results.neustartBisGesundMs = await waitForHealth(page);
    await expect(page.getByText("Nicht angemeldet", { exact: true })).toHaveCount(0);
    await page.reload();
    await expectSignedIn(page, "Server-Neustart");
    step("Server neu gestartet");
  } else {
    results.neustart = "übersprungen (E2E_RESTART_CMD fehlt)";
    step("Neustart übersprungen");
  }

  // 5 · Session starten (Schreibaktion) — muss ohne „Bitte anmelden“ und ohne Fehler durchgehen.
  await page.goto("/sessions");
  await expectSignedIn(page, "Sessions nach Neustart");
  await page.getByRole("button", { name: "Neue Session" }).first().click();
  const ns = page.getByRole("dialog", { name: "Neue Session" });
  await ns.getByRole("radio", { name: "Claude" }).click();
  await ns.getByLabel("Modell").selectOption("haiku");
  if (process.env.E2E_START_FOLDER) await ns.getByLabel("Ordner").selectOption({ label: process.env.E2E_START_FOLDER });
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/terminal/start"), { timeout: 60_000 }), ns.getByRole("button", { name: "Starten" }).click()]);
  const body = (await res.json().catch(() => ({}))) as { tmuxName?: string; sessionId?: string | null; error?: string };
  results.sessionStart = { status: res.status(), tmuxName: body.tmuxName ?? null, sessionId: body.sessionId ?? null, error: body.error ?? null };
  expect(res.status(), `Session-Start: ${body.error ?? ""}`).toBe(200);
  await expect(page.getByRole("dialog", { name: "Bitte anmelden" })).toHaveCount(0);
  await expect(page.getByText(/CSRF|Token fehlt/i)).toHaveCount(0);
  step(`Session gestartet (${body.tmuxName ?? "?"})`);

  // Bildschirmfoto: Einstellungen → Anmeldung, mit Statuszeile unten links.
  await page.goto("/settings");
  await expectSignedIn(page, "Bildschirmfoto");
  mkdirSync(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });
});

test("„Code erzeugen“ (nach Touch ID) und „Bitte anmelden“ mit Weiterlauf der Aktion", async () => {
  // Code erzeugen: nur angemeldet, erst Touch ID, dann steht der Code da.
  await page.goto("/settings");
  await expectSignedIn(page, "vor Code erzeugen");
  await page.getByRole("button", { name: "Code erzeugen" }).click();
  const codeBox = page.getByTestId("setup-code");
  await expect(codeBox).toBeVisible({ timeout: 15_000 });
  await expect(codeBox.locator("code")).toHaveText(/^\S{8,}$/);
  results.codeErzeugen = "ok";
  step("Code erzeugt");

  // Abmelden → Schreibaktion → „Bitte anmelden“ statt Fehlertext → Touch ID → die Aktion läuft weiter.
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page.getByRole("button", { name: "Nicht angemeldet" })).toBeVisible({ timeout: 10_000 });
  await page.goto("/sessions");
  await page.getByRole("button", { name: "Neue Session" }).first().click();
  const ns = page.getByRole("dialog", { name: "Neue Session" });
  await ns.getByRole("radio", { name: "Claude" }).click();
  await ns.getByLabel("Modell").selectOption("haiku");
  if (process.env.E2E_START_FOLDER) await ns.getByLabel("Ordner").selectOption({ label: process.env.E2E_START_FOLDER });
  const started = page.waitForResponse((r) => r.url().endsWith("/api/terminal/start") && r.status() === 200, { timeout: 60_000 });
  await ns.getByRole("button", { name: "Starten" }).click();
  const login = page.getByRole("dialog", { name: "Bitte anmelden" });
  await expect(login).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/CSRF|Token fehlt/i)).toHaveCount(0);
  await page.screenshot({ path: SHOT.replace(/\.png$/, "-bitte-anmelden.png") });
  await login.getByRole("button", { name: /Touch ID/ }).click();
  const res = await started;
  const body = (await res.json()) as { tmuxName?: string };
  results.weiterlaufNachAnmeldung = { status: res.status(), tmuxName: body.tmuxName ?? null };
  await expectSignedIn(page, "Anmeldung aus „Bitte anmelden“");
  step(`nach „Bitte anmelden“ weitergelaufen (${body.tmuxName ?? "?"})`);
});
