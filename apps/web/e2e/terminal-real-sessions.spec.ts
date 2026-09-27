// „Terminal funktioniert“ gegen den lokalen Stack mit ECHTEN Claude-Sessions: in 3 Sessions tippen, eine
// davon läuft vorher in einem eigenen Fenster (echtes Pseudo-Terminal ohne tmux) und wird über „In der NyxOS
// übernehmen“ geholt. Nur eigene Sessions (eigene Session-IDs, eigener tmux-Socket des lokalen Stacks), nie
// laufende Sessions des Nutzers.
//   pnpm dev     # druckt „Passkey-Einrichtung: Code …“
//   E2E_SETUP_CODE=<code> pnpm --filter @nyxos/web exec playwright test e2e/terminal-real-sessions.spec.ts --project=chromium-1440
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOTS = join(ROOT, ".probe", "shots");
const LOGS = join(ROOT, ".probe", "terminal-real-sessions");
const SOCKET = process.env.PROBE_TMUX_SOCKET ?? "nyxos-probe";
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p)) ?? "tmux";
/** Arbeitsordner der Test-Sessions: dieses Repository. */
const CWD = ROOT;
const CLAUDE = process.env.E2E_CLAUDE_BIN ?? join(process.env.HOME ?? "", ".local", "bin", "claude");

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(({ browserName }) => browserName !== "chromium", "virtueller Passkey nur in Chromium");
/** Anmeldung eines früheren Laufs (Cookie), damit ein neuer Lauf keinen neuen Einrichtungs-Code braucht. */
const STATE = join(ROOT, ".probe", "terminal-real-sessions", "state.json");
test.skip(!process.env.E2E_SETUP_CODE && !existsSync(STATE), "E2E_SETUP_CODE fehlt (steht im Log von pnpm dev)");

let page: Page;
const tmuxNames: string[] = [];
let outsidePid: number | null = null;
const outsideId = randomUUID();

const tmux = (...args: string[]) => execFileSync(TMUX, ["-L", SOCKET, ...args], { encoding: "utf8" });
const termText = (p: Page) =>
  p.evaluate(() => {
    const t = (window as unknown as { __zcTerm?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__zcTerm;
    if (!t) return "";
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n");
  });
const csrf = async (p: Page) => ((await (await p.request.get("/api/auth/status")).json()) as { csrf: string }).csrf;
interface ApiSession {
  id: string;
  sessionId: string;
  tmuxName: string | null;
  attachable: boolean;
  status: string;
}
const findSession = async (p: Page, sessionId: string): Promise<ApiSession | null> => {
  try {
    const r = await p.request.get("/api/sessions?limit=2000", { timeout: 20_000 });
    return (((await r.json()) as { sessions: ApiSession[] }).sessions ?? []).find((s) => s.sessionId === sessionId) ?? null;
  } catch {
    return null; // lokaler Stack gerade mit dem Nachimport beschäftigt → nächster Versuch
  }
};

/** Pageninhalt inkl. Hover-Hinweise — darf nie „tmux“ enthalten. */
const visibleText = (p: Page) => p.evaluate(() => document.body.innerText + " " + [...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).join(" "));

async function openTerminal(p: Page, id: string) {
  await p.goto(`/sessions/unsortiert/_/${encodeURIComponent(id)}?tab=terminal`);
  const panel = p.getByTestId("terminal-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** Wartet, bis Claude am Eingabefeld steht (Vertrauens-Frage für neue Ordner mit Enter bestätigen). */
async function waitReady(p: Page) {
  await expect
    .poll(
      async () => {
        const t = await termText(p);
        if (/trust/i.test(t) && /Yes, proceed|Ja/i.test(t)) await p.keyboard.press("Enter");
        return /bereit/i.test(t) && /[>❯]\s*$/m.test(t);
      },
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(true);
}

/** In das Terminal tippen: `!` = Shell-Befehl in Claude Code, die Antwort beweist den Weg hin und zurück. */
async function typeAndSee(p: Page, n: number) {
  await p.getByTestId("terminal-panel").locator(".xterm").click();
  await p.keyboard.type("!");
  await p.waitForTimeout(300);
  await p.keyboard.type(`echo d2-${n}-$((6*7))`);
  await p.keyboard.press("Enter");
  await expect.poll(async () => (await termText(p)).includes(`d2-${n}-42`), { timeout: 60_000, intervals: [300] }).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(existsSync(STATE) ? { storageState: STATE } : {}) });
  page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});

test.afterAll(() => {
  // Nur eigene Sessions aufräumen: die tmux-Sessions dieses Tests auf dem tmux-Socket des lokalen Stacks.
  for (const n of tmuxNames) {
    try {
      tmux("kill-session", "-t", `=${n}`);
    } catch {
      // schon weg
    }
  }
  if (outsidePid) {
    try {
      process.kill(outsidePid, "SIGTERM");
    } catch {
      // schon weg
    }
  }
});

test("anmelden (virtueller Passkey)", async () => {
  await page.goto("/sessions");
  if (((await (await page.request.get("/api/auth/status")).json()) as { authenticated: boolean }).authenticated) return;
  await page.evaluate(() => window.dispatchEvent(new Event("nyxos:login-required")));
  const dlg = page.getByRole("dialog", { name: /anmelden/i });
  const another = dlg.getByRole("button", { name: /Neues Gerät einrichten/ });
  await expect(dlg.getByLabel(/Einrichtungs-Code/).or(another)).toBeVisible();
  if (await another.isVisible()) await another.click();
  await dlg.getByLabel(/Einrichtungs-Code/).fill(process.env.E2E_SETUP_CODE ?? "");
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
  await page.context().storageState({ path: STATE });
});

test("3 echte Sessions: eine aus einem eigenen Fenster übernehmen, in alle drei tippen", async () => {
  // 1) Eine Session in einem „eigenen Fenster“ (Pseudo-Terminal ohne tmux), wie aus Terminal.app gestartet.
  const helper = join(ROOT, "apps", "web", "e2e", "helpers", "outside-window.py");
  const child = spawn("/usr/bin/python3", [helper, join(LOGS, "outside.log"), CWD, CLAUDE, "--model", "haiku", "--session-id", outsideId, "Antworte nur mit dem Wort: bereit"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  outsidePid = child.pid ?? null;

  // 2) Zwei neue Sessions aus der NyxOS — landen immer in tmux (tmux-Socket des lokalen Stacks).
  const token = await csrf(page);
  const started: { tmuxName: string; sessionId: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await page.request.post("/api/terminal/start", {
      headers: { "content-type": "application/json", "x-nyxos-csrf": token },
      data: { tool: "claude", model: "haiku", cwd: CWD, prompt: "Antworte nur mit dem Wort: bereit" },
    });
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { tmuxName: string; sessionId: string };
    tmuxNames.push(body.tmuxName);
    started.push(body);
    expect(() => tmux("has-session", "-t", `=${body.tmuxName}`)).not.toThrow();
  }

  // 3) Die Fenster-Session erscheint in der NyxOS — außerhalb, also noch nicht anhängbar.
  await expect.poll(async () => (await findSession(page, outsideId))?.status ?? null, { timeout: 120_000, intervals: [1000] }).toBe("running");
  expect((await findSession(page, outsideId))?.attachable).toBe(false);
  // Warten, bis Claude im Fenster wirklich geantwortet hat (sonst „arbeitet gerade“).
  await expect.poll(() => readFileSync(join(LOGS, "outside.log"), "utf8").includes("bereit"), { timeout: 120_000, intervals: [1000] }).toBe(true);

  const panel = await openTerminal(page, `claude:${outsideId}`);
  await expect(panel).toContainText("läuft in einem eigenen Fenster auf dem Rechner");
  expect(await visibleText(page)).not.toMatch(/tmux/i);

  // 4) Übernehmen: ehrlicher Dialog, erst der Klick beendet das alte Fenster.
  await panel.getByRole("button", { name: "In NyxOS übernehmen" }).click();
  const dlg = page.getByRole("dialog", { name: /übernehmen/ });
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  await expect(dlg).toContainText("Zwei Programme");
  await page.screenshot({ path: join(SHOTS, "terminal-take-over.png") });
  expect(outsidePid && isAlive(outsidePid)).toBe(true);
  await dlg.getByRole("button", { name: /Altes Fenster beenden/ }).click();
  await expect(dlg).toBeHidden({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await expect.poll(() => (outsidePid ? isAlive(outsidePid) : false), { timeout: 15_000 }).toBe(false);
  const taken = await findSession(page, outsideId);
  expect(taken).toMatchObject({ attachable: true });
  if (taken?.tmuxName) tmuxNames.push(taken.tmuxName);

  // 5) In alle drei tippen.
  await waitReady(page);
  await typeAndSee(page, 3);
  for (const [i, s] of started.entries()) {
    await openTerminal(page, `claude:${s.sessionId}`);
    await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
    await waitReady(page);
    await typeAndSee(page, i + 1);
  }

  // 6) Größe: das Terminal folgt dem Browserfenster (wer tippt, bestimmt die Größe).
  const last = started.at(-1)?.tmuxName ?? "";
  const width = () => Number(tmux("display", "-p", "-t", `=${last}:`, "#{window_width}").trim());
  const before = width();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByTestId("terminal-panel").locator(".xterm").click();
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
  await expect.poll(width, { timeout: 15_000 }).toBeLessThan(before);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("terminal-panel").locator(".xterm").click();
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
  await expect.poll(width, { timeout: 15_000 }).toBe(before);

  await page.screenshot({ path: join(SHOTS, "terminal-three-sessions.png") });
  expect(await visibleText(page)).not.toMatch(/tmux/i);
});

// Verbindungsabbruch: die Brücke DIESES lokalen Stacks (eigenes Datenverzeichnis, eigene PID) beenden und neu starten.
// Das Terminal muss „Rechner offline“ zeigen und danach von selbst wieder verbinden, ohne Klick.
test("nach einem Abbruch der Brücke verbindet das Terminal von selbst wieder", async () => {
  test.skip(process.env.E2E_BRIDGE_RESTART !== "1", "nur mit E2E_BRIDGE_RESTART=1 (startet die Brücke des lokalen Stacks neu)");
  const dataDir = join(ROOT, ".probe", "bridge-data");
  const pid = Number(execFileSync("/usr/bin/pgrep", ["-f", `apps/bridge/src/main.ts run --data-dir ${dataDir}`], { encoding: "utf8" }).trim().split("\n")[0]);
  expect(pid).toBeGreaterThan(1);
  const token = await csrf(page);
  const r = await page.request.post("/api/terminal/start", {
    headers: { "content-type": "application/json", "x-nyxos-csrf": token },
    data: { tool: "claude", model: "haiku", cwd: CWD, prompt: "Antworte nur mit dem Wort: bereit" },
  });
  const body = (await r.json()) as { tmuxName: string; sessionId: string };
  tmuxNames.push(body.tmuxName);
  const panel = await openTerminal(page, `claude:${body.sessionId}`);
  await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await waitReady(page);

  process.kill(-pid, "SIGTERM"); // eigene Prozessgruppe (dev.mjs startet mit detached: true)
  await expect(panel).toHaveAttribute("data-state", "offline", { timeout: 60_000 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  const again = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["apps/bridge/src/main.ts", "run", "--data-dir", dataDir], { cwd: ROOT, env, detached: true, stdio: "ignore" });
  again.unref();
  writeFileSync(join(LOGS, "bridge.pid"), String(again.pid)); // zum späteren Beenden des lokalen Stacks
  const t0 = Date.now();
  await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
  console.log(`wieder verbunden ${Date.now() - t0} ms nach dem Neustart der Brücke`);
  await typeAndSee(page, 4);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
