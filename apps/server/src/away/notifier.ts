// Abwesenheit: Wann geht was wohin?
//
//   Ereignisse (Session fertig, Auftrag erledigt, neuer Bug, Build rot, Nachtlauf fertig)
//     → NUR ntfy, NUR wenn der Nutzer weg ist, gebündelt:
//       · normal: frühestens `GATHER_MS` nach dem ersten Ereignis des Stapels UND höchstens alle `bundleMinutes`
//       · wichtig (Build rot, Bug P0/P1): sofort, aber nie öfter als alle `urgentGapMinutes`
//       · Ruhezeit: nur Wichtiges; der Rest wartet bis zum Ende der Ruhezeit
//       · der Nutzer wieder da → der Stapel verfällt (er sieht es ja in NyxOS)
//   Fragen/Bedarf (offene Inbox-Frage, Session wartet auf Eingabe)
//     → Telegram (mit Antwort-Knöpfen), NUR wenn weg, jede Frage höchstens einmal, höchstens eine Nachricht je
//       `questionGapMinutes` (mehrere Fragen darin). Telegram nicht gekoppelt → EIN ntfy-Hinweis je Abwesenheit.
//
// Die Klasse ist rein (Zeitquelle, Einstellungen, Versand von außen) und damit ohne Server testbar.
import { t, type AwayEventKind, type AwaySettings, type PushPriority } from "@nyxos/shared";
import { isQuietNow } from "../push/dispatcher.js";
import type { Presence } from "./presence.js";

/** Normale Ereignisse sammeln sich mindestens so lange, bevor die erste Sammel-Mitteilung rausgeht. */
export const GATHER_MS = 5 * 60_000;
/** Mehr Zeilen passen nicht sinnvoll auf den Sperrbildschirm. */
const MAX_LINES = 8;
/** Mehr Fragen je Telegram-Nachricht werden unübersichtlich (der Rest kommt in der nächsten). */
export const MAX_QUESTIONS_PER_MESSAGE = 5;

export interface AwayEvent {
  /** Eindeutig je Ereignis (z. B. `s:<session>:<zeit>`) – derselbe Schlüssel kommt nie zweimal in den Stapel. */
  key: string;
  kind: AwayEventKind;
  /** Eine Zeile für die Mitteilung, z. B. „Session „Push-Umbau“ fertig“. */
  label: string;
  /** NyxOS-Seite zum Ereignis (für den Klick in ntfy). */
  path: string | null;
  important: boolean;
}

export interface AwayQuestion {
  key: string;
  kind: "inbox" | "session" | "approval";
  /** Inbox-/Freigabe-Nummer bzw. Session-Schlüssel. */
  ref: number | string;
  title: string;
  body?: string | null;
  options: { id: string; label: string }[];
  path: string | null;
}

export interface AwayNtfyMessage {
  title: string;
  message: string;
  priority: PushPriority;
  path: string | null;
  /** Art fürs Protokoll (Nyx' `mitteilungen_liste`): Sammel-Mitteilung oder Hinweis auf offene Fragen. */
  kind?: "away_bundle" | "away_question_hint";
}

export interface AwayTelegram {
  /** Bot verbunden UND Chat gekoppelt? */
  ready(): Promise<boolean>;
  sendQuestions(questions: AwayQuestion[]): Promise<boolean>;
}

export interface AwayNotifierDeps {
  presence: Presence;
  settings: () => Promise<AwaySettings>;
  /** Versand NUR über ntfy (nie Mac/Browser). true = angekommen. */
  sendNtfy: (msg: AwayNtfyMessage) => Promise<boolean>;
  telegram: AwayTelegram | null;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

const KIND_ORDER: AwayEventKind[] = ["build_red", "bug_new", "auftrag_done", "session_done", "night_done"];
const KIND_WORDS: Record<AwayEventKind, [string, string]> = {
  build_red: ["{n} Build rot", "{n} Builds rot"],
  bug_new: ["{n} neuer Bug", "{n} neue Bugs"],
  auftrag_done: ["{n} Auftrag erledigt", "{n} Aufträge erledigt"],
  session_done: ["{n} Session fertig", "{n} Sessions fertig"],
  night_done: ["{n} Nachtlauf fertig", "{n} Nachtläufe fertig"],
};

/** „3 Sessions fertig, 1 Auftrag erledigt“ + Zeilen. */
export function summarize(events: AwayEvent[]): { title: string; message: string; path: string | null } {
  const counts = new Map<AwayEventKind, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const parts = KIND_ORDER.filter((k) => counts.has(k)).map((k) => {
    const n = counts.get(k) ?? 0;
    const [one, many] = KIND_WORDS[k];
    return t(n === 1 ? one : many, { n });
  });
  const sorted = [...events].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const lines = sorted.slice(0, MAX_LINES).map((e) => `• ${e.label}`);
  if (sorted.length > MAX_LINES) lines.push(t("… und {n} weitere", { n: sorted.length - MAX_LINES }));
  const paths = new Set(events.map((e) => e.path ?? "/overview"));
  const path = paths.size === 1 ? ([...paths][0] ?? "/overview") : "/overview";
  return { title: `NyxOS: ${parts.join(", ")}`, message: lines.join("\n"), path };
}

export class AwayNotifier {
  private readonly now: () => number;
  private readonly log: NonNullable<AwayNotifierDeps["log"]>;
  private readonly batch = new Map<string, AwayEvent & { at: number }>();
  private lastEventSend: number | null = null;
  private lastQuestionSend: number | null = null;
  private readonly askedQuestions = new Set<string>();
  private unpairedHintSent = false;
  private wasAway = false;

  constructor(private readonly d: AwayNotifierDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
  }

  get pendingEvents(): number {
    return this.batch.size;
  }

  /**
   * Ein Takt (Server-Ticker, jede Minute): neue Ereignisse aufnehmen, dann entscheiden, ob gesendet wird.
   * `openQuestions` = ALLE gerade offenen Fragen (beantwortete fallen so von selbst heraus).
   */
  async tick(input: { events: AwayEvent[]; openQuestions: AwayQuestion[] }): Promise<{ away: boolean; sentEvents: number; sentQuestions: number }> {
    const s = await this.d.settings();
    const now = this.now();
    const away = s.enabled && this.d.presence.isAway(s.awayAfterMinutes * 60_000);
    // Beantwortete/erledigte Fragen vergessen (hält den Speicher klein, eine neue Frage mit derselben Nummer gibt es nicht).
    const open = new Set(input.openQuestions.map((q) => q.key));
    for (const k of this.askedQuestions) if (!open.has(k)) this.askedQuestions.delete(k);

    if (!away) {
      if (this.batch.size > 0) this.log("abwesend-stapel-verworfen", { ereignisse: this.batch.size, grund: s.enabled ? "nutzer-da" : "aus" });
      this.batch.clear();
      if (this.wasAway) this.log("abwesend-ende");
      this.wasAway = false;
      this.unpairedHintSent = false;
      return { away: false, sentEvents: 0, sentQuestions: 0 };
    }
    if (!this.wasAway) this.log("abwesend-beginn", { nachMinuten: s.awayAfterMinutes });
    this.wasAway = true;

    let added = 0;
    for (const e of input.events) {
      if (!s.events[e.kind] || this.batch.has(e.key)) continue;
      this.batch.set(e.key, { ...e, at: now });
      added++;
    }
    if (added > 0) this.log("abwesend-gebuendelt", { neu: added, imStapel: this.batch.size });

    const sentEvents = await this.flushEvents(s, now);
    const sentQuestions = s.events.questions ? await this.flushQuestions(s, now, input.openQuestions) : 0;
    return { away: true, sentEvents, sentQuestions };
  }

  private quiet(s: AwaySettings, now: number): boolean {
    return s.quietEnabled && isQuietNow({ quietStart: s.quietStart, quietEnd: s.quietEnd }, new Date(now));
  }

  private async flushEvents(s: AwaySettings, now: number): Promise<number> {
    if (this.batch.size === 0) return 0;
    const all = [...this.batch.values()];
    const quiet = this.quiet(s, now);
    const important = all.some((e) => e.important);
    if (quiet && !important) return 0;
    const sinceLast = this.lastEventSend === null ? Infinity : now - this.lastEventSend;
    const oldest = Math.min(...all.map((e) => e.at));
    const gather = Math.min(GATHER_MS, s.bundleMinutes * 60_000);
    const due = important ? sinceLast >= s.urgentGapMinutes * 60_000 : now - oldest >= gather && sinceLast >= s.bundleMinutes * 60_000;
    if (!due) return 0;
    // In der Ruhezeit nur das Wichtige – der Rest bleibt im Stapel bis morgens.
    const send = quiet ? all.filter((e) => e.important) : all;
    const sum = summarize(send);
    const ok = await this.d.sendNtfy({ title: sum.title, message: sum.message, priority: important ? "high" : "default", path: sum.path, kind: "away_bundle" }).catch(() => false);
    this.lastEventSend = now; // auch bei Fehlschlag: kein Dauerfeuer auf einen kaputten ntfy-Dienst
    if (!ok) {
      this.log("abwesend-ntfy-fehler", { ereignisse: send.length });
      return 0;
    }
    for (const e of send) this.batch.delete(e.key);
    this.log("abwesend-ntfy-gesendet", { ereignisse: send.length, titel: sum.title, wichtig: important, ruhezeit: quiet });
    return send.length;
  }

  private async flushQuestions(s: AwaySettings, now: number, openQuestions: AwayQuestion[]): Promise<number> {
    const fresh = openQuestions.filter((q) => !this.askedQuestions.has(q.key));
    if (fresh.length === 0) return 0;
    if (this.quiet(s, now)) return 0; // Fragen warten die Ruhezeit ab (bleiben offen, kommen morgens)
    if (this.lastQuestionSend !== null && now - this.lastQuestionSend < s.questionGapMinutes * 60_000) return 0;
    const ready = this.d.telegram ? await this.d.telegram.ready().catch(() => false) : false;
    if (!ready) {
      for (const q of fresh) this.askedQuestions.add(q.key);
      if (this.unpairedHintSent) return 0;
      this.unpairedHintSent = true;
      this.lastQuestionSend = now;
      const first = fresh[0];
      const ok = await this.d
        .sendNtfy({
          title: t("Nyx hat eine Frage – Telegram ist nicht gekoppelt"),
          message: `${fresh.length === 1 ? "" : t("{n} Fragen, z. B.: ", { n: fresh.length })}${first?.title ?? ""}\n${t("Antworten geht in NyxOS (oder Telegram koppeln: Einstellungen → Telegram).")}`.trim(),
          priority: "default",
          path: fresh.length === 1 ? (first?.path ?? "/inbox") : "/inbox",
          kind: "away_question_hint",
        })
        .catch(() => false);
      this.log("abwesend-frage-ntfy-hinweis", { fragen: fresh.length, ok });
      return ok ? fresh.length : 0;
    }
    // Freigaben hat Telegram schon als eigene Karte mit Knöpfen (onApprovalCreated) – nicht doppelt schicken.
    for (const q of fresh) if (q.kind === "approval") this.askedQuestions.add(q.key);
    const toSend = fresh.filter((q) => q.kind !== "approval").slice(0, MAX_QUESTIONS_PER_MESSAGE);
    if (toSend.length === 0) return 0;
    this.lastQuestionSend = now;
    const ok = await this.d.telegram?.sendQuestions(toSend).catch(() => false);
    if (!ok) {
      this.log("abwesend-telegram-fehler", { fragen: toSend.length });
      return 0;
    }
    for (const q of toSend) this.askedQuestions.add(q.key);
    this.log("abwesend-telegram-gesendet", { fragen: toSend.length, arten: [...new Set(toSend.map((q) => q.kind))] });
    return toSend.length;
  }
}
