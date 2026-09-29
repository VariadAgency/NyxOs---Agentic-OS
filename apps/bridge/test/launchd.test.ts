// Installer-Wiederholung: `launchctl bootstrap` kann mit Fehler 5 fehlschlagen (Input/output error —
// der alte Dienst ist nach `bootout` noch nicht ganz entladen). Daher: entladen,
// warten bis wirklich weg, laden mit Wiederholungen, am Ende prüfen, dass der Dienst läuft.
// launchctl ist hier komplett nachgebaut — kein echter launchd-Aufruf.
import { describe, expect, it } from "vitest";
import { loadLaunchAgent, unloadLaunchAgent, type LaunchctlResult } from "../src/launchd.js";

const TARGET = "gui/501/app.nyxos.bridge";
const PLIST = "/tmp/app.nyxos.bridge.plist";

/** Simuliert launchd: Zustand geladen/läuft, verzögertes Entladen, scheiternde Bootstraps. */
function fakeLaunchd(o: { loaded?: boolean; bootoutLingers?: number; bootstrapFailures?: number; neverRuns?: boolean; disabled?: boolean } = {}) {
  let loaded = o.loaded ?? false;
  // Abgeschalteter Dienst (`launchctl disable`, Eintrag in der disabled-Liste): bootstrap scheitert mit Fehler 5,
  // egal wie oft man es versucht — nur `enable` hilft.
  let disabled = o.disabled ?? false;
  let lingering = 0;
  let failures = o.bootstrapFailures ?? 0;
  const calls: string[] = [];
  const run = (args: string[]): LaunchctlResult => {
    calls.push(args.join(" "));
    const [cmd] = args;
    if (cmd === "print") {
      if (lingering > 0) {
        lingering--;
        return { code: 0, out: "state = not running" };
      }
      return loaded ? { code: 0, out: o.neverRuns ? "state = spawn scheduled\n" : "state = running\n\tpid = 4242\n" } : { code: 113, out: "Could not find service" };
    }
    if (cmd === "bootout") {
      if (!loaded) return { code: 3, out: "No such process" };
      loaded = false;
      lingering = o.bootoutLingers ?? 0;
      return { code: 0, out: "" };
    }
    if (cmd === "enable") {
      disabled = false;
      return { code: 0, out: "" };
    }
    if (cmd === "bootstrap") {
      if (disabled) return { code: 5, out: "Bootstrap failed: 5: Input/output error" };
      if (lingering > 0 || loaded || failures > 0) {
        if (failures > 0) failures--;
        return { code: 5, out: "Bootstrap failed: 5: Input/output error" };
      }
      loaded = true;
      return { code: 0, out: "" };
    }
    return { code: 0, out: "" };
  };
  return { run, calls, sleep: async () => {} };
}

describe("launchd: Brücken-Dienst robust laden", () => {
  it("wartet nach bootout, bis der alte Dienst wirklich weg ist, bevor geladen wird", async () => {
    const f = fakeLaunchd({ loaded: true, bootoutLingers: 3 });
    await unloadLaunchAgent({ target: TARGET, run: f.run, sleep: f.sleep });
    const report = await loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep });
    expect(f.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(1);
    expect(report.join(" ")).toContain("läuft");
  });

  it("Fehler 5 beim bootstrap → entladen, warten, erneut versuchen (bis Erfolg)", async () => {
    const f = fakeLaunchd({ bootstrapFailures: 2 });
    const report = await loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep });
    expect(f.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(3);
    expect(report.join(" ")).toMatch(/Versuch 3/);
    expect(report.join(" ")).toContain("pid 4242");
  });

  it("ist schon geladen (z. B. halb abgebrochener Install) → erst entladen, dann laden", async () => {
    const f = fakeLaunchd({ loaded: true });
    await loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep });
    const i = f.calls.findIndex((c) => c.startsWith("bootout"));
    const j = f.calls.findIndex((c) => c.startsWith("bootstrap"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
  });

  it("gibt nach allen Versuchen mit klarer Meldung auf", async () => {
    const f = fakeLaunchd({ bootstrapFailures: 99 });
    await expect(loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep, attempts: 4 })).rejects.toThrow(/4 Versuchen.*Input\/output error/s);
    expect(f.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(4);
  });

  it("prüft am Ende, dass der Dienst wirklich läuft — geladen, aber nie gestartet → Fehler", async () => {
    const f = fakeLaunchd({ neverRuns: true });
    await expect(loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep, verifyMs: 3000 })).rejects.toThrow(/läuft aber nicht/);
  });

  it("abgeschalteter Dienst (disabled) → erst enable, dann bootstrap — sonst Fehler 5 bei jedem Versuch", async () => {
    const f = fakeLaunchd({ disabled: true });
    const report = await loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep });
    expect(report.join(" ")).toMatch(/Versuch 1 von/);
  });

  it("genaue Befehlsfolge: prüfen → entladen → warten → enable → bootstrap → kickstart (ohne -k) → prüfen", async () => {
    const f = fakeLaunchd({ loaded: true, bootoutLingers: 1 });
    await loadLaunchAgent({ target: TARGET, plist: PLIST, uid: 501, run: f.run, sleep: f.sleep });
    expect(f.calls).toEqual([
      `print ${TARGET}`,
      `bootout ${TARGET}`,
      `print ${TARGET}`, // noch da (entlädt gerade)
      `print ${TARGET}`, // jetzt weg
      `enable ${TARGET}`,
      `bootstrap gui/501 ${PLIST}`,
      `kickstart ${TARGET}`,
      `print ${TARGET}`,
    ]);
    expect(f.calls.some((c) => c.includes("-k"))).toBe(false);
  });
});
