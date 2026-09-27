// Der Brotkrümel bekam bei 1280/1440 neben der Haiku-Leiste früher nur 160–245 px (jede Ebene auf wenige
// Buchstaben gekürzt). Soll: EINE Kopfzeile, gleich hoch, nichts überlappt, der Session-Titel bleibt lesbar
// (≥ 200 px oder ganz sichtbar); Art und Baustelle bleiben per Klick erreichbar.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/topbar-session-title.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const LONG_TITLE = "Software review audio and everything else: Brotkrümel und Kopf bei 1440 ohne harte Kanten";

type Box = { x: number; y: number; width: number; height: number };
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error("Element ohne Box");
  return b;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

type Row = { id: string; tool: string; art: string };

async function openLongSession(page: Page): Promise<Row> {
  const r = await page.request.get("/api/sessions?limit=200");
  const body = (await r.json()) as { sessions: Row[] };
  const s = body.sessions.find((x) => x.tool === "claude" && x.art && x.art !== "_") ?? body.sessions[0];
  if (!s) throw new Error("lokaler Stack hat keine Session");
  const enc = encodeURIComponent(s.id);
  await page.route(new RegExp(`/api/sessions/${enc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), async (route) => {
    const detail = await route
      .fetch()
      .then((res) => res.json() as Promise<{ session: Record<string, unknown> }>)
      .catch(() => null);
    if (!detail) return route.abort().catch(() => {});
    detail.session = { ...detail.session, title: LONG_TITLE, baustelle: { slug: "nyxos", label: "NyxOS" } };
    await route.fulfill({ json: detail });
  });
  await page.goto(`/sessions/${s.art}/nyxos/${s.id}`);
  await expect(page.getByTestId("session-head")).toContainText("Software review", { timeout: 30_000 });
  await expect(page.getByTestId("topbar").getByRole("button", { name: /^Haiku öffnen/ })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
  return s;
}

for (const width of [1024, 1280, 1440, 1920]) {
  test(`Kopfzeile bei ${width} px: Session-Titel lesbar, nichts überlappt, eine Zeile`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const s = await openLongSession(page);
    const bar = page.getByTestId("topbar");
    const nav = bar.getByRole("navigation", { name: "Brotkrümel" });
    const haiku = bar.getByRole("button", { name: /^Haiku öffnen/ });

    // Titel: ≥ 200 px sichtbar (oder ganz), voller Titel im Tooltip.
    const title = nav.getByTestId("crumb-title");
    await expect(title).toHaveAttribute("title", LONG_TITLE);
    const t = await title.evaluate((el) => ({ w: el.getBoundingClientRect().width, full: el.scrollWidth <= el.clientWidth + 1 }));
    expect(t.full || t.w >= 200, `Titel nur ${Math.round(t.w)} px breit`).toBe(true);
    const navClipped = await nav.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
    expect(navClipped, "Brotkrümel hart abgeschnitten").toBe(false);
    // Entweder „…“ oder die ausgeschriebenen Ebenen — und die sind dann ungekürzt („Sessio…“ bei 1920 war ein Fehler).
    const levels = await nav.evaluate((n) => {
      const shown = [...n.querySelectorAll<HTMLElement>("[data-crumb-level]")].filter((el) => el.offsetParent !== null);
      const more = n.querySelector<HTMLElement>("[data-crumb-more]");
      return { shown: shown.length, cut: shown.filter((el) => (el.querySelector("a")?.scrollWidth ?? 0) > (el.querySelector("a")?.clientWidth ?? 0)).map((el) => el.textContent), more: more ? more.offsetParent !== null : false };
    });
    expect(levels.more !== levels.shown > 0, JSON.stringify(levels)).toBe(true);
    expect(levels.cut, "Ebenen gekürzt").toEqual([]);

    // Nichts überlappt, alles in der Kopfzeile, EINE Zeile, gleiche Höhe.
    const actions = bar.getByTestId("topbar-actions").locator(":scope > *");
    const n = await actions.count();
    expect(n).toBeGreaterThanOrEqual(4);
    const list: [string, Box][] = [
      ["Brotkrümel", await box(nav)],
      ["Haiku", await box(haiku)],
    ];
    for (let i = 0; i < n; i++) list.push([`Seiten-Knopf ${i + 1}`, await box(actions.nth(i))]);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [an, a] = list[i] as [string, Box];
        const [bn, b] = list[j] as [string, Box];
        expect(overlaps(a, b), `${an} überlappt ${bn}`).toBe(false);
      }
    }
    const barBox = await box(bar);
    for (const [name, b] of list) {
      expect(b.x + b.width, `${name} ragt rechts heraus`).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
      expect(b.x, `${name} ragt links heraus`).toBeGreaterThanOrEqual(barBox.x - 0.5);
    }
    expect(barBox.height, "Kopfzeile ist zweizeilig").toBeLessThan(56);
    const heights = list.filter(([name]) => name !== "Brotkrümel").map(([, b]) => Math.round(b.height * 10) / 10);
    expect(new Set(heights).size, `Höhen: ${heights.join(", ")}`).toBe(1);

    // Haiku zeigt seinen Zustand weiter in Worten (auch in der schmalen Form).
    const haikuText = (await haiku.innerText()).replace(/\s+/g, " ").trim();
    expect(haikuText.length, `Haiku-Text: „${haikuText}“`).toBeGreaterThan(2);

    await bar.screenshot({ path: `${SHOTS}/topbar-session-title-${width}.png` });

    // Art und Baustelle bleiben erreichbar: direkt als Link oder über „…“ (Menü).
    const more = nav.getByRole("button", { name: "Weitere Ebenen" });
    if (await more.isVisible()) {
      await more.click();
      const menu = page.getByRole("menu", { name: "Weitere Ebenen" });
      await expect(menu.getByRole("menuitem", { name: "NyxOS" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Sessions" })).toBeVisible();
      const b = await box(bar);
      await page.screenshot({ path: `${SHOTS}/topbar-session-title-${width}-menu.png`, clip: { x: b.x, y: b.y, width: b.width, height: b.height + 130 } });
      await menu.getByRole("menuitem", { name: "NyxOS" }).click();
    } else {
      await nav.getByRole("link", { name: "NyxOS" }).click();
    }
    await expect(page).toHaveURL(new RegExp(`/sessions/${s.art}/nyxos/?$`));
  });
}

// „Nach unten“ hat eine eigene Zeile unter dem Verlauf. Wenn sie erscheint/verschwindet, wird
// der Verlauf ~40 px niedriger/höher — der sichtbare Text darf dabei nicht springen und die Zeile nicht flackern.
test("„Nach unten“ in eigener Zeile: Verlauf springt nicht, Zeile flackert nicht", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongSession(page);
  const scroller = page.getByTestId("chat-scroll");
  await expect(scroller.locator("[data-index]").first()).toBeVisible({ timeout: 20_000 });
  // Ganz nach unten (der Virtualisierer misst Zeilen nach und verlängert den Verlauf – daher wiederholen).
  await expect(async () => {
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.getByTestId("chat-to-bottom")).toHaveCount(0, { timeout: 700 });
  }).toPass({ timeout: 15_000 });
  // Umschaltungen der Zeile mitzählen.
  await page.evaluate(() => {
    const w = window as unknown as { __toggles: number };
    w.__toggles = 0;
    const count = (n: Node) => {
      if (n instanceof HTMLElement && n.dataset.testid === "chat-to-bottom-bar") w.__toggles++;
    };
    new MutationObserver((ms) => ms.forEach((m) => [...m.addedNodes, ...m.removedNodes].forEach(count))).observe(document.body, { childList: true, subtree: true });
  });
  // Die Zeilen oberhalb einmal ausmessen lassen (der Virtualisierer korrigiert geschätzte Höhen — das ist
  // nicht Thema dieses Tests), dann wieder ganz nach unten.
  await scroller.evaluate((el) => el.scrollBy({ top: -300 }));
  await page.waitForTimeout(500);
  await expect(async () => {
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.getByTestId("chat-to-bottom")).toHaveCount(0, { timeout: 700 });
  }).toPass({ timeout: 15_000 });
  await page.waitForTimeout(300);
  // Jetzt hoch und im SELBEN Takt (vor dem Erscheinen der Zeile) die Lage einer sichtbaren Zeile merken;
  // nach dem Erscheinen muss genau diese Zeile an derselben Stelle stehen.
  const before = await scroller.evaluate((el) => {
    el.scrollBy({ top: -300 });
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-index]")].find((r) => r.getBoundingClientRect().bottom > top + 40);
    return row ? { idx: row.dataset.index ?? "", y: Math.round(row.getBoundingClientRect().top), bar: document.querySelector("[data-testid=chat-to-bottom-bar]") !== null } : null;
  });
  expect(before?.bar, "Zeile war schon vor dem Messen da").toBe(false);
  await expect(page.getByTestId("chat-to-bottom")).toBeVisible();
  await page.waitForTimeout(400);
  const after = await scroller.evaluate((el, idx) => {
    const row = el.querySelector<HTMLElement>(`[data-index="${idx}"]`);
    return row ? Math.round(row.getBoundingClientRect().top) : null;
  }, before?.idx ?? "");
  expect(after, JSON.stringify({ before, after })).toBe(before?.y);
  // Um die Grenze (≈ 80 px über dem Ende) hin und her: keine Dauer-Umschaltung.
  for (const dy of [200, 30, 30, -30, 30, -30]) {
    await scroller.evaluate((el, d) => el.scrollBy({ top: d }), dy);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const toggles = await page.evaluate(() => (window as unknown as { __toggles: number }).__toggles);
  expect(toggles, "Umschaltungen der „Nach unten“-Zeile").toBeLessThanOrEqual(4);
});
