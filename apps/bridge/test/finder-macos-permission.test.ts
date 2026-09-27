// Offene macOS-Freigabe: Nach einem Neubau fragt macOS erneut, ob die Brücke ~/Downloads lesen darf.
// Solange niemand „Erlauben“ klickt, hängt jedes Lesen dort (der Server würde 20 s warten und 504 geben). Daher:
// je Wurzel höchstens EIN erstes Lesen gleichzeitig, eigenes Zeitlimit, danach sofort ein klarer Fehler-Code;
// das hängende Lesen läuft weiter und füllt bei Erfolg den Zwischenspeicher. Kein echter Zugriff auf ~/Downloads:
// die Wurzel liegt in einem Temp-Ordner, das erste Lesen hängt künstlich (`probeDir`).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDER_ERR, finderPermissionText, type FinderListResult } from "@nyxos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinderError, FinderFs } from "../src/finder/fs.js";

const TIMEOUT_MS = 120;
const FILES = 50;

let home: string;
// je Test eigene Zähler: das weiterlaufende Lesen eines früheren Tests darf hier nicht mitzählen
let n = { stats: 0, probes: 0 };
let release: () => void = () => undefined;

/** Erstes Lesen von „Downloads“ hängt, bis der Test „Erlauben“ klickt (`release`). */
function hangingFs(): FinderFs {
  const c = n;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  return new FinderFs({
    projectRoots: [join(home, "Projekte")],
    home,
    screenshotsDir: null,
    backupsDir: join(home, "backups"),
    firstAccessTimeoutMs: TIMEOUT_MS,
    probeDir: async (abs) => {
      if (!abs.endsWith("/Downloads")) return readdir(abs);
      c.probes++;
      await gate;
      return readdir(abs);
    },
    onStat: async () => {
      c.stats++;
    },
  });
}

async function expectPermissionError(p: Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FinderError);
  expect((err as FinderError).code).toBe(FINDER_ERR.macosPermission);
  expect((err as FinderError).message).toBe(finderPermissionText("Downloads"));
  return performance.now() - t0;
}

beforeEach(() => {
  n = { stats: 0, probes: 0 };
  home = mkdtempSync(join(tmpdir(), "nyxos-p5-"));
  mkdirSync(join(home, "projekte"), { recursive: true });
  const dl = join(home, "Downloads");
  mkdirSync(join(dl, "Ordner"), { recursive: true });
  for (let i = 0; i < FILES; i++) writeFileSync(join(dl, `datei-${i}.pdf`), "x");
});

describe("macOS-Freigabe offen: die Brücke hängt nicht", () => {
  it("antwortet nach dem eigenen Zeitlimit mit `macos_freigabe_offen` statt zu warten", async () => {
    const f = hangingFs();
    const ms = await expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "" }));
    expect(ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(ms).toBeLessThan(TIMEOUT_MS + 1_000);
    release();
  });

  it("weitere Anfragen starten keinen zweiten Zugriff und antworten nach Ablauf sofort", async () => {
    const f = hangingFs();
    await expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "" }));
    // Neuversuch der Oberfläche, Kinderzahlen, Unterordner, Datei-Infos: alle hängen an demselben ersten Lesen.
    const again = await Promise.all([
      expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "" })),
      expectPermissionError(f.handle({ op: "counts", root: "downloads", rel: "" })),
      expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "Ordner" })),
      expectPermissionError(f.handle({ op: "stat", root: "downloads", rel: "datei-1.pdf" })),
    ]);
    for (const ms of again) expect(ms).toBeLessThan(60);
    expect(n.probes).toBe(1);
    expect(n.stats).toBe(0);
    release();
  });

  it("nach dem späten „Erlauben“ füllt das weiterlaufende Lesen den Zwischenspeicher", async () => {
    const f = hangingFs();
    await expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "" }));
    expect(n.stats).toBe(0);
    release();
    // Die Liste entsteht im Hintergrund — ohne dass jemand erneut fragt.
    await vi.waitFor(() => expect(n.stats).toBe(FILES + 1), { timeout: 2_000, interval: 10 });
    const r = (await f.handle({ op: "list", root: "downloads", rel: "" })) as FinderListResult;
    expect(r.entries).toHaveLength(FILES + 1);
    expect(n.stats).toBe(FILES + 1); // aus dem Zwischenspeicher, keine zweite Runde
    expect(n.probes).toBe(1);
  });

  it("Vorwärmen und Favoriten-Abfrage blockieren nichts, während macOS fragt", async () => {
    const f = hangingFs();
    let ticks = 0;
    const iv = setInterval(() => ticks++, 5);
    const t0 = performance.now();
    const roots = (await f.handle({ op: "roots" })) as { id: string }[];
    expect(performance.now() - t0).toBeLessThan(100);
    expect(roots.some((r) => r.id === "downloads")).toBe(true);
    // Vorwärmen endet nach dem Zeitlimit still (0 Einträge) — die Ereignisschleife tickt die ganze Zeit weiter.
    expect(await f.prewarm()).toBe(0);
    clearInterval(iv);
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(TIMEOUT_MS / 5 / 3));
    expect(n.probes).toBe(1);
    release();
  });

  it("andere Wurzeln sind nicht betroffen", async () => {
    const f = hangingFs();
    await expectPermissionError(f.handle({ op: "list", root: "downloads", rel: "" }));
    const r = (await f.handle({ op: "list", root: "project", rel: "" })) as FinderListResult;
    expect(r.entries).toEqual([]);
    release();
  });
});
