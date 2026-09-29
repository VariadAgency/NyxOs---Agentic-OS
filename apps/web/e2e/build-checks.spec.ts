// Build-Prüfungen: laufen ECHT auf dem Rechner über die Brücke des lokalen Stacks (`run_build`),
// „nicht eingerichtet“ statt rot, gleiche Fälle gebündelt mit Zähler, Rohmeldung nur unter „Details“.
// Braucht einen NyxOS-Worktree OHNE installierte Pakete in E2E_BARE_WORKTREE, sonst übersprungen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_BARE_WORKTREE=/pfad/zum/worktree pnpm --filter @nyxos/web exec playwright test e2e/build-checks.spec.ts --project chromium-1440
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const LOGIN = resolve(ROOT, ".probe/probe-login.json");
// Ein NyxOS-Worktree OHNE installierte Pakete → „nicht eingerichtet“.
const BARE = process.env.E2E_BARE_WORKTREE ?? "";

test.describe.configure({ timeout: 180_000 });

test("Server-Tab: echter Typen-Check grün, fehlende Pakete gebündelt als „nicht eingerichtet“", async ({ page, context, request, baseURL }) => {
  mkdirSync(SHOTS, { recursive: true });
  test.skip(!BARE || !existsSync(BARE), "E2E_BARE_WORKTREE fehlt: ein Worktree ohne installierte Pakete");
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string; csrf: string };
  const url = baseURL ?? "http://127.0.0.1:47890";
  await context.addCookies([{ name: "nyxos_session", value: login.token, url }]);
  const headers = { cookie: `nyxos_session=${login.token}`, "x-nyxos-csrf": login.csrf, "content-type": "application/json" };

  const ids: number[] = [];
  for (const cwd of [ROOT, BARE, BARE, BARE]) {
    const res = await request.post("/api/builds/run", { headers, data: { sessionKey: null, cwd } });
    expect(res.status(), await res.text()).toBe(200);
    ids.push(((await res.json()) as { id: number }).id);
  }
  // Warten, bis alle Läufe fertig sind (der Typen-Check braucht lokal ~10 s).
  await expect
    .poll(
      async () => {
        const rows = ((await (await request.get("/api/builds/summary")).json()) as { recent: { id: number; status: string }[] }).recent;
        return ids.every((id) => rows.some((r) => r.id === id && r.status !== "queued" && r.status !== "running"));
      },
      { timeout: 150_000, intervals: [1000] },
    )
    .toBe(true);
  const summary = (await (await request.get("/api/builds/summary")).json()) as { recent: { id: number; status: string }[]; groups: { state: string; count: number }[] };
  const mine = summary.recent.filter((r) => ids.includes(r.id));
  expect(mine.find((r) => r.id === ids[0])?.status).toBe("green");
  expect(mine.filter((r) => r.status === "unavailable")).toHaveLength(3);
  expect(summary.groups.some((g) => g.state === "unavailable" && g.count >= 3)).toBe(true);

  await page.goto("/server");
  const section = page.getByText("Letzte Builds");
  await expect(section).toBeVisible({ timeout: 60_000 }); // Server-Tab lädt im lokalen Stack gemächlich
  await expect(page.getByText(/Pakete noch nicht installiert/).first()).toBeVisible();
  await expect(page.getByText(/^\d+× seit \d\d:\d\d$/).first()).toBeVisible();
  await expect(page.getByText("grün", { exact: true }).first()).toBeVisible();
  // Keine Technik-Meldung sichtbar, solange „Details“ zu ist.
  await expect(page.getByText(/ENOENT|node_modules fehlt/).first()).toBeHidden();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS, "build-checks.png"), fullPage: true });

  // „Details“ aufklappen zeigt die Rohmeldung.
  await page.getByText("Details").first().click();
  await expect(page.getByText(/node_modules fehlt/).first()).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "build-checks-details.png"), fullPage: true });
});
