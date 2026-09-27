// Briefing zum Anhören gegen den lokalen Server (echter Bericht, echte Sprechfassung vom Server).
// Nur die Stimme selbst ist nachgestellt (ohne Stimmen-Dienst): `/api/nyx/voice/speak` liefert
// ein kurzes stilles WAV, `/api/nyx/voice/status` meldet „bereit“. Geprüft wird: Knopf → Kopf hervorgehoben,
// Rest abgedunkelt, Untertitel; die Hervorhebung wandert mit den Sätzen (Braucht dich → Kacheln → Abschnitte);
// Anfragen gehen als WAV mit `speed`, der nächste Satz wird vorgeladen; Esc beendet; `?vorlesen=1` startet selbst.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   (oder nur der Server ohne Brücke: PORT=47890 ARCHIVE_DIR=.probe/archive PGLITE_DIR=.probe/pglite WEB_DIR=apps/web/dist
//    node_modules/.bin/tsx apps/server/src/dev.ts)
//   pnpm --filter @nyxos/web exec playwright test e2e/briefing-read-aloud.spec.ts --workers=1
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");

test.describe.configure({ timeout: 240_000, mode: "serial" });
test.use({ video: { mode: "on", size: { width: 1280, height: 800 } } });

async function signIn(context: BrowserContext, url: string) {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url }]);
  return { cookie: `nyxos_session=${login.token}`, "x-nyxos-csrf": login.csrf, "content-type": "application/json" };
}

/** Stilles WAV (16 kHz, mono, 16 Bit) – so lang wie ein kurzer Satz. */
function silentWav(seconds: number): Buffer {
  const rate = 16_000;
  const samples = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

type Speak = { url: string; text: string; speed?: number; at: number };

async function fakeVoice(page: Page): Promise<Speak[]> {
  const calls: Speak[] = [];
  await page.route("**/api/nyx/voice/status", (route) =>
    route.fulfill({ json: { stt: { ready: true, state: "ready", progress: null, bytesTotal: null }, tts: { ready: true, state: "ready", progress: null, bytesTotal: null, voice: "probe", voices: [] }, sentence: "Stimme bereit.", fix: null } }),
  );
  await page.route("**/api/nyx/voice/speak**", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { text: string; speed?: number };
    calls.push({ url: route.request().url(), text: body.text, speed: body.speed, at: Date.now() });
    await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(1.4) });
  });
  return calls;
}

/** Probe ohne Brücke: ein paar Sessions und Aufträge, damit das Briefing etwas zu erzählen hat. */
const summary = (sessionId: string, title: string, minutesAgo: number) => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    type: "summary",
    summary: {
      sessionId,
      tool: "claude",
      parentSessionId: null,
      cwd: "/Users/alex/projects/atlas/tools/nyxos",
      title,
      titleSource: null,
      startedAt: at,
      lastActivityAt: at,
      models: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 },
      toolCalls: {},
      filesWritten: [],
      filesRead: [],
      subagents: [],
      gitBranch: null,
      cliVersion: null,
      eventCount: 0,
      parseErrors: 0,
      limits: null,
      lastUsage: null,
      lastUsageModel: null,
      modelContextWindow: null,
    },
  };
};

test.beforeAll(async ({ request, baseURL }) => {
  const base = baseURL ?? "";
  const ing = await request.post(`${base}/ingest/events`, {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { items: [summary("t5-probe-1", "Briefing vorlesen bauen", 4), summary("t5-probe-2", "Heatmap-Farben", 35), summary("t5-probe-3", "Telegram-Bot", 80)] },
  });
  expect(ing.ok()).toBe(true);
});

const activeTarget = (page: Page) => page.evaluate(() => document.querySelector("[data-speech-active]")?.getAttribute("data-speech-target") ?? null);

async function saveVideo(page: Page, name: string) {
  const video = page.video();
  await page.close();
  const path = await video?.path();
  if (path) copyFileSync(path, resolve(SHOTS, name));
}

test("Vorlesen hebt den erwähnten Abschnitt hervor, dunkelt den Rest ab und folgt den Sätzen", async ({ page, context, request, baseURL, browserName }) => {
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(context, baseURL ?? "http://127.0.0.1:47890");
  const created = await request.post("/api/haiku/report", { headers, data: { kind: "briefing" } });
  expect(created.status(), await created.text()).toBe(200);
  const report = ((await created.json()) as { report: { id: number } }).report;

  // Sprechfassung vom echten Server: jeder Satz mit Abschnitt + Stelle, gesprochen ohne Ziffern.
  const sp = await request.get(`/api/briefing/${report.id}/speech`, { headers });
  expect(sp.status()).toBe(200);
  const speech = ((await sp.json()) as { speech: { sentences: { section: string; target: string; text: string }[] } }).speech;
  expect(speech.sentences.length).toBeGreaterThanOrEqual(6);
  for (const s of speech.sentences) {
    expect(s.target).toMatch(/^(headline|needs|tile:[a-z_]+|group:(lief|haengt|naechstes))$/);
    expect(s.text).not.toMatch(/\d/);
  }

  const calls = await fakeVoice(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/briefing?art=briefing");
  await expect(page.getByTestId("briefing-headline")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(900);

  const btn = page.getByRole("button", { name: /Vorlesen/ });
  await expect(btn).toBeEnabled();
  await btn.click();

  // Satz 1: Kopf leuchtet, der Rest bleibt lesbar (nicht abgedunkelt), Untertitel steht da.
  await expect.poll(() => activeTarget(page), { timeout: 15_000 }).toBe(speech.sentences[0]?.target);
  await expect(page.getByTestId("speech-subtitle")).toHaveText(speech.sentences[0]?.text ?? "");
  const dim = await page.evaluate(() => {
    const kpis = document.querySelector('[data-testid="briefing-kpis"]');
    const head = document.querySelector("[data-speech-active]");
    return { kpis: kpis ? getComputedStyle(kpis).filter : "", head: head ? getComputedStyle(head).filter : "" };
  });
  expect(dim.kpis).toBe("none");
  expect(dim.head).toBe("none");
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, `read-aloud-head-${browserName}.png`) });

  // WAV (Safari) mit Tempo nur als speed; der nächste Satz wurde vorgeladen, bevor der erste zu Ende war.
  await expect.poll(() => calls.length).toBeGreaterThanOrEqual(2);
  // Format wählt die bestehende Server-Stimme (`preferWav`: WAV nur, wenn der Browser kein Ogg/Opus kann);
  // playbackRate bleibt 1 (Web-Test `briefing-read-aloud.test.tsx`).
  const format = await page.evaluate(() => (new Audio().canPlayType('audio/ogg; codecs="opus"') === "" ? "wav" : "ogg"));
  expect(calls[0]?.url.includes("format=wav")).toBe(format === "wav");
  expect(calls[1]?.text).toBe(speech.sentences[1]?.text);

  // Die Hervorhebung folgt den Sätzen – bis zu einer Kachel.
  const tileIdx = speech.sentences.findIndex((s) => s.target.startsWith("tile:"));
  const seen = new Set<string>();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const t = await activeTarget(page);
    if (t) seen.add(t);
    if (tileIdx >= 0 && t === speech.sentences[tileIdx]?.target) break;
    await page.waitForTimeout(150);
  }
  expect([...seen].slice(0, 2)).toEqual([...new Set(speech.sentences.map((s) => s.target))].slice(0, 2));
  if (tileIdx >= 0) {
    await expect.poll(() => activeTarget(page)).toBe(speech.sentences[tileIdx]?.target);
    // die leuchtende Kachel ist im Blick (sanft gescrollt)
    const box = await page.locator("[data-speech-active]").boundingBox();
    expect(box && box.y >= 0 && box.y + box.height <= 800).toBe(true);
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(SHOTS, `read-aloud-tile-${browserName}.png`) });
  }

  // Tempo: ab dem nächsten Satz als speed an den Server; Pause/Weiter.
  await page.getByRole("group", { name: "Tempo" }).getByRole("button", { name: "1,15×" }).click();
  await expect.poll(() => calls.some((c) => c.speed === 1.15), { timeout: 15_000 }).toBe(true);
  await page.getByRole("button", { name: /Pause/ }).click();
  await expect(page.getByRole("button", { name: /Weiter/ })).toBeVisible();
  await page.getByRole("button", { name: /Weiter/ }).click();

  // Esc beendet: nichts mehr hervorgehoben oder abgedunkelt.
  await page.keyboard.press("Escape");
  await expect.poll(() => activeTarget(page)).toBeNull();
  await expect(page.getByTestId("speech-subtitle")).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector("[data-reading]") === null)).toBe(true);
  await saveVideo(page, `read-aloud-${browserName}.webm`);
});

test("„Lies mir das Briefing vor“ – ?vorlesen=1 startet von selbst (wie von Nyx geöffnet)", async ({ page, context, baseURL, browserName }) => {
  await signIn(context, baseURL ?? "http://127.0.0.1:47890");
  await fakeVoice(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Erst eine andere Seite mit einem Klick (wie im echten Betrieb: NyxOS ist schon offen), dann navigiert Nyx.
  await page.goto("/overview");
  await page.mouse.click(5, 5);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/briefing?vorlesen=1&art=briefing");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("region", { name: "Vorlesen" })).toBeVisible({ timeout: 60_000 });
  // Läuft der Ton, leuchtet der Kopf; hat der Browser ihn blockiert, steht „Weiter“ mit Hinweis da.
  const blocked = await page.getByRole("button", { name: /Weiter/ }).isVisible();
  if (blocked) await page.getByRole("button", { name: /Weiter/ }).click();
  await expect.poll(() => activeTarget(page), { timeout: 15_000 }).toBe("headline");
  expect(new URL(page.url()).searchParams.get("vorlesen")).toBeNull();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, `read-aloud-nyx-start-${browserName}.png`) });
  await page.keyboard.press("Escape");
  await page.close();
});
