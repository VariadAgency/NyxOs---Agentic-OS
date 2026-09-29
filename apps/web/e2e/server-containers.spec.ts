// Server-Tab gegen den lokalen Stack mit nachgebautem Docker-Lesezugang (fixtures/fake-docker-proxy.mjs,
// kein Docker nötig): Container gruppiert mit Zustand/Health/Neustarts/CPU/RAM, Logs per Klick, und ein
// ehrlicher Hinweis, wenn der Lesezugang fehlt. Den Nachbau startet der Test selbst (Port FAKE_DOCKER_PORT).
//   NYXOS_DOCKER_PROXY_URL=http://127.0.0.1:47930 NYXOS_DOZZLE_URL=/dozzle/ pnpm dev
//   pnpm --filter @nyxos/web exec playwright test e2e/server-containers.spec.ts --project chromium-1440
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");
const FAKE = resolve(process.cwd(), "e2e/fixtures/fake-docker-proxy.mjs");
const FAKE_PORT = process.env.FAKE_DOCKER_PORT ?? "47930";

test.describe.configure({ mode: "serial", timeout: 180_000 });

let fake: ChildProcess | null = null;
function startFake(): Promise<void> {
  return new Promise((ok, fail) => {
    fake = spawn(process.execPath, [FAKE, "--port", FAKE_PORT], { stdio: ["ignore", "pipe", "inherit"] });
    fake.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("[fake-docker]")) ok();
    });
    fake.on("exit", (code) => fail(new Error(`fake-docker beendet (${code})`)));
  });
}
function stopFake() {
  fake?.kill("SIGTERM");
  fake = null;
}

async function waitDocker(request: APIRequestContext, available: boolean) {
  await expect
    .poll(async () => ((await (await request.get("/api/server")).json()) as { docker: { available: boolean } }).docker.available, { timeout: 40_000, intervals: [1000] })
    .toBe(available);
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  await startFake();
});
test.afterAll(() => stopFake());

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("alle Container gruppiert, Zustand/Health/Neustarts/CPU/RAM, Logs per Klick", async ({ page, request }) => {
  await waitDocker(request, true);
  // Zwei Messungen abwarten (Zwischenspeicher 10 s), damit CPU + Sparklines echte Werte haben.
  await expect
    .poll(async () => ((await (await request.get("/api/server")).json()) as { containers: { cpuHistory: number[] }[] }).containers.some((c) => c.cpuHistory.length >= 2), { timeout: 40_000, intervals: [2000] })
    .toBe(true);
  await page.goto("/server");
  const others = page.getByRole("region", { name: "Andere Projekte" });
  await expect(others.getByText("atlas-postgres")).toBeVisible({ timeout: 60_000 });
  await expect(others.getByText("ungesund").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "NyxOS" }).getByText("nyxos-socket-proxy")).toBeVisible();
  await expect(others.getByText("1432× neu gestartet")).toBeVisible();
  await expect(page.getByText(/wartet auf Freigabe/)).toHaveCount(0);
  await expect(page.getByTestId("server-pending")).toHaveCount(0);

  await others.getByText("atlas-media-service").click();
  const logs = page.getByTestId("logs-atlas-media-service");
  await expect(logs.getByText(/Upload fehlgeschlagen/).first()).toBeVisible();
  await logs.getByRole("searchbox").fill("fehlgeschlagen");
  await expect(logs.getByText(/von 40 Zeilen \(gefiltert\)/)).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "server-containers.png"), fullPage: true });
});

test("fehlt der Docker-Lesezugang wirklich, steht genau das da — mit Befehl, ohne Freigabe-Text", async ({ page, request }) => {
  stopFake();
  await waitDocker(request, false);
  await page.goto("/server");
  const box = page.getByTestId("server-pending");
  await expect(box).toBeVisible({ timeout: 60_000 });
  await expect(box.getByText(/Container-Ansicht:/)).toBeVisible();
  await expect(box.getByText(/docker compose up -d socket-proxy/).first()).toBeVisible();
  await expect(page.getByText(/wartet auf Freigabe/)).toHaveCount(0);
  await page.screenshot({ path: resolve(SHOTS, "server-docker-missing.png") });
  await startFake(); // für nachfolgende Läufe wieder da
});
