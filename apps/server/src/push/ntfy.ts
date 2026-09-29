// Push — Versand über ntfy. Die JSON-Veröffentlichungs-API (statt Kopfzeilen) vermeidet
// HTTP-Header-Encoding-Ärger mit deutschen Umlauten in Titel/Text. iOS-Zustellung läuft über den
// offiziellen Upstream (ntfy-Server-Einstellung `upstream-base-url`, s. infra/ntfy — Deploy-Schritt,
// nicht angewendet) — dieser Sender muss nur den ntfy-HTTP-Endpunkt erreichen, die
// APNs-Weiterleitung macht der ntfy-Server selbst.
import type { NtfyTarget, PushChannel, PushChannelResult, PushEventKind, PushPriority } from "@nyxos/shared";

export interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  priority: PushPriority;
  clickUrl: string | null;
  /** für den Browser-Weg (Klick öffnet die Seite in NyxOS) und die Art in der Live-Nachricht. */
  path?: string | null;
  kind?: PushEventKind | "test";
  /** Wege an/aus aus den Einstellungen (fehlend = Standard, s. `DEFAULT_PUSH_CHANNELS`). */
  channels?: Partial<Record<PushChannel, boolean>>;
  ntfyTarget?: NtfyTarget;
}

export interface SendOutcome {
  ok: boolean;
  status: number;
  /** Ergebnis je Weg (nur der Mehr-Wege-Sender füllt das). */
  channels?: PushChannelResult[];
}

export interface NtfySender {
  send(msg: NtfyMessage): Promise<SendOutcome>;
}

/** ntfy kennt nur Zahlen 1–5 (min…urgent) für die Priorität. */
const NTFY_TIMEOUT_MS = 8000;

const PRIORITY_NUMBER: Record<PushPriority, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

export class HttpNtfySender implements NtfySender {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string | null = null,
  ) {}

  async send(msg: NtfyMessage): Promise<SendOutcome> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const body = JSON.stringify({
      topic: msg.topic,
      title: msg.title,
      message: msg.message,
      priority: PRIORITY_NUMBER[msg.priority],
      ...(msg.clickUrl ? { click: msg.clickUrl } : {}),
    });
    try {
      // nie ohne Zeitlimit — sonst hängt der Test-Knopf (und der Ticker), wenn ntfy nicht antwortet.
      const res = await fetch(this.baseUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}
