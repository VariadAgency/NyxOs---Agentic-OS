// Sign-in and machine token for specs that run against a real NyxOS server:
// - the probe stack (`pnpm dev`, login in `.probe/probe-login.json`, bridge token `dev-token`), or
// - a local server (`local.ts`) + Vite: set `E2E_BASE_URL` (Vite), `E2E_NYXOS_API` (server) and `E2E_NYXOS_HOME`
//   (data folder with the machine token for the one-time sign-in).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";

const HOME = process.env.E2E_NYXOS_HOME;

/** Where the API server listens (the bridge routes `/ingest` and `/guard` do not go through the Vite proxy). */
export function apiBase(baseURL: string | undefined): string {
  return process.env.E2E_NYXOS_API ?? baseURL ?? `http://127.0.0.1:${process.env.PROBE_PORT ?? 47890}`;
}

/** Machine token of the bridge: from the data folder of a local server, else the probe token. */
export function bridgeToken(): string {
  return HOME ? readFileSync(join(HOME, "data", "bridge-token"), "utf8").trim() : (process.env.E2E_BRIDGE_TOKEN ?? "dev-token");
}

export async function signIn(page: Page, baseURL: string | undefined): Promise<void> {
  if (HOME) {
    const api = apiBase(baseURL);
    const res = await fetch(`${api}/local/login-code`, { method: "POST", headers: { authorization: `Bearer ${bridgeToken()}` } });
    const { code } = (await res.json()) as { code: string };
    // Cookies count per host (not per port): the sign-in on the server also holds for Vite on the same host.
    await page.goto(`${api}/auth/local?code=${encodeURIComponent(code)}&next=/health`);
    return;
  }
  const file = resolve(process.cwd(), "../../.probe/probe-login.json");
  if (!existsSync(file)) throw new Error("Keine Anmeldung: E2E_NYXOS_HOME setzen oder den Probe-Stack starten");
  const login = JSON.parse(readFileSync(file, "utf8")) as { token: string };
  await page.context().addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? apiBase(undefined) }]);
}

/** A write request with the CSRF token of the current sign-in. */
export async function apiWrite(page: Page, method: "PUT" | "POST", path: string, body: unknown) {
  const status = (await (await page.request.get("/api/auth/status")).json()) as { csrf?: string };
  return page.request.fetch(path, { method, data: body, headers: { "content-type": "application/json", "x-nyxos-csrf": String(status.csrf ?? "") } });
}

/** Signed in, onboarding skipped (a fresh data folder would otherwise show the setup in full screen). */
export async function prepare(page: Page, baseURL: string | undefined): Promise<void> {
  await signIn(page, baseURL);
  await page.goto("/overview");
  // German UI (the specs read the German source texts), whatever language the emulated device has.
  await apiWrite(page, "PUT", "/api/app/settings", { onboardingDone: true, lang: "de" });
}
