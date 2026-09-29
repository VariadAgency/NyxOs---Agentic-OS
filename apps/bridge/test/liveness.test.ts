import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_ACTIVE_MS, codexOpenSessions, parseLsofOpenPaths, stateChanges } from "../src/liveness.js";
import { findBin } from "../src/platform.js";
import { newOutbox } from "./helpers.js";

/**
 * Codex gilt nicht allein aus 10 Minuten Schreibstille als „weg", solange
 * ein `codex`-Prozess die Rollout-Datei der Session noch offen hält (langer Befehl, Freigabe-Frage).
 */

async function outbox() {
  const dir = mkdtempSync(join(tmpdir(), "nyxos-liveness-"));
  const ob = await newOutbox(dir);
  return { ob, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parseLsofOpenPaths", () => {
  it("liest jede 'n<Pfad>'-Zeile aus echter 'lsof -Fn'-Ausgabe (mehrere Prozesse/Dateien)", () => {
    const out = ["p111", "fcwd", "n/x", "ftxt", "n/Users/alex/.codex/sessions/a.jsonl", "p222", "f5w", "n/Users/alex/.codex/sessions/b.jsonl"].join(
      "\n",
    );
    expect(parseLsofOpenPaths(out)).toEqual(new Set(["/x", "/Users/alex/.codex/sessions/a.jsonl", "/Users/alex/.codex/sessions/b.jsonl"]));
  });

  it("liefert eine leere Menge für leere Ausgabe (kein Prozess offen)", () => {
    expect(parseLsofOpenPaths("")).toEqual(new Set());
  });

  it("ignoriert Zeilen, die nicht mit 'n' beginnen (p/f/... Felder)", () => {
    expect(parseLsofOpenPaths("p111\nfcwd\nftxt")).toEqual(new Set());
  });
});

// Linux ohne lsof liest /proc direkt (kein Programmaufruf) — dann gibt es hier nichts zu zählen.
describe.runIf(process.platform !== "linux" || findBin("lsof") !== null)("codexOpenSessions", () => {
  it("ruft lsof genau EINMAL auf, egal wie viele Kandidaten-Dateien geprüft werden (vorher: ein Aufruf je Datei)", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "p1\nn/a\nn/b\n", stderr: "" });
    const candidates = Array.from({ length: 16 }, (_, i) => ({ sessionId: `c${i}`, path: `/pfad/${i}.jsonl` }));
    await codexOpenSessions(candidates, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.stringMatching(/lsof$/), ["-c", "codex", "-Fpn"], expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it("meldet nur die Kandidaten als offen, deren Pfad in der lsof-Ausgabe steckt", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "p1\nn/offen/a.jsonl\n", stderr: "" });
    const result = await codexOpenSessions(
      [
        { sessionId: "offen", path: "/offen/a.jsonl" },
        { sessionId: "zu", path: "/zu/b.jsonl" },
      ],
      exec,
    );
    expect(result).toEqual(new Set(["offen"]));
  });

  it("stürzt nicht ab und meldet eine leere Menge, wenn lsof fehlschlägt (Exit-Code 1: nichts offen)", async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error("exit 1"), { stdout: "" }));
    const result = await codexOpenSessions([{ sessionId: "s1", path: "/x.jsonl" }], exec);
    expect(result).toEqual(new Set());
  });

  it("ruft lsof gar nicht auf, wenn es keine Kandidaten gibt", async () => {
    const exec = vi.fn();
    const result = await codexOpenSessions([], exec);
    expect(exec).not.toHaveBeenCalled();
    expect(result).toEqual(new Set());
  });

  it("echtes lsof: liefert eine leere Menge, wenn kein Prozess die Datei offen hat (Smoke-Test ohne Mock)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-lsof-"));
    const file = join(dir, "rollout-test.jsonl");
    writeFileSync(file, "test\n");
    const result = await codexOpenSessions([{ sessionId: "s1", path: file }]);
    expect(result.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("echtes lsof: liefert eine leere Menge für eine nicht existierende Datei (kein Absturz)", async () => {
    const result = await codexOpenSessions([{ sessionId: "s1", path: "/tmp/gibt-es-nicht/rollout.jsonl" }]);
    expect(result.size).toBe(0);
  });
});

describe("stateChanges: Codex-Lebenszeichen mit offener Rollout-Datei", () => {
  it("Codex gilt als 'läuft', solange kürzlich geschrieben wurde (unter 10 Min) — wie bisher", async () => {
    const { ob, cleanup } = await outbox();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const items = stateChanges(ob, {
      known: [{ tool: "codex", sessionId: "c1", lastMtimeMs: now - 5 * 60_000, path: "/x/rollout-c1.jsonl" }],
      claudeRunning: new Set(),
      codexProcess: true,
      codexOpenSessions: new Set(),
      now,
    });
    expect(items).toEqual([{ type: "state", state: { tool: "codex", sessionId: "c1", running: true, observedAt: new Date(now).toISOString() } }]);
    cleanup();
  });

  it("Codex gilt NICHT als 'weg', wenn seit > 10 Min nichts geschrieben wurde, aber die Rollout-Datei noch offen ist (langer Befehl)", async () => {
    const { ob, cleanup } = await outbox();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    // Vorher schon als "läuft" bekannt (sonst gäbe es ohnehin keine Änderung gegenüber dem letzten Stand).
    ob.setState("codex:c1", true);
    const items = stateChanges(ob, {
      known: [{ tool: "codex", sessionId: "c1", lastMtimeMs: now - 15 * 60_000, path: "/x/rollout-c1.jsonl" }],
      claudeRunning: new Set(),
      codexProcess: true,
      codexOpenSessions: new Set(["c1"]), // lsof: codex hält die Datei noch offen
      now,
    });
    expect(items).toEqual([]); // kein Wechsel — gilt weiterhin als "läuft"
    cleanup();
  });

  it("ohne offene Rollout-Datei (codexOpenSessions leer/fehlt): dieselbe stille Session gilt als 'weg'", async () => {
    const { ob, cleanup } = await outbox();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    ob.setState("codex:c1", true);
    const items = stateChanges(ob, {
      known: [{ tool: "codex", sessionId: "c1", lastMtimeMs: now - 15 * 60_000, path: "/x/rollout-c1.jsonl" }],
      claudeRunning: new Set(),
      codexProcess: true,
      // kein codexOpenSessions — die Datei ist (soweit bekannt) nicht mehr offen.
      now,
    });
    expect(items).toEqual([{ type: "state", state: { tool: "codex", sessionId: "c1", running: false, observedAt: new Date(now).toISOString() } }]);
    cleanup();
  });

  it("kein codex-Prozess mehr überhaupt (pgrep leer) → 'weg', auch wenn die Datei laut altem Stand offen wäre", async () => {
    const { ob, cleanup } = await outbox();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    ob.setState("codex:c1", true);
    const items = stateChanges(ob, {
      known: [{ tool: "codex", sessionId: "c1", lastMtimeMs: now - 15 * 60_000, path: "/x/rollout-c1.jsonl" }],
      claudeRunning: new Set(),
      codexProcess: false, // gar kein codex-Prozess mehr
      codexOpenSessions: new Set(["c1"]), // veralteter/falscher Treffer — codexProcess sticht
      now,
    });
    expect(items).toEqual([{ type: "state", state: { tool: "codex", sessionId: "c1", running: false, observedAt: new Date(now).toISOString() } }]);
    cleanup();
  });

  it("CODEX_ACTIVE_MS bleibt bei 10 Minuten", () => {
    expect(CODEX_ACTIVE_MS).toBe(10 * 60 * 1000);
  });
});
