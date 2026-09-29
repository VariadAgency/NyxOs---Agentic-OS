// Nyx navigiert im echten Browser immer mit dem Cursor – Befehl über den Server (wie ui_navigate), der Browser
// klickt den Klickpfad der NyxOS-Karte sichtbar ab. Läuft gegen Probe-Server + Vite (E2E_BASE_URL, ZENTRALE_API).
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const API = process.env.E2E_API ?? "http://127.0.0.1:47918";
const SHOTS = process.env.E2E_SHOTS;
/** Anmeldung der Probe (dev.ts legt sie neben das Archiv): `E2E_LOGIN=<pfad>/probe-login.json`. */
const LOGIN = JSON.parse(readFileSync(process.env.E2E_LOGIN ?? "../../.probe/probe-login.json", "utf8")) as { token: string; csrf: string };

async function command(route: string) {
  const r = await fetch(`${API}/api/nyx/ui/command`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `zentrale_session=${LOGIN.token}`, "x-zentrale-csrf": LOGIN.csrf },
    body: JSON.stringify({ action: "navigate", route }),
  });
  return (await r.json()) as { ok: boolean; route?: string; detail?: string; reason?: string };
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "zentrale_session", value: LOGIN.token, url: baseURL ?? "http://localhost:5218" }]);
});

for (const width of [1440, 390]) {
  test(`Nyx klickt sich zu Telegram durch (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/git");
    await page.waitForTimeout(1500); // Live-Verbindung steht
    const clicks: string[] = [];
    await page.exposeFunction("__nyxClick", (id: string) => void clicks.push(id));
    await page.evaluate(() => {
      document.addEventListener("click", (e) => {
        const el = (e.target as HTMLElement).closest("[data-nyx]");
        if (el) (window as unknown as { __nyxClick: (s: string) => void }).__nyxClick(el.getAttribute("data-nyx") ?? "");
      }, true);
    });
    const r = await command("/settings/telegram");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await expect(page).toHaveURL(/\/settings\/telegram$/);
    const bar = width < 768 ? ["tabbar:mehr", "nav:settings"] : ["nav:settings"];
    expect(clicks).toEqual([...bar, "settings:mitteilungen", "settings-sub:telegram"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/telegram-${width}.jpg`, type: "jpeg", quality: 70 });
    const s = await command("/skills");
    expect(s.ok, JSON.stringify(s)).toBe(true);
    await expect(page).toHaveURL(/\/skills$/);
  });
}
