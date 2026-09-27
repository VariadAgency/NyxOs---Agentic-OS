// Terminal-Messungen gegen den lokalen Stack mit ECHTEN Claude-/Codex-Sessions in einem eigenen tmux-Socket
// (nie `-L nyxos`, nie die installierte Brücke). Nur Chromium (virtueller WebAuthn-Authenticator über CDP).
// Braucht ein Projekt, das die Dev-Brücke kennt (E2E_PROJECT_DIR, Standard ~/projects/atlas; Worktrees
// darunter in E2E_WORKTREES_DIR, Standard <Projekt>/worktrees):
//   NYXOS_DEV_PROJECT_ROOTS=~/projects/atlas pnpm dev   # druckt „Passkey-Einrichtung: Code …"
//   E2E_SETUP_CODE=<code> pnpm --filter @nyxos/web exec playwright test e2e/terminal.spec.ts --project=chromium-1440
// Ergebnisse (Messwerte, keine Verlaufsinhalte) → .probe/shots/terminal/results.json
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, ".probe", "shots", "terminal");
const SOCKET = process.env.PROBE_TMUX_SOCKET ?? "nyxos-probe";
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p)) ?? "tmux";
const PROJECT = process.env.E2E_PROJECT_DIR ?? join(homedir(), "projects", "atlas");
const PROJECT_LABEL = basename(PROJECT);
/** Ordner-Beschriftung im „Neue Session“-Dialog für den Claude-Start (Standard: das Projekt selbst). */
const START_FOLDER = process.env.E2E_START_FOLDER ?? PROJECT_LABEL;
const WORKTREES = process.env.E2E_WORKTREES_DIR ?? join(PROJECT, "worktrees");
const results: Record<string, unknown> = {};

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.skip(({ browserName }) => browserName !== "chromium", "virtueller Passkey nur in Chromium");
test.skip(!process.env.E2E_SETUP_CODE, "E2E_SETUP_CODE fehlt (steht im Log von pnpm dev)");
test.skip(!existsSync(PROJECT), `Projektordner ${PROJECT} fehlt (E2E_PROJECT_DIR setzen)`);

let page: Page;
const consoleErrors: string[] = [];

const tmux = (...args: string[]) => execFileSync(TMUX, ["-L", SOCKET, "-f", join(ROOT, ".probe", "tmux.conf"), ...args], { encoding: "utf8" });
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
const termText = (p: Page) => p.evaluate(() => {
  const t = (window as unknown as { __zcTerm?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__zcTerm;
  if (!t) return "";
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n");
});
const csrf = async (p: Page) => ((await (await p.request.get("/api/auth/status")).json()) as { csrf: string }).csrf;
const sessionsApi = async (p: Page) => ((await (await p.request.get("/api/sessions?limit=2000")).json()) as { sessions: { id: string; sessionId: string; tmuxName: string | null; attachable: boolean; state: string | null; status: string }[] }).sessions;

async function openTerminal(p: Page, id: string, readOnly: boolean | null = null) {
  await p.goto(`/sessions/unsortiert/_/${id}?tab=terminal`);
  const panel = p.getByTestId("terminal-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  if (readOnly !== null) {
    const box = p.getByLabel("Nur ansehen");
    if ((await box.isChecked()) !== readOnly) await box.click();
  }
  await expect(panel).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
}

/** Start über die Web-App; liefert Session-Schlüssel + Zeiten. */
async function startViaUi(p: Page, tool: "claude" | "codex", folderLabel: string, prompt = "") {
  await p.goto("/sessions");
  await p.getByRole("button", { name: "Neue Session" }).click();
  const dlg = p.getByRole("dialog", { name: "Neue Session" });
  await dlg.getByRole("radio", { name: tool === "claude" ? "Claude" : "Codex" }).click();
  if (tool === "claude") await dlg.getByLabel("Modell").selectOption("haiku");
  await dlg.getByLabel("Ordner").selectOption({ label: folderLabel });
  if (prompt) await dlg.getByLabel(/Erste Nachricht/).fill(prompt);
  const t0 = Date.now();
  const [res] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/terminal/start")), dlg.getByRole("button", { name: "Starten" }).click()]);
  const body = (await res.json()) as { tmuxName: string; sessionId: string | null; startedMs: number };
  return { ...body, apiMs: Date.now() - t0, status: res.status() };
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
});

test.afterAll(() => {
  results.consoleErrors = consoleErrors.length;
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
});

test("ohne Anmeldung abgelehnt, dann Passkey einrichten (virtueller Authenticator)", async () => {
  await page.goto("/sessions");
  const denied: Record<string, number> = {};
  for (const [m, path] of [
    ["POST", "/api/terminal/start"],
    ["POST", "/api/sessions/claude:x/resume"],
    ["POST", "/api/sessions/claude:x/close"],
  ] as const) {
    denied[path] = (await page.request.fetch(path, { method: m, data: {}, headers: { "content-type": "application/json" } })).status();
  }
  const ws = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const s = new WebSocket(`ws://${location.host}/terminal/claude:x?mode=rw`);
        s.onopen = () => resolve("offen");
        s.onerror = () => resolve("abgelehnt");
      }),
  );
  results.step8_ohneAnmeldung = { ...denied, terminalKanal: ws };
  expect(Object.values(denied).every((s) => s === 401)).toBe(true);
  expect(ws).toBe("abgelehnt");
  consoleErrors.length = 0; // der absichtlich abgelehnte Handschlag erzeugt eine Konsolen-Meldung

  await page.evaluate(() => window.dispatchEvent(new Event("nyxos:login-required")));
  const dlg = page.getByRole("dialog", { name: "Anmelden" });
  const another = dlg.getByRole("button", { name: /Neues Gerät einrichten/ });
  await expect(dlg.getByLabel(/Einrichtungs-Code/).or(another)).toBeVisible();
  if (await another.isVisible()) await another.click(); // Stack mit schon eingerichtetem Passkey: dieser Browser ist ein weiteres Gerät
  await dlg.getByLabel(/Einrichtungs-Code/).fill(process.env.E2E_SETUP_CODE ?? "");
  await dlg.getByRole("button", { name: "Passkey einrichten" }).click();
  await expect(dlg).toBeHidden({ timeout: 10_000 });
  expect(((await (await page.request.get("/api/auth/status")).json()) as { authenticated: boolean }).authenticated).toBe(true);
  // CSRF: mit Cookie, aber ohne Token → 403
  const noCsrf = await page.request.post("/api/sessions/claude:x/close", { data: { by: "x" }, headers: { "content-type": "application/json" } });
  results.step8_csrfOhneToken = noCsrf.status();
  expect(noCsrf.status()).toBe(403);
});

test("Claude aus der Web-App starten, tippen, Echo-Latenz (200 Messungen)", async () => {
  const s = await startViaUi(page, "claude", START_FOLDER);
  expect(s.status).toBe(200);
  const id = `claude:${s.sessionId}`;
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
  results.step4_claude_projektOrdner = { startedMs: s.startedMs, klickBisAntwortMs: s.apiMs, tmux: s.tmuxName };
  await expect.poll(() => termText(page), { timeout: 30_000 }).toMatch(/❯/);
  await page.getByTestId("terminal-panel").locator(".xterm").click();

  // Latenz: Tastendruck (keydown im Browser) → erste Ausgabe zurück im Terminal.
  await page.evaluate(() => {
    const w = window as unknown as { __zcTerm: { onWriteParsed(cb: () => void): void }; __lat: number[]; __t0: number | null };
    w.__lat = [];
    w.__t0 = null;
    document.addEventListener("keydown", () => (w.__t0 = performance.now()), true);
    w.__zcTerm.onWriteParsed(() => {
      if (w.__t0 !== null) {
        w.__lat.push(performance.now() - w.__t0);
        w.__t0 = null;
      }
    });
  });
  // Ein Tastendruck ohne sichtbares Echo (z. B. Claude fasst zwei Neuzeichnungen zusammen) zählt als
  // „ohne Echo" und wird ausgewiesen, statt die ganze Messung abzubrechen.
  let ohneEcho = 0;
  const pressAndWait = async (key: string) => {
    const before = await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat.length);
    await page.keyboard.press(key);
    try {
      await page.waitForFunction((n) => (window as unknown as { __lat: number[] }).__lat.length > n, before, { timeout: 3000 });
    } catch {
      ohneEcho++;
      await page.evaluate(() => ((window as unknown as { __t0: number | null }).__t0 = null));
    }
  };
  for (let i = 0; i < 100; i++) {
    await pressAndWait("x");
    await pressAndWait("Backspace");
  }
  const lat = await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat);
  results.step1_latenz = { n: lat.length, ohneEcho, p50: percentile(lat, 50), p95: percentile(lat, 95), max: Math.max(...lat), systemlast: spawnSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).stdout.trim() };
  expect(lat.length).toBeGreaterThanOrEqual(195);
  expect(percentile(lat, 95)).toBeLessThan(100);

  // Befehl tippen, Ausgabe erscheint (Claude-Bash-Modus mit „!").
  await page.keyboard.type("!echo term-$((6*7))");
  await page.keyboard.press("Enter");
  await expect.poll(() => termText(page), { timeout: 20_000 }).toMatch(/term-42/);
  results.step1_befehl = "term-42 erschienen";
  results.sessionClaudeStart = id;
});

test("Codex im Projekt, Claude + Codex in einer Worktree: Start < 3 s", async () => {
  const worktrees = spawnSync("ls", [WORKTREES], { encoding: "utf8" }).stdout.split("\n").filter((x) => x && !x.startsWith("_") && !x.startsWith("."));
  const wt = worktrees[0];
  test.skip(!wt, "keine Worktree vorhanden");
  const r: Record<string, unknown> = {};
  for (const [tool, folder] of [
    ["codex", PROJECT_LABEL],
    ["claude", `Worktree ${wt}`],
    ["codex", `Worktree ${wt}`],
  ] as const) {
    const s = await startViaUi(page, tool, folder);
    expect(s.status).toBe(200);
    // läuft es wirklich? tmux-Session existiert und der Prozess lebt nach 2 s noch.
    await page.waitForTimeout(2000);
    const alive = tmux("list-sessions", "-F", "#{session_name}").split("\n").includes(s.tmuxName);
    r[`${tool}@${folder}`] = { startedMs: s.startedMs, klickBisAntwortMs: s.apiMs, laeuftNach2s: alive };
    expect(s.apiMs).toBeLessThan(3000);
    expect(alive).toBe(true);
    tmux("kill-session", "-t", `=${s.tmuxName}`);
  }
  results.step4_weitere = r;
});

test("großer Verlauf (50.000 Zeilen in tmux) öffnet < 2 s, kein Einfrieren", async () => {
  // Echte Session mit Verlauf: eine Shell in tmux schreibt 50.000 farbige Zeilen; die Zuordnung braucht
  // eine Session-Zeile → wir hängen sie an die gerade gestartete Claude-Session? Nein: eigener Weg über
  // die Web-App ist nicht nötig — der Kanal selbst wird gemessen (WebSocket direkt, wie der Reiter).
  const name = "zc-claude-bigp3000";
  try {
    tmux("kill-session", "-t", `=${name}`);
  } catch {
    // gab es nicht
  }
  tmux("new-session", "-d", "-s", name, "-x", "160", "-y", "45", "--", "/bin/sh", "-c", "i=0; while [ $i -lt 50000 ]; do printf '\\033[3%dmZeile %d \\033[0m%s\\n' $((i%7+1)) $i 'Lorem ipsum dolor sit amet, consectetur adipiscing elit'; i=$((i+1)); done; exec sleep 600");
  await expect.poll(() => tmux("capture-pane", "-p", "-t", `=${name}:`), { timeout: 60_000 }).toContain("Zeile 49999");
  const hist = tmux("display", "-p", "-t", `=${name}:`, "#{history_size}").trim();
  // Session-Zeile für den Kanal: über den normalen Ingest wie die Brücke (Dev-Token).
  const sid = "p3-big-history-probe";
  await page.request.post("/ingest/events", {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { items: [{ type: "terminal", terminal: { tool: "claude", sessionId: sid, tmuxName: name, attachable: true, screenWaiting: null, observedAt: new Date().toISOString() } }] },
  });
  // Wie ein Nutzer: Session ist offen (Chat), dann Klick auf den Reiter „Terminal" → bis der Verlauf da ist.
  await page.goto(`/sessions/unsortiert/_/claude:${sid}`);
  const tab = page.getByRole("tab", { name: /^Terminal/ });
  await expect(tab).toBeEnabled({ timeout: 10_000 });
  const t0 = Date.now();
  await tab.click();
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
  await expect.poll(() => termText(page), { timeout: 5000, intervals: [20] }).toMatch(/Zeile 49999/);
  const openMs = Date.now() - t0;
  // Nur lange Aufgaben NACH dem Eintreffen des Bildschirm-Abzugs zählen (Laden der ganzen App davor
  // wird woanders gemessen) — das ist das „Einfrieren" beim Öffnen des Terminals.
  const longTasks = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const mark = performance.getEntriesByName("zc-terminal-snapshot").at(-1)?.startTime ?? 0;
        const d: number[] = [];
        new PerformanceObserver((l) => d.push(...l.getEntries().filter((e) => e.startTime + e.duration >= mark).map((e) => Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
        setTimeout(() => resolve(d.filter((x) => x > 200)), 500);
      }),
  );
  const appLoad = await page.evaluate(() => {
    const t = (n: string) => Math.round(performance.getEntriesByName(n).at(-1)?.startTime ?? -1);
    return { open: t("zc-terminal-open"), webgl: t("zc-terminal-webgl"), snapshot: t("zc-terminal-snapshot"), written: t("zc-terminal-snapshot-written") };
  });
  // Farben, Verlauf scrollbar: Zellfarbe aus dem Abzug + Zeilen im xterm-Verlauf.
  const buf = await page.evaluate(() => {
    const t = (window as unknown as { __zcTerm: { rows: number; buffer: { active: { length: number; baseY: number; getLine(i: number): { getCell(x: number): { isFgPalette(): boolean; getFgColor(): number } | undefined } | undefined } } } }).__zcTerm;
    const b = t.buffer.active;
    let colored = 0;
    for (let i = Math.max(0, b.length - 200); i < b.length; i++) if (b.getLine(i)?.getCell(0)?.isFgPalette()) colored++;
    return { zeilenImVerlauf: b.length, sichtbar: t.rows, farbigeZeilenVon200: colored };
  });
  results.step3_farbenVerlauf = buf;
  expect(buf.zeilenImVerlauf).toBeGreaterThan(4000);
  expect(buf.farbigeZeilenVon200).toBeGreaterThan(100);
  results.step6_grosserVerlauf = { tmuxHistoryZeilen: Number(hist), oeffnenMs: openMs, marken: appLoad, longTasksUeber200msNachAbzug: longTasks };
  expect(openMs).toBeLessThan(2000);
  tmux("kill-session", "-t", `=${name}`);
});

test("zweites Fenster (echtes Pseudo-Terminal mit der Shell-Funktion) + Browser: beide Eingaben kommen an", async () => {
  // Test-Shell mit eigener Funktionsdatei (nie ~/.zshrc), zeigt auf den tmux-Socket des lokalen Stacks.
  const shellDir = join(ROOT, ".probe", "shell");
  mkdirSync(shellDir, { recursive: true });
  execFileSync(join(ROOT, "node_modules/.bin/tsx"), [
    "-e",
    `import { zshFunctions, runnerScript, shellPaths } from "./apps/bridge/src/terminal/shell.ts"; import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
     const p = { ...shellPaths(${JSON.stringify(join(ROOT, ".probe"))}), conf: ${JSON.stringify(join(ROOT, ".probe", "tmux.conf"))} }; mkdirSync(p.dir, { recursive: true });
     writeFileSync(p.runner, runnerScript()); chmodSync(p.runner, 0o755);
     writeFileSync(p.zsh, zshFunctions({ tmuxBin: ${JSON.stringify(TMUX)}, projectRoot: ${JSON.stringify(PROJECT)}, paths: p, socket: ${JSON.stringify(SOCKET)} }));`,
  ], { cwd: ROOT });
  // Echtes Pseudo-Terminal wie in Terminal.app: Python `pty.spawn` (Standardbibliothek) startet zsh in
  // einem pty; was wir auf stdin schreiben, kommt wie Tastatureingaben im Fenster an.
  const outChunks: Buffer[] = [];
  const before = new Set(tmux("list-sessions", "-F", "#{session_name}").split("\n"));
  const cmd = `stty cols 110 rows 32; source ${join(ROOT, ".probe", "shell", "nyxos.zsh")}; cd ${PROJECT}; claude --model haiku; echo "exit=$?"`;
  const child = spawn("/usr/bin/python3", ["-c", "import pty,sys; pty.spawn(['/bin/zsh','-f','-c',sys.argv[1]])", cmd], { stdio: ["pipe", "pipe", "ignore"], detached: true });
  child.stdout.on("data", (d: Buffer) => outChunks.push(d));
  const type = (t: string) => child.stdin.write(t);
  try {
    let name = "";
    await expect
      .poll(() => (name = tmux("list-sessions", "-F", "#{session_name}").split("\n").find((n) => n.startsWith("zc-claude-") && !before.has(n)) ?? ""), { timeout: 15_000 })
      .not.toBe("");
    // Die NyxOS ordnet sie selbst zu (Brücke: pid → ~/.claude/sessions → Session-ID).
    let row: { id: string; attachable: boolean } | undefined;
    const t0 = Date.now();
    await expect.poll(async () => (row = (await sessionsApi(page)).find((s) => s.tmuxName === name))?.attachable ?? false, { timeout: 20_000 }).toBe(true);
    const erscheintMs = Date.now() - t0;
    await openTerminal(page, row?.id ?? "", false);
    await expect.poll(() => termText(page), { timeout: 30_000 }).toMatch(/❯/);
    await page.getByTestId("terminal-panel").locator(".xterm").click();
    await page.keyboard.type("vombrowser");
    await expect.poll(() => tmux("capture-pane", "-p", "-t", `=${name}:`), { timeout: 5000 }).toContain("vombrowser");
    type("-vomfenster");
    await expect.poll(() => termText(page), { timeout: 5000 }).toMatch(/vombrowser-vomfenster/);
    const pane = tmux("capture-pane", "-p", "-t", `=${name}:`);
    const fenster = Buffer.concat(outChunks).toString("utf8");
    results.step2_zweiFenster = { tmux: name, automatischInTmux: true, erscheintInWebAppMs: erscheintMs, beideEingabenImBildschirm: pane.includes("vombrowser-vomfenster"), fensterZeigtEingabe: fenster.includes("vomfenster") };
    expect(pane).toContain("vombrowser-vomfenster");
    // Beenden: Eingabe löschen, /exit → tmux-Session endet, Exit-Code kommt in der Shell an.
    type("\u0015");
    await page.waitForTimeout(300);
    type("/exit\r");
    await expect.poll(() => tmux("list-sessions", "-F", "#{session_name}").split("\n").includes(name), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => Buffer.concat(outChunks).toString("utf8"), { timeout: 5000 }).toMatch(/exit=\d+/);
    results.step2_exitCodeInShell = /exit=(\d+)/.exec(Buffer.concat(outChunks).toString("utf8"))?.[1];
  } finally {
    try {
      process.kill(-(child.pid ?? 0), "SIGTERM");
    } catch {
      // schon weg
    }
  }
});

test("kill -9 → „Neu starten“ mit --resume, Gespräch geht weiter; bei laufendem Prozess verweigert", async () => {
  const s = await startViaUi(page, "claude", "tools/NyxOS", "Merke dir das Codewort Kiwi-47. Antworte jetzt nur mit: OK");
  const id = `claude:${s.sessionId}`;
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
  await expect.poll(() => termText(page), { timeout: 60_000 }).toMatch(/⏺\s*OK/);
  // Start-Sperre: Prozess läuft noch → 409
  const token = await csrf(page);
  const refused = await page.request.post(`/api/sessions/${id}/resume`, { data: {}, headers: { "content-type": "application/json", "x-nyxos-csrf": token } });
  expect(refused.status()).toBe(409);
  // Absturz: kill -9 auf den Claude-Prozess im tmux-Feld.
  const panePid = tmux("display", "-p", "-t", `=${s.tmuxName}:`, "#{pane_pid}").trim();
  const claudePid = spawnSync("pgrep", ["-P", panePid], { encoding: "utf8" }).stdout.trim().split("\n")[0] || panePid;
  spawnSync("kill", ["-9", claudePid]);
  spawnSync("kill", ["-9", panePid]);
  await expect.poll(async () => (await sessionsApi(page)).find((x) => x.id === id)?.status, { timeout: 20_000 }).toBe("ended");
  await page.goto(`/sessions/unsortiert/_/${id}`);
  const btn = page.getByRole("button", { name: /Neu starten|In NyxOS fortsetzen/ });
  await expect(btn).toBeEnabled({ timeout: 10_000 });
  const buttonText = await btn.textContent();
  await btn.click();
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect.poll(() => termText(page), { timeout: 30_000 }).toMatch(/❯/);
  await page.getByTestId("terminal-panel").locator(".xterm").click();
  await page.keyboard.type("Wie lautete das Codewort? Antworte nur mit dem Codewort.");
  await page.keyboard.press("Enter");
  await expect.poll(() => termText(page), { timeout: 60_000 }).toMatch(/⏺\s*Kiwi-47/);
  results.step5 = { verweigertBeiLaufendemProzess: refused.status(), knopf: buttonText, gespraechGehtWeiter: "Kiwi-47 erinnert" };
  const row = (await sessionsApi(page)).find((x) => x.id === id);
  if (row?.tmuxName) tmux("kill-session", "-t", `=${row.tmuxName}`);
});

test("Rechner offline: Brücke stoppen → Reiter aus mit Hinweis, keine Konsolen-Fehler; Brücke an → von selbst zurück", async () => {
  const name = "zc-claude-offl0001";
  try {
    tmux("kill-session", "-t", `=${name}`);
  } catch {
    // gab es nicht
  }
  tmux("new-session", "-d", "-s", name, "--", "/bin/sh");
  await page.request.post("/ingest/events", {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { items: [{ type: "terminal", terminal: { tool: "claude", sessionId: "p3-offline-probe", tmuxName: name, attachable: true, screenWaiting: null, observedAt: new Date().toISOString() } }] },
  });
  await openTerminal(page, "claude:p3-offline-probe", false);
  consoleErrors.length = 0;
  const dataDir = join(ROOT, ".probe", "bridge-data");
  const pids = spawnSync("pgrep", ["-f", `run --data-dir ${dataDir}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  for (const pid of pids) spawnSync("kill", ["-TERM", pid]);
  const t0 = Date.now();
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "offline", { timeout: 10_000 });
  const offlineMs = Date.now() - t0;
  await expect(page.getByText("Der Rechner ist gerade nicht verbunden.")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Terminal/ })).toHaveAttribute("aria-disabled", "true");
  // Brücke wieder an (wie launchd KeepAlive es täte).
  const bridge = spawn(join(ROOT, "node_modules/.bin/tsx"), ["apps/bridge/src/main.ts", "run", "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", detached: true });
  bridge.unref();
  const t1 = Date.now();
  await expect(page.getByTestId("terminal-panel")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  results.step7 = { offlineErkanntMs: offlineMs, zurueckNachMs: Date.now() - t1, konsolenFehler: consoleErrors.slice(0, 5), neueBrueckePid: bridge.pid };
  expect(consoleErrors).toEqual([]);
  tmux("kill-session", "-t", `=${name}`);
});
