// Abwesenheit: Zusammenbau für den Server – Anwesenheit (Herzschlag), Wächter (Tabellen → Ereignisse/Fragen)
// und Melder (Bündeln, ntfy, Telegram). `tick()` läuft im 60-s-Takt des Servers mit (app.ts `tickStates`).
import { DEFAULT_AWAY_SETTINGS, type AwaySettings, type AwayStatus, type NtfyTarget } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { logDelivery } from "../push/log.js";
import type { NtfySender } from "../push/ntfy.js";
import { loadOrInitSettings } from "../push/settings.js";
import { AwayNotifier, type AwayNtfyMessage, type AwayTelegram } from "./notifier.js";
import { Presence } from "./presence.js";
import { loadAwaySettings } from "./settings.js";
import { AwayWatcher } from "./watch.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Nur eine echte, vom iPhone erreichbare Adresse taugt als Klick-Ziel – die lokale Standard-Adresse nicht. */
export function clickUrlFor(publicBaseUrl: string, path: string | null): string | null {
  if (!path) return null;
  const base = publicBaseUrl.trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(base)) return null;
  return `${base}${path}`;
}

export interface AwayServiceDeps {
  db: Db;
  /** Roher ntfy-Transport je Ziel (eigener Dienst / ntfy.sh) – bewusst NICHT der Mehr-Wege-Sender (kein Mac, kein Browser). */
  ntfy: (target: NtfyTarget) => NtfySender;
  telegram: AwayTelegram | null;
  log?: Log;
  now?: () => number;
}

export class AwayService {
  readonly presence: Presence;
  readonly watcher: AwayWatcher;
  readonly notifier: AwayNotifier;
  private cached: AwaySettings | null = null;
  private readonly log: Log;

  constructor(private readonly d: AwayServiceDeps) {
    const now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
    this.presence = new Presence(now);
    this.watcher = new AwayWatcher(d.db, now);
    this.notifier = new AwayNotifier({
      presence: this.presence,
      settings: () => this.settings(),
      sendNtfy: (msg) => this.sendNtfy(msg),
      telegram: d.telegram,
      log: this.log,
      now,
    });
  }

  async settings(): Promise<AwaySettings> {
    this.cached = await loadAwaySettings(this.d.db);
    return this.cached;
  }

  /**
   * Für den alten Einzel-Push (Mehr-Wege-Sender): Ist der Nutzer weg und die Abwesenheit an, bekommt das iPhone NUR die
   * Sammel-Mitteilungen – sonst käme jede wartende Session zusätzlich einzeln aufs Handy. Synchron (letzter bekannter
   * Stand der Einstellungen), weil der Sender je Mitteilung fragt.
   */
  legacyNtfySuppressed(): boolean {
    const s = this.cached ?? DEFAULT_AWAY_SETTINGS;
    return s.enabled && this.presence.isAway(s.awayAfterMinutes * 60_000);
  }

  setCached(s: AwaySettings): void {
    this.cached = s;
  }

  private async sendNtfy(msg: AwayNtfyMessage): Promise<boolean> {
    const push = await loadOrInitSettings(this.d.db);
    const res = await this.d.ntfy(push.ntfyTarget).send({
      topic: push.topic,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
      clickUrl: clickUrlFor(push.publicBaseUrl, msg.path),
      path: msg.path,
      channels: { mac: false, browser: false, ntfy: true },
      ntfyTarget: push.ntfyTarget,
    });
    // auch diese Mitteilung ins Protokoll (Nyx' `mitteilungen_liste`), nur ntfy.
    await logDelivery(this.d.db, {
      kind: msg.kind ?? "away_bundle",
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
      clickUrl: clickUrlFor(push.publicBaseUrl, msg.path),
      channels: [{ channel: "ntfy", ok: res.ok }],
      bundle: (msg.kind ?? "away_bundle") === "away_bundle",
    });
    return res.ok;
  }

  async tick(): Promise<void> {
    const push = await loadOrInitSettings(this.d.db);
    const scan = await this.watcher.scan({ waitingAfterSeconds: push.waitingAfterSeconds });
    await this.notifier.tick(scan);
  }

  async status(): Promise<AwayStatus> {
    const settings = await this.settings();
    const last = this.presence.lastSeenAt();
    return {
      away: settings.enabled && this.presence.isAway(settings.awayAfterMinutes * 60_000),
      lastSeenAt: last === null ? null : new Date(last).toISOString(),
      pendingEvents: this.notifier.pendingEvents,
      settings,
    };
  }
}
