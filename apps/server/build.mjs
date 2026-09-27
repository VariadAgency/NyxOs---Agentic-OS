// Bündelt den Server in eine Datei (inkl. @nyxos/shared), damit das Docker-Image klein bleibt.
import { build } from "esbuild";

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
