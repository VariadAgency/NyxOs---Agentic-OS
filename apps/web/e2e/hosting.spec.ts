// Settings → „Betrieb & Zugriff“ in the real browser against a LOCAL server (local.ts): the state says honestly
// „on this computer“ with its port, „Auf diesem Rechner“ is the current way (no installer, real self check), a form
// gives ready commands (invalid values blocked, saved values survive a reload), Tailscale gives the real local
// commands, and the one-time sign-in link for the phone really works through an allowed outside address (the path
// `tailscale serve` takes). Plus „Nyx hilft“ and 390 px without horizontal scrolling, tap targets ≥ 44 px.
//
//   NYXOS_HOME=<tmp> PORT=47901 NYXOS_ALLOWED_HOSTS=nyxos.tail0000.ts.net NYXOS_HAIKU_SCHEDULER=0 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47901 pnpm exec vite --port 5201 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5201 E2E_NYXOS_API=http://127.0.0.1:47901 E2E_NYXOS_HOME=<tmp> [E2E_SHOTS=<folder>] \
//     pnpm --filter @nyxos/web exec playwright test e2e/hosting.spec.ts --project chromium-1440 --project webkit-1440
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { apiBase, apiWrite, prepare } from "./helpers/localStack";

const TS_NAME = "nyxos.tail0000.ts.net";
const SHOTS = process.env.E2E_SHOTS;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test.describe.configure({ timeout: 120_000, mode: "serial" });

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
});

async function shot(page: Page, name: string, projectName: string) {
  if (!SHOTS || !projectName.startsWith("chromium")) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, name), type: "jpeg", quality: 70 });
}

/** HTTP request with an own Host header, like a proxy (`fetch` drops that header). */
function hostRequest(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((done, fail) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

const card = (page: Page, id: string) => page.locator(`[data-hosting-card="${id}"]`);

/** Click „Speichern“ in a card and wait for the server's answer (the page may be busy with the connection checks). */
async function save(page: Page, c: ReturnType<typeof card>) {
  const answer = page.waitForResponse((r) => r.url().includes("/api/hosting/profile") && r.request().method() === "PUT", { timeout: 30_000 });
  await c.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await answer).status()).toBe(200);
  await expect(c.getByText("Gewählt")).toBeVisible();
}

async function openCard(page: Page, id: string, title: RegExp) {
  const c = card(page, id);
  if ((await c.getAttribute("data-open")) !== "1") await c.getByRole("button", { name: title }).first().click();
  await expect(c).toHaveAttribute("data-open", "1");
  return c;
}

test("local mode: honest state, this computer as the current way, forms → commands, save, checks, Nyx helps", async ({ page }, info) => {
  // A clean start for this run (the data folder may come from an earlier run).
  await apiWrite(page, "PUT", "/api/hosting/profile", { way: null, phoneWay: null, forms: (await (await page.request.get("/api/hosting/profile")).json()).forms });
  await page.goto("/settings/betrieb");
  const status = page.getByTestId("hosting-status");
  await expect(status).toContainText("Läuft auf diesem Rechner", { timeout: 30_000 });
  await expect(status).toContainText(`127.0.0.1:${new URL(apiBase(undefined)).port}`);
  await expect(status).toContainText("Anmeldung nötig – auch nur zum Lesen.");

  // „Auf diesem Rechner“ = how it runs now: no installer, the real `nyxos` commands, a real self check.
  const local = await openCard(page, "local", /Auf diesem Rechner/);
  await expect(local.getByText("So läuft es gerade")).toBeVisible();
  await expect(local.getByTestId("hosting-command").filter({ hasText: "nyxos status" })).toHaveCount(1);
  await expect(local.getByTestId("hosting-command").filter({ hasText: "install.sh" })).toHaveCount(0);
  await local.getByRole("button", { name: "Prüfen", exact: true }).click();
  await expect(local.getByTestId("hosting-check-result")).toHaveAttribute("data-verdict", "ok", { timeout: 15_000 });
  await expect(local.getByTestId("hosting-check-result")).toContainText("läuft hier auf diesem Rechner");
  await local.getByLabel("Autostart: startet mit dem Rechner").uncheck();
  await expect(local.getByTestId("hosting-command").filter({ hasText: "systemctl --user disable nyxos-server.service nyxos-bridge.service" })).toHaveCount(1);
  await local.getByLabel("Autostart: startet mit dem Rechner").check();
  await shot(page, "H-1-lokal-status.jpg", info.project.name);

  // Own server: no commands without required fields, ready commands with them, invalid values blocked.
  const server = await openCard(page, "server", /Eigener Server/);
  await server.getByLabel("Adresse (IP oder Name)").fill("");
  await expect(server.getByTestId("hosting-missing")).toContainText("Adresse");
  await server.getByLabel("Adresse (IP oder Name)").fill("203.0.113.10");
  await server.getByLabel("SSH-Nutzer").fill("ubuntu");
  await expect(server.getByTestId("hosting-command").first()).toContainText("HostName 203.0.113.10");
  await expect(server.getByTestId("hosting-command").filter({ hasText: "cp infra/.env.example infra/.env" })).toHaveCount(1);
  await server.getByLabel("SSH-Nutzer").fill("ubuntu; rm -rf ~");
  await expect(server.getByText(/Nur Buchstaben, Ziffern/)).toBeVisible();
  await expect(server.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  await expect(server.getByTestId("hosting-command").filter({ hasText: "rm -rf" })).toHaveCount(0);
  await server.getByLabel("SSH-Nutzer").fill("ubuntu");
  await save(page, server);
  await page.reload();
  const again = await openCard(page, "server", /Eigener Server/);
  await expect(again.getByLabel("Adresse (IP oder Name)")).toHaveValue("203.0.113.10");
  // Back to „this computer“ for the phone recipes (they follow the chosen way).
  const local2 = await openCard(page, "local", /Auf diesem Rechner/);
  await save(page, local2);

  // Tailscale on this computer: the real local port, allow the host (plist / systemd), sign-in link for the phone.
  const port = new URL(apiBase(undefined)).port;
  const ts = await openCard(page, "tailscale", /Tailscale/);
  await ts.getByLabel("Tailscale-Name").fill(TS_NAME);
  await expect(ts.getByTestId("hosting-command").filter({ hasText: `tailscale serve --bg --https=443 http://127.0.0.1:${port}` })).toHaveCount(1);
  await expect(ts.getByTestId("hosting-command").filter({ hasText: `EnvironmentVariables.NYXOS_ALLOWED_HOSTS -string ${TS_NAME}` })).toHaveCount(1);
  await expect(ts.getByTestId("hosting-command").filter({ hasText: "NYXOS_NO_BROWSER=1 nyxos open" })).toHaveCount(1);
  await expect(ts.getByTestId("hosting-phone-open")).toContainText(`https://${TS_NAME}`);
  await save(page, ts);
  await ts.getByRole("button", { name: "Prüfen", exact: true }).click();
  const result = ts.getByTestId("hosting-check-result");
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toHaveAttribute("data-verdict", "fail");
  await expect(result).toContainText("Tailscale-Namen kennt oft nur dein Tailnet");
  // Never „not reachable“ for a name only the tailnet knows: „not confirmed yet“ (or „reachable“ once the phone
  // really opened it – the next test does that, and the proof stays stored).
  await expect(page.getByTestId("hosting-status")).toContainText(/Vom Handy: (noch nicht bestätigt|erreichbar – zuletzt vom Handy)/, { timeout: 15_000 });
  await ts.getByLabel("Tailscale-Name").scrollIntoViewIfNeeded();
  await shot(page, "H-2-lokal-tailscale.jpg", info.project.name);

  // Nyx helps: the Nyx chat opens with the prepared request (way + form + state, without secrets).
  await page.getByRole("button", { name: "Nyx fragen" }).click();
  const box = page.getByLabel("Frage an Nyx").first();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue(/Hilf mir, NyxOS einzurichten/);
  await expect(box).toHaveValue(new RegExp(`Tailscale – Tailscale-Name: ${TS_NAME.replace(/\./g, "\\.")}`));
  await expect(box).toHaveValue(/So läuft es gerade: Läuft auf diesem Rechner/);
});

test("the phone sign-in link from the recipe really signs in through the Tailscale address", async ({ page }, info) => {
  test.skip(!process.env.E2E_NYXOS_HOME, "needs a local server (E2E_NYXOS_HOME)");
  await page.goto("/settings/betrieb");
  const ts = await openCard(page, "tailscale", /Tailscale/);
  const command = (await ts.getByTestId("hosting-command").filter({ hasText: "nyxos open" }).textContent())?.trim() ?? "";
  expect(command).toContain(`https://${TS_NAME}`);

  // Run exactly this command, with `nyxos` = this repository's CLI on the test data folder (never ~/.nyxos).
  const bin = mkdtempSync(join(tmpdir(), "nyxos-bin-"));
  writeFileSync(join(bin, "nyxos"), `#!/bin/sh\nexec "${process.execPath}" "${resolve(process.cwd(), "../cli/nyxos.mjs")}" "$@"\n`, { mode: 0o755 });
  const api = new URL(apiBase(undefined));
  const link = execFileSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, NYXOS_HOME: process.env.E2E_NYXOS_HOME, NYXOS_PORT: api.port, HOME: bin },
  }).trim();
  expect(link).toMatch(new RegExp(`^https://${TS_NAME.replace(/\./g, "\\.")}/auth/local\\?code=`));

  // What `tailscale serve` does: forward to 127.0.0.1:<port> with the Tailscale name as Host (from an iPhone).
  const target = new URL(link);
  const login = await hostRequest(`${api.origin}${target.pathname}${target.search}`, { host: TS_NAME, "user-agent": IPHONE_UA });
  expect(login.status).toBe(302);
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? "")).split(";")[0] ?? "";
  expect(cookie).toMatch(/=./);
  const statusRes = await hostRequest(`${api.origin}/api/hosting/status`, { host: TS_NAME, cookie, "user-agent": IPHONE_UA });
  expect(statusRes.status).toBe(200);
  const status = JSON.parse(statusRes.body) as { request: { host: string; remote: boolean }; phone: { state: string; lastRemote: { host: string; mobile: boolean } | null } };
  expect(status.request).toMatchObject({ host: TS_NAME, remote: true });
  expect(status.phone.lastRemote).toMatchObject({ host: TS_NAME, mobile: true });
  expect(status.phone.state).toBe("reachable");
  // Without the sign-in the same address gets nothing (reading needs the sign-in in local mode).
  expect((await hostRequest(`${api.origin}/api/hosting/status`, { host: TS_NAME })).status).toBe(401);
  // A second use of the same link is refused (one-time).
  const reuse = await hostRequest(`${api.origin}${target.pathname}${target.search}`, { host: TS_NAME });
  expect(String(reuse.headers.location)).toContain("login=expired");

  await page.reload();
  await expect(page.getByTestId("hosting-status")).toContainText("Vom Handy: erreichbar – zuletzt vom Handy geöffnet", { timeout: 15_000 });
  await shot(page, "H-3-handy-erreichbar.jpg", info.project.name);
});

test("390 px (iPhone): one column, no horizontal scrolling, tap targets ≥ 44 px", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/betrieb");
  await expect(page.getByTestId("hosting-status")).toContainText("Läuft auf diesem Rechner", { timeout: 30_000 });
  const provider = await openCard(page, "provider", /Fremder Server/);
  await provider.getByLabel("Anbieter").selectOption("digitalocean");
  await provider.getByLabel("Adresse (IP des neuen Servers)").fill("203.0.113.20");
  await expect(provider.getByTestId("hosting-command").first()).toBeVisible();
  const cf = await openCard(page, "cloudflare", /Cloudflare Tunnel/);
  await cf.getByLabel("Adresse (Hostname bei Cloudflare)").fill("nyxos.example.com");
  await expect(cf.getByTestId("hosting-command").filter({ hasText: "read -rs" })).toHaveCount(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.getByTestId("hosting-settings").evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("button, a, input, select")]
      .filter((el) => el.offsetParent !== null && (el as HTMLInputElement).type !== "checkbox")
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 43.5),
  );
  expect(small).toEqual([]);
  await cf.getByTestId("hosting-command").first().scrollIntoViewIfNeeded();
  await shot(page, "H-4-iphone-cloudflare.jpg", info.project.name);
});
