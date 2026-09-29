// Where do bug reports, ideas and donations go? Order: `NYXOS_SUPPORT_URL` (environment) → the setting in the sheet
// (table `support_settings`) → `SUPPORT_URL_DEFAULT` (@nyxos/shared, the one place for the project's address).
// Only https — plain http only for a service on this very computer (localhost) during development
// (`NYXOS_ALLOW_PRIVATE_URLS=1`, set by the probe server and the tests).
import { SUPPORT_URL_DEFAULT, t, type SupportState } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { supportSettings } from "../db/schema.js";
import { privateUrlsAllowed } from "../net/safeFetch.js";

export const SUPPORT_URL_ENV = "NYXOS_SUPPORT_URL";

export interface SupportTarget {
  /** Base address with a trailing `/` (endpoints are resolved against it), `null` = not set up. */
  base: URL | null;
  origin: string | null;
  source: SupportState["source"];
  settingUrl: string;
  envLocked: boolean;
  problem: string | null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** Checks an address for the support service. Returns the base URL (trailing slash, no query/hash) or a sentence. */
export function checkSupportUrl(raw: string, env: NodeJS.ProcessEnv = process.env): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: t("Die Adresse der Meldestelle ist ungültig.") };
  }
  if (url.username || url.password) return { ok: false, error: t("Die Adresse der Meldestelle darf keine Zugangsdaten enthalten.") };
  if (url.protocol === "http:") {
    if (!(isLoopbackHost(url.hostname) && privateUrlsAllowed(env))) return { ok: false, error: t("Die Meldestelle braucht eine sichere Adresse (https://).") };
  } else if (url.protocol !== "https:") {
    return { ok: false, error: t("Die Meldestelle braucht eine sichere Adresse (https://).") };
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { ok: true, url };
}

export async function loadSettingUrl(db: Pick<Db, "select">): Promise<string> {
  try {
    const [row] = await db.select({ url: supportSettings.url }).from(supportSettings).where(eq(supportSettings.id, 1)).limit(1);
    return row?.url ?? "";
  } catch {
    return ""; // table missing (very old test database): like "not set"
  }
}

export async function saveSettingUrl(db: Db, url: string): Promise<void> {
  await db
    .insert(supportSettings)
    .values({ id: 1, url })
    .onConflictDoUpdate({ target: supportSettings.id, set: { url, updatedAt: sql`now()` } });
}

export async function resolveSupportTarget(db: Pick<Db, "select">, env: NodeJS.ProcessEnv = process.env, fallback: string = SUPPORT_URL_DEFAULT): Promise<SupportTarget> {
  const settingUrl = await loadSettingUrl(db);
  const fromEnv = env[SUPPORT_URL_ENV]?.trim() ?? "";
  const [raw, source]: [string, SupportTarget["source"]] = fromEnv ? [fromEnv, "env"] : settingUrl.trim() ? [settingUrl.trim(), "setting"] : fallback.trim() ? [fallback.trim(), "default"] : ["", "none"];
  const base = { settingUrl, envLocked: fromEnv !== "" };
  if (!raw) return { ...base, base: null, origin: null, source: "none", problem: null };
  const checked = checkSupportUrl(raw, env);
  if (!checked.ok) return { ...base, base: null, origin: null, source, problem: checked.error };
  return { ...base, base: checked.url, origin: checked.url.origin, source, problem: null };
}
