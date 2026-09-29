// EINE Stelle für Fehlertexte in der Oberfläche. Nie Technik durchreichen („Failed to fetch“,
// „NetworkError“, „Server antwortet mit 502“, „ENOENT“ …) — stattdessen ein einfacher Satz, was los ist.
// Sätze vom Server (z. B. „Die Session arbeitet gerade“) bleiben stehen, sie sind schon für den Nutzer
// geschrieben (und serverseitig übersetzt). Der Aufrufer zeigt daneben „Erneut versuchen“, wo das Sinn ergibt.
import { t, getLang } from "@nyxos/shared";
import { isDemoReadonly } from "./demoReadonly";


/** Kein Netz / Tunnel weg / Seite vom Browser abgebrochen. */
export const OFFLINE_TEXT = t("Keine Verbindung zum Server – bitte gleich noch einmal versuchen.");
export const SERVER_TROUBLE_TEXT = t("Der Server hat gerade ein Problem – bitte gleich noch einmal versuchen.");
export const LOGIN_TEXT = t("Bitte anmelden (Touch ID), dann geht es weiter.");
export const DEFAULT_TEXT = t("Das hat nicht geklappt – bitte noch einmal versuchen.");

/**
 * Muster, die nach Technik aussehen und nie so in der Oberfläche stehen sollen. Bewusst eng:
 * „Status“, „null Einträge“, „nicht gefunden“ in einem ganzen Satz oder „500 Zeichen“ sind gutes Deutsch und
 * bleiben stehen. Ersetzt wird nur echte Technik (tmux, CSRF, ENOENT, Stack, „Error:“, Code-Namen) und
 * englische Fehlermeldungen (nur, wenn die Oberfläche Deutsch spricht – sonst sind englische Sätze vom Server
 * ja gewollt). Der Originaltext bleibt unter „Details“ aufklappbar (`errorDetail`).
 */
const TECHNICAL: RegExp[] = [
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|server antwortet mit|server responded with/i,
  /\bhttp\s?\d{3}\b|\bstatus(?:\s*code)?\s*:?\s*[1-5]\d\d\b/i,
  /\benoent\b|\beconn\w*|\betimedout\b|\bepipe\b|\beacces\b|\beperm\b|\bcsrf\b|\btmux\b|\bstack\b|\bjson\b/i,
  /\w*error\b|\bexception\b|unexpected token|\bexit code\b|\bspawn\b|\babort\w*/i,
  /\b(?:null|undefined|NaN)\b(?!\s+[A-ZÄÖÜ])/, // Code-Werte; „null Einträge“ (Zahlwort vor Nomen) bleibt
  /'[a-z][A-Za-z0-9_]*'|`[^`]+`/, // Code-Namen: Feld 'sessionKeys', `key`
  /\bat\s+\S+\s+\(|\/\w[\w/.-]*\.(?:ts|tsx|js|mjs):\d+/, // Stack-Zeilen, Pfade mit Zeilennummer
  /^(?:\S+\s+)?nicht gefunden\.?$/i, // knappe Entwickler-Meldung („Faden nicht gefunden“), kein ganzer Satz
  /ungültiger körper/i,
];

/** Englische Fehlermeldungen („Permission denied“, „Internal Server Error“, „Cannot read properties …“). */
const ENGLISH_TECHNICAL =
  /\b(?:the|is|are|cannot|can't|could|failed|denied|invalid|missing|required|unknown|unable|refused|internal|permission|request|properties|reading|timeout|timed out|not allowed|not found)\b/i;
/** Auch auf Englisch klar technisch: typische Browser-/Node-Meldungen. */
const ENGLISH_TECHNICAL_ALWAYS = /cannot read propert|is not a function|is not defined|internal server error|permission denied|unexpected end of/i;

function looksTechnical(msg: string): boolean {
  if (TECHNICAL.some((re) => re.test(msg))) return true;
  return getLang() === "de" ? ENGLISH_TECHNICAL.test(msg) : ENGLISH_TECHNICAL_ALWAYS.test(msg);
}

/**
 * Fehler beim Starten des Mikrofons (getUserMedia) — der Browser meldet sie technisch
 * („Permission denied“, NotAllowedError, NotFoundError). Einfache Sätze mit Hinweis, was zu tun ist.
 */
export const MIC_BLOCKED_TEXT = t(
  "Das Mikrofon ist gesperrt. Bitte den Mikrofon-Zugriff im Browser erlauben (Schloss-Symbol links in der Adresszeile) und noch einmal tippen.",
);
export const MIC_MISSING_TEXT = t("Kein Mikrofon da. Bitte ein Mikrofon anschließen oder in den Systemeinstellungen unter „Ton“ auswählen.");
export const MIC_BUSY_TEXT = t("Das Mikrofon wird gerade von einer anderen App benutzt. Bitte die andere App schließen und noch einmal tippen.");
export const MIC_UNSUPPORTED_TEXT = t(
  "Der Browser gibt das Mikrofon hier nicht frei. Bitte NyxOS über seine normale Adresse (https) in Safari oder Chrome öffnen.",
);
export const MIC_DEFAULT_TEXT = t("Das Mikrofon ließ sich nicht starten – bitte noch einmal tippen.");

export function micErrorText(e: unknown): string {
  const isErr = e instanceof Error || e instanceof DOMException;
  const name = isErr ? e.name : "";
  const msg = isErr ? e.message : typeof e === "string" ? e : "";
  if (name === "NotAllowedError" || name === "SecurityError" || /permission|not allowed|denied/i.test(msg)) return MIC_BLOCKED_TEXT;
  if (name === "NotFoundError" || name === "OverconstrainedError" || /not found|no device/i.test(msg)) return MIC_MISSING_TEXT;
  if (name === "NotReadableError" || name === "AbortError" || /could not start|in use/i.test(msg)) return MIC_BUSY_TEXT;
  // Ohne sichere Verbindung fehlt `navigator.mediaDevices` → TypeError. Das ist KEIN Netzfehler.
  if (e instanceof TypeError || name === "NotSupportedError") return MIC_UNSUPPORTED_TEXT;
  return MIC_DEFAULT_TEXT;
}

function statusOf(e: unknown): number | null {
  if (typeof e === "object" && e !== null && "status" in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return null;
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch() ohne Antwort: Chrome „Failed to fetch“, Safari „Load failed“, Firefox „NetworkError …“
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}

/** Freundlicher Satz für jeden Fehler. `fallback` ist der Satz für „irgendwas ging schief“ an dieser Stelle. */
export function friendlyError(e: unknown, fallback: string = DEFAULT_TEXT): string {
  if (e === null || e === undefined) return fallback;
  // Demo („nur umsehen“): die globale Demo-Meldung erklärt es schon – kein zusätzlicher roter Satz hier.
  if (isDemoReadonly(e)) return "";
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) return t("Der Server hat nicht rechtzeitig geantwortet – bitte noch einmal versuchen.");
  if (isNetworkError(e)) return OFFLINE_TEXT;
  const status = statusOf(e);
  const msg = (e instanceof Error ? e.message : typeof e === "string" ? e : "").trim();
  // Ein eigener Satz vom Server hat Vorrang vor dem Status (z. B. 409 „Die Session arbeitet gerade“).
  if (msg && !looksTechnical(msg) && msg.length <= 300) return msg;
  if (status === 401) return LOGIN_TEXT;
  if (status === 403) return t("Das ist gerade nicht erlaubt – bitte neu anmelden und noch einmal versuchen.");
  if (status === 404) return t("Das gibt es nicht mehr – bitte die Seite neu laden.");
  if (status === 413) return t("Das ist zu groß zum Senden.");
  if (status === 429) return t("Gerade zu viele Anfragen – bitte kurz warten.");
  if (status === 502 || status === 503 || status === 504) return t("Der Server ist gerade nicht erreichbar – bitte gleich noch einmal versuchen.");
  if (status !== null && status >= 500) return SERVER_TROUBLE_TEXT;
  return fallback;
}

/**
 * Der ORIGINALTEXT hinter dem freundlichen Satz — damit er nicht verloren geht. Die Oberfläche
 * zeigt ihn nur eingeklappt unter „Details“ (`ErrorDetails`). `null`, wenn der Satz schon der Originaltext ist.
 */
export function errorDetail(e: unknown): string | null {
  if (e === null || e === undefined || isDemoReadonly(e)) return null;
  const isErr = e instanceof Error || e instanceof DOMException;
  const name = isErr ? e.name : "";
  const msg = (isErr ? e.message : typeof e === "string" ? e : "").trim();
  const status = statusOf(e);
  if (msg && friendlyError(e) === msg) return null;
  const parts = [status !== null ? `Status ${status}` : "", name && name !== "Error" ? name : "", msg].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
