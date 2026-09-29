// Brücken-Dienst in launchd (macOS) robust laden.
//
// `launchctl bootout` kehrt zurück, bevor launchd den alten Dienst ganz entladen hat; ein sofortiges
// `bootstrap` trifft dann auf den noch registrierten Dienst und scheitert mit Fehler 5 (Input/output error).
// Zweite Ursache für Fehler 5: der Dienst steht auf „disabled" — darum `enable` vor jedem `bootstrap`.
// Ablauf: entladen → warten, bis `launchctl print` ihn nicht mehr kennt → enable → laden, bei Fehler bis zu
// N-mal wiederholen (mit erneutem Entladen) → am Ende prüfen, dass der Dienst läuft (state = running + pid).
import { execFileSync } from "node:child_process";
import { t } from "@nyxos/shared";

export interface LaunchctlResult {
  code: number;
  out: string;
}
export type LaunchctlRunner = (args: string[]) => LaunchctlResult;

/** Echter Aufruf: nie werfen, Exit-Code und Ausgabe zurückgeben. */
export const realLaunchctl: LaunchctlRunner = (args) => {
  try {
    // Zeitlimit: ein hängendes launchctl darf den Installer nicht endlos blockieren.
    const out = execFileSync("/bin/launchctl", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? e) };
  }
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Common {
  /** z. B. `gui/501/app.nyxos.bridge` */
  target: string;
  run?: LaunchctlRunner;
  sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 500;

function isLoaded(run: LaunchctlRunner, target: string): boolean {
  return run(["print", target]).code === 0;
}

/** Entlädt den Dienst (falls geladen) und wartet, bis launchd ihn wirklich nicht mehr kennt. */
export async function unloadLaunchAgent(o: Common & { waitMs?: number }): Promise<boolean> {
  const run = o.run ?? realLaunchctl;
  const sleep = o.sleep ?? realSleep;
  if (!isLoaded(run, o.target)) return true;
  run(["bootout", o.target]);
  for (let waited = 0; waited < (o.waitMs ?? 10_000); waited += POLL_MS) {
    if (!isLoaded(run, o.target)) return true;
    await sleep(POLL_MS);
  }
  return !isLoaded(run, o.target);
}

/**
 * Lädt den Dienst mit Wiederholungen und prüft, dass er läuft. Liefert Berichtszeilen; wirft mit einer
 * verständlichen Meldung, wenn es nach allen Versuchen nicht klappt.
 */
export async function loadLaunchAgent(o: Common & { plist: string; uid: number; domain?: string; attempts?: number; verifyMs?: number; logFile?: string }): Promise<string[]> {
  const domain = o.domain ?? `gui/${o.uid}`;
  const run = o.run ?? realLaunchctl;
  const sleep = o.sleep ?? realSleep;
  const attempts = o.attempts ?? 5;
  const report: string[] = [];
  let lastError = "";
  let loadedAt = 0;
  for (let i = 1; i <= attempts; i++) {
    await unloadLaunchAgent({ target: o.target, run, sleep });
    // VOR dem Laden: Ein abgeschalteter Dienst (Eintrag in `launchctl print-disabled`) lässt jedes
    // `bootstrap` mit Fehler 5 scheitern. `enable` wirkt auch auf nicht geladene Dienste.
    run(["enable", o.target]);
    const r = run(["bootstrap", domain, o.plist]);
    if (r.code === 0) {
      loadedAt = i;
      break;
    }
    lastError = r.out.split("\n")[0] ?? t("Fehler {code}", { code: r.code });
    if (i < attempts) await sleep(1000 * i); // 1 s, 2 s, 3 s … — launchd Zeit zum Aufräumen geben
  }
  if (!loadedAt) throw new Error(t("launchd hat die Brücke nach {n} Versuchen nicht geladen: {error}", { n: attempts, error: lastError }));
  report.push(t("launchd-Agent geladen ({domain}, Versuch {i} von {n})", { domain, i: loadedAt, n: attempts }));

  run(["kickstart", o.target]); // startet nur, falls RunAtLoad noch nicht gegriffen hat (ohne -k: kein Doppel-Neustart)

  let lastPrint = "";
  for (let waited = 0; waited <= (o.verifyMs ?? 15_000); waited += POLL_MS) {
    const p = run(["print", o.target]);
    lastPrint = p.out;
    const pid = /\bpid = (\d+)/.exec(p.out)?.[1];
    if (p.code === 0 && /\bstate = running\b/.test(p.out)) {
      report.push(pid ? t("Brücke läuft (pid {pid})", { pid }) : t("Brücke läuft"));
      return report;
    }
    await sleep(POLL_MS);
  }
  const state = /\bstate = ([^\n]+)/.exec(lastPrint)?.[1]?.trim() ?? t("unbekannt");
  throw new Error(t("Brücke ist geladen, läuft aber nicht (Zustand: {state}). Log: {log}", { state, log: o.logFile ?? "~/.nyxos/logs/bridge.log" }));
}
