// Briefing und Überblick gegen den lokalen Stack (echte Verläufe aus ~/.claude, echte DB-Zahlen):
// beide nennen dieselben Zahlen aus demselben Stand · keine uralten „abgestürzt“ · Kacheln/Listen mit echten
// Daten · das Logo führt zum Überblick.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/briefing-overview-consistency.spec.ts --project chromium-1440
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");

test.describe.configure({ timeout: 180_000, mode: "serial" });

async function signIn(context: BrowserContext, url: string) {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url }]);
  return { cookie: `nyxos_session=${login.token}`, "x-nyxos-csrf": login.csrf, "content-type": "application/json" };
}

type Overview = { lage: string; counts: { running: number; waiting: number; crashed: number; idle: number }; fingerprint: string; needsYouCount: number; generatedAt: string; criticalSessions: { reason: string; sessionKey: string }[]; metrics: { key: string; value: number; placeholder: boolean }[] };

test("Briefing und Überblick — gleiche Zahlen, gleicher Stand, Zeitstempel sichtbar", async ({ page, context, request, baseURL }) => {
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(context, baseURL ?? "http://127.0.0.1:47890");
  // „Jetzt neu erstellen“ über die API (derselbe Aufruf wie der Knopf), dann sofort den Überblick holen.
  const created = await request.post("/api/haiku/report", { headers, data: { kind: "briefing" } });
  expect(created.status(), await created.text()).toBe(200);
  const report = ((await created.json()) as { report: { lage: string; snapshot: { fingerprint: string; counts: Overview["counts"]; needsYouCount: number }; needsYou: { kind: string }[]; mode: string; modeReason: string | null } }).report;
  const ov = (await (await request.get("/api/overview")).json()) as Overview;
  // Solange sich in der Zwischenzeit nichts bewegt hat, ist es derselbe Stand (Fingerabdruck) — dann muss alles gleich sein.
  if (ov.fingerprint === report.snapshot.fingerprint) {
    expect(report.lage).toBe(ov.lage);
    expect(report.snapshot.counts).toEqual(ov.counts);
    expect(report.needsYou.filter((i) => i.kind === "session")).toHaveLength(ov.counts.waiting);
    expect(report.needsYou.filter((i) => i.kind === "crashed")).toHaveLength(ov.counts.crashed);
    expect(ov.metrics.find((m) => m.key === "sessions_waiting")?.value).toBe(ov.counts.waiting);
    expect(ov.criticalSessions.filter((c) => c.reason === "abgestürzt")).toHaveLength(ov.counts.crashed);
  }

  await page.goto("/briefing");
  await expect(page.getByTestId("briefing-lage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Briefing · Stand \d\d:\d\d/)).toBeVisible();
  const briefingLage = (await page.getByTestId("briefing-lage").textContent())?.trim();
  if (report.mode !== "ok") await expect(page.getByText(/^Ohne Nyx erstellt – /)).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "briefing-numbers.png"), fullPage: true });

  await page.goto("/overview");
  await expect(page.getByTestId("overview-lage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("overview-stand")).toHaveText(/Stand \d\d:\d\d/);
  const teaser = page.getByTestId("briefing-teaser");
  const stale = ((await (await request.get("/api/haiku/report?kind=briefing")).json()) as { report: { stale: boolean } }).report.stale;
  if (!stale) {
    // Gleicher Stand → derselbe Lage-Satz oben wie im Briefing.
    await expect(page.getByTestId("overview-lage")).toHaveText(briefingLage ?? "");
    await expect(teaser).toContainText(/Briefing von \d\d:\d\d/);
  } else {
    await expect(teaser).toContainText("hat sich etwas geändert");
  }
  await page.screenshot({ path: resolve(SHOTS, "overview-numbers.png"), fullPage: false });
});

test("keine uralten „abgestürzt“ — alles Abgestürzte ist jünger als die Schwelle; Einstellung sichtbar", async ({ page, context, request, baseURL }) => {
  await signIn(context, baseURL ?? "http://127.0.0.1:47890");
  const settings = (await (await request.get("/api/settings/session-state")).json()) as { crashedMaxHours: number };
  expect(settings.crashedMaxHours).toBeGreaterThanOrEqual(1);
  const sessions = ((await (await request.get("/api/sessions?limit=2000")).json()) as { sessions: { state: string | null; lastActivityAt: string | null; parentId?: string | null }[] }).sessions;
  const crashed = sessions.filter((s) => s.state === "crashed");
  for (const s of crashed) expect(Date.now() - Date.parse(s.lastActivityAt ?? "")).toBeLessThan(settings.crashedMaxHours * 3_600_000 + 120_000);
  const ov = (await (await request.get("/api/overview")).json()) as Overview;
  expect(ov.criticalSessions.filter((c) => c.reason === "abgestürzt")).toHaveLength(ov.counts.crashed);

  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Sessions" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByLabel(/abgestürzt/)).toHaveValue(String(settings.crashedMaxHours));
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(SHOTS, "crashed-threshold.png") });
});

test("Überblick mit mehr echten Daten — Tokens, Builds, Konflikt-Trend, Zuletzt fertig, Betrieb", async ({ page, request }) => {
  const ov = (await (await request.get("/api/overview")).json()) as Overview;
  for (const key of ["tokens_today", "tokens_7d", "builds_red", "conflicts"]) expect(ov.metrics.some((m) => m.key === key && !m.placeholder)).toBe(true);
  await page.goto("/overview");
  await expect(page.getByText("Tokens heute")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Tokens heute").locator("xpath=ancestor::a")).toHaveAttribute("href", "/usage");
  await expect(page.getByText("Builds rot").locator("xpath=ancestor::a")).toHaveAttribute("href", "/server");
  await expect(page.getByRole("region", { name: "Zuletzt fertig" })).toBeVisible();
  const ops = page.getByRole("region", { name: "Betrieb" });
  await expect(ops.getByText(/Brücke/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: resolve(SHOTS, "overview-tiles.png"), fullPage: true });
  // Die Seite scrollt im Hauptbereich (nicht im Fenster) — der untere Teil als eigenes Bild.
  await page.getByRole("region", { name: "Kritische Sessions" }).scrollIntoViewIfNeeded();
  await ops.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS, "overview-tiles-bottom.png") });
});

test("Logo oben links führt zum Überblick, auch per Tastatur", async ({ page }) => {
  await page.goto("/sessions");
  const logo = page.getByRole("link", { name: "NyxOS – zum Überblick" });
  await expect(logo).toBeVisible({ timeout: 60_000 });
  await logo.focus();
  await page.screenshot({ path: resolve(SHOTS, "logo-to-overview.png"), clip: { x: 0, y: 0, width: 420, height: 260 } });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/overview$/);
});
