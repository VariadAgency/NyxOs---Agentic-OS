// Rahmen und Nyx-Tab im Browser (Chromium + WebKit):
//   • Nyx-Tab: EIN Weck-Knopf, Zustandswort „bereit“ wie im Zentrum, der letzte Faden ist offen, „Neues Gespräch“ einmal.
//   • Kopfleiste ohne Vollbild-Knopf; Vollbild steht in ⌘K; Leiste nennt Skills einmal; Agenten mit Seitenkopf.
// Alle /api-Antworten werden hier im Test gestellt (nichts wird geschrieben) — läuft gegen den lokalen Stack
// oder leicht gegen die gebaute Web-App über `vite preview`. Der Vite-Dev-Server taugt nicht: er zieht
// `node:path` aus @nyxos/shared in den Browser.
//   pnpm --filter @nyxos/web exec vite build --outDir /tmp/nyxos-web-dist && pnpm --filter @nyxos/web exec vite preview --outDir /tmp/nyxos-web-dist --port 47961 --strictPort
//   E2E_BASE_URL=http://127.0.0.1:47961 pnpm --filter @nyxos/web exec playwright test e2e/nyx-tab-frame.spec.ts --project chromium-1440 --project webkit-1440
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const THREADS = [
  { id: 7, title: "hallo", topic: "overview", day: "2026-09-25", updatedAt: ago(120), temporary: false, expiresAt: null },
  { id: 3, title: "Deploy-Plan für Freitag", topic: "server", day: "2026-09-24", updatedAt: ago(60 * 20), temporary: false, expiresAt: null },
];

const STATUS = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-26", calls: 3, inputTokens: 900, outputTokens: 80, costUsd: 0.01, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

const RUNS = [
  { id: "claude:s1:a1", tool: "claude", parentSessionKey: "claude:s1", parentTitle: "Baustelle NyxOS", agentName: "test-coverage-critic", agentType: "test-coverage-critic", startedAt: ago(40), endedAt: ago(38), durationMs: 120_000, toolCalls: 14, verdict: "PASS", running: false },
  { id: "claude:s1:a2", tool: "claude", parentSessionKey: "claude:s1", parentTitle: "Baustelle NyxOS", agentName: "Explore", agentType: "Explore", startedAt: ago(3), endedAt: null, durationMs: null, toolCalls: 6, verdict: null, running: true },
];

async function stubApi(page: Page) {
  await page.route((u) => u.pathname.startsWith("/api/") || u.pathname === "/health", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === "/api/auth/status") return json({ authenticated: true, csrf: "t", hasPasskey: true, authReads: false });
    if (p === "/health") return json({ ok: true });
    if (p === "/api/haiku/status") return json(STATUS);
    if (p === "/api/haiku/threads") return json({ threads: THREADS });
    const m = /^\/api\/haiku\/threads\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      return json({
        thread: THREADS.find((t) => t.id === id),
        messages: [
          { id: 70, role: "user", text: "hallo", sources: [], estimate: false, createdAt: ago(121) },
          { id: 71, role: "assistant", text: "Hallo Alex! Gerade wartet eine Entscheidung auf dich, sonst ist alles ruhig.", sources: [], estimate: false, createdAt: ago(120) },
        ],
      });
    }
    if (p === "/api/haiku/tools") return json({ tools: [{ name: "git_lage", description: "Git-Lage" }] });
    if (p === "/api/graph") return json({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
    if (p === "/api/nyx/live") return json({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
    if (p === "/api/nyx/files") return json({ files: [] });
    if (p === "/api/open-questions") return json({ approvals: 0, inbox: 1, conflicts: 0, total: 1 });
    if (p.startsWith("/api/inbox")) return json({ items: [] });
    if (p.startsWith("/api/approvals")) return json({ approvals: [] });
    if (p === "/api/context-guard/settings") return json({ default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, models: [], sessions: [] });
    if (p.startsWith("/api/agents/runs")) return json({ runs: RUNS });
    if (p.startsWith("/api/agents/catalog")) return json({ catalog: [] });
    if (p.startsWith("/api/agents/skills/usage")) return json({ skills: [{ skill: "dataviz", runs7d: 2, lastUsedAt: ago(300) }] });
    if (p.startsWith("/api/agents/anomalies")) return json({ anomalies: [] });
    if (p.startsWith("/api/sessions")) return json({ sessions: [] });
    if (p.startsWith("/api/entries")) return json({ entries: [] });
    return json({}, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test("Nyx-Tab: ein Weck-Knopf, „bereit“, letzter Faden offen, „Neues Gespräch“ einmal", async ({ page }, info) => {
  await page.goto("/nyx");
  const chip = page.locator('[data-nyx="nyx-zustand"]');
  await expect(chip).toHaveText(/bereit/);
  await expect(page.getByRole("button", { name: /weck/i })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Nyx wecken" })).toHaveAttribute("data-nyx", "nyx-sprechen");
  await expect(page.locator('[data-nyx="nyx-aufwecken"]')).toHaveCount(0);
  // Leiste: Chat-Reiter öffnen (bei 1440 ist er offen), dort der Faden „hallo“ mit Verlauf.
  const chat = page.getByRole("tabpanel", { name: "Chat" });
  await expect(chat.getByText(/Gerade wartet eine Entscheidung/)).toBeVisible();
  await expect(chat.getByText("Noch kein Gespräch.")).toHaveCount(0);
  await expect(chat.getByText("Neues Gespräch", { exact: true })).toHaveCount(1);
  await expect(chat.locator('[data-nyx="nyx-faden"]')).toHaveText("hallo");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-tab-${info.project.name.startsWith("webkit") ? "webkit" : "chromium"}.png` });
});

test("Nyx-Zentrum sagt dasselbe Wort, ohne Wächter-Zeile", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("webkit"), "ein Browser reicht für das Zentrum");
  await page.goto("/agents");
  await page.getByTestId("nyx-bar").click();
  const center = page.getByRole("dialog", { name: "Nyx" });
  await expect(center.getByTestId("nyx-zustandswort")).toHaveText(/^bereit/);
  await expect(center.getByText(/Kontext-Wächter/)).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-center.png` });
});

test("Rahmen: Kopfleiste ohne Vollbild, Skills einmal, Agenten mit Seitenkopf, Vollbild in ⌘K", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("webkit"), "Rahmen: Chromium reicht");
  await page.goto("/agents");
  const bar = page.getByTestId("topbar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: /Vollbild/ })).toHaveCount(0);
  const nav = page.getByTestId("sidebar");
  await expect(nav.getByText(/Skills/)).toHaveCount(1);
  await expect(nav.getByRole("link", { name: /Agenten/ })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: /Agenten/ })).not.toContainText("Skills");
  const h1 = page.getByRole("heading", { level: 1, name: "Agenten" });
  await expect(h1).toBeVisible();
  expect(await h1.evaluate((el) => getComputedStyle(el).fontSize)).toBe("28px");
  await expect(page.locator("[data-page-header]").getByRole("link", { name: /Skills/ })).toHaveAttribute("href", "/skills");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-agents.png` });

  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Befehlspalette" });
  await expect(palette.getByRole("option", { name: /Vollbild/ })).toBeVisible();
  await page.keyboard.type("voll");
  await expect(palette.getByRole("option", { name: /Vollbild/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-cmdk-fullscreen.png` });
});

// 390 px (iPhone, Touch) – nichts abgeschnitten, kein seitliches Scrollen, Schalter mit Wort,
// „gedrückt halten“ statt „Leertaste“; Agenten-Seitenkopf bricht sauber um. Seitenfehler = rot (auch für Vite-Dev).
test("390 px: Nyx-Tab und Agenten ohne Abschneiden", async ({ browser }, info) => {
  test.skip(info.project.name !== "chromium-1440", "eine Handy-Probe reicht");
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubApi(page);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const inside = async (sel: string) => {
    const box = await page.locator(sel).first().boundingBox();
    expect(box, sel).not.toBeNull();
    if (box) expect(box.x >= 0 && box.x + box.width <= 390, `${sel} liegt im Bild`).toBe(true);
  };

  await page.goto("/nyx");
  await expect(page.locator('[data-nyx="nyx-zustand"]')).toHaveText(/bereit/);
  expect(await noOverflow()).toBe(true);
  await inside('[data-nyx="nyx-zustand"]');
  await inside('[data-nyx="nyx-sprechen"]');
  await expect(page.getByText("gedrückt halten")).toBeVisible();
  await expect(page.locator(".nyx-kbd", { hasText: "Leertaste" })).toBeHidden();
  await expect(page.locator(".nyx-switch__label")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-tab-390.png` });

  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agenten" })).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await inside("[data-page-header] a[href='/skills']");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/nyx-frame-agents-390.png` });
  expect(errors).toEqual([]);
  await ctx.close();
});
