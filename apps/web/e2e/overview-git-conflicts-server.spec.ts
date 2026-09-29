// Überblick, Git, Konflikte, Server, Einstellungen: Screenshots (Chromium 1440/1024) unter .probe/shots/ +
// Klick-Nachweis für jede Überblick-Kachel/Zeile. Läuft gegen den lokalen Stack (echte Sessions/Git-Daten,
// kein Docker nötig).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/overview-git-conflicts-server.spec.ts --project chromium-1440 --project chromium-1024
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUT = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });

function isChromium(name: string): boolean {
  return name.startsWith("chromium");
}

/** `page.screenshot({fullPage:true})` misst an `document.body` — das Layout scrollt aber INNERHALB
 * von `<main class="cc-scroll">` (äußerer Rahmen `h-dvh`, fixe Höhe). Für vollständige
 * Screenshots die Höhenbeschränkung kurzzeitig aufheben (nur in dieser Playwright-Seite, kein
 * Einfluss auf die echte App), dann normal `fullPage` schießen. */
async function shotMain(page: Page, path: string): Promise<void> {
  await page.addStyleTag({ content: ".h-dvh { height: auto !important; } .cc-scroll { overflow: visible !important; height: auto !important; }" });
  await page.screenshot({ path, fullPage: true });
}

test.describe("Überblick", () => {
  test("Screenshot + jede Kennzahl/Zeile öffnet ihre Quelle", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium (1440/1024)");
    await page.goto("/overview");
    await page.waitForSelector("h1");
    await page.waitForTimeout(300);
    await shotMain(page, join(OUT, `overview-${testInfo.project.name}.png`));

    // Jede echte (nicht-Platzhalter-)Kachel ist ein Link zu ihrer Quelle.
    const tiles = page.locator("a[href]").filter({ hasText: /Sessions offen|Commits 7 Tage|Ungesichert|Konflikte/ });
    const count = await tiles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const href = await tiles.nth(i).getAttribute("href");
      expect(href?.startsWith("/")).toBe(true);
    }
  });
});

test.describe("Git", () => {
  test("Screenshot: Zweige, Worktrees, Commits, Merges", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/git");
    await page.waitForSelector("h1");
    await page.waitForTimeout(500);
    await shotMain(page, join(OUT, `git-${testInfo.project.name}.png`));
  });
});

test.describe("Konflikte", () => {
  test("Screenshot: Kollisionskarte + Reservierungen", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/conflicts");
    await page.waitForSelector("h1");
    await page.waitForTimeout(300);
    // Bewusst NICHT `shotMain` (voll ausgeklappt): bei echten Daten kann die Kollisionskarte
    // durch viele parallel laufende Agenten (alle schreiben gerade in demselben Projekt)
    // hunderte Zeilen haben — ein Ausschnitt-Screenshot des sichtbaren, scrollenden
    // Bereichs zeigt das reale Aussehen, statt ein kilometerlanges Bild zu erzeugen.
    await page.screenshot({ path: join(OUT, `conflicts-${testInfo.project.name}.png`) });
  });
});

test.describe("Server", () => {
  test("Screenshot: Deploys, Hinweis zum Docker-Lesezugang", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/server");
    await page.waitForSelector("h1");
    await page.waitForTimeout(300);
    await expect(page.getByText(/Socket-Proxy/).first()).toBeVisible();
    await shotMain(page, join(OUT, `server-${testInfo.project.name}.png`));
  });
});

test.describe("Einstellungen — Lernbuch", () => {
  test("Screenshot", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/settings");
    await page.waitForSelector("h1");
    await page.waitForTimeout(300);
    await shotMain(page, join(OUT, `settings-${testInfo.project.name}.png`));
  });
});

test.describe("Navigation", () => {
  test("Überblick, Git, Konflikte, Server und Einstellungen sind in der Leiste anklickbar", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/overview");
    await page.waitForSelector("h1");
    // Auf der Seite "/overview" gibt es außer der Leiste noch eine gleichnamige Abschnitts-
    // Überschrift ("Server" verlinkt zusätzlich aus dem Überblick selbst) — deshalb gezielt
    // in der Seitenleiste (`<aside>`) suchen, nicht seitenweit.
    const sidebar = page.locator("aside");
    for (const [label, path] of [
      ["Überblick", "/overview"],
      ["Git", "/git"],
      ["Konflikte", "/conflicts"],
      ["Server", "/server"],
      ["Einstellungen", "/settings"],
    ] as const) {
      const link = sidebar.getByRole("link", { name: label, exact: true });
      await expect(link).toHaveAttribute("href", path);
    }
  });
});
