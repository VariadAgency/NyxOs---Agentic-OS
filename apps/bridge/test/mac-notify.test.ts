// MacOS-Mitteilung über die Brücke: Titel/Text gehen NUR als osascript-Argumente raus (execFile, keine
// Shell, festes Skript) — Anführungszeichen, `$(…)` oder ein führendes `-e` dürfen nichts ausführen.
import { execFileSync } from "node:child_process";
import { ServerToBridgeSchema } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { cleanText, NOTIFY_SCRIPT, OSASCRIPT, osascriptArgs, showMacNotification } from "../src/notify/macNotify.js";
import { TerminalManager } from "../src/terminal/manager.js";

const EVIL_TITLE = '-e do shell script "touch /tmp/pwned"';
const EVIL_TEXT = 'x" & (do shell script "id") & "$(id)`id`\\';

describe("Mac-Mitteilung (Brücke)", () => {
  it("festes Skript, dann `--`, dann genau Titel + Text als eigene Argumente", () => {
    const args = osascriptArgs(EVIL_TITLE, EVIL_TEXT);
    const scriptPart = args.slice(0, NOTIFY_SCRIPT.length * 2);
    expect(scriptPart).toEqual(NOTIFY_SCRIPT.flatMap((l) => ["-e", l]));
    expect(args.slice(NOTIFY_SCRIPT.length * 2)).toEqual(["--", EVIL_TITLE, EVIL_TEXT]);
    // Nichts vom Text steckt im Skript.
    for (const line of scriptPart) expect(line).not.toContain("pwned");
  });

  it("Steuerzeichen raus, Länge begrenzt, leerer Titel → NyxOS", () => {
    expect(cleanText("a\u0007b\u001bc", 50)).toBe("a b c");
    expect(cleanText("x".repeat(500), 10)).toHaveLength(10);
    expect(osascriptArgs("   ", "t").at(-2)).toBe("NyxOS");
  });

  it("ruft /usr/bin/osascript über den Runner (execFile) auf und prüft die Eingabe", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
    };
    await expect(showMacNotification({ title: "Wartet auf dich", message: "Push" }, run)).resolves.toEqual({ shown: true });
    expect(calls).toEqual([{ bin: OSASCRIPT, args: osascriptArgs("Wartet auf dich", "Push") }]);
    await expect(showMacNotification({ title: "", message: "x" }, run)).rejects.toThrow();
    await expect(showMacNotification({ message: "x" }, run)).rejects.toThrow();
  });

  it("der Server-Befehl `notify` kommt durch die Schema-Prüfung der Brücke (sonst würde er still verworfen)", () => {
    expect(ServerToBridgeSchema.safeParse({ op: "rpc", id: 1, method: "notify", params: { title: "a", message: "b" } }).success).toBe(true);
  });

  it("die Brücke kennt den Befehl `notify` (keine „Unbekannter Befehl“-Antwort)", async () => {
    const m = Object.create(TerminalManager.prototype) as TerminalManager;
    // Ungültige Eingabe → Prüf-Fehler von zod, NICHT „Unbekannter Befehl notify“.
    await expect(m.rpc("notify", { title: "" })).rejects.not.toThrow(/Unbekannter Befehl/);
  });

  it.runIf(process.platform === "darwin")("echtes osascript: argv kommt 1:1 an, nichts wird ausgeführt", () => {
    // Dasselbe Argument-Layout, nur mit einem Skript, das argv zurückgibt statt eine Mitteilung zu zeigen.
    const tail = osascriptArgs(EVIL_TITLE, EVIL_TEXT).slice(NOTIFY_SCRIPT.length * 2);
    const out = execFileSync(OSASCRIPT, ["-e", "on run argv", "-e", 'return (item 1 of argv) & "¦" & (item 2 of argv) & "¦" & ((count of argv) as text)', "-e", "end run", ...tail], { encoding: "utf8" });
    expect(out.trim()).toBe(`${EVIL_TITLE}¦${EVIL_TEXT}¦2`);
  });
});
