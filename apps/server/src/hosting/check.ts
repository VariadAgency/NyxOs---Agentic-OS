// „Prüfen“ (Settings → Betrieb & Zugriff): does an entered address reach NyxOS' `/health`?
//
// Security (SSRF): the address is entered by the user (or Nyx). In server mode the API container sits in the Docker
// network next to Postgres and the Docker socket proxy – so the rules of `net/safeFetch.ts` apply: http/https only,
// no credentials in the address, private/loopback/link-local targets blocked (also after DNS and after every
// redirect), Tailscale (100.64/10) allowed. Even if only the status and „looks like NyxOS“ came back, the internal
// network could otherwise be scanned (open/closed/timeout). Only `<origin>/health` is called (path, query and
// fragment of the input are dropped), with a fixed time limit and at most 64 KB of answer, and the content of the
// other side never goes out – only status, time and the names of failing NyxOS checks. In local mode and on the
// development server (NYXOS_ALLOW_PRIVATE_URLS=1) local targets are allowed.
import type { HostingCheckCode, HostingCheckResult, HostingCheckTarget } from "@nyxos/shared";
import { pinnedFetch, safeFetch, UnsafeUrlError, type HostResolver, type UrlPolicy } from "../net/safeFetch.js";
import { isAllowedHost } from "../security.js";
import { lookup } from "node:dns/promises";

export const CHECK_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 64 * 1024;
/** Only these check names of NyxOS' /health answer are passed on (as names). */
const KNOWN_HEALTH_CHECKS = ["database", "schema", "archive"] as const;

export interface CheckDeps {
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  timeoutMs?: number;
  allowedHosts: Set<string>;
  now?: () => number;
}

type Outcome = Omit<HostingCheckResult, "target" | "at">;

const VERDICT: Record<HostingCheckCode, HostingCheckResult["verdict"]> = {
  ok: "ok",
  self_ok: "ok",
  host_not_allowed: "warn",
  no_https: "warn",
  nyx_unhealthy: "warn",
  self_elsewhere: "warn",
  not_nyx: "fail",
  http_error: "fail",
  timeout: "fail",
  dns: "fail",
  blocked: "fail",
  invalid_url: "fail",
  network: "fail",
};

export function outcome(code: HostingCheckCode, rest: Partial<Omit<Outcome, "code" | "verdict">> = {}): Outcome {
  return { url: null, reachable: false, isNyx: false, hostAccepted: null, https: null, status: null, ms: 0, detail: null, ...rest, code, verdict: VERDICT[code] };
}

/** Input → origin (`https://name[:port]`). `null` = not a valid http(s) address. */
export function parseCheckUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || s.length > 500 || /[\s\\]/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return new URL(url.origin);
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return "";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface NyxHealth {
  ok: boolean;
  failing: string[];
}

/** Does the answer look like NyxOS' `/health` (`{ ok, checks: { database, … } }`)? */
export function parseNyxHealth(text: string): NyxHealth | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as { ok?: unknown; checks?: unknown };
  if (typeof b.ok !== "boolean" || !b.checks || typeof b.checks !== "object") return null;
  const checks = b.checks as Record<string, { ok?: unknown } | undefined>;
  if (!checks.database || typeof checks.database.ok !== "boolean") return null;
  const failing = KNOWN_HEALTH_CHECKS.filter((k) => checks[k] && checks[k]?.ok === false);
  return { ok: b.ok, failing: [...failing] };
}

function isTimeout(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Checks `<origin>/health`. `hostMatters`: is the address meant for THIS NyxOS installation (phone ways)? Then it
 * also counts whether NyxOS accepts the host (otherwise NyxOS answers every page except /health with 421).
 */
export async function checkHealthUrl(raw: string, deps: CheckDeps, opts: { hostMatters: boolean }): Promise<Outcome> {
  const url = parseCheckUrl(raw);
  if (!url) return outcome("invalid_url");
  const origin = url.origin;
  const https = url.protocol === "https:";
  const hostAccepted = opts.hostMatters ? isAllowedHost(url.host, deps.allowedHosts) : null;
  const base = { url: origin, https, hostAccepted };
  const now = deps.now ?? (() => performance.now());
  const start = now();
  const elapsed = () => Math.round(now() - start);

  // Tell a DNS error apart from „points into the internal network“ (both throw UnsafeUrlError).
  let dnsFailed = false;
  const baseResolve: HostResolver = deps.policy?.resolve ?? (async (h) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address));
  const policy: UrlPolicy = {
    ...deps.policy,
    resolve: async (h) => {
      try {
        return await baseResolve(h);
      } catch (e) {
        dnsFailed = true;
        throw e;
      }
    },
  };
  // Without an own `fetchImpl` (tests), `pinnedFetch` connects only to the checked addresses (DNS rebinding).
  const doFetch = safeFetch(deps.fetchImpl ?? pinnedFetch(policy), policy);
  let res: Response;
  try {
    res = await doFetch(`${origin}/health`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(deps.timeoutMs ?? CHECK_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof UnsafeUrlError) return outcome(dnsFailed ? "dns" : "blocked", { ...base, ms: elapsed() });
    if (isTimeout(e)) return outcome("timeout", { ...base, ms: elapsed() });
    // fetch wraps the error in `cause`, node:http (pinnedFetch) throws it directly.
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return outcome("dns", { ...base, ms: elapsed() });
    return outcome("network", { ...base, ms: elapsed(), detail: cause ?? null });
  }
  let text = "";
  try {
    text = await readLimited(res);
  } catch (e) {
    if (isTimeout(e)) return outcome("timeout", { ...base, status: res.status, reachable: true, ms: elapsed() });
  }
  const ms = elapsed();
  const nyx = parseNyxHealth(text);
  const common = { ...base, status: res.status, reachable: true, ms, isNyx: !!nyx };
  if (!nyx) return outcome(res.ok ? "not_nyx" : "http_error", common);
  if (!nyx.ok || res.status !== 200) return outcome("nyx_unhealthy", { ...common, detail: nyx.failing.join(", ") || null });
  if (hostAccepted === false) return outcome("host_not_allowed", common);
  if (!https) return outcome("no_https", common);
  return outcome("ok", common);
}

export function stamp(target: HostingCheckTarget, o: Outcome, at: Date): HostingCheckResult {
  return { target, ...o, at: at.toISOString() };
}
