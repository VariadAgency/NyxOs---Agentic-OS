// Echte Claude-Limits aus CodexBar: reiner Parser + Leser (nur bei geänderter Datei senden).
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageReadingsMsgSchema, type UsageReadingsMsg } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBarReader, parseCodexBarHistory } from "../src/codexbar.js";
import { BridgeLink } from "../src/terminal/link.js";
import type { TerminalManager } from "../src/terminal/manager.js";

const PREF = "f04744b0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function sessionEntries(n: number, lastAt: string, lastPct: number) {
  const last = Date.parse(lastAt);
  return Array.from({ length: n }, (_, i) => ({
    capturedAt: new Date(last - (n - 1 - i) * 3_600_000).toISOString().replace(".000Z", "Z"),
    resetsAt: "2026-09-26T18:30:00Z",
    usedPercent: Math.max(0, lastPct - (n - 1 - i)),
  }));
}

/** Aufbau wie die echte Datei: zwei Konten, das bevorzugte ist aktuell. */
function historyFile(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    preferredAccountKey: PREF,
    accounts: {
      "__claude_old": [
        { name: "session", windowMinutes: 300, entries: [{ capturedAt: "2026-08-08T02:01:26Z", resetsAt: "2026-08-08T02:59:59Z", usedPercent: 41 }] },
        { name: "weekly", windowMinutes: 10080, entries: [{ capturedAt: "2026-08-08T02:01:26Z", resetsAt: "2026-08-11T22:59:59Z", usedPercent: 51 }] },
      ],
      [PREF]: [
        { name: "session", windowMinutes: 300, entries: sessionEntries(20, "2026-09-26T15:06:00Z", 9) },
        { name: "opus", windowMinutes: 10080, entries: [{ capturedAt: "2026-07-14T08:26:39Z", usedPercent: 0 }] },
        {
          name: "weekly",
          windowMinutes: 10080,
          entries: [
            { capturedAt: "2026-09-26T14:59:43Z", resetsAt: "2026-10-02T17:59:59Z", usedPercent: 29 },
            { capturedAt: "2026-09-26T15:06:00Z", resetsAt: "2026-10-02T17:59:59Z", usedPercent: 30 },
          ],
        },
      ],
    },
    unscoped: [],
    sessionEquivalentWindowPairIdentities: {},
    ...over,
  };
}

describe("CodexBar-Verlauf lesen (reiner Parser)", () => {
  it("bevorzugtes Konto: jüngster Eintrag je Fenster, Format wie der OAuth-Weg, Quelle codexbar", () => {
    const r = parseCodexBarHistory(JSON.stringify(historyFile()));
    expect(r).not.toBeNull();
    expect(UsageReadingsMsgSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      op: "usage_readings",
      source: "codexbar",
      tool: "claude",
      fiveHour: { utilization: 9, resets_at: "2026-09-26T18:30:00.000Z", fetchedAt: "2026-09-26T15:06:00.000Z" },
      sevenDay: { utilization: 30, resets_at: "2026-10-02T17:59:59.000Z", fetchedAt: "2026-09-26T15:06:00.000Z" },
      sevenDayOpus: { utilization: 0, resets_at: null, fetchedAt: "2026-07-14T08:26:39.000Z" },
      sevenDaySonnet: null,
    });
    // bis zu 12 jüngste Sitzungs-Punkte, älteste zuerst, letzter = aktueller Stand
    expect(r?.sessionHistory).toHaveLength(12);
    expect(r?.sessionHistory.at(-1)).toEqual(r?.fiveHour);
    expect(Date.parse(r?.sessionHistory[0]?.fetchedAt ?? "")).toBeLessThan(Date.parse(r?.sessionHistory[1]?.fetchedAt ?? ""));
  });

  it("ohne preferredAccountKey (oder veraltetes bevorzugtes Konto) → Konto mit dem jüngsten capturedAt", () => {
    const noPref = parseCodexBarHistory(JSON.stringify(historyFile({ preferredAccountKey: undefined })));
    expect(noPref?.fiveHour?.utilization).toBe(9);
    const stalePref = parseCodexBarHistory(JSON.stringify(historyFile({ preferredAccountKey: "__claude_old" })));
    expect(stalePref?.fiveHour?.utilization).toBe(9);
    const unknownPref = parseCodexBarHistory(JSON.stringify(historyFile({ preferredAccountKey: "gibt-es-nicht" })));
    expect(unknownPref?.fiveHour?.utilization).toBe(9);
  });

  it("fehlende Felder: kaputte Einträge werden übersprungen, fehlender Reset → null, fehlendes Fenster → null", () => {
    const file = historyFile();
    const acct = (file.accounts as Record<string, { name: string; entries: unknown[] }[]>)[PREF];
    if (!acct) throw new Error("Testdaten");
    acct[0] = { name: "session", entries: [{ capturedAt: "2026-09-26T15:00:00Z", usedPercent: 7 }, { capturedAt: "kaputt", usedPercent: 8 }, { usedPercent: 9 }, { capturedAt: "2026-09-26T15:01:00Z", usedPercent: "10" }] };
    acct.splice(2, 1); // kein „weekly“
    const r = parseCodexBarHistory(JSON.stringify(file));
    expect(r?.fiveHour).toEqual({ utilization: 7, resets_at: null, fetchedAt: "2026-09-26T15:00:00.000Z" });
    expect(r?.sevenDay).toBeNull();
    expect(r?.sessionHistory).toHaveLength(1);
  });

  it("kaputtes JSON, falscher Aufbau oder gar keine Sitzungs-/Wochenwerte → null (nie ein Absturz)", () => {
    expect(parseCodexBarHistory("{ kaputt")).toBeNull();
    expect(parseCodexBarHistory("null")).toBeNull();
    expect(parseCodexBarHistory(JSON.stringify({ accounts: [] }))).toBeNull();
    expect(parseCodexBarHistory(JSON.stringify({ accounts: { a: "x" } }))).toBeNull();
    expect(parseCodexBarHistory(JSON.stringify({ accounts: { a: [{ name: "opus", entries: [{ capturedAt: "2026-09-26T15:00:00Z", usedPercent: 1 }] }] } }))).toBeNull();
  });
});

describe("CodexBar-Leser (Takt, nur bei geänderter Datei)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "codexbar-"));
    dirs.push(d);
    return d;
  };

  it("sendet beim ersten Lesen, danach nur, wenn sich die Datei geändert hat", async () => {
    const path = join(tmp(), "claude.json");
    writeFileSync(path, JSON.stringify(historyFile()));
    const sent: UsageReadingsMsg[] = [];
    const logs: string[] = [];
    const reader = new CodexBarReader({ path, send: (m) => (sent.push(m), true), log: (msg) => logs.push(msg) });
    expect(await reader.tick()).toBe("sent");
    expect(await reader.tick()).toBe("unchanged");
    expect(sent).toHaveLength(1);
    writeFileSync(path, JSON.stringify(historyFile()));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect(await reader.tick()).toBe("sent");
    expect(sent).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it("Kanal gerade zu → Bericht bleibt liegen und geht beim nächsten Takt raus", async () => {
    const path = join(tmp(), "claude.json");
    writeFileSync(path, JSON.stringify(historyFile()));
    let open = false;
    const sent: UsageReadingsMsg[] = [];
    const reader = new CodexBarReader({ path, send: (m) => (open ? (sent.push(m), true) : false), log: () => {} });
    expect(await reader.tick()).toBe("pending");
    open = true;
    expect(await reader.tick()).toBe("sent");
    expect(await reader.tick()).toBe("unchanged");
    expect(sent).toHaveLength(1);
  });

  it("Datei fehlt → still; kaputte Datei → ein Log ohne Inhalt, nichts gesendet", async () => {
    const dir = tmp();
    const path = join(dir, "claude.json");
    const sent: UsageReadingsMsg[] = [];
    const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
    const reader = new CodexBarReader({ path, send: (m) => (sent.push(m), true), log: (msg, extra) => logs.push({ msg, ...(extra ? { extra } : {}) }) });
    expect(await reader.tick()).toBe("missing");
    expect(logs).toEqual([]);
    writeFileSync(path, '{"geheim": "INHALT-NIE-LOGGEN"');
    expect(await reader.tick()).toBe("error");
    expect(await reader.tick()).toBe("unchanged");
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("INHALT");
    expect(sent).toEqual([]);
  });
});

describe("Brücken-Kanal: Nutzungswerte senden", () => {
  it("send() meldet false, solange der Kanal nicht offen ist (Bericht bleibt beim Leser liegen)", () => {
    const link = new BridgeLink({ serverUrl: "http://127.0.0.1:1", token: "t", manager: {} as TerminalManager, tmuxSocket: "x", log: () => {} });
    const msg = parseCodexBarHistory(JSON.stringify(historyFile()));
    if (!msg) throw new Error("Testdaten");
    expect(link.send(msg)).toBe(false);
  });
});
