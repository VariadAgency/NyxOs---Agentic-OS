// Nyx meldet sich von selbst (Erinnerung, geplante Aufgabe). `notifyUser()` ist die EINE Schnittstelle:
// Web = Nachricht im Faden „Nyx meldet sich“ + Ereignis `nyx.notify` über den WebSocket (N2/N2b zeigen es an);
// Telegram = ein Kanal, den N4 mit `registerChannel("telegram", …)` anschließt. Ohne angeschlossenen Kanal meldet die
// Funktion das ehrlich („nicht verbunden“) statt still zu schlucken.
import type { NyxDeliver, NyxNotifyEvent } from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuMessages, haikuThreads } from "../db/schema.js";
import { localDay } from "../haiku/settings.js";
import type { LiveHub } from "../live.js";
import { toSpeakText } from "./speak.js";

/** Thema des Fadens, in dem Nyx' eigene Meldungen landen (Chat-Suche wertet `nyx-*` ab). */
export const NOTIFY_TOPIC = "nyx-meldungen";
export const NOTIFY_THREAD_TITLE = "Nyx meldet sich";

export interface NyxNotice {
  title: string;
  text: string;
  speak?: string;
  deliver?: NyxDeliver;
  scheduleId?: number | null;
  link?: { url: string; title: string };
  image?: { fileId: number; url: string; title: string };
}

export interface ChannelMessage extends Required<Pick<NyxNotice, "title" | "text" | "speak">> {
  link?: NyxNotice["link"];
  image?: NyxNotice["image"];
  scheduleId: number | null;
}

export type ChannelSender = (msg: ChannelMessage) => Promise<void>;

export interface NotifyOutcome {
  web: boolean;
  threadId: number | null;
  telegram: "sent" | "not_connected" | "failed" | "skipped";
}

export class NyxNotifier {
  private readonly channels = new Map<string, ChannelSender>();
  /** Kann der Kanal gerade wirklich zustellen (Bot verbunden UND Chat gekoppelt)? */
  private readonly readiness = new Map<string, () => Promise<boolean>>();

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
    private readonly log?: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  /** Telegram anschließen (`notifier.registerChannel("telegram", send)`); `null` trennt. */
  registerChannel(name: "telegram", sender: ChannelSender | null, ready?: () => Promise<boolean>): void {
    if (sender) this.channels.set(name, sender);
    else this.channels.delete(name);
    if (sender && ready) this.readiness.set(name, ready);
    else this.readiness.delete(name);
  }

  /** Nur versprechen, was geht: angeschlossen UND (falls gemeldet) gerade zustellbar. Fehler = nein. */
  async channelReady(name: "telegram"): Promise<boolean> {
    if (!this.channels.has(name)) return false;
    const ready = this.readiness.get(name);
    if (!ready) return true;
    try {
      return await ready();
    } catch {
      return false;
    }
  }

  hasChannel(name: "telegram"): boolean {
    return this.channels.has(name);
  }

  private async notifyThread(): Promise<number> {
    const [t] = await this.db
      .select({ id: haikuThreads.id })
      .from(haikuThreads)
      .where(and(eq(haikuThreads.scope, "full"), eq(haikuThreads.topic, NOTIFY_TOPIC)))
      .limit(1);
    if (t) return t.id;
    const [created] = await this.db.insert(haikuThreads).values({ scope: "full", topic: NOTIFY_TOPIC, day: localDay(new Date()), title: NOTIFY_THREAD_TITLE }).returning({ id: haikuThreads.id });
    return (created as { id: number }).id;
  }

  async notifyUser(n: NyxNotice): Promise<NotifyOutcome> {
    const deliver = n.deliver ?? "web";
    const speak = n.speak ?? toSpeakText(`${n.title}. ${n.text}`);
    const out: NotifyOutcome = { web: false, threadId: null, telegram: "skipped" };
    // Web immer auch ablegen (auch bei „nur Telegram“ bleibt es im Verlauf nachlesbar).
    const threadId = await this.notifyThread();
    const body = n.title && !n.text.startsWith(n.title) ? `**${n.title}**\n\n${n.text}` : n.text;
    await this.db.insert(haikuMessages).values({ threadId, role: "assistant", text: body, speak, channel: "notify" });
    await this.db.update(haikuThreads).set({ updatedAt: new Date().toISOString() }).where(eq(haikuThreads.id, threadId));
    out.threadId = threadId;
    out.web = true;
    const ev: NyxNotifyEvent = { type: "nyx.notify", title: n.title, text: n.text, speak, threadId, scheduleId: n.scheduleId ?? null, ...(n.link ? { link: n.link } : {}), ...(n.image ? { image: n.image } : {}) };
    this.hub.broadcast(ev);
    this.hub.broadcast({ type: "haiku", what: "threads" });
    if (deliver === "telegram" || deliver === "both") {
      const send = this.channels.get("telegram");
      if (!send) out.telegram = "not_connected";
      else {
        try {
          await send({ title: n.title, text: n.text, speak, link: n.link, image: n.image, scheduleId: n.scheduleId ?? null });
          out.telegram = "sent";
        } catch (e) {
          out.telegram = "failed";
          this.log?.("nyx-telegram-fehler", { error: String(e).slice(0, 200) });
        }
      }
    }
    return out;
  }
}
