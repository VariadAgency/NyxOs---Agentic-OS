// Schutz vor Aufrufen ins interne Netz (SSRF).
// Anbieter- und Konnektor-Adressen trägt der Nutzer ein – aber auch fremde Server liefern Adressen (OAuth-Metadaten,
// SSE-Endpunkt, Weiterleitungen). Der API-Container hängt im Docker-Netz neben Postgres und dem Docker-Socket-Proxy;
// nichts davon darf über diese Wege erreichbar sein. Deshalb: jede Adresse (auch nach DNS) prüfen, Weiterleitungen
// selbst folgen und jede Station neu prüfen, Zugangsdaten beim Wechsel des Ursprungs abwerfen.
//
// Ausnahme nur für Entwicklung, Probe und Tests (Fake-Server auf 127.0.0.1): `NYXOS_ALLOW_PRIVATE_URLS=1`.
// Restrisiko: DNS-Rebinding zwischen Prüfung und Verbindung (kein festgenagelter Resolver) – bewusst in Kauf genommen.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { t } from "@nyxos/shared";

export class UnsafeUrlError extends Error {
  constructor(message = t("Diese Adresse zeigt ins interne Netz – NyxOS ruft sie aus Sicherheitsgründen nicht auf.")) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Blocked(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Private, Loopback-, Link-Local-, Multicast- und reservierte Adressen. Tailscale (100.64/10) bleibt erlaubt. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v !== 6) return true;
  // Erste Gruppe 0 (::, ::1, ::ffff:… eingebettete IPv4, veraltete ::a.b.c.d) → immer gesperrt;
  // dazu fc00::/7 (privat), fe80::/10 (Link-Local), ff00::/8 (Multicast).
  const first = parseInt(ip.toLowerCase().split(":")[0] || "0", 16);
  return first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

export interface UrlPolicy {
  /** Nur Entwicklung/Probe/Tests: private Adressen zulassen. */
  allowPrivate?: boolean;
  resolve?: HostResolver;
  /** `false`: nur die Form prüfen (IP-Literale, Docker-Namen, localhost) – fürs Speichern ohne Netz. Standard: mit DNS. */
  dns?: boolean;
}

export function privateUrlsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NYXOS_ALLOW_PRIVATE_URLS === "1";
}

/** Wirft `UnsafeUrlError`, wenn die Adresse kein http(s) ist oder (auch nach DNS) ins interne Netz zeigt. */
export async function assertPublicUrl(raw: string | URL, policy: UrlPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(t("Die Adresse ist ungültig."));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(t("Die Adresse muss mit http:// oder https:// beginnen."));
  if (policy.allowPrivate ?? privateUrlsAllowed()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError();
    return url;
  }
  // Docker-Dienstnamen (ohne Punkt), localhost und interne Endungen nie.
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) throw new UnsafeUrlError();
  if (policy.dns === false) return url;
  let addrs: string[];
  try {
    addrs = await (policy.resolve ?? defaultResolver)(host);
  } catch {
    throw new UnsafeUrlError(t("Diese Adresse ist im Netz nicht zu finden – bitte prüfen."));
  }
  if (addrs.length === 0 || addrs.some(isBlockedAddress)) throw new UnsafeUrlError();
  return url;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;
/** Beim Wechsel des Ursprungs bleiben nur diese Kopfzeilen (keine Schlüssel, Tokens, eigenen Kopfzeilen). */
const SAFE_CROSS_ORIGIN = new Set(["accept", "content-type", "user-agent", "mcp-protocol-version"]);

/**
 * fetch mit Adress-Prüfung vor jedem Aufruf und jeder Weiterleitung. Weiterleitungen auf einen anderen Ursprung
 * verlieren alle Zugangs-Kopfzeilen; 303 (und 301/302 nach POST) werden wie im Browser zu GET ohne Inhalt.
 */
export function safeFetch(base: typeof fetch = fetch, policy: UrlPolicy = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) throw new UnsafeUrlError(t("Interner Fehler: Request-Objekte werden hier nicht unterstützt."));
    let url = await assertPublicUrl(input, policy);
    let method = (init?.method ?? "GET").toUpperCase();
    let body = init?.body;
    let headers = new Headers(init?.headers);
    const origin = url.origin;
    for (let hop = 0; ; hop++) {
      const res = await base(url.toString(), { ...init, method, body, headers, redirect: "manual" });
      const loc = res.headers.get("location");
      if (!REDIRECT.has(res.status) || !loc) return res;
      if (hop >= MAX_HOPS) throw new UnsafeUrlError("Zu viele Weiterleitungen.");
      await res.body?.cancel().catch(() => {});
      url = await assertPublicUrl(new URL(loc, url), policy);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      if (url.origin !== origin) {
        const kept = new Headers();
        headers.forEach((v, k) => {
          if (SAFE_CROSS_ORIGIN.has(k.toLowerCase())) kept.set(k, v);
        });
        headers = kept;
      }
    }
  }) as typeof fetch;
}
