// Web-App-Symbole (Dock/Home-Bildschirm) und Manifest kommen ohne Anmeldung, mit richtigem
// Content-Type und Cache-Kopf. Vite-Dateien unter /assets tragen einen Inhalts-Hash → dürfen ewig im Cache liegen;
// index.html muss nach jedem Deploy neu geprüft werden. /api bleibt unverändert geschützt bzw. ohne diese Köpfe.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const webDir = mkdtempSync(join(tmpdir(), "nyxos-web-n2f-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>NyxOS</title>");
writeFileSync(join(webDir, "manifest.webmanifest"), JSON.stringify({ name: "NyxOS" }));
writeFileSync(join(webDir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(join(webDir, "icon-192.png"), Buffer.from("89504e470d0a1a0a", "hex"));
writeFileSync(join(webDir, "apple-touch-icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "assets", "index-AbC123.js"), "console.log(1)");

afterAll(() => rmSync(webDir, { recursive: true, force: true }));

describe("Statische Web-App-Dateien (Symbole, Manifest)", () => {
  it("Manifest und Symbole: ohne Anmeldung, richtiger Typ, einen Tag im Cache", async () => {
    const t = await setup({ webDir, signedIn: false });
    const cases: [string, RegExp][] = [
      ["/manifest.webmanifest", /^application\/manifest\+json/],
      ["/favicon.svg", /^image\/svg\+xml/],
      ["/icon-192.png", /^image\/png$/],
      ["/apple-touch-icon.png", /^image\/png$/],
    ];
    for (const [path, type] of cases) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(type);
      expect(res.headers.get("cache-control"), path).toBe("public, max-age=86400");
    }
  });

  it("gehashte /assets-Dateien: ein Jahr, unveränderlich; index.html: immer neu prüfen", async () => {
    const t = await setup({ webDir, signedIn: false });
    const asset = await t.app.request("/assets/index-AbC123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/index.html"]) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
    // SPA-Rückfall (tiefe URL der Web-App) ist ebenfalls index.html → ebenso nie aus dem Cache.
    const deep = await t.app.request("/sessions/coding/nyxos/abc");
    expect(deep.status).toBe(200);
    expect(deep.headers.get("cache-control")).toBe("no-cache");
  });

  it("macht dadurch nichts anderes öffentlich: geschützte /api-Pfade bleiben zu, unbekannte bleiben JSON-404", async () => {
    const t = await setup({ webDir, signedIn: false });
    const finder = await t.app.request("/api/finder/list");
    expect(finder.status).toBe(401);
    const unknown = await t.app.request("/api/gibt-es-nicht");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBeNull();
  });
});
