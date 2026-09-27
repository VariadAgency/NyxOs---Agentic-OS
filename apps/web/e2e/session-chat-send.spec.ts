// Session-Chat mit einer ECHTEN, harmlosen Claude-Session (Modell Haiku) auf dem eigenen tmux-Socket des
// lokalen Stacks (nie echte Sessions, nie `-L nyxos`):
//   NYXOS_HAIKU_SCHEDULER=0 pnpm dev
//   pnpm --filter @nyxos/web exec playwright test e2e/session-chat-send.spec.ts --project chromium-1440
// Szenario: Nachricht + Bild senden → Antwort erscheint. Dazu 3.000 Zeichen, Kopf mit aktuellem Modell +
// Prüfung, Info-Balken, einzeiliger Kopf bei 1280/1440/1920. Screenshots nach `.probe/shots/`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
const WORKTREE = resolve(process.cwd(), "../..");
const SOCKET = process.env.PROBE_TMUX_SOCKET ?? "nyxos-probe";
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "tmux"].find((p) => p === "tmux" || spawnSync(p, ["-V"]).status === 0) ?? "tmux";

/** 64×64 rotes PNG (ohne Bild-Bibliothek). */
function redPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, () => [220, 20, 60]).flat())]);
  const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
let sessionUrl = "";
let tmuxName = "";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test.afterAll(() => {
  // Nur die eigene Test-Session auf dem Socket des lokalen Stacks beenden — keine anderen Sessions.
  if (tmuxName) spawnSync(TMUX, ["-L", SOCKET, "kill-session", "-t", `=${tmuxName}`]);
});

async function openChat(page: Page) {
  await page.goto(sessionUrl);
  await expect(page.getByRole("textbox", { name: "Nachricht an Claude" })).toBeEnabled({ timeout: 60_000 });
}

test("Nachricht + Bild an eine echte Session senden, die Antwort erscheint", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await page.goto("/sessions");
  // Harmlose Claude-Session (Haiku) auf dem Socket des lokalen Stacks starten — wie der Knopf „Neue Session“.
  const started = await page.evaluate(
    async ({ csrf, cwd }) => {
      const r = await fetch("/api/terminal/start", { method: "POST", headers: { "content-type": "application/json", "x-nyxos-csrf": csrf }, body: JSON.stringify({ tool: "claude", model: "haiku", cwd, prompt: null }) });
      return { status: r.status, body: (await r.json()) as { sessionId?: string; tmuxName?: string } };
    },
    { csrf: login.csrf, cwd: WORKTREE },
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const sid = started.body.sessionId as string;
  tmuxName = started.body.tmuxName ?? "";
  sessionUrl = `${baseURL}/sessions/unsortiert/_/claude:${sid}`;
  // Claude braucht ein paar Sekunden, bis die Eingabe bereit ist.
  await page.waitForTimeout(8000);
  await openChat(page);

  const box = page.getByRole("textbox", { name: "Nachricht an Claude" });
  await page.getByTestId("chat-file-input").setInputFiles({ name: "rot.png", mimeType: "image/png", buffer: redPng() });
  await expect(page.getByTestId("chat-attachment")).toContainText("rot.png");
  await box.fill("e2e: Welche Farbe hat dieses Bild?\nAntworte nur mit einem Wort.");
  await box.press("Enter");
  await expect(page.getByTestId("chat-pending")).toBeVisible();
  // Antwort von Claude im Verlauf (über Brücke → Archiv → Transkript → /live).
  await expect(page.locator("[data-item-id]").filter({ hasText: /ASSISTENT/ }).getByTestId("chat-message-body").filter({ hasText: /^\s*rot\W*$/i }).last()).toBeVisible({ timeout: 150_000 });
  await expect(page.locator("[data-item-id]").filter({ hasText: "Welche Farbe hat dieses Bild?" }).last()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/chat-send.png` });
});

test("Eine 3.000-Zeichen-Nachricht steht ganz im Chat, Anfang und Ende sichtbar", async ({ page }) => {
  test.setTimeout(240_000);
  await openChat(page);
  const long = `probe-da ANFANG ${"Lorem ipsum dolor sit amet, ".repeat(110)}`.slice(0, 2960) + " ENDE-DER-NACHRICHT. Antworte nur mit OK.";
  expect(long.length).toBeGreaterThanOrEqual(3000);
  const box = page.getByRole("textbox", { name: "Nachricht an Claude" });
  await box.fill(long);
  await box.press("Enter");
  const bubble = page.locator("[data-item-id]").filter({ hasText: "probe-da ANFANG" }).last();
  await expect(bubble).toBeVisible({ timeout: 150_000 });
  const toggle = bubble.getByRole("button", { name: /Ganze Nachricht zeigen/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(bubble.getByText(/ENDE-DER-NACHRICHT/)).toBeVisible();
  await expect(bubble.getByText(/probe-da ANFANG/)).toBeVisible();
  // Bildschirmfoto: das Ende der aufgeklappten Nachricht (der Anfang steht darüber, s. Prüfung oben).
  await bubble.getByRole("button", { name: /Weniger zeigen/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/chat-long-message.png` });
});

test("Kopf zeigt das aktuelle Modell; Prüfung durch Haiku hängt an der Session", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await openChat(page);
  await expect(page.getByTestId("session-model")).toContainText(/haiku/i);
  const audit = page.getByRole("button", { name: "Session zusammenfassen & prüfen" });
  await expect(audit).toBeEnabled({ timeout: 30_000 });
  await audit.click();
  const card = page.getByTestId("session-audit");
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("prüft die Session gerade", { timeout: 240_000 });
  await expect(card).toContainText(/Qualität|nicht fertig|unvollständig/);
  await page.screenshot({ path: `${SHOTS}/chat-head-model.png` });
});

test("Infos klappen zu einem dünnen Balken, Zustand bleibt nach Neuladen", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Infos einklappen" }).click();
  const rail = page.getByTestId("session-info-rail");
  await expect(rail).toBeVisible();
  const railBox = await rail.boundingBox();
  expect(railBox?.width ?? 999).toBeLessThanOrEqual(56);
  await page.reload();
  await expect(page.getByTestId("session-info-rail")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/chat-info-bar.png` });
  await page.getByRole("button", { name: "Infos ausklappen" }).click();
  await expect(page.getByTestId("session-info")).toBeVisible();
});

for (const width of [1280, 1440, 1920]) {
  test(`Session-Kopf in EINER Zeile bei ${width} px, nichts bricht um`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openChat(page);
    await page.waitForTimeout(800);
    const head = page.getByTestId("session-head");
    const m = await head.evaluate((el) => {
      const hb = el.getBoundingClientRect();
      const ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a-ctl-h")) || 30;
      const visible = [...el.querySelectorAll<HTMLElement>("button, [data-testid=session-model], span.truncate, b")].filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden";
      });
      const centers = visible.map((n) => {
        const r = n.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      const buttons = [...el.querySelectorAll<HTMLElement>("button")].filter((b) => b.getBoundingClientRect().width > 0);
      return {
        headHeight: hb.height,
        headWidth: hb.width,
        scrollWidth: el.scrollWidth,
        ctl,
        spread: Math.max(...centers) - Math.min(...centers),
        buttonHeights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
        buttonLines: buttons.map((b) => Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight || "16"))),
      };
    });
    // Eine Zeile: Höhe = Bedienelement + Innenabstand, alle Mitten auf einer Linie, nichts ragt heraus.
    expect(m.headHeight, JSON.stringify(m)).toBeLessThanOrEqual(m.ctl + 20);
    expect(m.spread, JSON.stringify(m)).toBeLessThanOrEqual(3);
    expect(m.scrollWidth, JSON.stringify(m)).toBeLessThanOrEqual(Math.ceil(m.headWidth) + 1);
    for (const h of m.buttonHeights) expect(h, JSON.stringify(m)).toBeLessThanOrEqual(m.ctl + 1);
    await head.screenshot({ path: `${SHOTS}/chat-head-${width}.png` });
  });
}
