#!/usr/bin/env node
// Erzeugt das Web-App-Symbol von NyxOS (die lila Aura) – `apps/web/public/favicon.svg` und die
// gerasterten PNGs für Dock/Home-Bildschirm (Apple 180, 192, 512, „maskable“ 512 mit Schutzrand).
// Die Form kommt aus derselben Quelle wie das lebendige Logo in der App (`components/brand/auraGeometry.ts`,
// Node 24 lädt TypeScript ohne Übersetzer). Gerastert wird mit dem Chromium, das Playwright schon mitbringt –
// keine neue Abhängigkeit, nichts aus dem Netz.
// Aufruf: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "apps", "web");
const pub = join(web, "public");

const { auraIconSvg } = await import(pathToFileURL(join(web, "src", "components", "brand", "auraGeometry.ts")).href);

// Browser-Tab (oft 16 px): abgerundetes Schwarz, Motiv groß, ohne Satelliten (wären bei 16 px nur Rauschen).
writeFileSync(join(pub, "favicon.svg"), `${auraIconSvg({ scale: 1.02, radius: 22, satellites: false })}\n`);

/** Datei → [Kantenlänge, Optionen]. Apple und Android runden/maskieren selbst: eckiger schwarzer Grund. */
const PNGS = {
  "apple-touch-icon.png": [180, { scale: 0.94 }],
  "icon-192.png": [192, { scale: 0.94 }],
  "icon-512.png": [512, { scale: 0.94 }],
  // „maskable“: alles Wichtige im inneren Kreis (80 %), der Rand darf abgeschnitten werden.
  "icon-maskable-512.png": [512, { scale: 0.7 }],
};

const require = createRequire(join(web, "package.json"));
const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, [size, opts]] of Object.entries(PNGS)) {
    const svg = auraIconSvg(opts).replace('width="100" height="100"', `width="${size}" height="${size}"`);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000">${svg}</body></html>`);
    await page.screenshot({ path: join(pub, file), clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`geschrieben: apps/web/public/${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
console.log("geschrieben: apps/web/public/favicon.svg");
