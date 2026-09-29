// & Unterstützen im echten Browser, gegen einen echten NyxOS-Server und eine Attrappe der Meldestelle.
//
// Läuft gegen den Probe-Stack (`pnpm dev`, Anmeldung über .probe/probe-login.json) oder gegen einen lokalen Server
// (`local.ts`) + Vite: dann `E2E_BASE_URL` (Vite), `E2E_NYXOS_API` (Server) und `E2E_NYXOS_HOME` (Datenordner mit
// dem Maschinen-Token für die Einmal-Anmeldung) setzen. Der Server braucht `NYXOS_ALLOW_PRIVATE_URLS=1`, damit er die
// Attrappe auf 127.0.0.1 erreichen darf. Bilder (JPEG) nur mit `E2E_SHOTS=<ordner>`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Free port chosen at start (0 = the system picks one), so parallel runs never collide. */
const SUPPORT_PORT = Number(process.env.E2E_SUPPORT_PORT ?? 0);
let SUPPORT_BASE = "";
const SHOTS = process.env.E2E_SHOTS;

interface Received {
  path: string;
  body: Record<string, unknown>;
  key: string | undefined;
}
const received: Received[] = [];

const EMBED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px system-ui;margin:0;padding:24px;background:#fff;color:#111}button{font:inherit;padding:12px 18px;margin-right:8px}
</style></head><body><h1>Attrappe: Bezahlseite</h1><p id="amount"></p>
<button id="pay">Jetzt bezahlen (Attrappe)</button><button id="cancel">Abbrechen</button>
<script>
const post = (m) => parent.postMessage(m, "*");
document.getElementById("amount").textContent = new URLSearchParams(location.search).get("amount") + " Cent";
document.getElementById("pay").onclick = () => post({ type: "nyxos-support:paid", reference: "D-1" });
document.getElementById("cancel").onclick = () => post({ type: "nyxos-support:cancelled" });
post({ type: "nyxos-support:ready" });
post({ type: "nyxos-support:resize", height: 320 });
</script></body></html>`;

/** Attrappe der Meldestelle (Vertrag: docs/support-api.md). */
function startFakeSupport(): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1/");
    if (req.method === "GET" && url.pathname === "/embed/donate") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(EMBED_PAGE);
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      received.push({ path: url.pathname, body, key: req.headers["idempotency-key"] as string | undefined });
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/v1/bug" || url.pathname === "/v1/idea") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: `NYX-${received.length}`, message: "Danke, ist angekommen!" }));
      } else if (url.pathname === "/v1/donate/session") {
        res.writeHead(200);
        res.end(JSON.stringify({ embedUrl: `${SUPPORT_BASE}embed/donate?amount=${String(body.amountCents)}` }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "not_found", message: "Unbekannt" } }));
      }
    });
  });
  return new Promise((ok) =>
    server.listen(SUPPORT_PORT, "127.0.0.1", () => {
      const addr = server.address();
      SUPPORT_BASE = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : SUPPORT_PORT}/`;
      ok(server);
    }),
  );
}

async function signIn(page: Page, baseURL: string): Promise<void> {
  const home = process.env.E2E_NYXOS_HOME;
  if (home) {
    const api = process.env.E2E_NYXOS_API ?? baseURL;
    const token = readFileSync(join(home, "data", "bridge-token"), "utf8").trim();
    const res = await fetch(`${api}/local/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { code } = (await res.json()) as { code: string };
    // Cookies gelten je Host (nicht je Port): die Anmeldung am Server gilt auch für Vite auf demselben Host.
    await page.goto(`${api}/auth/local?code=${encodeURIComponent(code)}&next=/health`);
  } else {
    const file = resolve(process.cwd(), "../../.probe/probe-login.json");
    if (!existsSync(file)) throw new Error("Keine Anmeldung: E2E_NYXOS_HOME setzen oder den Probe-Stack starten");
    const login = JSON.parse(readFileSync(file, "utf8")) as { token: string };
    await page.context().addCookies([{ name: "nyxos_session", value: login.token, url: baseURL }]);
  }
}

async function api(page: Page, method: "PUT" | "POST", path: string, body: unknown) {
  const status = await (await page.request.get("/api/auth/status")).json();
  return page.request.fetch(path, { method, data: body, headers: { "content-type": "application/json", "x-nyxos-csrf": String(status.csrf) } });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // Einblenden (150 ms) abwarten
  await page.screenshot({ path: join(SHOTS, `${name}.jpg`), type: "jpeg", quality: 70 });
}

async function openFromStatusLine(page: Page) {
  const button = page.getByRole("button", { name: "Feedback & Unterstützen" }).first();
  await button.click();
  await expect(page.getByRole("dialog", { name: "Feedback & Unterstützen" })).toBeVisible();
}

let fake: Server;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake = await startFakeSupport();
});
test.afterAll(async () => {
  await new Promise((ok) => (fake ? fake.close(ok) : ok(undefined)));
});

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, baseURL ?? "");
  await page.goto("/overview");
  // Frischer Datenordner: Einrichtung überspringen, Meldestelle zurücksetzen (Attrappe setzt jeder Test selbst).
  await api(page, "PUT", "/api/app/settings", { onboardingDone: true });
  await api(page, "PUT", "/api/support/settings", { url: "" });
});

test("Knopf in der Statuszeile öffnet das Blatt; Fehler ohne Meldestelle landet im Postausgang", async ({ page }) => {
  await page.goto("/overview");
  const entry = page.getByRole("button", { name: "Feedback & Unterstützen" }).first();
  await expect(entry).toBeVisible();
  if (SHOTS) await entry.locator("..").screenshot({ path: join(SHOTS, "00-statuszeile-einstieg.jpg"), type: "jpeg", quality: 70 });
  await openFromStatusLine(page);
  await expect(page).toHaveURL(/support=bug/);
  await shot(page, "01-blatt-fehler-1440");

  const sheet = page.getByRole("dialog", { name: "Feedback & Unterstützen" });
  await sheet.getByLabel("Was ist passiert?").fill("E2E: Der Knopf reagiert nicht");
  await sheet.getByText("Genau das wird mitgeschickt").click();
  const preview = sheet.getByTestId("support-diagnostics-preview");
  await expect(preview).toContainText('"page": "/overview"');
  await expect(preview).not.toContainText("/Users/");
  await sheet.getByRole("button", { name: "In den Postausgang legen" }).click();
  await expect(sheet.getByTestId("support-result")).toHaveAttribute("data-status", "queued");
  await expect(sheet.getByTestId("support-result")).toContainText("Gespeichert im Postausgang");
  await sheet.getByRole("button", { name: "Noch einen Fehler melden" }).click();
  await expect(sheet.getByTestId("support-outbox-waiting")).toContainText(/Meldung(en)? warte.*sobald die Meldestelle eingerichtet ist/);
  await shot(page, "02-postausgang-ohne-meldestelle");
  expect(received).toHaveLength(0);

  // Spende ohne Meldestelle: ehrlich gesperrt.
  await sheet.getByRole("tab", { name: "Buy me Tokens" }).click();
  await expect(sheet.getByText("Bezahlen wird gerade eingerichtet – danke, dass du helfen willst!")).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Weiter zur Bezahlung/ })).toBeDisabled();
});

test("mit Attrappen-Dienst: Wartendes geht raus, neue Meldung wird gesendet", async ({ page }) => {
  await api(page, "PUT", "/api/support/settings", { url: SUPPORT_BASE });
  // Wartende Meldung aus dem ersten Test geht nach dem Einrichten von selbst raus.
  await expect.poll(() => received.filter((r) => r.path === "/v1/bug").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect(received[0]?.body.what).toBe("E2E: Der Knopf reagiert nicht");
  expect(received[0]?.key).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto("/overview?support=idea");
  const sheet = page.getByRole("dialog", { name: "Feedback & Unterstützen" });
  await sheet.getByLabel("Titel").fill("E2E: Heller Modus");
  await sheet.getByLabel("Beschreibung").fill("Für draußen in der Sonne");
  await sheet.getByRole("radio", { name: "Brauche ich dringend" }).click();
  await sheet.getByRole("button", { name: "Idee schicken" }).click();
  await expect(sheet.getByTestId("support-result")).toHaveAttribute("data-status", "sent");
  await expect(sheet.getByTestId("support-result")).toContainText("Danke, ist angekommen!");
  const idea = received.find((r) => r.path === "/v1/idea");
  expect(idea?.body).toMatchObject({ title: "E2E: Heller Modus", importance: "essential" });
  await shot(page, "03-idee-gesendet");
});

test("Spende mit Attrappe: eingebettete Bezahlseite und Danke-Zustand", async ({ page }) => {
  await api(page, "PUT", "/api/support/settings", { url: SUPPORT_BASE });
  await page.goto("/overview?support=tokens");
  const sheet = page.getByRole("dialog", { name: "Feedback & Unterstützen" });
  await sheet.getByRole("radio", { name: "5 €", exact: true }).click();
  await sheet.getByRole("radio", { name: "Monatlich" }).click();
  await shot(page, "04-tokens-formular");
  await sheet.getByRole("button", { name: /Weiter zur Bezahlung/ }).click();
  const frame = page.frameLocator('iframe[title="Bezahlseite"]');
  await expect(frame.getByText("Attrappe: Bezahlseite")).toBeVisible();
  await expect(frame.getByText("500 Cent")).toBeVisible();
  await shot(page, "05-bezahlseite-eingebettet");
  await frame.getByRole("button", { name: "Jetzt bezahlen (Attrappe)" }).click();
  await expect(sheet.getByTestId("support-thanks")).toContainText("Danke von Herzen!");
  await shot(page, "06-danke");
  expect(received.find((r) => r.path === "/v1/donate/session")?.body).toMatchObject({ amountCents: 500, interval: "monthly", currency: "EUR" });
});

test("Einstieg auch in den Einstellungen (eigener Bereich ganz unten) und auf der Verbindungsseite", async ({ page }) => {
  await page.goto("/settings");
  const row = page.locator('[data-nyx="settings:unterstuetzen"]');
  await row.scrollIntoViewIfNeeded();
  if (SHOTS) await row.screenshot({ path: join(SHOTS, "09-einstellungen-einstieg.jpg"), type: "jpeg", quality: 70 });
  await row.click();
  await expect(page).toHaveURL(/\/settings\/unterstuetzen$/);
  await page.locator('[data-nyx="support-open:bug"]').click();
  await expect(page.getByRole("dialog", { name: "Feedback & Unterstützen" })).toBeVisible();

  // The connections check (Einstellungen → Betrieb & Zugriff) keeps its line.
  await page.goto("/settings/betrieb");
  const main = page.locator("main");
  await expect(main.getByText("Hakt etwas, das hier nicht auftaucht?")).toBeVisible();
  await main.getByRole("button", { name: /Feedback & Unterstützen/ }).last().click();
  await expect(page.getByRole("dialog", { name: "Feedback & Unterstützen" })).toBeVisible();
});

test("⌘K kennt „Fehler melden“, „Idee schicken“ und „Buy me Tokens“", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("button", { name: "Feedback & Unterstützen" }).first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Befehlspalette" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("Buy me");
  await palette.getByRole("option", { name: /Buy me Tokens/ }).click();
  await expect(page).toHaveURL(/support=tokens/);
  await expect(page.getByRole("tab", { name: "Buy me Tokens" })).toHaveAttribute("aria-selected", "true");
});

test.describe("iPhone (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("über das Menü erreichbar, ohne waagerechtes Scrollen, Tipp-Ziele ≥ 44 px", async ({ page }) => {
    await page.goto("/overview");
    await page.getByRole("button", { name: /Menü/ }).first().click();
    await openFromStatusLine(page);
    const sheet = page.getByRole("dialog", { name: "Feedback & Unterstützen" });
    for (const tab of ["Fehler melden", "Idee an den Entwickler", "Buy me Tokens"]) {
      const box = await sheet.getByRole("tab", { name: tab }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const scroll = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(scroll.doc).toBeLessThanOrEqual(scroll.view);
    await shot(page, "07-iphone-fehler");
    await sheet.getByRole("tab", { name: "Buy me Tokens" }).click();
    const panel = await sheet.boundingBox();
    expect(panel?.width ?? 0).toBeLessThanOrEqual(390);
    await shot(page, "08-iphone-tokens");
  });
});
