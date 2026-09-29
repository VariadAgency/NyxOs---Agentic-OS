// Große Ordner beim ersten Öffnen: ~/Downloads (1.753 Einträge) stand ohne Vorarbeit erst nach 7,0 s.
// Die Brücke liest den Ordner deshalb einmal vorab (sobald die Favoriten abgefragt werden), gleichzeitige
// Anfragen für denselben Ordner teilen sich eine Runde, und ein unveränderter Ordner kommt kurz aus dem
// Zwischenspeicher. Künstliche Verzögerung je Datei-Abfrage simuliert eine kalte Platte.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinderListResult } from "@nyxos/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FinderFs } from "../src/finder/fs.js";

let home: string;
let project: string;
let stats = 0;
const DELAY_MS = 4;

function slowFs(extra: Partial<ConstructorParameters<typeof FinderFs>[0]> = {}): FinderFs {
  return new FinderFs({
    projectRoots: [project],
    home,
    screenshotsDir: null,
    backupsDir: join(home, "backups"),
    onStat: async () => {
      stats++;
      await new Promise((res) => setTimeout(res, DELAY_MS));
    },
    ...extra,
  });
}

beforeEach(() => {
  stats = 0;
  home = mkdtempSync(join(tmpdir(), "nyxos-p3b-"));
  project = join(home, "projekte");
  mkdirSync(project, { recursive: true });
  const dl = join(home, "Downloads");
  mkdirSync(dl, { recursive: true });
  for (let i = 0; i < 2000; i++) writeFileSync(join(dl, `datei-${i}.pdf`), "x");
});

describe("großer Ordner beim ersten Öffnen", () => {
  it("die Favoriten-Abfrage wärmt ~/Downloads vor; die Liste danach braucht keine zweite Runde", async () => {
    const f = slowFs();
    await f.handle({ op: "roots" });
    const t0 = performance.now();
    const r = (await f.handle({ op: "list", root: "downloads", rel: "" })) as FinderListResult;
    const first = performance.now() - t0;
    expect(r.entries).toHaveLength(2000);
    // eine einzige Runde Datei-Abfragen, obwohl Vorwärmen und Liste beide den Ordner wollten
    expect(stats).toBe(2000);
    // 2.000 × 4 ms / 32 gleichzeitig ≈ 250 ms — die Liste wartet höchstens auf den Rest des Vorwärmens
    expect(first).toBeLessThan(2000);
    const t1 = performance.now();
    await f.handle({ op: "list", root: "downloads", rel: "" });
    expect(performance.now() - t1).toBeLessThan(40);
    expect(stats).toBe(2000);
  });

  it("zwei gleichzeitige Listen desselben Ordners teilen sich eine Runde", async () => {
    const f = slowFs();
    const [a, b] = (await Promise.all([f.handle({ op: "list", root: "downloads", rel: "" }), f.handle({ op: "list", root: "downloads", rel: "" })])) as FinderListResult[];
    expect(a?.entries).toHaveLength(2000);
    expect(b?.entries).toHaveLength(2000);
    expect(stats).toBe(2000);
  });

  it("ändert sich der Ordner (neue Datei), kommt die Liste frisch", async () => {
    const f = slowFs();
    await f.handle({ op: "list", root: "downloads", rel: "" });
    writeFileSync(join(home, "Downloads", "neu.txt"), "neu");
    // mtime des Ordners sicher anders (manche Dateisysteme runden auf Sekunden)
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(home, "Downloads"), later, later);
    const r = (await f.handle({ op: "list", root: "downloads", rel: "" })) as FinderListResult;
    expect(r.entries).toHaveLength(2001);
    expect(r.entries.some((e) => e.name === "neu.txt")).toBe(true);
  });

  it("der Zwischenspeicher ist kurzlebig (Größen wachsender Dateien bleiben nicht lange alt)", async () => {
    let clock = 1_000_000;
    const f = slowFs({ nowMs: () => clock });
    await f.handle({ op: "list", root: "downloads", rel: "" });
    expect(stats).toBe(2000);
    clock += 60_000;
    await f.handle({ op: "list", root: "downloads", rel: "" });
    expect(stats).toBe(4000);
  });
});
