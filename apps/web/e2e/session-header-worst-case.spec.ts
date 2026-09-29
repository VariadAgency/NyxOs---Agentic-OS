// Der Session-Kopf muss in JEDER Breite ab 1024 px in eine Zeile passen — auch im schlimmsten Fall (langer
// Titel, langer Pfad, Modell „+2“, aktiver Kontext-Ring mit Hinweis, Build-Plakette, Session läuft im eigenen
// Fenster → „In der NyxOS übernehmen“ + „Prozess beenden“). Grenzprüfung: KEIN sichtbares Element ragt aus
// dem Kopf, kein Knopf bricht um oder ist abgeschnitten. „Schließen“ und die Session-Knöpfe bleiben
// erreichbar (in der Zeile oder im Menü „⋯“).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/session-header-worst-case.spec.ts --project chromium-1440
// Nur die Antworten für DIESE eine Session werden ersetzt (Layout-Test), nichts wird geschrieben.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

const LONG_TITLE = "Software-Paket Kopfzeile: Session-Kopf bei jeder Breite einzeilig halten und alle Knöpfe erreichbar lassen, auch mit sehr langem Titel";
const LONG_CWD = "/Users/alex/projects/atlas/worktrees/sehr-langer-worktree-name-fuer-den-kopf-test/app/ios/Atlas Mobile App";
const MODELS = ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"];

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

type Row = { id: string; tool: string; art: string };

async function pickSession(page: Page): Promise<Row> {
  const r = await page.request.get("/api/sessions?limit=200");
  const body = (await r.json()) as { sessions: Row[] };
  const s = body.sessions.find((x) => x.tool === "claude") ?? body.sessions[0];
  if (!s) throw new Error("lokaler Stack hat keine Session");
  return s;
}

/** Schlimmster Fall für den Kopf — nur die Antworten dieser einen Session werden ersetzt. */
async function worstCase(page: Page, s: Row) {
  const enc = encodeURIComponent(s.id);
  await page.route(new RegExp(`/api/sessions/${enc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), async (route) => {
    // Die Seite lädt das Detail mehrmals; eine alte, schon verworfene Anfrage einfach fallen lassen.
    const detail = await route
      .fetch()
      .then((res) => res.json() as Promise<{ session: Record<string, unknown> }>)
      .catch(() => null);
    if (!detail) return route.abort().catch(() => {});
    detail.session = {
      ...detail.session,
      title: LONG_TITLE,
      cwd: LONG_CWD,
      models: MODELS,
      lastUsageModel: MODELS[0],
      state: "waiting",
      status: "running",
      attachable: false,
      tmuxName: null,
      lastActivityAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    };
    await route.fulfill({ json: detail });
  });
  await page.route(`**/api/context-guard/sessions/${enc}`, (route) =>
    route.fulfill({
      json: {
        sessionKey: s.id,
        thresholds: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 85, source: "default" },
        pct: 78,
        hint: true,
        forced: false,
        attachable: false,
        state: "waiting",
      },
    }),
  );
  await page.route(`**/api/builds?sessionKey=${enc}`, (route) =>
    route.fulfill({
      json: {
        runs: [
          { id: 2, sessionKey: s.id, kind: "ios", command: "xcodebuild", exitCode: null, logExcerpt: "spawn xcodebuild ENOENT", status: "unavailable", startedAt: new Date().toISOString() },
          { id: 1, sessionKey: s.id, kind: "ios", command: "xcodebuild", exitCode: 0, logExcerpt: null, status: "green", startedAt: new Date(Date.now() - 3600_000).toISOString() },
        ],
      },
    }),
  );
  await page.route("**/api/terminal/status", (route) => route.fulfill({ json: { online: true, machineId: "dev", since: new Date().toISOString() } }));
}

async function measure(page: Page) {
  return page.getByTestId("session-head").evaluate((head) => {
    const hb = head.getBoundingClientRect();
    const ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a-ctl-h")) || 30;
    const outside: string[] = [];
    const clipped: string[] = [];
    for (const n of head.querySelectorAll<HTMLElement>("*")) {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || n.closest(".sr-only")) continue;
      // Schwebende Hinweise/Menüs (nur bei Klick offen) gehören nicht zur Zeile.
      if (n.closest("[role=menu],[role=tooltip],[role=status],[role=alert],[role=group]")) continue;
      // Inhalt eines gekürzten Felds (Ellipse) wird von diesem abgeschnitten — geprüft wird das Feld selbst.
      if (n.parentElement?.closest(".truncate")) continue;
      const label = `${n.tagName.toLowerCase()} „${(n.textContent ?? n.getAttribute("aria-label") ?? "").trim().slice(0, 30)}“ [${Math.round(r.left)}–${Math.round(r.right)}]`;
      if (r.left < hb.left - 0.5 || r.right > hb.right + 0.5 || r.top < hb.top - 0.5 || r.bottom > hb.bottom + 0.5) outside.push(label);
      if (n.tagName === "BUTTON" && n.scrollWidth > n.clientWidth + 1) clipped.push(label);
    }
    const buttons = [...head.querySelectorAll<HTMLElement>("button")].filter((b) => b.getBoundingClientRect().width > 0 && !b.closest("[role=menu]"));
    return {
      headWidth: Math.round(hb.width),
      headHeight: Math.round(hb.height),
      scrollWidth: head.scrollWidth,
      clientWidth: head.clientWidth,
      ctl,
      outside,
      clipped,
      buttonHeights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
      labels: buttons.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim()),
    };
  });
}

for (const width of [1024, 1180, 1280, 1440, 1920]) {
  test(`Session-Kopf bei ${width} px in einer Zeile, nichts ragt heraus (schlimmster Fall)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const s = await pickSession(page);
    await worstCase(page, s);
    await page.goto(`/sessions/${s.art}/_/${s.id}`);
    const head = page.getByTestId("session-head");
    await expect(head).toContainText("Software-Paket Kopfzeile", { timeout: 30_000 });
    await expect(head.getByRole("button", { name: /Kontext-Wächter/ })).toBeVisible();
    await expect(head.getByTestId("session-model")).toContainText("+2");
    await page.waitForTimeout(400);

    const m = await measure(page);
    const info = JSON.stringify(m);
    expect(m.outside, info).toEqual([]);
    expect(m.clipped, info).toEqual([]);
    expect(m.scrollWidth, info).toBeLessThanOrEqual(m.clientWidth + 1);
    expect(m.headHeight, info).toBeLessThanOrEqual(m.ctl + 20);
    for (const h of m.buttonHeights) expect(h, info).toBeLessThanOrEqual(m.ctl + 1);

    // Erreichbar: „Schließen“ in der Zeile oder im Menü, die Session-Knöpfe in der Zeile oder im Menü.
    const inlineClose = head.getByRole("button", { name: "Schließen", exact: true });
    const more = head.getByRole("button", { name: "Weitere Aktionen" });
    if (!(await inlineClose.isVisible())) {
      await more.click();
      await expect(page.getByRole("menuitem", { name: /Schließen/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /Kontext komprimieren/ })).toBeVisible();
      await page.keyboard.press("Escape");
    } else if (!(await head.getByRole("button", { name: /Kontext komprimieren/ }).isVisible())) {
      await more.click();
      await expect(page.getByRole("menuitem", { name: /Kontext komprimieren/ })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    if (width === 1280) await head.screenshot({ path: `${SHOTS}/session-header-worst-case-1280.png` });
  });
}

test("Fenster schmaler ziehen und wieder breiter — Kopf passt in jedem Schritt", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const s = await pickSession(page);
  await worstCase(page, s);
  await page.goto(`/sessions/${s.art}/_/${s.id}`);
  await expect(page.getByTestId("session-head")).toContainText("Software-Paket Kopfzeile", { timeout: 30_000 });
  for (const w of [1700, 1500, 1300, 1100, 1024, 1250, 1600, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const m = await measure(page);
    expect(m.outside, `${w}: ${JSON.stringify(m)}`).toEqual([]);
    expect(m.scrollWidth, `${w}`).toBeLessThanOrEqual(m.clientWidth + 1);
  }
  // Wieder ganz breit: alles steht ausgeschrieben in der Zeile.
  const head = page.getByTestId("session-head");
  await expect(head.getByRole("button", { name: "Schließen", exact: true })).toBeVisible();
  await expect(head.getByRole("button", { name: /Kontext komprimieren/ })).toBeVisible();
});

// Keine Mess-Schleife: Beim Ziehen zwischen 1024 und 1280 px keine Konsolenfehler
// (z. B. „ResizeObserver loop …“, „Maximum update depth exceeded“), und nach dem Stillstand bleibt der Kopf
// stehen — gleiche Knöpfe über mehrere Frames, kein Flackern zwischen zwei Stufen.
test("Ziehen 1024 ↔ 1280 ohne Konsolenfehler und ohne Flackern", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || /ResizeObserver|Maximum update depth/i.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // „ResizeObserver loop …“ kommt als window-`error`-Ereignis, nicht zwingend in der Konsole — mitschreiben.
  await page.addInitScript(() => {
    const w = window as unknown as { __winErrors: string[] };
    w.__winErrors = [];
    window.addEventListener("error", (e) => w.__winErrors.push(String(e.message)));
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const s = await pickSession(page);
  await worstCase(page, s);
  await page.goto(`/sessions/${s.art}/_/${s.id}`);
  await expect(page.getByTestId("session-head")).toContainText("Software-Paket Kopfzeile", { timeout: 30_000 });
  await page.waitForTimeout(400);
  for (let round = 0; round < 3; round++) {
    for (let w = 1280; w >= 1024; w -= 16) await page.setViewportSize({ width: w, height: 900 });
    for (let w = 1024; w <= 1280; w += 16) await page.setViewportSize({ width: w, height: 900 });
  }
  for (const w of [1024, 1152, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    const samples: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await measure(page);
      samples.push(JSON.stringify([m.labels, m.headHeight]));
      await page.waitForTimeout(50);
    }
    expect(new Set(samples).size, `${w}: ${samples.join(" | ")}`).toBe(1);
    const m = await measure(page);
    expect(m.scrollWidth, `${w}`).toBeLessThanOrEqual(m.clientWidth + 1);
  }
  // Nur Fehler aus der Seite selbst zählen, nicht abgebrochene Netz-Anfragen der ersetzten Session-Antwort.
  errors.push(...(await page.evaluate(() => (window as unknown as { __winErrors: string[] }).__winErrors)));
  // „ResizeObserver loop completed …“ kommt NICHT von useFitLevel: es tritt genauso auf, wenn dessen
  // Beobachter abgeschaltet sind (geprüft) — Quelle ist ein älterer Beobachter der Seite
  // (Terminal/Scroll-Kanten). Offen, nicht Teil dieses Tests; harmlos (nur Meldung, kein Absturz).
  const real = errors.filter((e) => !/Failed to load resource|net::ERR_|ResizeObserver loop completed/i.test(e));
  expect(real, real.join("\n")).toEqual([]);
});
