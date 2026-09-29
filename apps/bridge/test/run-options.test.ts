import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunOptions } from "../src/run-options.js";

/**
 * `nyxos-bridge run --data-dir <ordner>` (lokaler Probe-Stack ohne Docker): eine zweite,
 * getrennte Brücken-Instanz mit eigenem Puffer/Spool, ohne die installierte Brücke
 * (`~/Library/Application Support/NyxOS/…`) anzufassen. `defaultConfigFile` erlaubt Tests,
 * nie die echte installierte Konfigurationsdatei zu berühren.
 */
describe("resolveRunOptions (Brücke: --data-dir)", () => {
  it("ohne --data-dir: lädt die übergebene Standard-Konfiguration, nur die Git-Erfassung als Daemon-Option", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-run-default-"));
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ serverUrl: "http://127.0.0.1:47801", token: "echt" }));

    const { cfg, daemonOpts, dataDir } = resolveRunOptions([], configFile);

    expect(dataDir).toBeNull();
    expect(cfg.serverUrl).toBe("http://127.0.0.1:47801");
    expect(cfg.token).toBe("echt");
    // Auch die installierte Brücke scannt Git , sonst nichts Eigenes.
    // Und nur die installierte Brücke liest die echten Limits aus CodexBar (Probe nie).
    expect(Object.keys(daemonOpts)).toEqual(["git", "codexbar"]);
    // Kein Datenverzeichnis angelegt — es wurde keins verlangt.
    expect(existsSync(join(dir, "spool"))).toBe(false);
  });

  it("mit --data-dir: eigenes Puffer/Spool-Verzeichnis, config.json aus dem Datenverzeichnis (nie der Standardpfad)", () => {
    const base = mkdtempSync(join(tmpdir(), "nyxos-run-data-"));
    const dataDir = join(base, "probe");
    const untouchedDefault = join(base, "sollte-nie-gelesen-werden.json"); // existiert bewusst gar nicht

    // Das Probe-Skript legt die config.json selbst im Datenverzeichnis an, bevor "run" startet.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serverUrl: "http://127.0.0.1:47890", token: "dev-token" }));

    const { cfg, daemonOpts, dataDir: returnedDataDir } = resolveRunOptions(["--data-dir", dataDir], untouchedDefault);

    expect(returnedDataDir).toBe(dataDir);
    expect(cfg.serverUrl).toBe("http://127.0.0.1:47890");
    expect(cfg.token).toBe("dev-token");
    expect(daemonOpts.spoolDir).toBe(join(dataDir, "spool"));
    expect(daemonOpts.dbPath).toBe(join(dataDir, "buffer.sqlite"));
    // Chat-Anhänge der Probe landen im Datenordner, nie im Ordner der installierten Brücke.
    expect(daemonOpts.uploadsDir).toBe(join(dataDir, "uploads"));
    // Die (nicht existierende) Standard-Konfigurationsdatei wurde nie angefasst/gebraucht.
    expect(existsSync(untouchedDefault)).toBe(false);
  });

  it("legt das Datenverzeichnis an, falls es noch nicht existiert (config.json muss trotzdem schon da sein)", () => {
    const base = mkdtempSync(join(tmpdir(), "nyxos-run-mkdir-"));
    const dataDir = join(base, "noch-nicht-da");

    expect(existsSync(dataDir)).toBe(false);
    expect(() => resolveRunOptions(["--data-dir", dataDir])).toThrow(); // config.json fehlt noch
    expect(existsSync(dataDir)).toBe(true); // der Ordner selbst wurde trotzdem angelegt

    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serverUrl: "http://127.0.0.1:47890", token: "dev-token" }));
    const { dataDir: returned } = resolveRunOptions(["--data-dir", dataDir]);
    expect(returned).toBe(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).token).toBe("dev-token");
  });

  describe("git.applyCatchups", () => {
    function configureDataDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "nyxos-run-apply-"));
      writeFileSync(join(dir, "config.json"), JSON.stringify({ serverUrl: "http://127.0.0.1:47890", token: "dev-token" }));
      return dir;
    }

    it("ohne NYXOS_GIT_CATCHUP_APPLY: applyCatchups ist false (Sicherheits-Standard aus)", () => {
      const prev = process.env.NYXOS_GIT_CATCHUP_APPLY;
      delete process.env.NYXOS_GIT_CATCHUP_APPLY;
      try {
        const { daemonOpts } = resolveRunOptions(["--data-dir", configureDataDir()]);
        expect(daemonOpts.git?.applyCatchups).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.NYXOS_GIT_CATCHUP_APPLY;
        else process.env.NYXOS_GIT_CATCHUP_APPLY = prev;
      }
    });

    it.each(["true", "TRUE", " 1 ", "01", "yes", ""])("mit NYXOS_GIT_CATCHUP_APPLY=%j (alles außer exakt '1'): bleibt aus", (value) => {
      const prev = process.env.NYXOS_GIT_CATCHUP_APPLY;
      process.env.NYXOS_GIT_CATCHUP_APPLY = value;
      try {
        const { daemonOpts } = resolveRunOptions(["--data-dir", configureDataDir()]);
        expect(daemonOpts.git?.applyCatchups).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.NYXOS_GIT_CATCHUP_APPLY;
        else process.env.NYXOS_GIT_CATCHUP_APPLY = prev;
      }
    });

    it("mit NYXOS_GIT_CATCHUP_APPLY=1 (exakt): applyCatchups ist true", () => {
      const prev = process.env.NYXOS_GIT_CATCHUP_APPLY;
      process.env.NYXOS_GIT_CATCHUP_APPLY = "1";
      try {
        const { daemonOpts } = resolveRunOptions(["--data-dir", configureDataDir()]);
        expect(daemonOpts.git?.applyCatchups).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.NYXOS_GIT_CATCHUP_APPLY;
        else process.env.NYXOS_GIT_CATCHUP_APPLY = prev;
      }
    });
  });
});
