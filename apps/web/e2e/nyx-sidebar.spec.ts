// Nyx in der Leiste gegen den lokalen Server (Chromium UND WebKit): Sitz in der Leiste, gedrückt halten = sprechen,
// Nyx-Zentrum per Klick, Nyx-Cursor bei Befehlen. Reicht ohne Brücke — nur den Server starten:
//   PORT=47890 ARCHIVE_DIR=.probe/archive PGLITE_DIR=.probe/pglite WEB_DIR=apps/web/dist node_modules/.bin/tsx apps/server/src/dev.ts
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-sidebar.spec.ts --project chromium-1440 --project webkit-1440
// (oder einfach `pnpm dev`). Bilder → `.probe/shots/nyx-sidebar-*.png` (je Browser), Video → nyx-sidebar-cursor.webm (Chromium).
// Mikrofon: im Test eine Tonquelle (Oszillator) statt echtem Mikrofon; Erkennung + Nyx-Antwort per Route
// ersetzt (der lokale Stack hat keinen Sprach-Server und kein Modell) – geprüft wird die Oberfläche und die Verdrahtung.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const shot = (name: string) => resolve(SHOTS, name);
const LOGIN = process.env.E2E_LOGIN_FILE ?? resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.describe.configure({ mode: "serial", timeout: 90_000 });
test.use({ video: "on" });

let transcript = "Wie viele Sessions laufen gerade?";

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test.beforeEach(async ({ context, baseURL }) => {
  if (login) await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
  await context.addInitScript(() => {
    // Dauer-Zuhören aus, Vorlesen aus (kein Lautsprecher im Test).
    localStorage.setItem("nyxos:companion", JSON.stringify({ listening: false, speak: false }));
    // Mikrofon-Ersatz: ein leiser Ton, damit Aufnahme und Pegel echt laufen.
    const md = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: md });
    md.getUserMedia = async () => {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.frequency.value = 180;
      lfo.frequency.value = 3;
      lfoGain.gain.value = 0.25;
      gain.gain.value = 0.3;
      lfo.connect(lfoGain).connect(gain.gain);
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      lfo.start();
      return dest.stream;
    };
  });
  await context.route("**/api/nyx/voice/transcribe", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: transcript, language: "de", ms: 140 }) }));
  await context.route("**/api/haiku/status", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { engine: Record<string, unknown> };
    body.engine = { ...body.engine, state: "ready", available: true, reason: null, model: "haiku" };
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await context.route("**/api/haiku/chat", async (route) => {
    const text = "Gerade laufen zwei Sessions: „Nyx in der Leiste“ und „Heatmap-Farben“. Beide arbeiten, nichts wartet auf dich.";
    const lines = [{ type: "thread", threadId: 1 }, { type: "status", status: "tool", tool: "sessions_list" }, { type: "delta", text }, { type: "done", messageId: 1, text, sources: [], estimate: false, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } }];
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
  });
});

async function holdBar(page: Page, ms: number) {
  const box = await page.getByTestId("nyx-bar").boundingBox();
  if (!box) throw new Error("Nyx-Leiste nicht sichtbar");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("nyx-bar")).toHaveAttribute("data-phase", "talking", { timeout: 5_000 });
  await page.waitForTimeout(ms);
}

test("Nyx sitzt in der Leiste, kein Kreis mehr", async ({ page, browserName }) => {
  await page.goto("/overview");
  const bar = page.getByTestId("nyx-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Nyx");
  await expect(page.getByTestId("nyx-companion")).toHaveCount(0);
  // Die Leiste sitzt in der Kopfzeile.
  const top = await page.getByTestId("topbar").boundingBox();
  const b = await bar.boundingBox();
  expect(b && top && b.y >= top.y && b.y + b.height <= top.y + top.height).toBe(true);
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot(`nyx-sidebar-${browserName}.png`), clip: { x: 0, y: 0, width: 1440, height: 120 } });
});

test("Gedrückt halten = sprechen; Ausgabe-Feld unter der Leiste", async ({ page, browserName }) => {
  transcript = "Wie viele Sessions laufen gerade?";
  await page.goto("/overview");
  await holdBar(page, 900);
  await expect(page.getByTestId("nyx-bar-level")).toBeVisible();
  await expect(page.getByTestId("nyx-caption")).toContainText("Ich höre zu");
  await page.screenshot({ path: shot(`nyx-sidebar-speaking-${browserName}.png`), clip: { x: 0, y: 0, width: 1440, height: 300 } });
  await page.mouse.up();
  const caption = page.getByTestId("nyx-caption");
  await expect(caption.getByTestId("nyx-caption-heard")).toContainText("Wie viele Sessions laufen gerade?", { timeout: 10_000 });
  await expect(caption.getByTestId("nyx-caption-reply")).toContainText("zwei Sessions", { timeout: 10_000 });
  // Loslassen öffnet NICHT das Zentrum.
  await expect(page.getByRole("dialog", { name: "Nyx" })).toHaveCount(0);
  // Das Feld hängt direkt unter der Leiste.
  const bar = await page.getByTestId("nyx-bar").boundingBox();
  const cap = await caption.boundingBox();
  expect(bar && cap && cap.y - (bar.y + bar.height) < 20 && cap.y > bar.y).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot(`nyx-sidebar-output-${browserName}.png`), clip: { x: 0, y: 0, width: 1440, height: 360 } });
  // Tippen geht auch.
  await caption.getByLabel("Nachricht an Nyx").fill("Und was wartet auf mich?");
  await caption.getByLabel("Nachricht an Nyx").press("Enter");
  await expect(caption.getByTestId("nyx-caption-heard")).toContainText("Und was wartet auf mich?");
  await page.keyboard.press("Escape");
  await expect(caption).toHaveCount(0);
});

test("Klick = Nyx-Zentrum von oben (wie iOS), Kacheln, Esc/Ziehen schließt", async ({ page, browserName }) => {
  await page.goto("/overview");
  await page.getByTestId("nyx-bar").click();
  const center = page.getByRole("dialog", { name: "Nyx" });
  await expect(center).toHaveAttribute("data-state", "open");
  await page.waitForTimeout(700); // Feder ausgeschwungen
  const box = await center.boundingBox();
  const bar = await page.getByTestId("nyx-bar").boundingBox();
  expect(box && box.width <= 720 && Math.abs(box.x + box.width / 2 - 720) < 4).toBe(true); // mittig, ≤ 720 px
  expect(box && bar && box.y > bar.y + bar.height - 2 && box.y - (bar.y + bar.height) < 20).toBe(true); // hängt unter der Leiste
  await expect(center.getByRole("group", { name: "Schnell-Aktionen" })).toBeVisible();
  await expect(center.getByRole("button", { name: /Briefing vorlesen/ })).toBeVisible();
  await expect(center.getByRole("textbox", { name: "Frage an Nyx" })).toBeVisible();
  await page.screenshot({ path: shot(`nyx-sidebar-center-${browserName}.png`) });
  await page.keyboard.press("Escape");
  await expect(center).toHaveAttribute("data-state", "closed");
  // ⌘J öffnet wieder; nach oben ziehen schließt.
  await page.keyboard.press("Meta+j");
  await expect(center).toHaveAttribute("data-state", "open");
  await page.waitForTimeout(700);
  const handle = page.locator(".nyx-center [title='Nach oben ziehen zum Schließen']");
  const h = await handle.boundingBox();
  if (!h) throw new Error("Griff fehlt");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y - 140, { steps: 8 });
  await page.mouse.up();
  await expect(center).toHaveAttribute("data-state", "closed");
});

test("Befehl → Nyx-Cursor startet aus der Leiste, klickt, fliegt zurück", async ({ page, browserName }) => {
  transcript = "Öffne Git";
  await page.goto("/overview");
  await page.waitForTimeout(600);
  // Gesprochen: halten, „Öffne Git“, loslassen.
  await holdBar(page, 700);
  await page.mouse.up();
  const cursor = page.getByTestId("nyx-cursor");
  await expect(cursor).toHaveAttribute("data-mode", "out", { timeout: 8_000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(`nyx-sidebar-cursor-${browserName}.png`) });
  await expect(page).toHaveURL(/\/git$/, { timeout: 10_000 });
  await expect(cursor).toHaveAttribute("data-mode", "docked", { timeout: 8_000 });
  // Zurück in der Leiste: Cursor steht am Netz-Symbol.
  const anchor = await page.locator("[data-nyx-anchor]").boundingBox();
  const c = await cursor.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  expect(anchor && Math.hypot(c.x - (anchor.x + anchor.width / 2), c.y - (anchor.y + anchor.height / 2)) < 6).toBe(true);
  // Getippt: „zeig die Nutzung“ über das Ausgabe-Feld.
  await page.getByTestId("nyx-caption").getByLabel("Nachricht an Nyx").fill("Zeig die Nutzung");
  await page.getByTestId("nyx-caption").getByLabel("Nachricht an Nyx").press("Enter");
  await expect(cursor).toHaveAttribute("data-mode", "out", { timeout: 8_000 });
  await expect(page).toHaveURL(/\/usage$/, { timeout: 10_000 });
  await expect(cursor).toHaveAttribute("data-mode", "docked", { timeout: 8_000 });
  await page.waitForTimeout(600);
  const video = page.video();
  await page.close();
  if (browserName === "chromium") await video?.saveAs(shot("nyx-sidebar-cursor.webm"));
  else await video?.saveAs(shot(`nyx-sidebar-cursor-${browserName}.webm`));
});
