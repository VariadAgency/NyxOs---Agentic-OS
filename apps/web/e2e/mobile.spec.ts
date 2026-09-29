// NyxOS on the iPhone (WebKit „iPhone 13“) and Android (Chromium „Pixel 7“) – only in these two projects
// (playwright.config.ts). Runs against the probe stack (`pnpm dev`) or a local server + Vite, e.g.:
//   NYXOS_HOME=<tmp> PORT=47899 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47899 pnpm exec vite --port 5199 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5199 E2E_NYXOS_API=http://127.0.0.1:47899 E2E_NYXOS_HOME=<tmp> \
//     pnpm --filter @nyxos/web exec playwright test e2e/mobile.spec.ts
// Sample sessions come in through the bridge route (`helpers/mobileSeed.ts`). The bridge is not running there, so
// terminal/chat get fakes: bridge status „online“, chat „ready“ and a terminal WebSocket that records what arrives
// (so we can check that Esc/Ctrl-C really go out).
import { expect, test, type Page } from "@playwright/test";
import { apiBase, bridgeToken, prepare } from "./helpers/localStack";
import { MOBILE_CWD, MOBILE_LIVE, seedMobileSessions } from "./helpers/mobileSeed";

const LIVE_ID = `claude:${MOBILE_LIVE.sessionId}`;
const LIVE_URL = `/sessions/unsortiert/_/${LIVE_ID}`;

/** Alle Routen aus App.tsx (dynamische mit einem echten Beispiel). */
const ROUTES = [
  "/overview",
  "/nyx",
  "/git",
  "/conflicts",
  "/server",
  "/settings",
  "/settings/konto",
  "/settings/mitteilungen",
  "/settings/sessions",
  "/settings/modelle",
  "/settings/unterstuetzen",
  "/sessions",
  LIVE_URL,
  `${LIVE_URL}?tab=terminal`,
  "/briefing",
  "/inbox",
  "/einstellungen/haiku",
  "/einstellungen/nyx",
  "/einstellungen/nyx/persoenlichkeit",
  "/einstellungen/nyx/stimme",
  "/einstellungen/info",
  "/tasks",
  "/ideas",
  "/audits",
  "/files",
  "/agents",
  "/skills",
  "/usage",
  "/gehirn",
];



test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext();
  await seedMobileSessions(api, apiBase(baseURL));
  await api.dispose();
});

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
});

/** Seite (Dokument) und Hauptbereich dürfen nie waagerecht scrollen. */
async function horizontalOverflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) return `Seite ${doc.scrollWidth} > ${doc.clientWidth}`;
    const main = document.querySelector("main");
    if (main && main.scrollWidth > main.clientWidth + 1) return `Hauptbereich ${main.scrollWidth} > ${main.clientWidth}`;
    return null;
  });
}

async function checkAllRoutes(page: Page) {
  const bad: string[] = [];
  for (const path of ROUTES) {
    await page.goto(path);
    await page.locator("main").waitFor();
    await page.waitForTimeout(900);
    const over = await horizontalOverflow(page);
    if (over) bad.push(`${path}: ${over}`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
}

/** The bridge is not connected here – bridge, chat and terminal as fakes. */
async function fakeBridge(page: Page) {
  const sent: { text: string }[] = [];
  const termIn: string[] = [];
  await page.route("**/api/terminal/status", (r) => r.fulfill({ json: { online: true, machineId: "dev", since: new Date().toISOString() } }));
  await page.route("**/api/terminal/folders", (r) => r.fulfill({ json: { folders: [{ label: "handy-test", path: MOBILE_CWD }] } }));
  await page.route(/\/api\/sessions\/[^/]+\/chat$/, (r) => r.fulfill({ json: { canSend: true, reason: null, message: null, busy: false } }));
  await page.route(/\/api\/sessions\/[^/]+\/message$/, async (r) => {
    sent.push(JSON.parse(r.request().postData() ?? "{}") as { text: string });
    await r.fulfill({ json: { sent: true, queued: false } });
  });
  await page.routeWebSocket(/\/terminal\//, (ws) => {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { t: string; d?: string };
      if (msg.t === "in" && msg.d !== undefined) termIn.push(msg.d);
    });
    // Wie der echte Server: der Abzug hat die Feldgröße, mit der sich der Browser gemeldet hat.
    const q = new URL(ws.url()).searchParams;
    ws.send(JSON.stringify({ t: "snapshot", d: "Claude Code \x1b[32mbereit\x1b[0m\r\n> ", cols: Number(q.get("cols")), rows: Number(q.get("rows")) }));
  });
  return { sent, termIn };
}

test.describe("Handy (390 px)", () => {
  test("jede Route ohne waagerechtes Scrollen", async ({ page }) => {
    test.setTimeout(120_000);
    await checkAllRoutes(page);
  });

  test("Safe-Area: viewport-fit=cover, Ränder oben (App) und unten (Leiste)", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    // The app renders after the language boot – wait for the shell before reading its styles.
    await page.getByTestId("mobile-tabbar").waitFor();
    const rules = await page.evaluate(() => {
      const hits = (el: Element | null, prop: string) => {
        if (!el) return false;
        for (const sheet of document.styleSheets) {
          let list: CSSRuleList;
          try {
            list = sheet.cssRules;
          } catch {
            continue;
          }
          const walk = (rs: CSSRuleList): boolean => {
            for (const r of rs) {
              if (r instanceof CSSStyleRule && r.style.cssText.includes(`${prop}`) && r.style.cssText.includes("safe-area-inset") && el.matches(r.selectorText)) return true;
              if ("cssRules" in r && walk((r as CSSGroupingRule).cssRules)) return true;
            }
            return false;
          };
          if (walk(list)) return true;
        }
        return false;
      };
      return { top: hits(document.querySelector(".cc-app"), "padding-top"), bottom: hits(document.querySelector("[data-testid=mobile-tabbar]"), "padding-bottom") };
    });
    expect(rules).toEqual({ top: true, bottom: true });
  });

  test("untere Leiste: Nyx · Sessions · Entscheidungen · Überblick · Mehr, Tipp-Ziele ≥ 44 px", async ({ page }) => {
    await page.goto("/overview");
    const bar = page.getByRole("navigation", { name: "Schnellzugriff" });
    await expect(bar).toBeVisible();
    for (const box of await bar.locator("a, button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await bar.getByRole("link", { name: /Sessions/ }).click();
    await expect(page).toHaveURL(/\/sessions/);
    await bar.getByRole("link", { name: /Entscheidungen/ }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await bar.getByRole("link", { name: /Nyx/ }).click();
    await expect(page).toHaveURL(/\/nyx$/);
    await expect(bar).toBeVisible(); // auch im Nyx-Tab (Fokus-Modus) bleibt die Leiste
    await bar.getByRole("button", { name: "Mehr" }).click();
    // Die Schublade ist zu unsichtbar (nicht im Bedienbaum) – darum über ihre Id.
    const menu = page.locator("#app-sidebar");
    await expect(menu).toHaveAttribute("data-open", "true");
    await menu.getByRole("link", { name: /Git/ }).click();
    await expect(page).toHaveURL(/\/git$/);
    await expect(menu).toHaveAttribute("data-open", "false");
    await expect(bar.getByRole("button", { name: "Mehr" })).toHaveAttribute("data-active", "true");
  });

  test("Suche ohne ⌘K: Knopf in der Kopfzeile öffnet die Befehlspalette", async ({ page }) => {
    await page.goto("/overview");
    await page.getByRole("button", { name: "Suchen und Befehle" }).click();
    const input = page.getByPlaceholder("Suche alles oder frag Nyx …");
    await expect(input).toBeVisible();
    // ≥ 16 px, sonst zoomt iOS beim Antippen.
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    // Ganz im Bild (oben, fast volle Breite) – nicht halb rechts hinaus.
    const box = await page.locator(".cc-palette").boundingBox();
    const vw = page.viewportSize()?.width ?? 0;
    expect(box && box.x).toBeGreaterThanOrEqual(0);
    expect(box && Math.round(box.x + box.width)).toBeLessThanOrEqual(vw);
  });

  test("Session öffnen → schreiben → Terminal-Tastenzeile schickt Esc und Strg-C", async ({ page }) => {
    test.setTimeout(90_000);
    const bridge = await fakeBridge(page);
    await page.goto("/sessions");
    await page.locator(`[data-session-id="${LIVE_ID}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(MOBILE_LIVE.sessionId));
    // Liste → Session wie in iOS: Filter/Reiter weichen, „‹ Sessions“ führt zurück.
    await expect(page.getByTestId("sessions-filter-compact")).toBeHidden();
    await page.getByRole("button", { name: "Zurück zu den Sessions" }).click();
    await expect(page.locator(`[data-session-id="${LIVE_ID}"]`).first()).toBeVisible();
    await page.locator(`[data-session-id="${LIVE_ID}"]`).first().click();

    // Chat: schreiben und senden (Enter macht auf dem Handy eine neue Zeile, gesendet wird per Knopf).
    const box = page.getByRole("textbox", { name: "Nachricht an Claude" });
    await expect(box).toBeEnabled({ timeout: 15_000 });
    await box.fill("Hallo vom Handy");
    await page.getByRole("button", { name: "Senden", exact: true }).click();
    await expect.poll(() => bridge.sent.map((m) => m.text)).toContain("Hallo vom Handy");

    // Terminal: Tastenzeile unten, erst nach „Nur ansehen“ aus.
    await page.getByRole("tab", { name: "Terminal" }).click();
    const panel = page.getByTestId("terminal-panel");
    await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
    const keys = page.getByRole("toolbar", { name: "Terminal-Tasten" });
    await expect(keys).toBeVisible();
    await expect(keys.getByRole("button", { name: "Esc" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Nur ansehen" }).uncheck();
    await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
    await keys.getByRole("button", { name: "Esc" }).click();
    await keys.getByRole("button", { name: "Strg-C" }).click();
    await keys.getByRole("button", { name: "Pfeil hoch" }).click();
    await expect.poll(() => bridge.termIn).toEqual(["\x1b", "\x03", "\x1b[A"]);
    // Tastenzeile liegt ganz im Bild (über der Leiste bzw. Tastatur) und hat daumengroße Tasten.
    const kb = await keys.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(kb && kb.y + kb.height).toBeLessThanOrEqual(vh);
    expect((await keys.getByRole("button", { name: "Esc" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    // Handy-Tastatur offen (so meldet es lib/visualViewport.ts): App schrumpft auf den sichtbaren Bereich,
    // Kopfzeile/Leisten gehen weg, die Tastenzeile sitzt direkt über der Tastatur.
    await page.evaluate(() => {
      const r = document.documentElement;
      r.dataset.kb = "open";
      r.style.setProperty("--app-h", "380px");
      r.style.setProperty("--app-top", "0px");
    });
    await expect(page.getByTestId("topbar")).toBeHidden();
    await expect(page.getByTestId("mobile-tabbar")).toBeHidden();
    const kbOpen = await keys.boundingBox();
    expect(kbOpen && Math.round(kbOpen.y + kbOpen.height)).toBeLessThanOrEqual(380);
    expect((await page.locator(".xterm-screen").boundingBox())?.height ?? 0).toBeGreaterThan(100);
    await page.evaluate(() => {
      const r = document.documentElement;
      delete r.dataset.kb;
      r.style.removeProperty("--app-h");
      r.style.removeProperty("--app-top");
    });
    // Schrift anpassen: A+ macht die Schrift größer.
    const before = await page.evaluate(() => (window as unknown as { __zcTerm?: { options: { fontSize?: number } } }).__zcTerm?.options.fontSize ?? 0);
    await page.getByRole("button", { name: "Schrift größer" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __zcTerm?: { options: { fontSize?: number } } }).__zcTerm?.options.fontSize ?? 0)).toBe(before + 1);
    await page.getByRole("button", { name: "Schrift kleiner" }).click();
  });

  test("Neue Session auf dem Handy: Blatt von unten, volle Breite, Starten schickt den Auftrag", async ({ page }) => {
    await fakeBridge(page);
    let started: Record<string, unknown> | null = null;
    await page.route("**/api/terminal/start", async (r) => {
      started = JSON.parse(r.request().postData() ?? "{}") as Record<string, unknown>;
      await r.fulfill({ json: { tmuxName: "zc-claude-m5neu001", tool: "claude", sessionId: "5e5a0000-0000-4000-8000-00000000a0ff", startedMs: 800 } });
    });
    await page.goto("/sessions");
    await page.getByRole("button", { name: "Neue Session" }).click();
    const dialog = page.getByRole("dialog", { name: "Neue Session" });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(350); // Einblenden
    const b = await dialog.boundingBox();
    const vp = page.viewportSize();
    expect(b && vp && Math.round(b.width)).toBe(vp?.width);
    expect(b && vp && Math.round(b.y + b.height)).toBe(vp?.height);
    await dialog.getByRole("textbox", { name: "Erste Nachricht (optional)" }).fill("Handy-Test");
    await dialog.getByRole("button", { name: "Starten" }).click();
    await expect.poll(() => started?.prompt).toBe("Handy-Test");
    await expect(page).toHaveURL(/tab=terminal/);
  });
});

test.describe("Freigaben auf dem Handy", () => {
  test("Zähler in der Leiste → Entscheidungen → „Freigeben“ entscheidet", async ({ page, playwright, baseURL }) => {
    // A real approval request through the bridge route (as the guard hook on the computer sends it).
    const api = await playwright.request.newContext();
    const res = await api.post(`${apiBase(baseURL)}/guard/check`, {
      headers: { authorization: `Bearer ${bridgeToken()}`, "content-type": "application/json" },
      data: { tool: "Bash", command: `git push origin handy-test-${Date.now()}`, cwd: MOBILE_CWD, sessionId: MOBILE_LIVE.sessionId, auftrag: "Handy-Prüfung", worktree: null, rule: "git_push", reason: "Push braucht Freigabe" },
    });
    expect(res.ok()).toBe(true);
    const { approvalId } = (await res.json()) as { approvalId: number };
    await api.dispose();

    await page.goto("/overview");
    const bar = page.getByRole("navigation", { name: "Schnellzugriff" });
    await expect(bar.getByTestId("tabbar-badge")).toBeVisible({ timeout: 15_000 });
    await bar.getByRole("link", { name: /Entscheidungen/ }).click();
    const card = page.locator("article", { hasText: `handy-test-` }).first();
    await expect(card).toBeVisible();
    const approve = card.getByRole("button", { name: "Freigeben" });
    expect((await approve.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await approve.click();
    await expect.poll(async () => {
      const r = await page.request.get("/api/approvals?status=all");
      const list = ((await r.json()) as { approvals: { id: number; status: string }[] }).approvals;
      return list.find((a) => a.id === approvalId)?.status;
    }).toBe("approved");
  });
});

test.describe("iPad (820 × 1180)", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("jede Route ohne waagerechtes Scrollen, Seitenleiste fest, keine Handy-Leiste", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/overview");
    await expect(page.getByRole("navigation", { name: "Hauptmenü" })).toBeVisible();
    await expect(page.getByTestId("mobile-tabbar")).toBeHidden();
    await checkAllRoutes(page);
  });
});
