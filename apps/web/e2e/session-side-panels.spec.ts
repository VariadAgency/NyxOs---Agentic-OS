// Seitenleisten einer Session mit echten Daten: geänderte Dateien, Reiter „Änderungen“ mit Suche, Agenten-Kacheln,
// Bezüge. Braucht eine Session mit vielen geänderten Dateien und Sub-Agenten, per `E2E_SESSION=<tool:id>`
// (ohne wird übersprungen). Screenshots nach `.probe/shots/`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_SESSION=claude:<uuid> pnpm --filter @nyxos/web exec playwright test e2e/session-side-panels.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const KEY = process.env.E2E_SESSION ?? "";

test.skip(!KEY, "E2E_SESSION fehlt (eine Session mit vielen geänderten Dateien und Sub-Agenten, z. B. claude:<uuid>)");

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

async function openSession(page: Page) {
  const res = await page.request.get(`/api/sessions/${encodeURIComponent(KEY)}`);
  expect(res.ok()).toBe(true);
  const { session } = (await res.json()) as { session: { art: string; baustelle: { slug: string } | null } };
  await page.goto(`/sessions/${session.art}/${session.baustelle?.slug ?? "_"}/${KEY}`);
  await page.getByTestId("changed-files").waitFor();
}

async function openTab(page: Page, name: string) {
  await page.getByRole("tablist", { name: "Session-Ansicht" }).getByRole("tab", { name }).click();
}

test("Dateien: erst 5 mit +/−, „Alle N zeigen“ klappt aus, Klick zeigt die Änderungen der Datei", async ({ page }) => {
  await openSession(page);
  const box = page.getByTestId("changed-files");
  await expect(box.getByRole("listitem")).toHaveCount(5);
  await expect(box.locator(".text-a-ok").first()).toBeVisible({ timeout: 60_000 }); // +N aus dem Server-Digest
  const more = box.getByRole("button", { name: /^Alle \d+ zeigen/ });
  await expect(more).toBeVisible();
  // Kurze Pfade: kein Eintrag zeigt den vollen /Users/…-Pfad als Text, aber im Tooltip.
  const first = box.getByRole("listitem").first();
  await expect(first).not.toContainText("/Users/");
  await expect(first.locator("[title^='/']").first()).toHaveAttribute("title", /^\//);
  await box.screenshot({ path: `${SHOTS}/session-files.png` });
  await first.getByRole("button").click();
  await expect(box.getByTestId("file-changes")).toBeVisible();
  await box.screenshot({ path: `${SHOTS}/session-files-detail.png` });

  await more.click();
  expect(await box.getByRole("listitem").count()).toBeGreaterThan(5);
  await box.getByRole("button", { name: "Weniger zeigen" }).click();
  await expect(box.getByRole("listitem")).toHaveCount(5);
});

test("Reiter „Änderungen“ — Suche filtert nach Inhalt, Treffer markiert, „x von y“", async ({ page }) => {
  await openSession(page);
  await openTab(page, "Änderungen");
  const count = page.getByTestId("changes-count");
  await expect(count).toContainText(/\d+ Dateien/);
  const total = Number((await count.textContent())?.match(/(\d+)/)?.[1] ?? 0);
  expect(total).toBeGreaterThan(5);
  // Virtualisiert: bei Hunderten Dateien stehen nur die sichtbaren Zeilen im DOM.
  const rendered = await page.getByTestId("changes-scroll").getByRole("button").count();
  expect(rendered).toBeLessThan(60);

  await page.getByRole("searchbox", { name: "Änderungen durchsuchen" }).fill("useVirtualizer");
  await expect(count).toContainText(new RegExp(`^\\d+ von ${total}`));
  await expect(page.locator("mark", { hasText: /useVirtualizer/i }).first()).toBeVisible();
  await page.getByTestId("session-main").screenshot({ path: `${SHOTS}/session-changes-search.png` });
});

test("Klick vergrößert die Agenten-Kachel — Auftrag, Ergebnis, Tokens, Werkzeuge, Dateien", async ({ page }) => {
  await openSession(page);
  await openTab(page, "Agenten");
  const tile = page.getByTestId("agent-tile").first();
  await expect(tile).toBeVisible({ timeout: 60_000 }); // erster Abruf rechnet ggf. noch Digests
  const closed = await tile.boundingBox();
  await tile.getByRole("button").first().click();
  await expect(tile).toHaveAttribute("data-open", "true");
  await expect(tile.getByTestId("agent-prompt")).toBeVisible({ timeout: 30_000 });
  await expect(tile.getByTestId("agent-tokens")).toContainText("Gesamt");
  await expect(tile.getByTestId("agent-tools")).toBeVisible();
  await page.waitForTimeout(400); // Wachs-Animation (300 ms) abwarten
  const opened = await tile.boundingBox();
  expect(opened?.height ?? 0).toBeGreaterThan((closed?.height ?? 0) * 3);
  expect(page.url()).toContain(KEY); // kein neuer Tab, keine neue Seite
  await page.getByTestId("session-main").screenshot({ path: `${SHOTS}/session-agent-tile.png` });
});

test("Bezüge — erledigt, behoben (mit Sicherheit), offen, vergleichbar; alles klickbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openSession(page);
  await openTab(page, "Bezüge");
  const done = page.getByTestId("refs-done");
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("refs-stats")).toContainText("Commits");
  await expect(page.getByTestId("refs-fixed")).toBeVisible();
  await expect(page.getByTestId("refs-open")).toBeVisible();
  const similar = page.getByTestId("refs-similar");
  await expect(similar).toBeVisible();
  // Ein Eintrag aus „Erledigt“ klappt auf und sagt, warum er dort steht.
  await done.getByRole("button").first().click();
  await expect(done.getByText("Warum hier:")).toBeVisible();
  // Die Listen stehen unter dem lokalen Graphen: dorthin scrollen, dann den sichtbaren Ausschnitt zeigen.
  await page.getByTestId("refs-stats").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${SHOTS}/session-references.png` });
  if ((await similar.getByRole("link").count()) > 0) {
    await expect(similar.getByRole("link").first()).toHaveAttribute("href", /^\/sessions\//);
  }
});
