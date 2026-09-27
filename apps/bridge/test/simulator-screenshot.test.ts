// Simulator-Screenshot auf dem Rechner (RPC `simulator_screenshot`): `xcrun simctl io booted screenshot`
// in einen Temp-Ordner, Bild als Base64 zurück, Ordner wieder weg. Kein Simulator an → ehrliche Meldung.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { simulatorScreenshot, type SimRunner } from "../src/simulator/screenshot.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

describe("simulator_screenshot", () => {
  it("schreibt das Bild in einen Temp-Ordner, liefert Base64 + Gerät und räumt auf", async () => {
    const calls: string[][] = [];
    let shotPath = "";
    const run: SimRunner = async (_bin, args) => {
      calls.push(args);
      if (args.includes("screenshot")) {
        shotPath = args[args.length - 1] as string;
        await writeFile(shotPath, PNG);
        return { code: 0, stdout: "", stderr: "Wrote screenshot" };
      }
      return { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{ name: "iPhone 17 Pro", state: "Booted" }] } }), stderr: "" };
    };
    const r = await simulatorScreenshot({ run, xcrun: "/usr/bin/xcrun" });
    expect(r).toMatchObject({ ok: true, device: "iPhone 17 Pro", bytes: PNG.length });
    if (r.ok) expect(Buffer.from(r.pngB64, "base64").equals(PNG)).toBe(true);
    expect(calls.some((a) => a.join(" ").startsWith("simctl io booted screenshot"))).toBe(true);
    expect(existsSync(shotPath)).toBe(false);
  });

  it("kein Simulator an → no_simulator (keine Technik-Meldung)", async () => {
    const run: SimRunner = async (_bin, args) =>
      args.includes("screenshot") ? { code: 164, stdout: "", stderr: "Invalid device: booted\nNo devices are booted." } : { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" };
    const r = await simulatorScreenshot({ run, xcrun: "/usr/bin/xcrun" });
    expect(r).toMatchObject({ ok: false, reason: "no_simulator" });
  });

  it("ohne xcrun → xcrun_missing", async () => {
    const r = await simulatorScreenshot({ run: async () => ({ code: 0, stdout: "", stderr: "" }), xcrun: null });
    expect(r).toMatchObject({ ok: false, reason: "xcrun_missing" });
  });
});
