// ⌘K gegen den lokalen Stack: sucht alles (Gruppen je Art), Enter springt zur Detailseite,
// letzte Zeile „Nyx fragen: …“ öffnet ⌘J mit der Frage (nicht abgeschickt).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/command-palette.spec.ts --project chromium-1440 --workers=1
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ mode: "serial", timeout: 120_000 });

function login() {
  return JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "nyxos_session", value: login().token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("⌘K findet Idee und Gedächtnis gruppiert, Enter springt, „Nyx fragen“ füllt ⌘J", async ({ page, request, baseURL }) => {
  const l = login();
  const headers = { cookie: `nyxos_session=${l.token}`, "x-nyxos-csrf": l.csrf, "content-type": "application/json" };
  // Saat nur auf der Probe (eigene PGlite): eine Idee und eine Gedächtnis-Zeile.
  const idea = await request.post(`${baseURL}/api/entries`, { headers, data: { kind: "idee", title: "Heatmap zeigt Freunde live", description: "Punkte auf der Karte, wer wo feiert" } });
  expect(idea.ok()).toBe(true);
  const mem = await request.post(`${baseURL}/api/nyx/memory`, { headers, data: { category: "preference", fact: "Alex mag die Stimme von Nyx ruhig und tief." } });
  expect(mem.ok()).toBe(true);

  // Server-Antwort: gruppiert, schnell.
  const api = (await (await request.get(`${baseURL}/api/search/all?q=Heatmap`, { headers })).json()) as { groups: { kind: string }[]; tookMs: number };
  expect(api.groups.map((g) => g.kind)).toContain("idee");
  console.log(`search/all Heatmap: ${api.tookMs} ms, Gruppen ${api.groups.map((g) => g.kind).join(",")}`);

  await page.goto("/overview");
  await page.waitForTimeout(800);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Befehlspalette" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("Stimme");
  await expect(dialog.locator('[data-search-group="gedaechtnis"]')).toContainText("Alex mag die Stimme", { timeout: 10_000 });
  await expect(dialog.getByTestId("palette-ask-nyx")).toContainText("Nyx fragen: „Stimme“");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Heatmap");
  const ideas = dialog.locator('[data-search-group="idee"]');
  await expect(ideas).toContainText("Heatmap zeigt Freunde live", { timeout: 10_000 });
  await expect(dialog.getByTestId("palette-ask-nyx")).toContainText("Nyx fragen: „Heatmap“");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, "command-palette.png") });

  // Tastatur: ↓ bis zur Idee, Enter öffnet die Großansicht.
  const row = ideas.locator("[cmdk-item]", { hasText: "Heatmap zeigt Freunde live" });
  for (let i = 0; i < 30 && (await row.getAttribute("data-selected")) !== "true"; i++) await page.keyboard.press("ArrowDown");
  await expect(row).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/ideas\?e=\d+/);

  // „Nyx fragen“: letzte Zeile, ↑ (loop) wählt sie, Enter öffnet ⌘J mit vorausgefüllter Frage.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Wie läuft die Heatmap");
  const askRow = dialog.getByTestId("palette-ask-nyx");
  await expect(askRow).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(askRow).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Nyx" });
  await expect(panel).toHaveAttribute("data-state", "open");
  await expect(panel.getByLabel("Frage an Haiku")).toHaveValue("Wie läuft die Heatmap");
  await page.screenshot({ path: resolve(SHOTS, "command-palette-ask-nyx.png") });
});
