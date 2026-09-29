// Nyx-Tab gegen den lokalen Stack (Live-Ereignisse über /live, Nyx-Ablage, Anmeldung), mit Fake-Mikrofon
// (Chromium-Testgerät), Fake-Stimme (`/api/nyx/voice/*` → erzeugtes WAV) und Fake-Modell
// (`/api/haiku/chat` → feste NDJSON-Antwort). Aufruf:
//   NYXOS_HAIKU_SCHEDULER=0 pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-tab-states.spec.ts --project chromium-1440
// Bilder → `.probe/shots/` (anderer Ordner per E2E_SHOT_DIR).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request, test, type Page } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const shot = (name: string) => resolve(SHOTS, name);
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const login = existsSync(LOGIN) ? (JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string }) : null;

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/**
 * Fake-Mikrofon im Browser: Chromiums Test-Gerät (`--use-fake-device-for-media-stream`) hängt auf macOS in
 * `getUserMedia` (Systemfreigabe) — darum ein sprachähnliches Signal aus Web Audio (Grundton + Obertöne,
 * Silben-Hüllkurve). Die App nimmt es wie ein echtes Mikro auf (MediaRecorder, Pegel, Bänder).
 */
async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const syll = ac.createGain();
      syll.gain.value = 0.25;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 4.2;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 0.25;
      lfo.connect(lfoGain).connect(syll.gain);
      for (const [f, g] of [
        [170, 0.5],
        [340, 0.3],
        [900, 0.18],
        [2400, 0.08],
      ] as const) {
        const o = ac.createOscillator();
        o.frequency.value = f;
        const og = ac.createGain();
        og.gain.value = g;
        o.connect(og).connect(syll);
        o.start();
      }
      syll.connect(dest);
      lfo.start();
      return dest.stream;
    };
  });
}

/** Sprachähnliches WAV (16 kHz, mono): Grundton mit Silben-Hüllkurve — damit der Ausgangspegel sichtbar pulsiert. */
function speechWav(seconds: number): Buffer {
  const rate = 16_000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.max(0, Math.sin(t * Math.PI * 4.5)) ** 0.6;
    const v = env * (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t) + 0.15 * Math.sin(2 * Math.PI * 1200 * t));
    buf.writeInt16LE(Math.round(v * 12_000), 44 + i * 2);
  }
  return buf;
}

const QUESTION = "Welche Session wartet gerade auf mich?";
const ANSWER = "Die Session „Nyx-Tab bauen“ wartet auf dich. Sie braucht deine Freigabe für den Push. Ich habe dir die Karte in die Entscheidungen gelegt.";

interface Calls {
  chat: unknown[];
  interrupted: unknown[];
  transcribe: number;
  speak: string[];
}

async function fakeVoiceAndModel(page: Page, chatDelayMs: number): Promise<Calls> {
  const calls: Calls = { chat: [], interrupted: [], transcribe: 0, speak: [] };
  await page.route("**/api/nyx/voice/status", (r) => r.fulfill({ json: { stt: { model: "fake-whisper", ready: true }, tts: { voice: "fake-thorsten", ready: true } } }));
  await page.route("**/api/nyx/voice/transcribe", async (r) => {
    calls.transcribe++;
    await new Promise((res) => setTimeout(res, 380));
    await r.fulfill({ json: { text: calls.transcribe === 1 ? QUESTION : "Stopp, danke.", language: "de", ms: 380 } });
  });
  await page.route("**/api/nyx/voice/speak**", async (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { text?: string };
    calls.speak.push(body.text ?? "");
    await new Promise((res) => setTimeout(res, 180));
    await r.fulfill({ status: 200, headers: { "content-type": "audio/wav" }, body: speechWav(Math.min(6, 0.6 + (body.text ?? "").length / 14)) });
  });
  await page.route("**/api/haiku/chat", async (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { message?: string };
    calls.chat.push(body);
    const first = calls.chat.length === 1;
    if (first) await new Promise((res) => setTimeout(res, chatDelayMs));
    const text = first ? ANSWER : "Alles klar.";
    const lines = [
      { type: "thread", threadId: 990_001 },
      { type: "status", status: "tool", tool: "sessions_suchen" },
      { type: "delta", text },
      { type: "done", messageId: 1, text, sources: [], estimate: false, usage: { inputTokens: 5120, outputTokens: 64, costUsd: 0.0061, durationMs: 1650 }, callId: 1 },
    ];
    await r.fulfill({ status: 200, headers: { "content-type": "application/x-ndjson" }, body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
  });
  await page.route("**/api/haiku/threads/990001/interrupted", async (r) => {
    calls.interrupted.push(JSON.parse(r.request().postData() ?? "{}"));
    await r.fulfill({ json: { messageId: 2, text: "" } });
  });
  return calls;
}

/** Echte Server-Meldung (wie der Nyx-Kern sie schickt) — geht über /live an den Tab. */
async function nyxEvent(page: Page, body: unknown) {
  const res = await page.request.post("/api/nyx/events", { data: body, headers: { "x-nyxos-csrf": login?.csrf ?? "" } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!login, "Anmeldung des lokalen Stacks fehlt (.probe/probe-login.json)");
  await context.addCookies([{ name: "nyxos_session", value: login?.token ?? "", url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Vollbild: Netz reagiert auf idle/listening/thinking/tool/speaking, Unterbrechen speichert Gehörtes", async ({ page }) => {
  const calls = await fakeVoiceAndModel(page, 3500);
  await fakeMic(page);
  await page.goto("/nyx");
  const net = page.locator('[data-nyx="nyx-netz"]');
  await expect(net).toHaveAttribute("data-state", "idle", { timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Nyx" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot("nyx-tab-idle.png") });

  // Aufwecken (Mikro-Freigabe = Fake-Gerät), dann Leertaste halten → hört zu.
  await page.getByRole("button", { name: "Nyx wecken" }).click();
  await expect(page.getByRole("button", { name: "Mikro aus" })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Space");
  await expect(net).toHaveAttribute("data-state", "listening");
  await page.waitForTimeout(1400);
  await page.screenshot({ path: shot("nyx-tab-listening.png") });

  // Loslassen → Erkennung (Fake) → Frage geht an Nyx → denkt.
  await page.keyboard.up("Space");
  await expect(page.locator('[data-nyx="nyx-untertitel"]').getByText(QUESTION)).toBeVisible({ timeout: 10_000 });
  await expect(net).toHaveAttribute("data-state", "thinking");
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot("nyx-tab-thinking.png") });

  // Der Kern meldet ein Werkzeug (echter Server → /live) → Knoten leuchtet mit Namen.
  await nyxEvent(page, { kind: "state", event: { state: "tool", tool: "sessions_suchen", detail: "Suche wartende Sessions" } });
  await nyxEvent(page, { kind: "task", event: { taskId: "e2e-1", phase: "started", title: "Wartende Sessions finden", where: "Sessions", href: "/sessions", tool: "sessions_suchen" } });
  await nyxEvent(page, { kind: "task", event: { taskId: "e2e-1", phase: "step", title: "Wartende Sessions finden", step: { index: 0, label: "Sessions durchsuchen", status: "done" } } });
  await nyxEvent(page, { kind: "task", event: { taskId: "e2e-1", phase: "step", title: "Wartende Sessions finden", step: { index: 1, label: "Freigaben prüfen", status: "running", total: 2 } } });
  await expect(net).toHaveAttribute("data-state", "tool");
  await expect(net).toHaveAttribute("data-tool", "sessions_suchen");
  await page.waitForTimeout(900);
  await page.screenshot({ path: shot("nyx-tab-tool.png") });
  await nyxEvent(page, { kind: "state", event: { state: "idle" } });

  // Antwort kommt → Satz für Satz gesprochen (Fake-Stimme) → spricht, Untertitel zeigt den aktuellen Satz.
  await expect(net).toHaveAttribute("data-state", "speaking", { timeout: 15_000 });
  await expect(page.locator('[data-nyx="nyx-untertitel"]').getByText(/wartet auf dich/)).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("nyx-tab-speaking.png") });
  const timings = await page.evaluate(() => window.__nyxTimings ?? []);
  expect(timings.length).toBeGreaterThan(0);
  console.log(`Nyx-Tab-Zeiten (Fake-Stimme/Fake-Modell, Modell-Wartezeit 3,5 s eingebaut): ${JSON.stringify(timings[0])}`);
  test.info().annotations.push({ type: "zeiten", description: JSON.stringify(timings[0]) });
  expect(calls.speak[0]).toBe("Die Session „Nyx-Tab bauen“ wartet auf dich.");

  // Reinsprechen → Stimme sofort aus, der gehörte Teil geht als „unterbrochen“ an den Server.
  await page.keyboard.down("Space");
  await expect(net).toHaveAttribute("data-state", "listening");
  await expect.poll(() => calls.interrupted.length).toBe(1);
  const heard = (calls.interrupted[0] as { heard: string }).heard;
  expect(ANSWER.startsWith(heard.replace(/ …$/, ""))).toBe(true);
  await expect(page.locator('[data-nyx="nyx-untertitel"]').getByText("unterbrochen")).toBeVisible();
  await page.keyboard.up("Space");
  await expect(page.getByText("unterbrochen", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: shot("nyx-tab-interrupted.png") });

  // Aufgaben live: die Karte des Kerns mit Schritten.
  await page.getByRole("tab", { name: /Aufgaben live/ }).click();
  const card = page.getByRole("article", { name: "Aufgabe: Wartende Sessions finden" });
  await expect(card.getByText("Freigaben prüfen")).toBeVisible();
  // Kontext: Kosten je Antwort + gemessene Zeiten.
  await page.getByRole("tab", { name: /Kontext/ }).click();
  await expect(page.locator('[data-nyx="nyx-zeiten"]')).toBeVisible();
  await page.screenshot({ path: shot("nyx-tab-context.png") });
  expect(calls.chat[0]).toMatchObject({ message: QUESTION, channel: "voice" });
});

test("Bilder: Galerie, groß ansehen, herunterladen (echte Ablage auf dem lokalen Server)", async ({ page, baseURL }) => {
  await fakeVoiceAndModel(page, 0);
  // Zwei echte Bilder in die Nyx-Ablage (so, wie ein Nutzer sie hineinzieht) — Aufnahmen aus NyxOS selbst.
  await page.goto("/overview");
  await page.waitForTimeout(1500);
  const a = await page.screenshot();
  await page.goto("/gehirn");
  await page.waitForTimeout(2500);
  const b = await page.screenshot();
  const ids: number[] = [];
  for (const [name, bytes] of [
    ["Überblick.png", a],
    ["Gehirn.png", b],
  ] as const) {
    const res = await page.request.post("/api/nyx/files", { data: bytes, headers: { "content-type": "image/png", "x-nyx-file-name": encodeURIComponent(name), "x-nyxos-csrf": login?.csrf ?? "" } });
    expect(res.status()).toBe(200);
    ids.push(((await res.json()) as { file: { id: number } }).file.id);
  }
  // Nyx zeigt eins davon als Vorschau in „Aufgaben live“ (Ereignis über den echten Server).
  await page.goto("/nyx?r=bilder");
  await nyxEvent(page, { kind: "task", event: { taskId: "e2e-bild", phase: "done", title: "Screenshot gezeigt", image: { fileId: ids[1], title: "Gehirn" } } });
  const gallery = page.locator('[data-nyx="nyx-galerie"]');
  await expect(gallery.getByRole("button", { name: /Bild öffnen: Gehirn\.png/ }).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("nyx-tab-images.png") });

  await gallery.getByRole("button", { name: /Bild öffnen: Gehirn\.png/ }).first().click();
  const viewer = page.getByRole("dialog", { name: /Bild: Gehirn\.png/ });
  await expect(viewer).toBeVisible();
  const href = await viewer.getByRole("link", { name: "Herunterladen" }).getAttribute("href");
  expect(href).toBe(`/api/nyx/files/${ids[1]}?download=1`);
  const dl = await page.request.get(href ?? "");
  expect(dl.headers()["content-disposition"]).toMatch(/^attachment; filename="Gehirn\.png"/);
  expect((await dl.body()).subarray(1, 4).toString()).toBe("PNG");
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("nyx-tab-image-large.png") });
  // Ohne Anmeldung gibt es die Bilder nicht.
  const anonCtx = await request.newContext({ baseURL });
  expect((await anonCtx.get(`/api/nyx/files/${ids[0]}`)).status()).toBe(401);
  await anonCtx.dispose();
});
