// Gehirn: 3D-Wechsel mit Bildrate, freie Kamera, Farben je Art/Gruppe, mehrere Gehirne, flüssiges 2D und
// lokaler Graph mit Info-Karte. Läuft gegen den lokalen Stack mit echten Sessions und Vault:
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/brain-views.spec.ts --project chromium-1440
// Mit echter GPU messen (sonst Software-Rendering): zusätzlich `E2E_GPU=1` (Chrome, sichtbares Fenster).
// Screenshots: `.probe/shots/brain-*.png`
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openBrainPanel } from "./helpers/brainPanel";

const SHOTS = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(SHOTS, { recursive: true });

if (process.env.E2E_GPU) test.use({ channel: "chrome", headless: false });

/** Zählt Bilder (requestAnimationFrame) — Grundlage für fps und „längstes Bild" (Hänger). */
async function installFrameCounter(page: Page) {
  await page.addInitScript(() => {
    const frames: number[] = [];
    (window as unknown as { __frames: number[] }).__frames = frames;
    const loop = (t: number) => {
      frames.push(t);
      if (frames.length > 20_000) frames.splice(0, 10_000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function now(page: Page) {
  return page.evaluate(() => performance.now());
}
async function frameStats(page: Page, from: number, to: number) {
  return page.evaluate(
    ([a, b]) => {
      const xs = (window as unknown as { __frames: number[] }).__frames.filter((t) => t >= (a ?? 0) && t <= (b ?? 0));
      let maxGap = 0;
      for (let i = 1; i < xs.length; i++) maxGap = Math.max(maxGap, (xs[i] ?? 0) - (xs[i - 1] ?? 0));
      return { fps: Math.round(((xs.length - 1) / (((b ?? 0) - (a ?? 0)) / 1000)) * 10) / 10, maxGapMs: Math.round(maxGap) };
    },
    [from, to],
  );
}

async function openBrain(page: Page, errors: string[], clean = true) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  if (clean) {
    await page.goto("/gehirn");
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("nyxos.brain.")) localStorage.removeItem(k);
    });
  }
  await page.goto("/gehirn");
  await page.waitForSelector('[data-testid="graph-canvas"] canvas', { timeout: 30_000 });
  await page.waitForFunction(() => (window.__brainPerf?.nodes ?? 0) > 0);
  // Die Leiste startet zugeklappt — diese Tests arbeiten mit ihr, also ausfahren.
  await openBrainPanel(page);
}

const counts = async (page: Page) => {
  const v = page.getByTestId("brain-view");
  return { visible: Number(await v.getAttribute("data-visible-count")), hidden: Number(await v.getAttribute("data-hidden-count")) };
};

async function to3d(page: Page) {
  await openBrainPanel(page);
  const disp = page.getByRole("button", { name: /Darstellung/i });
  if ((await disp.getAttribute("aria-expanded")) !== "true") await disp.click();
  await page.getByLabel("Ansicht", { exact: true }).getByRole("radio", { name: "3D", exact: true }).click();
  await page.waitForSelector('[data-testid="graph-3d"][data-ready="1"]', { timeout: 20_000 });
}

test.describe("Gehirn: Ansichten", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Messungen/Screenshots nur in Chromium");

  test("Wechsel auf 3D ohne Hänger, ≥ 30 fps mit allen Knoten, zurück auf 2D sofort", async ({ page }, info) => {
    await installFrameCounter(page);
    const errors: string[] = [];
    await openBrain(page, errors);
    await page.waitForFunction(() => window.__brainPerf?.firstStableMs != null, undefined, { timeout: 20_000 });
    const t0 = await now(page);
    await to3d(page);
    const tReady = await now(page);
    await page.waitForTimeout(3000);
    const sw = await frameStats(page, t0, await now(page));
    const perf = await page.evaluate(async () => {
      const p = window.__brain3dPerf;
      return p ? { nodes: p.nodes, visible: p.visible, ...(await p.measure(3000)) } : null;
    });
    // Umkreisen per Maus (echtes Ziehen)
    const box = await page.getByTestId("graph-3d").boundingBox();
    if (!box) throw new Error("kein 3D-Bereich");
    const o0 = await now(page);
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + box.width / 2 - 150 + i * 5, box.y + box.height / 2 + Math.sin(i / 8) * 30);
    await page.mouse.up();
    const orbit = await frameStats(page, o0, await now(page));
    await page.screenshot({ path: join(SHOTS, "brain-3d-switch.png") });
    const b0 = await now(page);
    await page.getByLabel("Ansicht", { exact: true }).getByRole("radio", { name: "2D", exact: true }).click();
    await page.waitForTimeout(1500);
    const back = await frameStats(page, b0, await now(page));
    const m = { readyMs: Math.round(tReady - t0), switch: sw, perf, orbit, back };
    info.annotations.push({ type: "3d-switch", description: JSON.stringify(m) });
    console.log("[brain 3d-switch]", JSON.stringify(m));
    expect(perf?.nodes ?? 0).toBeGreaterThan(1000);
    expect(perf?.visible).toBe(perf?.nodes);
    // Kein Hänger: der Hauptthread bleibt frei (auch ohne GPU). Die fps-Grenze gilt nur mit echter GPU —
    // headless zeichnet Chrome per Software (SwiftShader), dort sind ~15 fps normal.
    expect(sw.maxGapMs).toBeLessThan(400);
    expect(back.maxGapMs).toBeLessThan(400);
    expect(perf?.renderMsAvg ?? 99).toBeLessThan(8); // Hauptthread-Kosten je Bild
    if (process.env.E2E_GPU) {
      expect(perf?.fps ?? 0).toBeGreaterThanOrEqual(30);
      expect(orbit.fps).toBeGreaterThanOrEqual(30);
      expect(sw.maxGapMs).toBeLessThan(300);
    }
    expect(errors).toEqual([]);
  });

  test("Frei bewegen — Tasten bewegen die Kamera, Fliegen/Umkreisen, Alles einpassen", async ({ page }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    await to3d(page);
    await expect(page.getByTestId("brain-3d-keys")).toBeVisible();
    await page.waitForFunction(() => window.__brain3dPerf?.simRunning === false, undefined, { timeout: 30_000 }).catch(() => undefined);
    const host = page.getByTestId("graph-3d");
    await host.focus();
    const d0 = await page.evaluate(() => window.__brain3dPerf?.cameraDistance() ?? 0);
    await page.keyboard.down("w");
    await page.waitForTimeout(700);
    await page.keyboard.up("w");
    const d1 = await page.evaluate(() => window.__brain3dPerf?.cameraDistance() ?? 0);
    expect(Math.abs(d1 - d0)).toBeGreaterThan(20); // W fliegt vorwärts
    await page.keyboard.press("v"); // V = Fliegen, F = alles zeigen
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.control)).toBe("fly");
    await expect(page.getByRole("radiogroup", { name: "3D-Steuerung" }).first().getByRole("radio", { name: "Fliegen" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.down("Shift");
    await page.keyboard.down("e");
    await page.waitForTimeout(400);
    await page.keyboard.up("e");
    await page.keyboard.up("Shift");
    await page.screenshot({ path: join(SHOTS, "brain-3d-move.png") });
    await page.getByRole("button", { name: /Alles einpassen/ }).first().click();
    await page.waitForTimeout(900);
    const d2 = await page.evaluate(() => window.__brain3dPerf?.cameraDistance() ?? 0);
    expect(d2).toBeGreaterThan(50);
    await page.keyboard.press("v"); // V = Fliegen, F = alles zeigen
    await expect.poll(() => page.evaluate(() => window.__brain3dPerf?.control)).toBe("orbit");
    expect(errors).toEqual([]);
  });

  test("Farbe je Art ist Standard, Legende sichtbar, Farbe je Gruppe änderbar (gemerkt)", async ({ page }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    await expect(page.getByRole("switch", { name: "Farben je Art" })).toHaveAttribute("aria-checked", "true");
    const legend = page.getByTestId("brain-legend");
    // Legende ist standardmäßig eingeklappt
    const legendToggle = legend.getByRole("button", { name: /^Legende/ });
    if ((await legendToggle.getAttribute("aria-expanded")) === "false") await legendToggle.click();
    await expect(legend).toBeVisible();
    const colors = await legend.locator("[data-color]").evaluateAll((els) => els.map((e) => e.getAttribute("data-color") ?? ""));
    expect(colors.length).toBeGreaterThanOrEqual(8);
    expect(new Set(colors).size).toBeGreaterThanOrEqual(colors.length - 3); // bewusst geteilte Farben (Bug ↔ Bugs & Fixes …)
    for (const c of colors) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      expect({ c, bunt: sat > 0.15 }).toEqual({ c, bunt: true }); // kein Grau/Weiß/Schwarz
    }
    // Obsidian-Notizen nach Ordner: mehrere Notiz-Kategorien vorhanden
    await expect(page.getByTestId("note-groups").locator('[data-testid^="note-group-"]')).not.toHaveCount(0);
    expect(await page.getByTestId("note-groups").locator('[data-testid^="note-group-"]').count()).toBeGreaterThanOrEqual(4);
    // Farbe ändern → Legende zeigt sie, nach Neuladen noch da
    await page.getByLabel("Farbe: Sessions").evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(el, "#ff7a00");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(legend.locator('[data-color="#ff7a00"]')).toHaveCount(1);
    await page.waitForTimeout(500);
    await openBrain(page, errors, false);
    await expect(page.getByTestId("brain-legend").locator('[data-color="#ff7a00"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Farben zurücksetzen" }).click();
    await page.waitForFunction(() => (window.__brainPerf?.alpha ?? 1) < 0.05, undefined, { timeout: 25_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, "brain-colors.png") });
    expect(errors).toEqual([]);
  });

  test("Mehrere Gehirne — Vorgaben, Pro Baustelle, eigene Ansicht, Gehirn je Session", async ({ page, request }) => {
    const errors: string[] = [];
    await openBrain(page, errors);
    const all = await counts(page);
    const tabs = page.getByRole("tablist", { name: "Gehirne" });
    await tabs.getByRole("tab", { name: "Nur Code" }).click();
    await expect(tabs.getByRole("tab", { name: "Nur Code" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await counts(page)).visible).toBeLessThan(all.visible);
    await tabs.getByRole("tab", { name: "Sessions & Agenten" }).click();
    const sess = await counts(page);
    expect(sess.visible).toBeLessThan(1000);
    await tabs.getByRole("tab", { name: "Pro Baustelle" }).click();
    await expect(page.getByLabel("Baustelle wählen")).toBeVisible();
    await expect.poll(async () => (await counts(page)).visible).toBeLessThan(all.visible);
    // eigene Ansicht speichern
    await tabs.getByRole("tab", { name: "Planung/Obsidian" }).click();
    await page.getByRole("button", { name: "+ Ansicht speichern" }).click();
    await page.getByLabel("Name der Ansicht").fill("Meine Planung");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(tabs.getByRole("tab", { name: "★ Meine Planung" })).toHaveAttribute("aria-selected", "true");
    await tabs.getByRole("tab", { name: "Alles" }).click();
    await expect.poll(async () => (await counts(page)).visible).toBe(all.visible);
    await tabs.getByRole("tab", { name: "★ Meine Planung" }).click();
    await expect.poll(async () => (await counts(page)).visible).toBeLessThan(all.visible);
    await tabs.getByRole("tab", { name: "Alles" }).click();
    // Gehirn je Session (Knopf aus der Session: /gehirn?brain=<id>)
    const list = (await (await request.get("/api/sessions?limit=50")).json()) as { sessions: Array<{ id: string; parentId: string | null }> };
    const s = list.sessions.find((x) => !x.parentId);
    test.skip(!s, "keine Session im lokalen Stack");
    await page.goto(`/gehirn?brain=${encodeURIComponent(`session:${s?.id ?? ""}`)}`);
    await expect(page.getByTestId("brain-focus")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await counts(page)).visible).toBeLessThan(all.visible);
    await page.waitForFunction(() => window.__brainPerf?.firstStableMs != null, undefined, { timeout: 20_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SHOTS, "brain-multiple.png") });
    await page.getByRole("button", { name: "Eigenes Gehirn schließen" }).click();
    await expect(page.getByTestId("brain-focus")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("2D flüssig beim Zoomen, Schieben und Hover (keine Hänger)", async ({ page }, info) => {
    await installFrameCounter(page);
    const errors: string[] = [];
    await openBrain(page, errors);
    const firstStableMs = await page.waitForFunction(() => window.__brainPerf?.firstStableMs ?? null, undefined, { timeout: 20_000 }).then((h) => h.jsonValue());
    await page.waitForFunction(() => (window.__brainPerf?.alpha ?? 1) < 0.05, undefined, { timeout: 30_000 }).catch(() => undefined);
    const box = await page.getByTestId("graph-canvas").boundingBox();
    if (!box) throw new Error("kein Graph");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    const z0 = await now(page);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, i < 15 ? -120 : 120);
      await page.waitForTimeout(40);
    }
    const zoom = await frameStats(page, z0, await now(page));
    const p0 = await now(page);
    await page.mouse.move(box.x + 40, box.y + box.height - 40);
    await page.mouse.down();
    for (let i = 0; i < 50; i++) await page.mouse.move(box.x + 40 + i * 6, box.y + box.height - 40 - i * 3);
    await page.mouse.up();
    const pan = await frameStats(page, p0, await now(page));
    const h0 = await now(page);
    for (let i = 0; i < 50; i++) {
      await page.mouse.move(cx - 180 + i * 7, cy - 90 + (i % 10) * 18);
      await page.waitForTimeout(25);
    }
    const hover = await frameStats(page, h0, await now(page));
    await page.screenshot({ path: join(SHOTS, "brain-2d-smooth.png") });
    const m = { firstStableMs, zoom, pan, hover };
    info.annotations.push({ type: "2d-smooth", description: JSON.stringify(m) });
    console.log("[brain 2d-smooth]", JSON.stringify(m));
    expect(zoom.maxGapMs).toBeLessThan(150);
    expect(pan.maxGapMs).toBeLessThan(150);
    expect(hover.maxGapMs).toBeLessThan(150);
    expect(errors).toEqual([]);
  });

  test("Lokaler Graph — Klick auf einen Punkt zeigt rechts die Info-Karte, Esc schließt", async ({ page }) => {
    await page.goto("/sessions");
    const list = page.getByRole("list").first();
    await expect(list).toBeVisible({ timeout: 15_000 });
    const cards = list.getByRole("button");
    test.skip((await cards.count()) === 0, "keine Sessions im lokalen Stack");
    await cards.first().click();
    await page.getByRole("tab", { name: /Bezüge/ }).click();
    const lg = page.getByTestId("local-graph");
    await expect(lg).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Number(await lg.getAttribute("data-node-count")), { timeout: 15_000 }).toBeGreaterThan(1);
    await lg.getByRole("radio", { name: "Tiefe 2" }).click();
    await page.waitForTimeout(2500);
    const target = await page.evaluate(() => {
      const p = window.__localGraphPerf;
      const id = p?.topNodes(12).find((x) => x.startsWith("note:") || x.startsWith("session:") || x.startsWith("baustelle:"));
      return id ? { id, pos: p?.screenPos(id) } : null;
    });
    test.skip(!target?.pos, "kein Punkt im lokalen Graphen");
    const box = await lg.getByTestId("graph-canvas").boundingBox();
    if (!box || !target?.pos) throw new Error("kein Graph");
    const url = page.url();
    await page.mouse.click(box.x + target.pos.x, box.y + target.pos.y);
    const card = lg.getByTestId("node-card");
    await expect(card).toBeVisible();
    expect(page.url()).toBe(url); // kein Tab-/Seitenwechsel
    await expect(card.locator("dl")).toBeVisible({ timeout: 5000 }); // Fakten vom Server
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "brain-local-graph.png") });
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  });
});
