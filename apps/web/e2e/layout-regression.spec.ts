// Layout-Regressionen im echten Browser. Vollbild-Infospalte: war bei jedem Breakpoint gequetscht bzw. riss
// den ganzen Screen auf ~2145 px Breite auf, weil ein langer, unumbrochener Dateipfad ein Grid-Kind ohne
// `min-w-0`/`minmax(0, …)` aufreißen konnte. Läuft — wie `real-data.spec.ts` — gegen den lokalen Stack mit
// echten Daten und wird übersprungen (nicht rot), wenn der Bestand keine Session mit einem Dateipfad
// > 140 Zeichen enthält.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/layout-regression.spec.ts --project chromium-1440
import { expect, test } from "@playwright/test";

const LONG_PATH_MIN_LENGTH = 140;

interface SessionRow {
  id: string;
  sessionId: string;
  art: string;
  baustelle: { slug: string } | null;
}

interface SessionFile {
  path: string;
  mode: "read" | "write";
}

interface SessionDetail {
  files: SessionFile[];
}

async function fetchSessions(page: import("@playwright/test").Page, baseURL: string | undefined): Promise<SessionRow[]> {
  const res = await page.request.get(`${baseURL ?? ""}/api/sessions?limit=2000`);
  const body = (await res.json()) as { sessions: SessionRow[] };
  return body.sessions;
}

/** Sucht die erste Session mit mindestens einer geschriebenen Datei, deren Pfad `LONG_PATH_MIN_LENGTH`
 * Zeichen überschreitet — genau der Fall, der das Layout früher sprengte (z. B. ein Scratchpad-Pfad unter
 * `/private/tmp/claude-501/…`). `null`, wenn der Bestand (noch) keinen solchen Pfad enthält. */
async function findSessionWithLongPath(
  page: import("@playwright/test").Page,
  baseURL: string | undefined,
): Promise<{ session: SessionRow; longestPath: string } | null> {
  const sessions = await fetchSessions(page, baseURL);
  for (const s of sessions) {
    const res = await page.request.get(`${baseURL ?? ""}/api/sessions/${encodeURIComponent(s.id)}`);
    if (!res.ok()) continue;
    const detail = (await res.json()) as SessionDetail;
    const longest = [...detail.files].sort((a, b) => b.path.length - a.path.length)[0];
    if (longest && longest.path.length > LONG_PATH_MIN_LENGTH) return { session: s, longestPath: longest.path };
  }
  return null;
}

function sessionUrl(session: SessionRow): string {
  return `/sessions/${session.art}/${session.baustelle?.slug ?? "_"}/${session.id}`;
}

async function noHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test.describe("Vollbild-Layout: Info-Spalte lesbar, kein horizontales Scrollen", () => {
  test("1440 px: Info-Spalte ≥ 300 px breit, kein horizontales Scrollen, langer Pfad lesbar gekürzt", async ({ page, baseURL }, testInfo) => {
    const found = await findSessionWithLongPath(page, baseURL);
    test.skip(!found, `Kein Bestand mit Dateipfad > ${LONG_PATH_MIN_LENGTH} Zeichen im lokalen Stack — pnpm dev zuerst laufen lassen.`);
    if (!found) return;
    const { session } = found;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(sessionUrl(session));
    await page.waitForSelector('[data-testid="session-info"]');
    // "Änderungen" zeigt die Dateiliste unabhängig davon, ob der Chat schon geladen ist.
    await page.getByRole("tab", { name: "Änderungen", exact: true }).click();
    await page.waitForTimeout(150);

    expect(await noHorizontalScroll(page)).toBe(true);

    const infoBox = await page.locator('[data-testid="session-info"]').boundingBox();
    expect(infoBox).not.toBeNull();
    expect(infoBox?.width ?? 0).toBeGreaterThanOrEqual(300);

    // Kein Wert reißt auf die volle, unumbrochene Pfadlänge auf (früher: "Toke…"/"/Use…").
    const mainBox = await page.locator('[data-testid="session-main"]').boundingBox();
    expect(mainBox).not.toBeNull();
    const stackWidth = (infoBox?.width ?? 0) + (mainBox?.width ?? 0);
    expect(stackWidth).toBeLessThan(1440); // nicht die früheren ~2145 px

    await page.screenshot({ path: testInfo.outputPath(`fullscreen-longpath-1440-${testInfo.project.name}.png`), fullPage: true });
  });

  test("1024 px: Info-Bereich steht UNTER dem Hauptbereich (gestapelt), kein horizontales Scrollen", async ({ page, baseURL }, testInfo) => {
    const found = await findSessionWithLongPath(page, baseURL);
    test.skip(!found, `Kein Bestand mit Dateipfad > ${LONG_PATH_MIN_LENGTH} Zeichen im lokalen Stack — pnpm dev zuerst laufen lassen.`);
    if (!found) return;
    const { session } = found;

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(sessionUrl(session));
    await page.waitForSelector('[data-testid="session-info"]');
    await page.getByRole("tab", { name: "Änderungen", exact: true }).click();
    await page.waitForTimeout(150);

    expect(await noHorizontalScroll(page)).toBe(true);

    const mainBox = await page.locator('[data-testid="session-main"]').boundingBox();
    const infoBox = await page.locator('[data-testid="session-info"]').boundingBox();
    if (!mainBox || !infoBox) throw new Error("session-main/session-info nicht gefunden");
    // Gestapelt heißt: Info-Bereich beginnt UNTERHALB des Hauptbereichs (größeres y), nicht daneben.
    expect(infoBox.y).toBeGreaterThan(mainBox.y + mainBox.height - 1);
    // Und beide sind (annähernd) so breit wie der 1024-px-Viewport, nicht auf ~2145 px aufgerissen.
    expect(mainBox.width).toBeLessThanOrEqual(1024);
    expect(infoBox.width).toBeLessThanOrEqual(1024);

    await page.screenshot({ path: testInfo.outputPath(`fullscreen-longpath-1024-${testInfo.project.name}.png`), fullPage: true });
  });
});

// EIN gemeinsamer Seitenrahmen (`PageShell`, 1200 px,
// `grid-cols-[minmax(0,1fr)]`, `content-start`) für ALLE Tabs. Früher liefen Git/Nutzung bei
// 1024 px rechts aus dem Bild und mehrere Karten dehnten sich über ihren Inhalt hinaus; der Test prüft
// beides über ALLE Tabs bei 1440/1024 in einem Lauf.
const ALL_TABS: { label: string; path: string }[] = [
  { label: "Überblick", path: "/overview" },
  { label: "Sessions", path: "/sessions" },
  { label: "Aufgaben", path: "/tasks" },
  { label: "Ideen", path: "/ideas" },
  { label: "Audits", path: "/audits" },
  { label: "Agenten", path: "/agents" },
  { label: "Konflikte", path: "/conflicts" },
  { label: "Git", path: "/git" },
  { label: "Server", path: "/server" },
  { label: "Nutzung", path: "/usage" },
  { label: "Einstellungen", path: "/settings" },
];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
];
/** Toleranz gegen Sub-Pixel-Rundung/Rahmen (border/box-shadow) — keine echte Dehnung. */
const STRETCH_TOLERANCE_PX = 4;

interface StretchResult {
  index: number;
  diff: number;
  stretched: boolean;
}

/** Prüft jede `[data-slot="card"]` (`components/ui/Card.tsx`): die Karte darf nicht höher sein als
 * "letztes Kind-Ende + Padding-unten" — genau das frühere Symptom ("Titel mitten in der Karte",
 * Freiraum zwischen die Zeilen verteilt). Karten ohne Kinder (leer/gerade ladend) werden übersprungen. */
async function findStretchedCards(page: import("@playwright/test").Page): Promise<StretchResult[]> {
  return page.evaluate((tolerance) => {
    const cards = Array.from(document.querySelectorAll('[data-slot="card"]'));
    const out: { index: number; diff: number; stretched: boolean }[] = [];
    cards.forEach((card, index) => {
      const children = Array.from(card.children) as HTMLElement[];
      if (children.length === 0) return;
      const style = getComputedStyle(card);
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const cardRect = card.getBoundingClientRect();
      if (cardRect.height === 0) return; // unsichtbar (z. B. per CSS ausgeblendet)
      const last = children[children.length - 1] as HTMLElement;
      const lastRect = last.getBoundingClientRect();
      const expectedHeight = lastRect.bottom - cardRect.top + paddingBottom;
      const diff = cardRect.height - expectedHeight;
      // Tiles with `data-equal-row` (server "at a glance") are deliberately as tall as the tallest tile of their grid
      // row. Only space at the BOTTOM is allowed then: the content starts at the top and the card is not taller than
      // its tallest neighbour needs.
      if (card.hasAttribute("data-equal-row")) {
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const firstTop = Math.min(...children.map((c) => c.getBoundingClientRect().top));
        const topGap = firstTop - cardRect.top - paddingTop;
        const row = Array.from(document.querySelectorAll("[data-equal-row]")).filter((o) => Math.abs(o.getBoundingClientRect().top - cardRect.top) < 1);
        const need = Math.max(
          ...row.map((o) => {
            const r = o.getBoundingClientRect();
            const kids = Array.from(o.children).map((c) => c.getBoundingClientRect().bottom);
            return Math.max(...kids) - r.top + (parseFloat(getComputedStyle(o).paddingBottom) || 0);
          }),
        );
        const over = Math.max(topGap, cardRect.height - need);
        out.push({ index, diff: over, stretched: over > tolerance });
        return;
      }
      out.push({ index, diff, stretched: diff > tolerance });
    });
    return out;
  }, STRETCH_TOLERANCE_PX);
}

// Die ART-Zeile im Sessions-Tab schnitt "Server & De…" am Suchfeld ab, ohne
// zu zeigen, dass die Zeile scrollt. Fix (TabRows.tsx): Suchfeld/Regeln/Werkzeug-Umschalter in eine
// eigene rechtsbündige Zeile darüber, die ART-Zeile bekommt die volle Breite + Fade-Maske für den
// schmalen Fall. Bei 1440 px darf die Zeile gar nicht mehr scrollen müssen — genau das prüft dieser Test.
test.describe("Sessions-Tab: ART-Zeile bei 1440 px vollständig sichtbar", () => {
  test("alle Art-Tab-Beschriftungen sind vollständig sichtbar, nicht am Suchfeld abgeschnitten", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/sessions");
    const scroll = page.getByTestId("art-tabs-scroll");
    await expect(scroll).toBeVisible();

    const tablist = page.getByRole("tablist", { name: "Art der Arbeit" });
    const tabs = tablist.getByRole("tab");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);

    // "Vollständig sichtbar, nicht abgeschnitten" heißt bei 1440 px: die Zeile braucht gar kein
    // horizontales Scrollen (scrollWidth passt in clientWidth) — jede Beschriftung ist von Anfang an da.
    const { scrollWidth, clientWidth } = await scroll.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(scrollWidth, `Art-Tabs-Zeile braucht ${scrollWidth - clientWidth}px mehr Platz als sichtbar bei 1440px`).toBeLessThanOrEqual(clientWidth + 1);

    for (let i = 0; i < count; i++) {
      await expect(tabs.nth(i)).toBeInViewport();
    }

    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe("PageShell auf allen Tabs — kein Überlauf, keine gedehnte Karte (1440/1024)", () => {
  for (const viewport of VIEWPORTS) {
    for (const tab of ALL_TABS) {
      test(`${tab.label} @ ${viewport.width}px`, async ({ page }, testInfo) => {
        test.skip(!testInfo.project.name.startsWith("chromium"), "Layout-Maße nur in Chromium messen (WebKit: Sichtprüfung in den Screenshot-Specs)");
        await page.setViewportSize(viewport);
        await page.goto(tab.path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(200); // Stagger-/Zähl-Animationen kurz auslaufen lassen

        expect(await noHorizontalScroll(page), `${tab.label} @ ${viewport.width}px: horizontales Scrollen`).toBe(true);

        const stretched = (await findStretchedCards(page)).filter((r) => r.stretched);
        expect(stretched, `${tab.label} @ ${viewport.width}px: gedehnte Karte(n) (Index/px): ${stretched.map((r) => `${r.index}:+${r.diff.toFixed(0)}px`).join(", ")}`).toEqual([]);
      });
    }
  }
});
