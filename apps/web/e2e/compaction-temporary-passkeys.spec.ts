// Gegen den lokalen Stack mit echten Verläufen:
//   1 · eine echte, von Hand komprimierte Session zeigt „Kontext komprimiert · HH:MM“ (kein rohes „/compact“)
//   2 · „Zuletzt fertig“ ohne beendete temporäre Sessions
//   3 · Einstellungen → Anmeldung: Passkeys anzeigen/entfernen (virtueller Passkey, nur Chromium)
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_SETUP_CODE=<aus dem Log von pnpm dev> E2E_COMPACT_SESSION=<uuid> \
//   pnpm --filter @nyxos/web exec playwright test e2e/compaction-temporary-passkeys.spec.ts --project chromium-1440
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const shot = (name: string) => resolve(SHOTS, `compaction-${name}.png`);

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("Komprimierung als ruhige Zeile im Chat", async ({ page }) => {
  const id = process.env.E2E_COMPACT_SESSION;
  test.skip(!id, "E2E_COMPACT_SESSION fehlt");
  await page.goto(`/sessions/unsortiert/_/${encodeURIComponent(`claude:${id}`)}`);
  const line = page.getByTestId("chat-system-line").filter({ hasText: "Kontext komprimiert" }).last();
  await expect(line).toBeVisible({ timeout: 60_000 });
  await expect(line).toContainText(/Kontext komprimiert · \d\d:\d\d/);
  await expect(page.locator("[data-item-id]").filter({ hasText: /This session is being continued|Compacted/ })).toHaveCount(0);
  await line.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot("kompakt") });
});

test("Zuletzt fertig ohne beendete temporäre Sessions", async ({ page, request, baseURL }) => {
  // Der lokale Stack kennt die echten „⏳ Temporär“-Starts nicht (eigene DB). Darum hier die oberste
  // beendete Session in „Zuletzt fertig“ von Hand als temporär markieren – danach darf sie dort nicht mehr stehen.
  const before = (await (await request.get("/api/overview")).json()) as { recentDone: { kind: string; id: string; title: string }[] };
  const victim = before.recentDone.find((d) => d.kind === "session");
  expect(victim, "mindestens eine beendete Session in „Zuletzt fertig“").toBeTruthy();
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  await page.context().addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
  const res = await page.request.post(`/api/sessions/${encodeURIComponent(victim?.id ?? "")}/temporary`, { data: { temporary: true }, headers: { "x-nyxos-csrf": login.csrf } });
  expect(res.ok(), await res.text()).toBe(true);
  const after = (await (await request.get("/api/overview")).json()) as { recentDone: { id: string }[] };
  expect(after.recentDone.map((d) => d.id)).not.toContain(victim?.id);
  await page.goto("/");
  const panel = page.getByText("Zuletzt fertig", { exact: true }).first();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot("zuletzt-fertig") });
});

async function passkeyPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return page;
}

async function register(page: Page, code: string) {
  await page.goto("/settings");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nyxos:login-required", { detail: { newDevice: true } })));
  const dlg = page.getByRole("dialog", { name: "Anmelden" });
  await dlg.getByLabel(/Einrichtungs-Code/).fill(code);
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
}

test("Passkeys anzeigen und entfernen", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium" || !process.env.E2E_SETUP_CODE, "virtueller Passkey nur in Chromium, E2E_SETUP_CODE fehlt");
  const a = await passkeyPage(browser);
  await register(a, process.env.E2E_SETUP_CODE ?? "");
  // Zweites Gerät: Code hier erzeugen (frisches Touch ID), im zweiten Browser einrichten.
  await a.getByRole("button", { name: "Code erzeugen" }).click();
  const codeBox = a.getByTestId("setup-code");
  await expect(codeBox).toBeVisible({ timeout: 15_000 });
  const code = ((await codeBox.innerText()).match(/[A-Za-z0-9_-]{16,}/) ?? [""])[0];
  expect(code).not.toBe("");
  const b = await passkeyPage(browser);
  await register(b, code);

  await a.reload();
  await a.getByRole("button", { name: "Passkeys anzeigen" }).click();
  const list = a.getByTestId("passkey-list");
  await expect(list).toBeVisible({ timeout: 15_000 });
  await expect(list).toContainText("gerade benutzt");
  await list.scrollIntoViewIfNeeded();
  await a.waitForTimeout(500);
  await a.screenshot({ path: shot("passkeys") });

  const removable = list.locator("button:not([disabled])", { hasText: "Entfernen" }).first();
  await removable.click();
  await expect(a.getByRole("group", { name: /entfernen bestätigen/ })).toBeVisible();
  await a.screenshot({ path: shot("passkeys-rueckfrage") });
});
