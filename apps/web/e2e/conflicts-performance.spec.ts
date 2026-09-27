// Messung Konflikte-Seite: Zeit bis bedienbar, lange Aufgaben (Long Tasks) im Leerlauf und Frame-Zeiten
// beim Scrollen — einmal mit den Daten des lokalen Stacks, einmal mit 3.200 künstlichen Konflikten
// (Stresstest). Ergebnis: `.probe/shots/conflicts-performance-<Phase>-<Fall>.json`; mit `E2E_PHASE=<name>`
// lassen sich zwei Stände (z. B. vor und nach einer Änderung) nebeneinander ablegen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/conflicts-performance.spec.ts --project chromium-1440
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { manyConflicts } from "./fixtures/manyConflicts";
import { stressRoutes } from "./fixtures/stressRoutes";

const OUT = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });
const PHASE = process.env.E2E_PHASE ?? "aktuell";
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ context, baseURL }) => {
  try {
    const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
    await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
  } catch {
    // ohne Anmeldedatei des lokalen Stacks: nur lesende Aufrufe, reicht für die Messung
  }
});

interface Measurement {
  contentMs: number;
  clickMs: number;
  longTasks: number;
  longestTaskMs: number;
  blockingMs: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  framesOver50: number;
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
}

async function measure(page: Page): Promise<Measurement> {
  await page.addInitScript(() => {
    const w = window as unknown as { __lt: { start: number; d: number }[] };
    w.__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push({ start: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  const t0 = Date.now();
  await page.goto("/conflicts");
  // Ordner-Knopf `group-toggle`; ältere Stände: der erste auf-/zuklappbare Knopf der Karte.
  const newToggle = page.locator('[data-testid="group-toggle"]').first();
  const oldToggle = page.locator("main button[aria-expanded]").first();
  await Promise.race([newToggle.waitFor({ timeout: 60_000 }).catch(() => {}), oldToggle.waitFor({ timeout: 60_000 }).catch(() => {})]);
  const toggle = (await newToggle.count()) > 0 ? newToggle : oldToggle;
  await toggle.waitFor({ timeout: 1_000 });
  const contentMs = Date.now() - t0;

  // Klick-Reaktion: ein Ordner auf-/zuklappen — erst wenn das sofort antwortet, ist die Seite bedienbar.
  const before = await toggle.getAttribute("aria-expanded");
  const tc = Date.now();
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "", { timeout: 30_000 });
  const clickMs = Date.now() - tc;
  await toggle.click();

  // Leerlauf 12 s: fängt das alte 5-s-Neuladen der ganzen Karte ein.
  await page.waitForTimeout(12_000);
  const lt = await page.evaluate(() => (window as unknown as { __lt: { start: number; d: number }[] }).__lt);

  const frames = await page.evaluate(async () => {
    const main = document.querySelector("main.cc-scroll");
    if (!main) return [] as number[];
    const deltas: number[] = [];
    let last = performance.now();
    let run = true;
    const loop = (t: number) => {
      deltas.push(t - last);
      last = t;
      if (run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const wait = () => new Promise((r) => setTimeout(r, 40));
    for (let i = 0; i < 40; i++) {
      main.scrollBy(0, 300);
      await wait();
    }
    for (let i = 0; i < 40; i++) {
      main.scrollBy(0, -300);
      await wait();
    }
    run = false;
    return deltas.slice(1);
  });

  return {
    contentMs,
    clickMs,
    longTasks: lt.length,
    longestTaskMs: Math.round(Math.max(0, ...lt.map((x) => x.d))),
    blockingMs: Math.round(lt.reduce((n, x) => n + Math.max(0, x.d - 50), 0)),
    frameP50: pct(frames, 50),
    frameP95: pct(frames, 95),
    frameMax: Math.round(Math.max(0, ...frames)),
    framesOver50: frames.filter((f) => f > 50).length,
  };
}

function save(name: string, m: Measurement) {
  writeFileSync(join(OUT, `conflicts-performance-${PHASE}-${name}.json`), JSON.stringify(m, null, 2) + "\n");
  console.log(`[conflicts-performance ${PHASE} ${name}]`, JSON.stringify(m));
}

test("Messung: Daten des lokalen Stacks", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1440", "Messung nur einmal (Chromium 1440)");
  save("local", await measure(page));
});

test("Messung: 3.200 künstliche Konflikte", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1440", "Messung nur einmal (Chromium 1440)");
  await stressRoutes(page, manyConflicts(3200, 800));
  save("stress", await measure(page));
});
