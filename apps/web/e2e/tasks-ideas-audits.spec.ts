// Aufgaben/Ideen/Audits: Screenshots unter `.probe/shots/`, Klick-Kette über 4 Ebenen mit echter
// Browser-Zurück-Taste, Fortschrittsbalken folgt einer anderen Quelle < 2 s, Suche/Filter < 300 ms.
// Läuft gegen den lokalen Stack; die Klick-Kette braucht verknüpfte Demo-Einträge und wird ohne sie
// übersprungen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/tasks-ideas-audits.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const OUT_DIR = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(OUT_DIR, { recursive: true });
const shot = (page: import("@playwright/test").Page, name: string, project: string) => page.screenshot({ path: join(OUT_DIR, `${name}-${project}.png`), fullPage: true });

test.describe("Aufgaben/Ideen: Aussehen + Klick-Kette", () => {
  test("Aufgaben-Tab: Kennzahlen, Abschnitte, Screenshot", async ({ page }, testInfo) => {
    await page.goto("/tasks");
    await page.waitForSelector("text=Offen gesamt");
    await page.waitForTimeout(250); // Kennzahl-Hochzähl-Animation abwarten
    await shot(page, "tasks", testInfo.project.name);
  });

  test("Ideen-Tab: Kennzahlen, Abschnitte, Screenshot", async ({ page }, testInfo) => {
    await page.goto("/ideas");
    await page.waitForSelector("text=Eingang");
    await page.waitForTimeout(250);
    await shot(page, "ideas", testInfo.project.name);
  });

  test("Audits-Tab: Screenshot", async ({ page }, testInfo) => {
    await page.goto("/audits");
    await page.waitForSelector("text=Offen gesamt");
    await page.waitForTimeout(250);
    await shot(page, "audits", testInfo.project.name);
  });

  test("Großansicht öffnet, Screenshot", async ({ page }, testInfo) => {
    await page.goto("/tasks");
    await page.waitForSelector("text=Offen gesamt");
    const row = page.locator('[role="button"]').first();
    await row.click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(200);
    await shot(page, "grossansicht", testInfo.project.name);
  });

  test("Klick-Kette über 4 Ebenen (Aufgabe → Entscheidung → blockierte Aufgabe → Session) und zurück, echte Browser-Zurück-Taste", async ({ page }) => {
    // Sucht gezielt den Demo-Auftrag statt der ersten Zeile, damit der Test unabhängig von der
    // Reihenfolge der importierten Aufgaben bleibt.
    // Die Kette braucht Aufgabe↔Entscheidung↔Aufgabe-Verknüpfungen, die nur Demo-Einträge mitbringen
    // (der echte Import liefert nur Dokument-Links) → ohne sie übersprungen statt rot, wie
    // real-data/layout-regression bei fehlendem Bestand.
    const seeded = await page.request.get(`/api/entries?q=${encodeURIComponent("B2B in der Kunden-App")}&limit=1`);
    const seededBody = (await seeded.json()) as { entries: unknown[] };
    test.skip(seededBody.entries.length === 0, "Demo-Verknüpfungen fehlen im Bestand — Kette nicht prüfbar.");
    await page.goto("/tasks");
    const search = page.getByPlaceholder("Aufgaben suchen: Titel, Baustelle, Bug-Nr …");
    await search.fill("A04 Clubkontext");
    await page.waitForTimeout(150);
    const row = page.locator('[role="button"]', { hasText: "A04 Clubkontext" }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.click();
    await page.waitForSelector('[role="dialog"]');
    await expect(page).toHaveURL(/\?e=\d+$/);

    // Ebene 2: Verknüpfung zur Entscheidung (Frage) öffnen.
    const decisionLink = page.locator('button:has-text("B2B in der Kunden-App")').first();
    await expect(decisionLink).toBeVisible({ timeout: 5000 });
    await decisionLink.click();
    await expect(page).toHaveURL(/\?e=\d+,\d+$/);

    // Ebene 3: von der Entscheidung zur blockierten Aufgabe.
    const blockedLink = page.locator('button:has-text("Schichtmodus S01")').first();
    await expect(blockedLink).toBeVisible({ timeout: 5000 });
    await blockedLink.click();
    await expect(page).toHaveURL(/\?e=\d+,\d+,\d+$/);

    // Ebene 4: von der blockierten Aufgabe zur Session (echte URL, verlässt den Aufgaben-Stapel).
    const sessionLink = page.locator('a[href^="/sessions/"]').first();
    await expect(sessionLink).toBeVisible({ timeout: 5000 });
    const href = (await sessionLink.getAttribute("href")) ?? "";
    expect(href).not.toBe("");
    await sessionLink.click();
    await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Browser-Zurück-Taste läuft die ganze Kette rückwärts.
    await page.goBack();
    await expect(page).toHaveURL(/\?e=\d+,\d+,\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(/\?e=\d+,\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(/\?e=\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("Der Fortschrittsbalken zieht < 2 s nach, wenn eine ANDERE Quelle (curl statt Klick) eine Teilaufgabe erledigt", async ({ page, baseURL }, testInfo) => {
    // Eindeutiger Titel je Projekt/Lauf (Chromium 1440 UND 1024 laufen gegen denselben lokalen Server
    // — ein fester Titel würde beim zweiten Projekt die Zeile des ersten treffen).
    const title = `Live-Update-Beweis ${testInfo.project.name} ${Date.now()}`;
    // Neuer Bug + 2 Teilaufgaben, ausschließlich per HTTP (steht für einen MCP-Aufruf aus einer
    // echten Session, s. apps/bridge/src/mcp.ts + apps/bridge/test/mcp.test.ts). /api/entries/* braucht
    // entweder eine Passkey-Sitzung oder ein Maschinen-Token (wie /ingest/*, s. terminal/auth.ts
    // `verifyMachineToken`) — "dev-token" ist der feste Token des lokalen Servers (apps/server/src/dev.ts),
    // genau wie in terminal.spec.ts.
    const created = await page.request.post(`${baseURL}/api/entries`, {
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      data: { kind: "bug", title, subtasks: ["Schritt 1", "Schritt 2"] },
    });
    const { entry } = (await created.json()) as { entry: { id: number } };

    await page.goto("/tasks");
    const search = page.getByPlaceholder("Aufgaben suchen: Titel, Baustelle, Bug-Nr …");
    await search.fill(title);
    const row = page.locator('[role="button"]', { hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    // Vor der ersten Teilaufgabe: Stufe "geplant", die Zeile zeigt noch keinen Fortschrittsbalken.
    await expect(row.locator('[role="progressbar"]')).toHaveCount(0);

    // Ohne Klick in der Web-App: eine andere Quelle (hier curl-äquivalent per Playwright-Request)
    // erledigt die erste Teilaufgabe — genau das, was eine Session per MCP tut.
    const start = Date.now();
    await page.request.post(`${baseURL}/api/entries/${entry.id}/subtasks/complete`, {
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      data: { subtaskTitle: "Schritt 1" },
    });

    await expect(row.getByText("50%")).toBeVisible({ timeout: 2000 });
    const tookMs = Date.now() - start;
    expect(tookMs).toBeLessThan(2000);

    // Aufräumen: der Server löscht über diesen Endpunkt NUR Einträge mit dem festen Test-Präfix
    // "Live-Update-Beweis " (s. apps/server/src/routes/entries.ts) — kein allgemeiner Lösch-Weg.
    await page.request.delete(`${baseURL}/api/entries/${entry.id}`, {
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    });
  });

  test("Suche über Aufgaben < 300 ms", async ({ page }) => {
    await page.goto("/tasks");
    await page.waitForSelector("text=Offen gesamt");
    const search = page.getByPlaceholder("Aufgaben suchen: Titel, Baustelle, Bug-Nr …");
    // Zeit der Anfrage selbst, gemessen IN der Seite (`fetch`) — `page.request.get` misst zusätzlich
    // die Playwright-Protokoll-Zeit Node↔Browser (in der Praxis 150–300 ms je nach Rechner) und damit
    // nicht die reale Antwortzeit.
    const tookMs = await page.evaluate(async () => {
      const start = performance.now();
      const res = await fetch("/api/entries?q=Clubkontext");
      await res.json();
      return performance.now() - start;
    });
    expect(tookMs).toBeLessThan(300);
    await search.fill("Clubkontext");
  });
});
