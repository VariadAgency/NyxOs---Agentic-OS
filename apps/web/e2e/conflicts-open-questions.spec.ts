// Offene Fragen gegen den lokalen Stack (echte Verläufe): Konflikte nur zwischen lebenden Sessions,
// „offene Fragen“ überall dieselbe Zahl (Konflikte, Entscheidungen, Überblick), Kennzahl-Kacheln ohne
// fremde Abzeichen, Agenten-Kachel zählt laufende Sub-Agenten.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/conflicts-open-questions.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");

interface OpenQuestions {
  approvals: number;
  inbox: number;
  conflicts: number;
  total: number;
}

test.describe.configure({ timeout: 180_000 });
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("Konflikte fragen nur nach lebenden Sessions, Zahl = Entscheidungen = Überblick", async ({ page, request }) => {
  const oq = (await (await request.get("/api/open-questions")).json()) as OpenQuestions;
  const summary = (await (await request.get("/api/conflicts/summary")).json()) as { totals: { openDecisions: number; past: number; conflicts: number } };
  expect(oq.conflicts).toBe(summary.totals.openDecisions);

  await page.goto("/conflicts");
  await expect(page.getByRole("heading", { name: "Was muss ich entscheiden?" })).toBeVisible();
  const head = page.locator("#entscheiden + p");
  if (summary.totals.openDecisions === 0) await expect(head).toContainText("Gerade nichts");
  else await expect(head).toContainText(`${summary.totals.openDecisions} Konflikt-Frage`);
  if (summary.totals.past > 0) await expect(head).toContainText("Rückblick");
  await page.screenshot({ path: resolve(SHOTS, "open-questions-conflicts.png") });

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Entscheidungen" })).toBeVisible();
  if (oq.total > 0) await expect(page.getByText(`${oq.total} offen`, { exact: true })).toBeVisible();
  else await expect(page.getByText("Nichts zu entscheiden.")).toBeVisible();
  if (oq.conflicts > 0) await expect(page.getByTestId("inbox-conflicts")).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "open-questions-inbox.png") });

  await page.goto("/");
  const tile = page.locator('[data-metric="open_questions"]');
  await expect(tile).toContainText(String(oq.total));
  // „Konflikte“ und „Sessions offen“ ohne fremdes Abzeichen.
  await expect(page.locator('[data-metric="conflicts"] [title*="vorher"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="sessions_open"] [title*="vorher"]')).toHaveCount(0);
  await page.locator('[aria-label="Kennzahlen"]').scrollIntoViewIfNeeded();
  // Kacheln zählen beim ersten Anzeigen hoch und blenden gestaffelt ein — erst danach das Bild.
  await expect(page.locator('[aria-label="Kennzahlen"] [data-metric]')).toHaveCount(12);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(SHOTS, "open-questions-overview.png") });
});

test("Agenten-Kachel zählt laufende Sub-Agenten aus echten Signalen", async ({ page, request }) => {
  const runs = (await (await request.get("/api/agents/runs")).json()) as { runs?: { running: boolean }[] } | { running: boolean }[];
  const list = Array.isArray(runs) ? runs : (runs.runs ?? []);
  const running = list.filter((r) => r.running).length;
  await page.goto("/agents");
  await expect(page.locator('[data-metric="agents-running"]')).toContainText(String(running));
  await page.screenshot({ path: resolve(SHOTS, "open-questions-agents.png") });
});
