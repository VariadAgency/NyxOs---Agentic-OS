// Sprache, Build-Wächter, Push und Nachtmodus sind in der Oberfläche eingebunden: Mikrofon im Suchfeld und
// in ⌘K, Push/Nachtmodus in den Einstellungen, „Letzte Builds“ im Server-Tab, Build-Status im Session-Kopf.
// Läuft gegen den lokalen Stack mit echten Daten. Screenshots unter `.probe/shots/`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/voice-builds-push-visible.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(process.cwd(), "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });

test.describe("Sprache, Builds, Push und Nachtmodus sichtbar", () => {
  test("Mikrofon im Suchfeld + ⌘K, Push/Nachtmodus in Einstellungen, Letzte Builds im Server-Tab", async ({ page }) => {
    // 1) Sichtbarer Such-Einstieg (ART-Zeile): Mikrofon-Knopf steht direkt im Suchfeld.
    await page.goto("/sessions");
    await expect(page.getByPlaceholder("Suchen")).toBeVisible();
    const inlineMic = page.getByRole("button", { name: "Diktat aufnehmen (halten)" });
    await expect(inlineMic).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "session-kopf-suchfeld.png") });

    // 2) ⌘K bekommt sein eigenes Mikrofon (VoiceTarget "search"), unabhängig vom Suchfeld.
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "Befehlspalette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Diktat aufnehmen (halten)" })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "cmdk-mikrofon.png") });
    await page.keyboard.press("Escape");

    // 3) Einstellungen: Push- und Nachtmodus-Abschnitte stehen vor dem Lernbuch.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Push aufs iPhone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nachtmodus" })).toBeVisible();
    const headings = await page.getByRole("heading").allTextContents();
    expect(headings.indexOf("Push aufs iPhone")).toBeLessThan(headings.indexOf("Lernbuch"));
    expect(headings.indexOf("Nachtmodus")).toBeLessThan(headings.indexOf("Lernbuch"));
    await page.screenshot({ path: join(SHOTS, "einstellungen.png"), fullPage: true });

    // 4) Server-Tab: „Letzte Builds" ist ein eigener Abschnitt (leer oder gefüllt, nie unsichtbar).
    await page.goto("/server");
    await expect(page.getByText("Letzte Builds")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "server-letzte-builds.png") });
  });

  test("Build-Status-Pill steht im Session-Vollbild-Kopf neben dem Zustand", async ({ page, request }) => {
    await page.goto("/sessions");
    const list = page.getByRole("list").first();
    await expect(list).toBeVisible({ timeout: 15_000 });
    const cards = list.getByRole("button");
    test.skip((await cards.count()) === 0, "keine Sessions im lokalen Stack");
    await cards.first().click();
    const sessionUuid = page.url().split("/").pop() ?? "";
    const res = await request.get(`/api/sessions/${sessionUuid}`);
    const s = ((await res.json()) as { session: { id: string } }).session;

    // Diese Session hat im echten Bestand meist noch keinen Build-Lauf — die Pill soll dann
    // ungezeigt bleiben (kein Rauschen, s. Test oben). Mit einem `build_runs`-Eintrag über die
    // Route (Frontend-seitig, keine Backend-Änderung) prüfen wir die verdrahtete Anzeige selbst.
    // RegExp statt Glob: ein wörtliches "?" in einem Glob-Muster ist mehrdeutig (Einzelzeichen-Joker).
    await page.route(new RegExp(`/api/builds\\?sessionKey=${encodeURIComponent(s.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), (route) =>
      route.fulfill({
        json: {
          // API-Reihenfolge ist `desc(startedAt)` (neuester zuerst) — der neueste Lauf ist grün.
          runs: [
            { id: 2, sessionKey: s.id, kind: "nyxos", command: "pnpm test", status: "green", exitCode: 0, logExcerpt: null, startedAt: new Date().toISOString() },
            { id: 1, sessionKey: s.id, kind: "nyxos", command: "pnpm test", status: "red", exitCode: 1, logExcerpt: null, startedAt: new Date(Date.now() - 60_000).toISOString() },
          ],
        },
      }),
    );
    await page.reload();
    await expect(page.getByText("grün", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: join(SHOTS, "session-build-pill.png") });
  });
});
