// Simulator-Screenshot (nur macOS mit Xcode) (RPC `simulator_screenshot` vom Server, Werkzeug `screenshot_simulator`).
// `xcrun simctl io booted screenshot <temp>/shot.png` → Bild als Base64 zurück → Temp-Ordner weg. Vom Server kommt
// nichts außer dem Befehl selbst (kein Pfad, kein Argument). Muster „Brücke meldet Befehle, Server ruft sie auf“
// nach OpenClaw `src/node-host/invoke.ts` (MIT).
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { t, type SimulatorScreenshotResult } from "@nyxos/shared";

export type SimRunner = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface SimDeps {
  run?: SimRunner;
  /** Pfad zu `xcrun`; `undefined` = im PATH suchen, `null` = fehlt (Tests). */
  xcrun?: string | null;
  path?: string;
  timeoutMs?: number;
  /** Tests: Betriebssystem vorgeben. */
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Größtes Bild, das über die Brücke geht (ein Screenshot ist 1–4 MB). */
const MAX_BYTES = 15 * 1024 * 1024;

const defaultRun: SimRunner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

function findXcrun(path: string): string | null {
  for (const dir of [...path.split(delimiter), "/usr/bin"]) {
    if (!dir) continue;
    try {
      const p = join(dir, "xcrun");
      if (statSync(p).isFile()) return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

/** Name des laufenden Simulators (erstes „Booted“-Gerät), sonst null. */
async function bootedDevice(run: SimRunner, xcrun: string, timeoutMs: number): Promise<string | null> {
  try {
    const r = await run(xcrun, ["simctl", "list", "devices", "booted", "--json"], timeoutMs);
    if (r.code !== 0) return null;
    const data = JSON.parse(r.stdout) as { devices?: Record<string, { name?: string; state?: string }[]> };
    for (const list of Object.values(data.devices ?? {})) for (const d of list) if (d.state === "Booted" && d.name) return d.name;
  } catch {
    // Anzeige ist optional
  }
  return null;
}

export async function simulatorScreenshot(deps: SimDeps = {}): Promise<SimulatorScreenshotResult> {
  const run = deps.run ?? defaultRun;
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: false, reason: "xcrun_missing", detail: t("Den iOS-Simulator gibt es nur auf macOS") };
  const xcrun = deps.xcrun === undefined ? findXcrun(deps.path ?? process.env.PATH ?? "") : deps.xcrun;
  if (!xcrun) return { ok: false, reason: "xcrun_missing", detail: t("xcrun nicht gefunden (Xcode-Werkzeuge fehlen)") };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), "nyxos-sim-"));
  try {
    const file = join(dir, "shot.png");
    let r: Awaited<ReturnType<SimRunner>>;
    try {
      r = await run(xcrun, ["simctl", "io", "booted", "screenshot", "--type=png", file], timeoutMs);
    } catch (e) {
      return { ok: false, reason: "failed", detail: String(e).slice(0, 200) };
    }
    if (r.code !== 0) {
      if (/no devices are booted|invalid device: booted|unable to find a device/i.test(r.stderr)) return { ok: false, reason: "no_simulator", detail: t("kein Simulator gestartet") };
      return { ok: false, reason: "failed", detail: r.stderr.trim().slice(-300) };
    }
    const bytes = await readFile(file);
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return { ok: false, reason: "failed", detail: t("Bildgröße {n} Bytes", { n: bytes.length }) };
    const device = await bootedDevice(run, xcrun, timeoutMs);
    return { ok: true, pngB64: bytes.toString("base64"), device, bytes: bytes.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
