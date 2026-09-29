// Bündelt den Server in eine Datei (inkl. @nyxos/shared), damit das Docker-Image klein bleibt.
import { build } from "esbuild";
import { existsSync, writeFileSync } from "node:fs";

// NyxOS-Karte vor dem Bündeln aus dem Code neu erzeugen (Leiste, Routen, Einstellungen, data-nyx, API, Tabellen).
// Fehlen Web-Quellen oder Generator (schlanker Docker-Build), bleibt die eingecheckte Karte – der Test hält sie aktuell.
if (existsSync("../web/src/App.tsx") && existsSync("../../scripts/nyxos-map.mjs")) {
  const gen = await import("../../scripts/nyxos-map.mjs").catch((e) => (console.warn(`NyxOS-Karte: Generator nicht ladbar (${e.message}) – eingecheckte Karte bleibt.`), null));
  if (gen) {
    const map = gen.buildNyxosMap();
    if (map.problems.length) throw new Error(`NyxOS-Karte hat Lücken:\n- ${map.problems.join("\n- ")}`);
    writeFileSync(`../../${gen.MAP_OUT}`, gen.renderNyxosMap(map));
  }
}


const entries = process.argv.includes("--dev") ? ["dev"] : ["main", "local", "cli", "haiku-worker"];
// MCP-Brücke von Haiku als eigene Datei (vom claude-CLI als Kindprozess gestartet), s. haiku/claudeCli.ts.
await build({ entryPoints: ["src/haiku/mcpProxy.ts"], outfile: "dist/haiku-mcp.js", bundle: true, platform: "node", target: "node24", format: "esm", keepNames: true });
for (const entry of entries) {
  await build({
    entryPoints: [`src/${entry}.ts`],
    outfile: `dist/${entry}.js`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    // R3-Live: ohne keepNames benennt esbuild Klassen um (z. B. `AbortSignal2`) – node-fetch (in grammY) prüft aber
    // `constructor.name === "AbortSignal"` und lehnte jede Telegram-Anfrage ab; grammY wiederholte das still und endlos.
    keepNames: true,
    external: ["@electric-sql/pglite"],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}
console.log(`Server gebaut → dist/ (${entries.join(", ")})`);
