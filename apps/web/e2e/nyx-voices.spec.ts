// Deutsch + Englisch mit zwei getrennten Stimmen: Einstellungen zeigen „Deutsche Stimme“ und „Englische Stimme“
// (jede nur mit Stimmen ihrer Sprache) und „Probe hören“; die API spricht gemischten Text als EINEN Strom und
// nennt beide Stimmen. Stimmen-Dienst lokal ohne Modelle (Attrappen):
//   (infra/nyx-voice) NYX_FAKE=1 NYX_PORT=8793 NYX_MODELS_DIR=/tmp/nyx-fake python3 -m nyx_voice
//   NYXOS_NYX_VOICE_URL=http://127.0.0.1:8793 NYXOS_HAIKU_SCHEDULER=0 pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-voices.spec.ts --project chromium-1440
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!login, "Anmeldung des lokalen Stacks fehlt (.probe/probe-login.json)");
  await context.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Zwei Stimmen-Auswahlen + gemischter Text in einem Strom", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  // Die Stimmen laden in der Attrappe in Sekunden.
  await expect
    .poll(async () => ((await (await page.request.get("/api/nyx/voice/status")).json()) as { tts: { ready: boolean } }).tts.ready, { timeout: 30_000 })
    .toBe(true);

  const res = await page.request.post("/api/nyx/voice/speak?stream=1", {
    data: { text: "Der Build ist fertig. The build is green." },
    headers: { "x-nyxos-csrf": login?.csrf ?? "" },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["x-nyx-voices"]).toBe("pocket-juergen,pocket-en-george");
  expect((await res.body()).subarray(0, 4).toString()).toBe("RIFF");

  await page.goto("/nyx");
  await page.locator('[data-nyx="nyx-reiter-einstellungen"]').click();
  const de = page.locator('[data-nyx="nyx-stimme"]');
  const en = page.locator('[data-nyx="nyx-stimme-en"]');
  await expect(de).toBeVisible();
  await expect(en).toBeVisible();
  await expect(page.getByText("Deutsche Stimme")).toBeVisible();
  await expect(page.getByText("Englische Stimme")).toBeVisible();
  // Die Auswahl füllt sich, sobald der Stimmen-Status da ist.
  await expect(en.locator("option", { hasText: "George" })).not.toHaveCount(0, { timeout: 20_000 });
  await expect(de.locator("option", { hasText: "Jürgen" })).not.toHaveCount(0);
  const enOptions = await en.locator("option").allTextContents();
  expect(enOptions.join(" ")).toMatch(/George/);
  expect(enOptions.join(" ")).not.toMatch(/Jürgen|Thorsten/);
  const deOptions = await de.locator("option").allTextContents();
  expect(deOptions.join(" ")).toMatch(/Jürgen/);
  expect(deOptions.join(" ")).not.toMatch(/George|Linda/);
  await expect(page.locator('[data-nyx="nyx-stimme-en-probe"]')).toBeVisible();
  await page.locator('[data-nyx="nyx-stimme-en"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS, "nyx-voices.png") });
});
