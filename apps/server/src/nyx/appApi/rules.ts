// Nyx bedient NyxOS über die eigene API (`app_api`). EINE Tabelle entscheidet je Methode + Weg:
// - „gesperrt“: nie, auch nicht mit Bestätigung (Anmeldung, Geheimnisse, Zugänge, Nyx-Runde selbst, Cursor-Wege …),
// - „bestaetigung“: nur nach des Nutzers Klick auf „Ausführen“ (Löschen, Session beenden/schließen, Freigaben/Entscheidungen …),
// - „direkt“: alles andere (nur in Runden, die vom Nutzer selbst kommen – s. service.ts).
// Die Sperre gilt doppelt: im Werkzeug UND im Anmelde-Tor (`terminal/auth.ts`) für interne Anfragen.

export type ApiAccess = "direkt" | "bestaetigung" | "gesperrt";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRule {
  methods: "*" | readonly string[];
  /** Weg-Muster: `:x` = genau ein Abschnitt, `**` am Ende = dieser Weg und alles darunter. */
  pattern: string;
  /** Kurzer deutscher Grund (gesperrt) bzw. was bestätigt wird (Bestätigung). */
  label: string;
  /** Vorsorge für Wege, die es heute noch nicht gibt (z. B. Git-Merge/Push über NyxOS). */
  future?: true;
}

/** So viel Antwort bekommt Nyx höchstens (Zeichen); darüber wird gekürzt und Nyx erfährt es. */
export const APP_API_BODY_LIMIT = 20_000;
/** So lange wartet eine riskante Aktion auf des Nutzers „Ausführen“. */
export const APP_API_CONFIRM_TTL_MS = 30 * 60 * 1000;

const W = ["POST", "PUT", "PATCH", "DELETE"] as const;

export const BLOCKED_RULES: readonly ApiRule[] = [
  { methods: "*", pattern: "/api/auth/**", label: "Anmeldung, Passkeys und Anmelde-Sitzungen fasst nur der Nutzer selbst an." },
  { methods: "*", pattern: "/api/secrets/**", label: "Geheimnisse (Schlüssel, Tokens) fasst Nyx nie an." },
  { methods: "*", pattern: "/api/access/**", label: "Zugänge (Schlüssel, Tokens) fasst Nyx nie an." },
  { methods: "*", pattern: "/api/idealinks/**", label: "Ideen-Links sind Zugangsschlüssel für andere – die verwaltet nur der Nutzer." },
  { methods: W, pattern: "/api/telegram/token", label: "Das Telegram-Token fasst Nyx nie an." },
  { methods: W, pattern: "/api/telegram/pairing", label: "Die Telegram-Kopplung (Zugangscode) macht nur der Nutzer." },
  { methods: W, pattern: "/api/nyx/voice/elevenlabs/key", label: "Den ElevenLabs-Schlüssel fasst Nyx nie an." },
  { methods: ["POST"], pattern: "/api/models/providers", label: "Modell-Anbieter tragen Schlüssel – die richtet nur der Nutzer ein." },
  { methods: ["PUT", "DELETE"], pattern: "/api/models/providers/:id", label: "Modell-Anbieter tragen Schlüssel – die richtet nur der Nutzer ein." },
  { methods: ["POST"], pattern: "/api/mcp/connectors", label: "Konnektoren tragen Tokens – die richtet nur der Nutzer ein." },
  { methods: ["PATCH", "DELETE"], pattern: "/api/mcp/connectors/:id", label: "Konnektoren tragen Tokens – die richtet nur der Nutzer ein." },
  { methods: "*", pattern: "/api/mcp/connectors/:id/oauth/**", label: "Konnektor-Anmeldungen macht nur der Nutzer." },
  { methods: "*", pattern: "/api/mcp/connectors/:id/device/**", label: "Konnektor-Anmeldungen macht nur der Nutzer." },
  { methods: "*", pattern: "/api/mcp/oauth/**", label: "Konnektor-Anmeldungen macht nur der Nutzer." },
  { methods: "*", pattern: "/api/push/subscribe", label: "Das geheime Mitteilungs-Thema bleibt geheim." },
  { methods: "*", pattern: "/api/haiku/chat", label: "Eine Nyx-Runde startet Nyx nicht aus sich selbst heraus." },
  { methods: "*", pattern: "/api/haiku/selftest", label: "Eine Nyx-Runde startet Nyx nicht aus sich selbst heraus." },
  { methods: "*", pattern: "/api/haiku/threads/:id/interrupted", label: "Gehört zur laufenden Nyx-Runde im Browser." },
  { methods: "*", pattern: "/api/nyx/ui/**", label: "Den sichtbaren Cursor steuerst du mit den ui_*-Werkzeugen." },
  { methods: "*", pattern: "/api/nyx/events", label: "Die Live-Anzeige meldet nur der Server selbst." },
  { methods: "*", pattern: "/api/away/heartbeat", label: "Das würde vortäuschen, dass der Nutzer gerade in NyxOS ist." },
  { methods: "*", pattern: "/api/server/ssh/**", label: "Eine Shell auf dem Server öffnet nur der Nutzer selbst." },
  { methods: "*", pattern: "/api/server/deploys", label: "Deploys meldet nur das Deploy-Skript." },
  { methods: "*", pattern: "/api/entries/git/commit", label: "Commits meldet nur die Brücke." },
  { methods: "*", pattern: "/api/entries/docs/mirror", label: "Den Doku-Spiegel liefert nur die Brücke." },
  // Rohdaten (Audio, Dateien) passen nicht in JSON.
  { methods: "*", pattern: "/api/voice/transcribe", label: "Braucht eine Tonaufnahme – geht nicht über app_api." },
  { methods: "*", pattern: "/api/nyx/voice/transcribe", label: "Braucht eine Tonaufnahme – geht nicht über app_api." },
  { methods: "*", pattern: "/api/nyx/voice/elevenlabs/clone", label: "Braucht eine Tonaufnahme – geht nicht über app_api." },
  { methods: ["POST"], pattern: "/api/nyx/files", label: "Braucht eine Datei – dafür gibt es show_image/screenshot_simulator." },
];

export const CONFIRM_RULES: readonly ApiRule[] = [
  { methods: ["DELETE"], pattern: "/api/**", label: "Löschen" },
  { methods: ["POST"], pattern: "/api/sessions/:id/kill", label: "Session beenden" },
  { methods: ["POST"], pattern: "/api/sessions/:id/close", label: "Session schließen" },
  { methods: ["POST"], pattern: "/api/sessions/:id/takeover", label: "Session übernehmen (altes Fenster beenden)" },
  { methods: ["POST"], pattern: "/api/approvals/:id/decide", label: "Freigabe entscheiden" },
  { methods: ["POST"], pattern: "/api/inbox/:id/answer", label: "Entscheidung beantworten" },
  { methods: ["POST"], pattern: "/api/inbox/:id/dismiss", label: "Entscheidung verwerfen" },
  { methods: ["POST"], pattern: "/api/haiku/release-all", label: "Alles freigeben" },
  { methods: ["POST"], pattern: "/api/conflicts/decisions/**", label: "Konflikt-Entscheidung" },
  { methods: ["POST"], pattern: "/api/conflicts/pause", label: "Sessions pausieren" },
  // Budget und Ideen-Link-Grenzen lockert Nyx nie allein.
  { methods: ["PATCH"], pattern: "/api/haiku/settings", label: "Nyx-Budget/Grenzen ändern" },
  // Code läuft ohne weitere Rückfrage (autonomer Auftrag), Anweisungen für künftige Sessions (CLAUDE.md …) oder
  // Schutz-Einstellungen (Hooks, Projektordner): nie allein auf Grund fremder Texte (Prompt-Injection).
  { methods: ["POST"], pattern: "/api/entries/:id/start", label: "Auftrag autonom starten" },
  { methods: ["POST"], pattern: "/api/finder/write", label: "Datei auf dem Rechner speichern" },
  { methods: ["POST"], pattern: "/api/setup", label: "Einrichtung ändern (Hooks, Projektordner)" },
  { methods: W, pattern: "/api/git/**", label: "Git (Merge, Push …)", future: true },
];

/** Passt ein konkreter Weg auf ein Muster (`:x` = ein Abschnitt, `**` am Ende = Rest, auch leer)? */
export function matchRoutePattern(pattern: string, path: string): boolean {
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as string;
    if (p === "**" && i === ps.length - 1) return xs.length >= i;
    const x = xs[i];
    if (x === undefined) return false;
    if (p.startsWith(":")) continue;
    if (p !== x) return false;
  }
  return xs.length === ps.length;
}

const ruleHits = (rule: ApiRule, method: string, path: string) => (rule.methods === "*" || rule.methods.includes(method)) && matchRoutePattern(rule.pattern, path);

export interface ApiClassification {
  access: ApiAccess;
  /** Grund (gesperrt) bzw. Name der Aktion (Bestätigung). */
  label: string | null;
}

/** Einordnung eines (schon geprüften) Wegs. Gesperrt geht immer vor Bestätigung. `body` nur für die eine Ausnahme
 * unten: eine neue Session mit `auftrag` läuft autonom (`--permission-mode auto`) – dieselbe Hürde wie ein Auftrag. */
export function classifyApiRequest(method: string, path: string, body?: unknown): ApiClassification {
  const m = method.toUpperCase();
  const blocked = BLOCKED_RULES.find((r) => ruleHits(r, m, path));
  if (blocked) return { access: "gesperrt", label: blocked.label };
  const confirm = CONFIRM_RULES.find((r) => ruleHits(r, m, path));
  if (confirm) return { access: "bestaetigung", label: confirm.label };
  if (m === "POST" && path === "/api/terminal/start" && typeof body === "object" && body !== null && (body as { auftrag?: unknown }).auftrag != null) {
    return { access: "bestaetigung", label: "Auftrag autonom starten" };
  }
  return { access: "direkt", label: null };
}

/** Zweite Sperre im Anmelde-Tor: nur die Frage „gesperrt?“, ohne Pfad-Prüfung (die macht das Werkzeug). */
export function isBlockedForInternal(method: string, path: string): boolean {
  if (!path.startsWith("/api/")) return true;
  return classifyApiRequest(method, path).access === "gesperrt";
}

/** Erlaubte Zeichen in einem Abschnitt (wie in den echten Wegen: Session-Schlüssel `claude:…`, UUIDs, Zahlen). */
const SEGMENT_RE = /^[A-Za-z0-9._~:@+=,-]+$/;

/**
 * Prüft den Weg, den Nyx angibt. `null` = in Ordnung, sonst ein kurzer Grund. Keine Punkte-Abschnitte, keine
 * Prozent-Kodierung, keine leeren Abschnitte, kein `?`/`#` – sonst ließe sich die Sperr-Tabelle umgehen.
 */
export function validateApiPath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/api/")) return "Der Weg muss mit /api/ beginnen.";
  if (path.length > 500) return "Der Weg ist zu lang.";
  if (/[?#\\%\s]/.test(path)) return "Abfrage-Werte gehören in „query“; Prozent-Kodierung, Leerzeichen und \\ sind nicht erlaubt.";
  const segs = path.slice(1).split("/");
  if (segs.at(-1) === "") segs.pop(); // ein abschließendes „/“ ist ok
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "Leere Abschnitte und Punkte-Abschnitte sind nicht erlaubt.";
    if (!SEGMENT_RE.test(s)) return `Ungültiger Abschnitt „${s.slice(0, 40)}“.`;
  }
  return null;
}
