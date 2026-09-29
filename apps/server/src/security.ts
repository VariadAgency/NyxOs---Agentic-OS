// Zugriffsschutz (vor P3 Pflicht): kein CORS, keine Cookies — stattdessen eine
// Host-Allowlist gegen DNS-Rebinding plus eine Origin-Prüfung für WebSocket und schreibende
// Anfragen. Details/Ports „Zugriffsschutz".
//
// Echte Ports, gegen die die Standard-Allowlist geprüft wird (s. Auftrag):
// - Container intern: 8080
// - Auf dem Server veröffentlicht: 127.0.0.1:47800 (curl auf dem Server)
// - Per SSH-Tunnel auf dem Rechner: 127.0.0.1:47801 (Browser — der Tunnel reicht den Host-Header
//   des Browsers unverändert durch, der Container sieht also "127.0.0.1:47801")
// - Lokaler Probe-Stack (kein Docker): 127.0.0.1:47890
//
// Statt jeden Port einzeln zu pflegen, erlaubt die Standard-Regel jeden Port auf "127.0.0.1" und
// "localhost" (beide Namen zeigen unveränderlich auf dieselbe Maschine — das eigentliche
// DNS-Rebinding-Risiko ist ein FREMDER Hostname, der per DNS auf 127.0.0.1 auflöst, dessen
// Host-Header aber trotzdem den fremden Namen trägt und hier durchfällt). Für den späteren
// Tailscale-Namen kommen weitere, exakte Host-Angaben über `NYXOS_ALLOWED_HOSTS` dazu.

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

/** `NYXOS_ALLOWED_HOSTS` ist eine Komma-Liste zusätzlicher Hosts (Groß-/Kleinschreibung egal,
 * mit oder ohne Port), z. B. `mein-mac.tailXXXX.ts.net,mein-mac.tailXXXX.ts.net:47801`. */
export function parseAllowedHosts(envValue: string | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!envValue) return set;
  for (const raw of envValue.split(",")) {
    const h = raw.trim().toLowerCase();
    if (h) set.add(h);
  }
  return set;
}

export function isAllowedHost(host: string | null | undefined, extra: Set<string>): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (LOOPBACK_HOST_RE.test(h)) return true;
  return extra.has(h);
}

/** Fehlender Origin = kein Browser (curl, die Brücke) → erlaubt. Vorhandener Origin muss auf
 * einen erlaubten Host zeigen — geprüft mit derselben Regel wie der Host-Header. */
export function isAllowedOrigin(origin: string | null | undefined, extra: Set<string>): boolean {
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return isAllowedHost(host, extra);
}

/** für Kanäle, die NIE von einer anderen Seite auf demselben Rechner geöffnet
 * werden dürfen (`/live` trägt Session-Nachrichten ALLER offenen Sessions), reicht die grobe
 * Loopback-Erlaubnis oben nicht — die erlaubt JEDEN Port auf 127.0.0.1/localhost, eine beliebige
 * Seite auf `localhost:3000` könnte sonst `ws://localhost:47801/live` öffnen und mitlesen. Hier
 * exakt Origin == Host verlangen (dieselbe Regel wie der Terminal-Handschlag `/terminal/:id`, s.
 * `routes/terminal.ts`). Fehlender Origin bleibt erlaubt (kein Browser). */
export function originMatchesHost(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** sobald `NYXOS_ALLOWED_HOSTS` gesetzt ist (Tailscale-Name
 * o. Ä.), MUSS `NYXOS_AUTH_READS=1` mitgesetzt sein — sonst wären lesende Endpunkte und
 * `/live` auch von außerhalb 127.0.0.1/localhost ohne Anmeldung erreichbar. Reine Funktion, in
 * `main.ts` VOR dem Start geprüft (nicht in `createApp`: Tests/Probe/`dev.ts` setzen
 * `NYXOS_ALLOWED_HOSTS` nie über die Umgebung und sollen frei bleiben). */
export function assertAuthReadsWithAllowedHosts(allowedHostsEnv: string | null | undefined, authReadsEnv: string | null | undefined): void {
  if (!allowedHostsEnv?.trim()) return;
  if (authReadsEnv === "1") return;
  throw new Error(
    "NYXOS_ALLOWED_HOSTS ist gesetzt, aber NYXOS_AUTH_READS=1 fehlt — vor Zugriff von außerhalb 127.0.0.1/localhost (Tailscale) müssen lesende Endpunkte und /live eine Anmeldung verlangen. Server-Start abgebrochen.",
  );
}
