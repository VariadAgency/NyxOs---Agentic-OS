// Im Session-Chat steht die Zustell-Warteschlange (was die NyxOS gerade NICHT eintippen durfte) mit Art,
// Text, „seit …“ und „Zurückziehen“, darunter ehrlich Abgelaufenes. Nur die Antwort von
// `/api/sessions/<id>/deliveries` für DIESE Session wird ersetzt (die Sessions des lokalen Stacks laufen
// nicht in der NyxOS, dort landet nichts in der Schlange) — nichts wird geschrieben.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/session-delivery-queue.spec.ts --project chromium-1440
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.skip(({ browserName }) => browserName !== "chromium", "ein Browser genügt");
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Session-Chat zeigt die Zustell-Warteschlange", async ({ page }) => {
  test.setTimeout(90_000);
  const r = await page.request.get("/api/sessions?limit=200");
  const s = ((await r.json()) as { sessions: { id: string; tool: string; art: string }[] }).sessions.find((x) => x.tool === "claude");
  if (!s) throw new Error("lokaler Stack hat keine Session");
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  await page.route(/\/api\/sessions\/[^/]+\/deliveries$/, (route) =>
    route.fulfill({
      json: {
        deliveries: [
          { id: 11, kind: "approval", text: "Freigabe #42 von Alex erteilt: Führe genau diesen Befehl jetzt einmal erneut aus (unverändert): git push origin HEAD", status: "queued", reason: "Die Session arbeitet gerade – geht raus, sobald sie auf dich wartet.", attempts: 2, createdAt: iso(-4 * 60_000), expiresAt: iso(5 * 3_600_000), doneAt: null },
          { id: 12, kind: "chat", text: "Wenn du fertig bist: bitte noch die Tests laufen lassen.", status: "queued", reason: "Vor dieser Nachricht wartet noch etwas anderes auf die Session – sie geht danach raus.", attempts: 0, createdAt: iso(-60_000), expiresAt: iso(6 * 3_600_000), doneAt: null },
          { id: 9, kind: "compact", text: "/compact", status: "expired", reason: "Nicht zugestellt: Die Session hat in der Zeit nicht auf dich gewartet.", attempts: 5, createdAt: iso(-130 * 60_000), expiresAt: iso(-10 * 60_000), doneAt: iso(-10 * 60_000) },
        ],
      },
    }),
  );
  await page.goto(`/sessions/${s.art}/_/${s.id}`);
  const queue = page.getByTestId("delivery-queue");
  await expect(queue).toBeVisible({ timeout: 30_000 });
  await expect(queue.getByText("Freigabe-Bescheid")).toBeVisible();
  await expect(queue.getByRole("button", { name: "Zurückziehen" })).toHaveCount(2);
  await expect(queue.getByText(/Nicht zugestellt/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/delivery-queue.png` });
});
