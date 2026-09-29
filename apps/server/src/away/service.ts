// Abwesenheit: Zusammenbau für den Server – Anwesenheit (Herzschlag), Wächter (Tabellen → Ereignisse/Fragen)
// und Melder (Bündeln, ntfy, Telegram). `tick()` läuft im 60-s-Takt des Servers mit (app.ts `tickStates`).
import { DEFAULT_AWAY_SETTINGS, NOTIFY_OCCASIONS, t, type AwaySettings, type AwayStatus, type FocusMode, type NotifyRules, type NtfyTarget, type PushEventKind } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { runPipeline, type NotifyEnv } from "../notifications/pipeline.js";
import { loadNotifyRules } from "../notifications/rules.js";
import { logDelivery } from "../push/log.js";
import type { NtfySender } from "../push/ntfy.js";
import { loadOrInitSettings } from "../push/settings.js";
import { AwayNotifier, type AwayEvent, type AwayNtfyMessage, type AwayQuestion, type AwayTelegram } from "./notifier.js";
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
  /**
   * Shared notification pipeline. Every event of the watcher goes through it (when? sub-agent? Nyx? text) – user
   * present + level "always" → normal notification, away → digest. Without it: the earlier behaviour.
   */
  pipeline?: { sender: () => NtfySender; env: () => NotifyEnv };
  /** Focus button: current focus ("away" = away, "dnd" = present). Missing: auto. */
  focus?: () => FocusMode;
}

/** Away event → occasion of the pipeline. */
const EVENT_KIND: Record<AwayEvent["kind"], PushEventKind> = {
  session_done: "session_done",
  auftrag_done: "auftrag_done",
  bug_new: "bug_new",
  build_red: "build_red",
  night_done: "night_run_done",
  session_waiting: "session_waiting",
  session_crashed: "session_crashed",
  approval_needed: "approval_needed",
  deploy_failed: "deploy_failed",
  context_guard_hinweis: "context_guard_hinweis",
  usage_warning: "usage_warning",
};

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
      settings: () => this.effectiveSettings(),
      sendNtfy: (msg) => this.sendNtfy(msg),
      telegram: d.telegram,
      log: this.log,
      now,
      awayOverride: () => this.focusOverride(),
    });
  }

  /** Focus: `true` = "away", `false` = "do not disturb", `null` = presence decides. */
  focusOverride(): boolean | null {
    const mode = this.d.focus?.() ?? "auto";
    return mode === "away" ? true : mode === "dnd" ? false : null;
  }

  async settings(): Promise<AwaySettings> {
    this.cached = await loadAwaySettings(this.d.db);
    return this.cached;
  }

  /**
   * Which events may go into the digest is decided by the notification rules (level "never" = off). The old switches
   * in `away_settings.events` only count as long as there is no pipeline.
   */
  private async effectiveSettings(): Promise<AwaySettings> {
    const s = await this.settings();
    if (!this.d.pipeline) return s;
    const rules = await loadNotifyRules(this.d.db);
    const on = (k: PushEventKind) => rules.when[k] !== "never";
    return {
      ...s,
      events: {
        session_done: on("session_done"),
        auftrag_done: on("auftrag_done"),
        bug_new: on("bug_new"),
        build_red: on("build_red"),
        night_done: on("night_run_done"),
        questions: on("approval_needed") || on("session_waiting"),
      },
    };
  }

  /** Is the user away right now (away detection on, no active window)? Last known state, synchronous. */
  isAwayNow(): boolean {
    return this.legacyNtfySuppressed();
  }

  /**
   * Für den alten Einzel-Push (Mehr-Wege-Sender): Ist der Nutzer weg und die Abwesenheit an, bekommt das iPhone NUR die
   * Sammel-Mitteilungen – sonst käme jede wartende Session zusätzlich einzeln aufs Handy. Synchron (letzter bekannter
   * Stand der Einstellungen), weil der Sender je Mitteilung fragt.
   */
  legacyNtfySuppressed(): boolean {
    const s = this.cached ?? DEFAULT_AWAY_SETTINGS;
    return this.focusOverride() ?? (s.enabled && this.presence.isAway(s.awayAfterMinutes * 60_000));
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
    await this.settings(); // keep the cache for isAwayNow() fresh
    const rules = this.d.pipeline ? await loadNotifyRules(this.d.db) : null;
    const scan = await this.watcher.scan({ waitingAfterSeconds: push.waitingAfterSeconds, skipSubAgents: rules?.skipSubAgents ?? false });
    if (!this.d.pipeline || !rules) {
      await this.notifier.tick(scan);
      return;
    }
    // Every event through the pipeline; it puts it into the batch itself (away) or sends it (present + "always").
    const env = this.d.pipeline.env();
    for (const e of scan.events) {
      const kind = EVENT_KIND[e.kind];
      // "Build rot" is reported by the build watcher itself (bundled per failure, see builds/notify.ts) – not twice.
      if (kind === "build_red") continue;
      try {
        await runPipeline(
          { kind, title: t(NOTIFY_OCCASIONS[kind].title), message: e.label, what: e.what ?? e.label, at: e.occurredAt ?? null, path: e.path, sessionKey: e.sessionKey ?? null, priority: e.important ? "high" : undefined },
          { db: this.d.db, sender: this.d.pipeline.sender(), settings: push, now: new Date((this.d.now ?? Date.now)()), env },
          { awayEvent: { key: e.key } },
        );
      } catch (err) {
        this.log("mitteilung-fehler", { art: kind, error: String(err) });
      }
    }
    await this.notifier.tick({ events: [], openQuestions: this.allowedQuestions(scan.openQuestions, rules) });
  }

  /** Telegram questions only for occasions that are not set to "never". */
  private allowedQuestions(questions: AwayQuestion[], rules: NotifyRules): AwayQuestion[] {
    return questions.filter((q) => (q.kind === "session" ? rules.when.session_waiting !== "never" : rules.when.approval_needed !== "never"));
  }

  async status(): Promise<AwayStatus> {
    const settings = await this.settings();
    const last = this.presence.lastSeenAt();
    return {
      away: this.focusOverride() ?? (settings.enabled && this.presence.isAway(settings.awayAfterMinutes * 60_000)),
      lastSeenAt: last === null ? null : new Date(last).toISOString(),
      pendingEvents: this.notifier.pendingEvents,
      settings,
    };
  }
}
