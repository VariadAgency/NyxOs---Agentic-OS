#!/usr/bin/env node
// Fake-Claude-Programm (Kritik 3): meldet als Ergebnis, was es bekommen hat – Befehlszeile und
// den Inhalt/Modus der --mcp-config-Datei. So prüft der Test, dass kein Token in der Befehlszeile steht.
import { readFileSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const i = argv.indexOf("--mcp-config");
const cfgArg = i >= 0 ? argv[i + 1] : null;
let cfg = null;
let mode = null;
let path = null;
try {
  cfg = JSON.parse(readFileSync(cfgArg, "utf8"));
  mode = statSync(cfgArg).mode & 0o777;
  path = cfgArg;
} catch {
  // kein Pfad
}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify({ argv, cfg, mode, path }), usage: {}, total_cost_usd: 0 })}\n`);
});
