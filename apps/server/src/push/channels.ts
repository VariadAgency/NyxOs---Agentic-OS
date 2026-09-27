// Push über mehrere Wege. Vorher ging jede Mitteilung NUR an den eigenen ntfy-Dienst — der lauscht
// aber nur auf 127.0.0.1 des Servers, also konnte kein iPhone ihn abonnieren: veröffentlicht wurde, angekommen
// ist nie etwas. Jetzt fächert `MultiChannelSender` jede Mitteilung auf drei Wege auf:
//   mac     → macOS-Mitteilung über die Brücke (RPC `notify`, läuft ohne öffentlichen Port)
//   browser → Web-Mitteilung in jedem offenen NyxOS-Fenster (Live-WebSocket `{ type: "push" }`)
//   ntfy    → iPhone-App ntfy (eigener Dienst oder ntfy.sh, s. `ntfyTarget`)
// Er erfüllt dieselbe `NtfySender`-Schnittstelle wie vorher, damit alle Anlässe (wartend, Build rot,
// Freigabe, Kontext, Nutzung) ohne Änderung an ihren Aufrufstellen alle Wege bekommen.
import {
  BRIDGE_CAP_NOTIFY,
  DEFAULT_PUSH_CHANNELS,
  PUSH_CHANNELS,
  type NtfyTarget,
  type PushChannel,
  type PushChannelResult,
  type PushLiveMessage,
  t,
} from "@nyxos/shared";
import type { NtfyMessage, NtfySender, SendOutcome } from "./ntfy.js";

/** Was der Mac-Weg von der Brücke braucht (erfüllt `BridgeHub`). */
export interface BridgeNotifier {
  readonly online: boolean;
  supports(cap: string): boolean;
  rpc(method: "notify", params: unknown, timeoutMs?: number): Promise<{ ok: boolean; error?: string; code?: string }>;
}

/** Was der Browser-Weg vom Live-Hub braucht (erfüllt `LiveHub`). */
export interface LiveBroadcaster {
  readonly size: number;
  broadcast(message: unknown): void;
}

export interface MultiChannelDeps {
  ntfy: (target: NtfyTarget) => NtfySender;
  bridge: BridgeNotifier;
  live: LiveBroadcaster;
  /**
   * Abwesenheit: Darf diese Einzel-Mitteilung aufs iPhone (ntfy)? Ist „Wenn ich weg bin“ an, bekommt das iPhone
   * nur noch die gebündelten Sammel-Mitteilungen (away/notifier.ts) – Einzel-Anlässe gehen dann nur an Mac + Browser.
   * Fehlt die Funktion: wie früher.
   */
  ntfyAllowed?: (msg: NtfyMessage) => boolean;
}

export const NTFY_BUNDLED_DETAIL = "Aufs iPhone kommt nur die gebündelte Mitteilung, wenn du weg bist.";

/** Eine macOS-Mitteilung darf nicht hängen bleiben — sonst wartet der Test-Knopf ewig. */
export const MAC_NOTIFY_TIMEOUT_MS = 5000;
/** Grenzen aus `MacNotifyRequestSchema` (Brücke). */
const MAC_TITLE_MAX = 200;
const MAC_MESSAGE_MAX = 1000;

export class MultiChannelSender implements NtfySender {
  constructor(private readonly d: MultiChannelDeps) {}

  async send(msg: NtfyMessage): Promise<SendOutcome> {
    const enabled: Record<PushChannel, boolean> = { ...DEFAULT_PUSH_CHANNELS, ...(msg.channels ?? {}) };
    const skip = (channel: PushChannel): PushChannelResult => ({ channel, ok: false, skipped: true, detail: t("In den Einstellungen aus.") });
    // Mac zuerst: der Browser-Weg erfährt so, ob der Rechner die Mitteilung schon zeigt (kein Doppel auf dem Rechner).
    const mac = enabled.mac ? await this.sendMac(msg) : skip("mac");
    const [browser, ntfy] = await Promise.all([
      enabled.browser ? Promise.resolve(this.sendBrowser(msg, mac.ok)) : Promise.resolve(skip("browser")),
      !enabled.ntfy
        ? Promise.resolve(skip("ntfy"))
        : this.d.ntfyAllowed && !this.d.ntfyAllowed(msg)
          ? Promise.resolve<PushChannelResult>({ channel: "ntfy", ok: false, skipped: true, detail: t(NTFY_BUNDLED_DETAIL) })
          : this.sendNtfy(msg),
    ]);
    const byChannel: Record<PushChannel, PushChannelResult> = { mac, browser, ntfy };
    const channels = PUSH_CHANNELS.map((c) => byChannel[c]);
    const ok = channels.some((c) => c.ok);
    return { ok, status: ok ? 200 : 0, channels };
  }

  private async sendMac(msg: NtfyMessage): Promise<PushChannelResult> {
    const b = this.d.bridge;
    if (!b.online) return { channel: "mac", ok: false, detail: t("Brücke ist nicht verbunden.") };
    if (!b.supports(BRIDGE_CAP_NOTIFY)) return { channel: "mac", ok: false, detail: t("Brücke ist zu alt – mit dem nächsten Deploy (--mac) neu ausrollen.") };
    // auf die Grenzen der Brücke (MacNotifyRequestSchema) kürzen – ein langer oder leerer Text darf den
    // Mac-Weg nicht an der Prüfung scheitern lassen.
    const title = msg.title.trim().slice(0, MAC_TITLE_MAX) || "NyxOS";
    const message = msg.message.trim().slice(0, MAC_MESSAGE_MAX) || title;
    const res = await b.rpc("notify", { title, message }, MAC_NOTIFY_TIMEOUT_MS);
    if (res.ok) return { channel: "mac", ok: true, detail: t("Auf dem Rechner angezeigt.") };
    return { channel: "mac", ok: false, detail: res.error ?? t("Mac konnte die Mitteilung nicht zeigen.") };
  }

  private sendBrowser(msg: NtfyMessage, macShown: boolean): PushChannelResult {
    const open = this.d.live.size;
    if (open === 0) return { channel: "browser", ok: false, detail: t("Kein NyxOS-Fenster offen.") };
    const live: PushLiveMessage & { macShown: boolean } = {
      type: "push",
      kind: msg.kind ?? "test",
      title: msg.title,
      message: msg.message,
      path: msg.path ?? null,
      macShown,
    };
    this.d.live.broadcast(live);
    return { channel: "browser", ok: true, detail: open === 1 ? t("An 1 offenes Fenster geschickt.") : t("An {n} offene Fenster geschickt.", { n: open }) };
  }

  private async sendNtfy(msg: NtfyMessage): Promise<PushChannelResult> {
    const target = msg.ntfyTarget ?? "own";
    const res = await this.d.ntfy(target).send(msg);

    if (res.ok) return { channel: "ntfy", ok: true, detail: target === "ntfy_sh" ? t("An ntfy.sh übergeben.") : t("An den eigenen ntfy-Dienst übergeben.") };
    return { channel: "ntfy", ok: false, detail: target === "ntfy_sh" ? (res.status === 0 ? t("ntfy.sh ist nicht erreichbar.") : t("ntfy.sh lehnt ab ({status}).", { status: res.status })) : res.status === 0 ? t("Der eigene ntfy-Dienst ist nicht erreichbar.") : t("Der eigene ntfy-Dienst lehnt ab ({status}).", { status: res.status }) };
  }
}
