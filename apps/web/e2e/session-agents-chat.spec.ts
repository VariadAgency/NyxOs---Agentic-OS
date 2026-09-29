// Agents in the session chat — proof in a real browser against a real server with SAMPLE DATA from this test (never
// real transcripts; a new session id per run). Against the probe stack (`pnpm dev`) or a local server + Vite, e.g.:
//   NYXOS_HOME=<tmp> PORT=47901 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47901 pnpm exec vite --port 5201 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5201 E2E_NYXOS_API=http://127.0.0.1:47901 E2E_NYXOS_HOME=<tmp> \
//     pnpm --filter @nyxos/web exec playwright test e2e/session-agents-chat.spec.ts --project chromium-1440
// Screenshots (JPEG) only when `E2E_SHOTS=<folder>` is set.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiBase, bridgeToken, prepare } from "./helpers/localStack";

const SHOTS = process.env.E2E_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SID = randomUUID();
const KEY = `claude:${SID}`;
const MIN = 60_000;
/** A made-up project folder (nothing is read from it). */
const CWD = "/home/demo/projects/agents-test";

async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-${project}.jpg`, type: "jpeg", quality: 70 });
}

let n = 0;
const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const ev = (kind: string, agoMs: number, data: Record<string, unknown>) => ({
  type: "event",
  event: { id: `claude:${SID}:e2e${++n}`, tool: "claude", sessionId: SID, ts: at(agoMs), kind, source: "file", data },
});
const usage = (input: number, output: number, cacheRead: number) => ({ input, output, cacheRead, cacheCreation: 0 });

const AGENTS = [
  { id: "a-leiste", name: "Baut die Agenten-Leiste", type: "general-purpose" },
  { id: "a-tests", name: "Schreibt die Tests", type: "general-purpose" },
  { id: "a-suche", name: "Sucht die Stellen", type: "Explore" },
  { id: "a-alt", name: "Prüft den alten Stand", type: "Plan" },
];

function seedItems() {
  return [
    {
      type: "summary",
      summary: {
        tool: "claude",
        sessionId: SID,
        parentSessionId: null,
        cwd: CWD,
        title: "Probe: Leiter mit Agenten",
        titleSource: "custom",
        startedAt: at(90 * MIN),
        lastActivityAt: at(0),
        models: ["claude-opus-5-5"],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 },
        toolCalls: {},
        filesWritten: [],
        filesRead: [],
        subagents: AGENTS,
        gitBranch: "agents-test",
        cliVersion: null,
        eventCount: 0,
        parseErrors: 0,
        limits: null,
        lastUsage: null,
        lastUsageModel: null,
        modelContextWindow: null,
      },
    },
    // Earlier run
    ev("prompt", 60 * MIN, { text: "Prüfe den alten Stand der Sessions-Seite" }),
    ev("assistant", 59.5 * MIN, { text: "Ich starte einen Prüfer." }),
    ev("prompt", 59 * MIN, { text: "Prüfe den alten Stand", agentId: "a-alt" }),
    ev("tool_call", 58 * MIN, { name: "Read", target: "apps/web/src/App.tsx", toolUseId: "x1", agentId: "a-alt", msgId: "m-alt", model: "claude-opus-5-5", usage: usage(40, 900, 22_000) }),
    ev("assistant", 55 * MIN, { text: "Urteil: PASS – nichts zu tun.", agentId: "a-alt" }),
    // Current run
    ev("prompt", 12 * MIN, { text: "Baue Paket A: Agenten im Chat" }),
    ev("assistant", 11.8 * MIN, { text: "Ich verteile die Arbeit auf drei Agenten." }),
    ev("prompt", 11 * MIN, { text: "Baue die Agenten-Leiste unten im Chat.\n\nSie soll live zählen.", agentId: "a-leiste" }),
    ev("tool_call", 10 * MIN, { name: "Read", target: "apps/web/src/features/session-chat/SessionChat.tsx", toolUseId: "l1", agentId: "a-leiste", msgId: "m-l1", model: "claude-opus-5-5", usage: usage(12, 300, 18_000) }),
    ev("tool_result", 9.9 * MIN, { toolUseId: "l1", isError: false, agentId: "a-leiste" }),
    ev("tool_call", 6 * MIN, { name: "Edit", target: "apps/web/src/features/session-agents/SessionAgentsBar.tsx", toolUseId: "l2", agentId: "a-leiste", msgId: "m-l2", model: "claude-opus-5-5", usage: usage(8, 1_200, 26_000) }),
    ev("tool_result", 5.9 * MIN, { toolUseId: "l2", isError: false, agentId: "a-leiste" }),
    ev("tool_call", 0.3 * MIN, { name: "Bash", target: "pnpm test apps/web/test/session-agents.test.tsx", toolUseId: "l3", agentId: "a-leiste", msgId: "m-l3", model: "claude-opus-5-5", usage: usage(5, 400, 30_000) }),
    ev("prompt", 10.5 * MIN, { text: "Schreibe die Tests für die Leiste.", agentId: "a-tests" }),
    ev("tool_call", 0.5 * MIN, { name: "Write", target: "apps/web/test/session-agents.test.tsx", toolUseId: "t1", agentId: "a-tests", msgId: "m-t1", model: "claude-opus-5-5", usage: usage(9, 2_400, 40_000) }),
    ev("prompt", 10 * MIN, { text: "Suche alle Stellen, an denen Sub-Agenten erkannt werden.", agentId: "a-suche" }),
    ev("tool_call", 9 * MIN, { name: "Grep", target: "agentId", toolUseId: "s1", agentId: "a-suche", msgId: "m-s1", model: "claude-opus-5-5", usage: usage(6, 500, 9_000) }),
    ev("tool_result", 8.9 * MIN, { toolUseId: "s1", isError: false, agentId: "a-suche" }),
    ev("assistant", 4 * MIN, { text: "Gefunden: parse/claude.ts, agents/runs.ts und transcript.ts.", agentId: "a-suche" }),
    // The parent session is running (otherwise no agent counts as "running").
    { type: "state", state: { tool: "claude", sessionId: SID, running: true, observedAt: at(0) } },
  ];
}

async function uploadSubagentTranscript(request: APIRequestContext, api: string) {
  const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: SID, timestamp: at(9 * MIN), ...o });
  const raw = Buffer.from(
    [
      line({ type: "user", uuid: "u1", message: { role: "user", content: "Suche alle Stellen, an denen Sub-Agenten erkannt werden." } }),
      line({ type: "assistant", uuid: "u2", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Ich suche nach agentId im Code." }] } }),
      line({ type: "assistant", uuid: "u3", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Gefunden: parse/claude.ts, agents/runs.ts und transcript.ts." }] } }),
    ].join("\n") + "\n",
  );
  const res = await request.post(`${api}/ingest/archive`, {
    data: gzipSync(raw),
    headers: {
      authorization: `Bearer ${bridgeToken()}`,
      "x-nyxos-tool": "claude",
      "x-nyxos-session": SID,
      "x-nyxos-path": encodeURIComponent(`-home-demo-projects-agents-test/${SID}/subagents/agent-a-suche.jsonl`),
      "x-nyxos-sha256": createHash("sha256").update(raw).digest("hex"),
      "x-nyxos-size": String(raw.length),
      "content-type": "application/octet-stream",
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

let chatUrl = "";
let seeded = false;

test.beforeEach(async ({ page, baseURL, request }) => {
  const api = apiBase(baseURL);
  if (!seeded) {
    const res = await request.post(`${api}/ingest/events`, { headers: { authorization: `Bearer ${bridgeToken()}`, "content-type": "application/json" }, data: { items: seedItems() } });
    expect(res.status(), await res.text()).toBe(200);
    await uploadSubagentTranscript(request, api);
    seeded = true;
  }
  await prepare(page, baseURL);
  if (!chatUrl) {
    const r = await page.request.get(`/api/sessions/${encodeURIComponent(KEY)}`);
    expect(r.ok()).toBe(true);
    const { session } = (await r.json()) as { session: { art: string; baustelle: { slug: string } | null } };
    chatUrl = `/sessions/${session.art}/${session.baustelle?.slug ?? "_"}/${encodeURIComponent(KEY)}`;
  }
});

const bar = (page: Page) => page.getByTestId("session-agents-bar").getByRole("button").first();

test("bar at the bottom of the chat → popup with ticking elapsed time, tokens next to it → detail with steps and chat", async ({ page }, info) => {
  await page.goto(chatUrl);
  await expect(bar(page)).toHaveText(/2 Agenten aktiv · 1 fertig/, { timeout: 20_000 });
  await page.mouse.move(0, 0);
  await shot(page, "chat-leiste", info.project.name);

  await bar(page).click();
  const dialog = page.getByRole("dialog", { name: "Agenten dieser Session" });
  await expect(dialog).toBeVisible();
  const row = dialog.getByTestId("agent-row-a-leiste");
  await expect(row).toContainText("Baut die Agenten-Leiste");
  await expect(row).toContainText(/Tok\./);
  const elapsed = row.getByTestId("agent-elapsed");
  const first = await elapsed.textContent();
  await page.waitForTimeout(2_200);
  expect(await elapsed.textContent()).not.toBe(first);
  // The popup stays inside the chat window (not beyond the page head).
  const box = await dialog.boundingBox();
  const main = await page.getByTestId("session-main").boundingBox();
  expect(box && main && box.y >= main.y - 1).toBe(true);
  await shot(page, "popup", info.project.name);

  await row.click();
  const detail = dialog.getByTestId("agent-detail-live");
  await expect(detail.getByTestId("agent-step-current")).toContainText("Bash");
  await expect(detail).toContainText("Baue die Agenten-Leiste unten im Chat.");
  await shot(page, "detail-laufend", info.project.name);
  await detail.getByRole("button", { name: /Alle Agenten/ }).click();

  // Finished agent with an archived transcript: chat read only
  await dialog.getByTestId("agent-row-a-suche").click();
  await dialog.getByRole("button", { name: "Verlauf anzeigen" }).click();
  await expect(dialog.getByText("Ich suche nach agentId im Code.")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("region", { name: "Ergebnis" })).toContainText("Gefunden");
  await shot(page, "detail-chat", info.project.name);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("archive: agents from earlier runs, grouped by run; full screen and back to the chat", async ({ page }, info) => {
  await page.goto(chatUrl);
  await bar(page).click();
  const dialog = page.getByRole("dialog", { name: "Agenten dieser Session" });
  await dialog.getByRole("tab", { name: /Archiv/ }).click();
  await expect(dialog.getByText(/Prüfe den alten Stand der Sessions-Seite/)).toBeVisible();
  await expect(dialog.getByTestId("agent-row-a-alt")).toContainText("PASS");
  await shot(page, "archiv", info.project.name);

  await dialog.getByRole("link", { name: "Vollbild" }).click();
  await expect(page).toHaveURL(/\/agenten$/);
  await expect(page.getByRole("heading", { name: "Agenten", level: 1 })).toBeVisible();
  await expect(page.getByTestId("agent-row-a-tests")).toBeVisible();
  await shot(page, "vollbild", info.project.name);
  await page.getByTestId("agent-row-a-tests").click();
  await expect(page).toHaveURL(/\/agenten\/a-tests$/);
  await page.getByRole("link", { name: /Zurück zum Chat/ }).click();
  await expect(page).toHaveURL((url) => decodeURIComponent(url.pathname).endsWith(`/${KEY}`));
  await expect(bar(page)).toBeVisible();
});

test("terminal tab: the same bar as entry to the popup", async ({ page }, info) => {
  await page.goto(`${chatUrl}?tab=terminal`);
  await expect(bar(page)).toHaveText(/Agenten aktiv/, { timeout: 20_000 });
  await bar(page).click();
  await expect(page.getByRole("dialog", { name: "Agenten dieser Session" })).toBeVisible();
  await shot(page, "terminal-popup", info.project.name);
});

test("390 px (iPhone): bar, sheet from the bottom, tap targets ≥ 44 px, no sideways overflow", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(chatUrl);
  const b = bar(page);
  await expect(b).toBeVisible({ timeout: 20_000 });
  expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await shot(page, "chat-leiste-390", info.project.name);
  await b.click();
  const dialog = page.getByRole("dialog", { name: "Agenten dieser Session" });
  await expect(dialog).toBeVisible();
  // Wait for the slide-in (180 ms), then measure.
  await expect.poll(async () => Math.round(((await dialog.boundingBox())?.y ?? 0) + ((await dialog.boundingBox())?.height ?? 0))).toBe(844);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  // Sheet from the bottom: full width, flush at the bottom.
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
    return Math.max(doc, dlg ? dlg.scrollWidth - dlg.clientWidth : 0);
  });
  expect(overflow).toBeLessThanOrEqual(1);
  const rowBox = await dialog.getByTestId("agent-row-a-leiste").boundingBox();
  expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await shot(page, "blatt-390", info.project.name);
  await dialog.getByTestId("agent-row-a-leiste").click();
  // A cold server (first archive digest, first Vite build of the route) can take a few seconds here.
  await expect(dialog.getByTestId("agent-step-current")).toBeVisible({ timeout: 15_000 });
  await shot(page, "detail-390", info.project.name);
});

test("390 px terminal tab: bar below the terminal, popup as a sheet", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${chatUrl}?tab=terminal`);
  const b = bar(page);
  await expect(b).toBeVisible({ timeout: 20_000 });
  const bb = await b.boundingBox();
  expect(bb?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((bb?.x ?? 0) + (bb?.width ?? 0)).toBeLessThanOrEqual(390);
  await b.click();
  const dialog = page.getByRole("dialog", { name: "Agenten dieser Session" });
  await expect.poll(async () => Math.round(((await dialog.boundingBox())?.y ?? 0) + ((await dialog.boundingBox())?.height ?? 0))).toBe(844);
  await shot(page, "terminal-390", info.project.name);
});
