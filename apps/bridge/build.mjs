// Baut die Brücke als EINE Datei `dist/bridge.js` (ESM, Node 24): alles gebündelt, auch @nyxos/shared und
// chokidar. Node-eigene Module (node:sqlite, node:fs, …) bleiben außen vor.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/bridge.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  keepNames: true,
  legalComments: "none",
  // Gebündelte CommonJS-Abhängigkeiten brauchen in ESM ein `require`.
  banner: { js: "import { createRequire as __nyxosCreateRequire } from 'node:module'; const require = __nyxosCreateRequire(import.meta.url);" },
  logLevel: "warning",
});
