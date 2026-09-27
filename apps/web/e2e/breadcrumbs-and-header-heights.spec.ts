// UI-Details: Brotkrümel, Session-Kopf, gleiche Höhe in Kopfzeilen mit Suche, „Nach unten“ verdeckt nichts,
// Git-Überschriften, keine „ResizeObserver loop …“-Meldung. Nur lesend (einzelne Antworten werden im
// Browser ersetzt).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/breadcrumbs-and-header-heights.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const LONG_TITLE = "Software review audio and everything else: Brotkrümel und Kopf bei 1440 ohne harte Kanten";
const CWD = "/Users/alex/projects/atlas/tools/NyxOS";

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
  // „ResizeObserver loop …“ kommt als window-`error`-Ereignis, nicht zwingend in der Konsole — mitschreiben.
  await context.addInitScript(() => {
    const w = window as unknown as { __winErrors: string[] };
    w.__winErrors = [];
    window.addEventListener("error", (e) => w.__winErrors.push(String(e.message)));
  });
});

type Row = { id: string; tool: string; art: string; messageCount?: number };

/** Eine Claude-Session mit möglichst langem Verlauf (für „Nach unten“). */
async function pickSession(page: Page): Promise<Row> {
  const r = await page.request.get("/api/sessions?limit=200");
  const body = (await r.json()) as { sessions: Row[] };
  const claude = body.sessions.filter((x) => x.tool === "claude");
  const s = claude.sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))[0] ?? body.sessions[0];
  if (!s) throw new Error("lokaler Stack hat keine Session");
  return s;
}

/** Schwieriger Kopf: langer Titel, Baustelle „nyxos“, Modell claude-opus-5-5, Pfad …/NyxOS, Build „nicht eingerichtet“. */
async function worstCaseHead(page: Page, s: Row) {
  const enc = encodeURIComponent(s.id);
  await page.route(new RegExp(`/api/sessions/${enc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), async (route) => {
    const detail = await route
      .fetch()
      .then((res) => res.json() as Promise<{ session: Record<string, unknown> }>)
      .catch(() => null);
    if (!detail) return route.abort().catch(() => {});
    detail.session = { ...detail.session, title: LONG_TITLE, cwd: CWD, models: ["claude-opus-5-5"], lastUsageModel: "claude-opus-5-5", baustelle: { slug: "nyxos", label: "NyxOS" }, state: "waiting", status: "running", attachable: false, tmuxName: null, contextPct: 20, contextWindow: 1_000_000 };
    await route.fulfill({ json: detail });
  });
  await page.route(`**/api/builds?sessionKey=${enc}`, (route) =>
    route.fulfill({
      json: { runs: [{ id: 2, sessionKey: s.id, kind: "ios", command: "xcodebuild", exitCode: null, logExcerpt: "Auf dem Rechner fehlt das Werkzeug „xcodebuild“ – die Brücke findet es nicht.", status: "unavailable", startedAt: new Date().toISOString() }] },
    }),
  );
}

async function winErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __winErrors: string[] }).__winErrors);
}

for (const width of [1280, 1440]) {
  test(`Session bei ${width} — Brotkrümel, Kopf, Plakette, „Nach unten“`, async ({ page }) => {
    const consoleRo: string[] = [];
    page.on("console", (m) => {
      if (/ResizeObserver/i.test(m.text())) consoleRo.push(m.text());
    });
    await page.setViewportSize({ width, height: 900 });
    const s = await pickSession(page);
    await worstCaseHead(page, s);
    await page.goto(`/sessions/${s.art}/nyxos/${s.id}`);
    const head = page.getByTestId("session-head");
    await expect(head).toContainText("Software review", { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Name statt Kennung, der letzte Krümel kürzt mit Ellipse und hat den vollen Titel als Tooltip.
    const nav = page.getByRole("navigation", { name: "Brotkrümel" });
    // Bei 1280/1440 steht die Baustelle im „…“-Menü (der Titel braucht den Platz).
    const more = nav.getByRole("button", { name: "Weitere Ebenen" });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole("menu", { name: "Weitere Ebenen" }).getByRole("menuitem", { name: "NyxOS", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(nav.getByText("NyxOS", { exact: true })).toBeVisible();
    }
    await expect(page.getByText("nyxos", { exact: true })).toHaveCount(0);
    const crumb = await nav.evaluate((n) => {
      const last = [...n.querySelectorAll<HTMLElement>("span.truncate")].at(-1);
      return last ? { title: last.title, overflow: getComputedStyle(last).textOverflow, clipped: last.scrollWidth > last.clientWidth, navClipped: n.scrollWidth > n.clientWidth + 1 } : null;
    });
    expect(crumb?.title).toBe(LONG_TITLE);
    expect(crumb?.overflow).toBe("ellipsis");
    expect(crumb?.navClipped, JSON.stringify(crumb)).toBe(false);

    // Modell ausgeschrieben als Kurzform, Pfad mit dem Ordner vorn.
    await expect(head.getByTestId("session-model")).toHaveText("Opus 5.5");
    await expect(head.getByTestId("session-path")).toHaveText("…/NyxOS");
    const fit = await head.evaluate((h) => {
      const clippedOf = (sel: string) => {
        const el = h.querySelector<HTMLElement>(sel);
        return el ? el.scrollWidth > el.clientWidth + 1 : null;
      };
      return { model: clippedOf("[data-testid=session-model]"), path: clippedOf("[data-testid=session-path]"), head: h.scrollWidth > h.clientWidth + 1 };
    });
    expect(fit).toEqual({ model: false, path: false, head: false });

    // Build-Plakette erklärt sich (Tooltip + Klick-Detail).
    const pill = head.getByTestId("build-pill");
    await expect(pill).toHaveAttribute("title", /nicht eingerichtet.*xcodebuild/);
    await pill.click();
    await expect(page.getByRole("dialog", { name: /Build-Prüfung nicht eingerichtet/ })).toContainText("Alle Builds ansehen");
    await page.keyboard.press("Escape");

    // „Nach unten“ liegt unter dem Verlauf, nicht darüber.
    const scroller = page.getByTestId("chat-scroll");
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    const toBottom = page.getByTestId("chat-to-bottom");
    await expect(toBottom).toBeVisible({ timeout: 10_000 });
    const overlap = await page.evaluate(() => {
      const pillEl = document.querySelector("[data-testid=chat-to-bottom]")?.getBoundingClientRect();
      const sc = document.querySelector("[data-testid=chat-scroll]")?.getBoundingClientRect();
      if (!pillEl || !sc) return null;
      return { pillTop: Math.round(pillEl.top), scrollBottom: Math.round(sc.bottom) };
    });
    expect(overlap && overlap.pillTop >= overlap.scrollBottom, JSON.stringify(overlap)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/session-details-${width}.png` });
    await head.screenshot({ path: `${SHOTS}/session-details-head-${width}.png` });

    // Reiter wechseln, scrollen, Fenster ziehen — keine „ResizeObserver loop …“-Meldung.
    await toBottom.click();
    for (const tab of ["Terminal", "Änderungen", "Agenten", "Bezüge", "Chat"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click().catch(() => {});
      await page.waitForTimeout(300);
    }
    for (const w of [width - 200, width, width - 100, width]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(500);
    expect([...(await winErrors(page)), ...consoleRo].filter((m) => /ResizeObserver/i.test(m))).toEqual([]);
  });

  test(`Gleiche Höhe in Kopfzeilen mit Suche, Git-Überschriften ungekürzt (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/tasks", "/files", "/audits"]) {
      await page.goto(path);
      const search = page.locator("input[type=search]").first();
      await expect(search).toBeVisible({ timeout: 20_000 });
      const heights = await search.evaluate((input) => {
        const field = input.closest("label") ?? input;
        const row = field.parentElement;
        const chips = row ? [...row.querySelectorAll<HTMLElement>("button")].map((b) => Math.round(b.getBoundingClientRect().height)) : [];
        const ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a-ctl-h"));
        return { field: Math.round(field.getBoundingClientRect().height), chips, ctl };
      });
      expect(heights.field, `${path} ${JSON.stringify(heights)}`).toBe(heights.ctl);
      for (const h of heights.chips) expect(h, `${path} ${JSON.stringify(heights)}`).toBe(heights.ctl);
      if (path !== "/audits") await page.screenshot({ path: `${SHOTS}/header-heights-${path.slice(1)}-${width}.png` });
      expect((await winErrors(page)).filter((m) => /ResizeObserver/i.test(m)), path).toEqual([]);
    }
    for (const path of ["/ideas", "/agents", "/conflicts"]) {
      await page.goto(path);
      const search = page.locator("input[type=search], input[aria-label='Kollisionskarte durchsuchen']").first();
      await expect(search).toBeVisible({ timeout: 20_000 });
      const h = await search.evaluate((input) => Math.round((input.closest("label") ?? input).getBoundingClientRect().height));
      expect(h, path).toBe(30);
      expect((await winErrors(page)).filter((m) => /ResizeObserver/i.test(m)), path).toEqual([]);
    }
    // Auch die übrigen Tabs ohne „ResizeObserver loop …“.
    for (const path of ["/briefing", "/overview", "/gehirn", "/server", "/usage", "/settings"]) {
      await page.goto(path);
      await page.waitForTimeout(1200);
      expect((await winErrors(page)).filter((m) => /ResizeObserver/i.test(m)), path).toEqual([]);
    }

    await page.goto("/git");
    const kpis = page.getByTestId("git-kpis");
    await expect(kpis).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);
    const cut = await kpis.evaluate((k) => [...k.querySelectorAll<HTMLElement>("span.truncate")].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));
    expect(cut).toEqual([]);
    // Die Sparkline bleibt in ihrer Kachel (Linie endet vor dem Innenrand).
    const spill = await kpis.evaluate((k) =>
      [...k.querySelectorAll<HTMLElement>("[data-metric]")].flatMap((card) => {
        const svg = card.querySelector("svg");
        if (!svg) return [];
        const c = card.getBoundingClientRect();
        const r = svg.getBoundingClientRect();
        return r.right > c.right - 8 ? [`${card.dataset.metric}: ${Math.round(r.right)} > ${Math.round(c.right)}`] : [];
      }),
    );
    expect(spill).toEqual([]);
    await kpis.screenshot({ path: `${SHOTS}/header-heights-git-${width}.png` });
    expect((await winErrors(page)).filter((m) => /ResizeObserver/i.test(m))).toEqual([]);
  });
}
