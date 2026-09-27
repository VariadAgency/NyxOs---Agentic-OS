// Gehirn-Graph gegen den lokalen Stack mit echten Sessions und Vault: Filter, Leistung ohne Konsolenfehler,
// lokaler Graph im Session-Vollbild, Live-Aktualisierung < 2 s.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/brain-graph.spec.ts --project chromium-1440
// Screenshots landen unter `.probe/shots/` (gitignoriert).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openBrainPanel } from "./helpers/brainPanel";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });

async function counts(page: Page) {
  const v = page.getByTestId("brain-view");
  return {
    visible: Number(await v.getAttribute("data-visible-count")),
    dimmed: Number(await v.getAttribute("data-dimmed-count")),
    hidden: Number(await v.getAttribute("data-hidden-count")),
  };
}

async function openBrain(page: Page, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-canvas"] canvas', { timeout: 30_000 });
  await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0);
}

async function waitSettled(page: Page, maxMs = 25_000) {
  await page.waitForFunction(() => (window.__brainPerf?.alpha ?? 1) < 0.01, undefined, { timeout: maxMs, polling: 250 }).catch(() => undefined);
}

test.describe("Gehirn: Graph", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Messungen/Screenshots nur in Chromium");

  test("Gesamtgraph lädt schnell, keine Konsolenfehler, fps gemessen + Screenshots", async ({ page }, info) => {
    const errors: string[] = [];
    const t0 = Date.now();
    await openBrain(page, errors);
    const firstPaintMs = Date.now() - t0;
    await page.waitForFunction(() => window.__brainPerf?.firstStableMs !== null, undefined, { timeout: 15_000 });
    const firstStableMs = await page.evaluate(() => window.__brainPerf?.firstStableMs ?? null);
    await waitSettled(page);
    const perf = await page.evaluate(async () => {
      const p = window.__brainPerf;
      if (!p) return null;
      const m = await p.measure(3000);
      return { nodes: p.nodes, links: p.links, simTickMs: Math.round(p.simTickMs * 10) / 10, ...m };
    });
    info.annotations.push({ type: "messung-echt", description: JSON.stringify({ firstPaintMs, firstStableMs, ...perf }) });
    console.log("[brain-graph] echter Graph", JSON.stringify({ firstPaintMs, firstStableMs, ...perf }));
    expect(perf?.nodes ?? 0).toBeGreaterThan(1000);
    expect(firstStableMs ?? 99_999).toBeLessThan(1500);
    expect(perf?.fps ?? 0).toBeGreaterThan(30);
    await page.screenshot({ path: join(SHOTS, "gesamt-2d.png") });

    // Hover: Nachbarn hell, Rest abgeblendet (erst nach dem Einpassen, Schatten-Canvas braucht ein Bild)
    await page.waitForTimeout(1500);
    const hub = await page.evaluate(() => window.__brainPerf?.topNodes(1, "note")[0] ?? null);
    expect(hub).not.toBeNull();
    const pos = await page.evaluate((id) => window.__brainPerf?.screenPos(id as string) ?? null, hub);
    const box = await page.getByTestId("graph-canvas").boundingBox();
    if (pos && box) {
      await page.mouse.move(box.x + pos.x - 30, box.y + pos.y - 30);
      await page.waitForTimeout(900);
      await page.mouse.move(box.x + pos.x, box.y + pos.y, { steps: 4 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, "hover.png") });
      // Klick: Seitenblatt mit Fakten + Nachbarn, Zoom zum Knoten
      await page.mouse.click(box.x + pos.x, box.y + pos.y);
      await expect(page.getByRole("complementary", { name: /^Details:/ })).toBeVisible();
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(SHOTS, "seitenblatt.png") });
    }
    expect(errors).toEqual([]);
  });

  test("Graph füllt den ganzen Inhaltsbereich (Endprüfung: TabFade ohne Höhe → nur 480 px)", async ({ page }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    const sizes = await page.evaluate(() => {
      const main = document.querySelector("main");
      const view = document.querySelector('[data-testid="brain-view"]');
      return { main: main?.clientHeight ?? 0, view: view?.getBoundingClientRect().height ?? 0 };
    });
    expect(sizes.main).toBeGreaterThan(600);
    expect(sizes.view).toBeGreaterThanOrEqual(sizes.main - 2);
  });

  test("60 fps bei 2.000 Knoten (synthetisch)", async ({ page }, info) => {
    // Nur für die Messung: Graph mit 2.000 Knoten, vom Test selbst erzeugt (keine Platzhalter in der App).
    const N = 2000;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const nodes = Array.from({ length: N }, (_, i) => ({ id: `note:syn/${i}.md`, type: "note", label: `Notiz ${i}`, group: `g${i % 12}`, degree: 0, ref: { kind: "note", path: `syn/${i}.md` } }));
    const links: Array<{ source: string; target: string; kind: string; weight: number }> = [];
    for (let i = 1; i < N; i++) {
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) links.push({ source: `note:syn/${i}.md`, target: `note:syn/${Math.floor(rnd() * i)}.md`, kind: "wikilink", weight: 1 });
    }
    const deg = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target]) deg.set(id, (deg.get(id) ?? 0) + 1);
    for (const n of nodes) n.degree = deg.get(n.id) ?? 0;
    await page.route("**/api/graph", (route) =>
      route.fulfill({ json: { version: 1, nodes, links, stats: { nodes: N, links: links.length, orphans: 0, byType: { note: N }, byKind: { wikilink: links.length }, builtAt: new Date().toISOString(), buildMs: 0, sources: ["test"] } } }),
    );
    const errors: string[] = [];
    await openBrain(page, errors);
    await page.waitForFunction(() => window.__brainPerf?.firstStableMs !== null, undefined, { timeout: 15_000 });
    const duringSim = await page.evaluate(async () => (await window.__brainPerf?.measure(2000)) ?? null);
    await waitSettled(page);
    const settled = await page.evaluate(async () => {
      const p = window.__brainPerf;
      return p ? { ...(await p.measure(3000)), firstStableMs: p.firstStableMs, simTickMs: Math.round(p.simTickMs * 10) / 10 } : null;
    });
    info.annotations.push({ type: "messung-2000", description: JSON.stringify({ duringSim, settled }) });
    console.log("[brain-graph] 2000 Knoten", JSON.stringify({ duringSim, settled }));
    expect(settled?.fps ?? 0).toBeGreaterThanOrEqual(55);
    expect(duringSim?.fps ?? 0).toBeGreaterThanOrEqual(50);
    expect(settled?.firstStableMs ?? 99_999).toBeLessThan(1000);
    expect(errors).toEqual([]);
  });

  test("Filter: jede Art zeigen · ausgrauen · ausblenden, Suche, Waisen, Zeitraum", async ({ page }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    const base = await counts(page);
    expect(base.visible).toBeGreaterThan(0);

    await openBrainPanel(page);
    const groups = page.getByLabel("Steuerung Gehirn").locator('[data-testid^="group-"]');
    const n = await groups.count();
    expect(n).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < n; i++) {
      const row = groups.nth(i);
      const type = (await row.getAttribute("data-testid"))?.replace("group-", "") ?? "";
      const size = Number((await row.locator("span.font-mono").first().textContent()) ?? "0");
      if (type === "file" || size === 0) continue;
      await row.getByRole("radio", { name: "grau" }).click();
      await expect.poll(async () => (await counts(page)).dimmed).toBeGreaterThanOrEqual(size);
      await row.getByRole("radio", { name: "aus" }).click();
      await expect.poll(async () => (await counts(page)).hidden).toBeGreaterThanOrEqual(base.hidden + size);
      await row.getByRole("radio", { name: "zeigen" }).click();
      await expect.poll(async () => (await counts(page)).hidden).toBe(base.hidden);
      await expect.poll(async () => (await counts(page)).dimmed).toBe(0);
    }

    // Dateien einblenden lädt sie nach (include=files)
    await page.getByTestId("group-file").getByRole("radio", { name: "zeigen" }).click();
    await expect.poll(async () => Number((await page.getByTestId("group-file").locator("span.font-mono").first().textContent()) ?? "0"), { timeout: 10_000 }).toBeGreaterThan(0);
    await page.getByTestId("group-file").getByRole("radio", { name: "aus" }).click();

    // Suche graut Nicht-Treffer aus
    await page.getByLabel("Im Gehirn suchen").fill("Session");
    await expect.poll(async () => (await counts(page)).dimmed).toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS, "filter-offen.png") });
    await page.getByLabel("Im Gehirn suchen").fill("");
    await expect.poll(async () => (await counts(page)).dimmed).toBe(0);

    // Waisen aus
    const beforeOrphans = await counts(page);
    await page.getByRole("switch", { name: "Waisen" }).click();
    await expect.poll(async () => (await counts(page)).hidden).toBeGreaterThan(beforeOrphans.hidden);
    await page.getByRole("switch", { name: "Waisen" }).click();

    // Zeitraum 7 Tage blendet ältere Knoten aus; „Archiv" nur geschlossene/beendete Sessions
    await page.getByRole("radio", { name: "7 Tage" }).click();
    await expect.poll(async () => (await counts(page)).hidden).toBeGreaterThan(base.hidden);
    await page.getByRole("radio", { name: "Archiv" }).click();
    await expect.poll(async () => (await counts(page)).hidden).toBeGreaterThan(base.hidden);
    await page.getByRole("radio", { name: "Alles" }).click();
    await expect.poll(async () => (await counts(page)).hidden).toBe(base.hidden);
    expect(errors).toEqual([]);
  });

  test("3D-Umschalter (Screenshot)", async ({ page }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    await openBrainPanel(page);
    await page.getByRole("button", { name: /Darstellung/i }).click();
    await page.getByRole("radio", { name: "3D" }).click();
    await page.locator('[data-testid="graph-3d"] canvas').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: join(SHOTS, "gesamt-3d.png") });
    expect(errors.filter((e) => !/WebGL|GPU stall|GroupMarkerNotSet/i.test(e))).toEqual([]);
  });

  test("Lokaler Graph im Session-Vollbild: Tiefe 1–3, Klick zeigt Info-Karte, Doppelklick springt zur Session", async ({ page, request }) => {
    // Wie ein Mensch: Sessions-Tab, erste Karte öffnen (echte Daten).
    await page.goto("/sessions");
    const list = page.getByRole("list").first();
    await expect(list).toBeVisible({ timeout: 15_000 });
    const cards = list.getByRole("button");
    test.skip((await cards.count()) === 0, "keine Sessions im lokalen Stack");
    await cards.first().click();
    const sessionUuid = page.url().split("/").pop() ?? "";
    const res = await request.get(`/api/sessions/${sessionUuid}`);
    const s = ((await res.json()) as { session: { id: string } }).session;
    await page.getByRole("tab", { name: /Bezüge/ }).click();
    const lg = page.getByTestId("local-graph");
    await expect(lg).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Number(await lg.getAttribute("data-node-count")), { timeout: 15_000 }).toBeGreaterThan(1);
    const d1 = Number(await lg.getAttribute("data-node-count"));
    await lg.getByRole("radio", { name: "Tiefe 2" }).click();
    await expect.poll(async () => Number(await lg.getAttribute("data-node-count")), { timeout: 10_000 }).toBeGreaterThan(d1);
    await lg.getByRole("radio", { name: "Tiefe 3" }).click();
    await expect(lg).toHaveAttribute("data-depth", "3");
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(SHOTS, "lokal-session.png") });

    // Klick auf eine andere Session → Info-Karte, Doppelklick → deren Vollbild
    await lg.getByRole("radio", { name: "Tiefe 1" }).click();
    await page.waitForTimeout(2500);
    const target = await page.evaluate(() => {
      const p = window.__localGraphPerf;
      const id = p?.topNodes(20).find((x) => x.startsWith("session:") && !x.includes("/"));
      return id ? { id, pos: p?.screenPos(id) } : null;
    });
    test.skip(!target?.pos, "keine Nachbar-Session im lokalen Graphen");
    const own = `session:${s.id}`;
    if (target && target.pos && target.id !== own) {
      const box = await lg.getByTestId("graph-canvas").boundingBox();
      if (box) await page.mouse.click(box.x + target.pos.x, box.y + target.pos.y);
      await expect(lg.getByTestId("node-card")).toBeVisible();
      if (box) await page.mouse.dblclick(box.x + target.pos.x, box.y + target.pos.y);
      const uuid = target.id.split(":").pop() ?? "";
      await expect(page).toHaveURL(new RegExp(uuid), { timeout: 5000 });
    }
  });

  test("Live: neue Session erscheint ohne Neuladen < 2 s", async ({ page, request }, info) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    await page.waitForTimeout(1500); // /live verbunden
    const before = await page.evaluate(() => window.__brainPerf?.nodes ?? 0);
    const id = randomUUID();
    const now = new Date().toISOString();
    const t0 = Date.now();
    // Test-Session über den Brücken-Weg des lokalen Servers (Token `dev-token`, nur lokal).
    const res = await request.post("/ingest/events", {
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      data: {
        items: [
          {
            type: "summary",
            summary: {
              tool: "claude", sessionId: id, parentSessionId: null, cwd: null, title: "Gehirn Live-Probe", titleSource: "custom", startedAt: now, lastActivityAt: now, models: [],
              tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 }, toolCalls: {}, filesWritten: [], filesRead: [], subagents: [], gitBranch: null, cliVersion: null, eventCount: 0, parseErrors: 0, limits: null,
            },
          },
        ],
      },
    });
    expect(res.ok()).toBe(true);
    await page.waitForFunction((b) => (window.__brainPerf?.nodes ?? 0) > b, before, { timeout: 5000 });
    const ms = Date.now() - t0;
    info.annotations.push({ type: "live-ms", description: String(ms) });
    console.log("[brain-graph] Live neue Session sichtbar nach", ms, "ms");
    expect(ms).toBeLessThan(2000);
    // Aufräumen: Test-Session schließen (bleibt nur im lokalen Bestand)
    await request.post(`/api/sessions/claude:${id}/close`, { headers: { "content-type": "application/json" }, data: { by: "pg-e2e" } });
  });
});
