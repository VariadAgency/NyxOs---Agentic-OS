// Abwesenheit: Woher kommen die Ereignisse? Statt jeden Schreibweg einzeln anzuzapfen (Ingest, Import,
// Audit, Nyx-Werkzeuge, MCP …) schaut der Wächter jede Minute in die Tabellen und meldet nur NEUES – jedes
// Ereignis genau einmal (Schlüssel im Speicher bzw. Wasserstand). Beim Start wird der Stand „vorgemerkt“, damit
// nach einem Deploy nicht alles Alte als neu gilt.
//
//   Session fertig   = Zug geht zu (turn_open wechselt auf false, Zustand „wartet“) – je Zug einmal. Bewusst NICHT
//                      über state_observed_at: das ist der SessionStart (bleibt über alle Züge gleich); und nicht
//                      über turn_observed_at allein: ein Notification-Hook nach Stop rückt ihn vor, ohne neuen Zug.
//   Session braucht dich = „wartet“ bei offenem Zug mit Eingabe-Bildschirm (screen_waiting), länger als die Warte-Schwelle
//   Auftrag erledigt = Eintrag wechselt auf Stufe „erledigt“ (nicht Idee/Frage/Entscheidung)
//   neuer Bug        = neuer Eintrag Art „bug“ oder „audit“ (wichtig bei Priorität P0/P1)
//   Build rot        = Build-Lauf mit Status „red“, nach dem Start beendet
//   Nachtlauf fertig = Nachtlauf mit Endzeit nach dem Start
//   Inbox-Frage      = offene Frage aus der Entscheidungs-Inbox (ohne Nyx' Sortier-Vorschläge), nach dem Start angelegt
//   Freigabe         = offene Freigabe-Anfrage, nach dem Start angelegt
import { GUARD_RULE_LABELS, sessionLabel, t } from "@nyxos/shared";
import { and, eq, gt, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals, buildRuns, entries, inboxItems, nightRuns, sessions } from "../db/schema.js";
import { countedSession } from "../db/visible.js";
import { sessionPath } from "../push/waiting.js";
import type { AwayEvent, AwayQuestion } from "./notifier.js";

const BUG_KINDS = ["bug", "audit"];
const NOT_AUFTRAG_KINDS = ["idee", "frage", "entscheidung"];
const HIGH_PRIORITIES = new Set(["p0", "p1", "hoch", "high", "kritisch"]);
/** Ältere Zustände zählen nicht mehr als „gerade fertig“ (hält die Abfrage klein). */
const LOOKBACK_MS = 24 * 3_600_000;
const SEEN_MAX = 5000;

function short(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export class AwayWatcher {
  private since: string;
  private primed = false;
  private bugMaxId = 0;
  private doneIds = new Set<number>();
  /** Session → war die Runde beim letzten Blick offen? (Übergang offen → zu = „fertig“). */
  private turnOpen = new Map<string, boolean>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.since = new Date(now()).toISOString();
  }

  /** Stand beim Start merken: was jetzt schon da ist, ist nicht neu. */
  async prime(): Promise<void> {
    this.since = new Date(this.now()).toISOString();
    const [bug] = await this.db
      .select({ max: sql<number | null>`max(${entries.id})` })
      .from(entries)
      .where(inArray(entries.kind, BUG_KINDS));
    this.bugMaxId = Number(bug?.max ?? 0);
    const done = await this.db.select({ id: entries.id }).from(entries).where(eq(entries.stage, "erledigt"));
    this.doneIds = new Set(done.map((r) => r.id));
    const recent = await this.db
      .select({ id: sessions.id, turnOpen: sessions.turnOpen })
      .from(sessions)
      .where(and(gte(this.turnAt, new Date(this.now() - LOOKBACK_MS).toISOString()), countedSession));
    this.turnOpen = new Map(recent.map((r) => [r.id, r.turnOpen]));
    this.primed = true;
  }

  /** Letztes Runden-Signal (Rückfall: letzte Aktivität, Zustandswechsel). */
  private readonly turnAt = sql<string | null>`coalesce(${sessions.turnObservedAt}, ${sessions.lastActivityAt}, ${sessions.stateObservedAt})`;

  /** Seit wann (ms) eine Session ununterbrochen auf Eingabe wartet – selbst gemessen, s. „Offene Fragen“. */
  private readonly waitingSince = new Map<string, number>();

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Neue Ereignisse seit dem letzten Aufruf + alle gerade offenen Fragen. */
  async scan(opts: { waitingAfterSeconds: number }): Promise<{ events: AwayEvent[]; openQuestions: AwayQuestion[] }> {
    if (!this.primed) await this.prime();
    const now = this.now();
    const lookback = new Date(now - LOOKBACK_MS).toISOString();
    const floor = this.since > lookback ? this.since : lookback;
    const events: AwayEvent[] = [];

    // ── Sessions: Zug fertig (wartet, Zug geschlossen) ──
    const sessionCols = {
      id: sessions.id,
      sessionId: sessions.sessionId,
      title: sessions.title,
      titleSource: sessions.titleSource,
      tool: sessions.tool,
      cwd: sessions.cwd,
      startedAt: sessions.startedAt,
      lastActivityAt: sessions.lastActivityAt,
      turnObservedAt: sessions.turnObservedAt,
      categoryBaustelleLabel: sessions.categoryBaustelleLabel,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      stateObservedAt: sessions.stateObservedAt,
    };
    const recent = await this.db
      .select({ ...sessionCols, state: sessions.state, turnOpen: sessions.turnOpen, turnAt: this.turnAt, afterStart: sql<boolean>`${this.turnAt} >= ${floor}::timestamptz` })
      .from(sessions)
      .where(and(gte(this.turnAt, lookback), countedSession));
    const nextOpen = new Map<string, boolean>();
    for (const r of recent) {
      nextOpen.set(r.id, r.turnOpen);
      const prev = this.turnOpen.get(r.id);
      const finished = r.state === "waiting" && !r.turnOpen;
      // Fertig = beim letzten Blick offen, jetzt zu; eine unbekannte Session nur, wenn ihr Zug nach dem Start endete.
      if (!finished || !(prev === true || (prev === undefined && r.afterStart === true))) continue;
      const key = `s:${r.id}:${String(r.turnAt)}`;
      if (!this.remember(key)) continue;
      events.push({ key, kind: "session_done", label: t("Session „{name}“ fertig", { name: sessionLabel({ ...r, baustelleLabel: r.categoryBaustelleLabel }) }), path: sessionPath(r), important: false });
    }
    this.turnOpen = nextOpen;

    // ── Einträge: neue Bugs/Audit-Funde ──
    const bugs = await this.db
      .select({ id: entries.id, kind: entries.kind, title: entries.title, priority: entries.priority })
      .from(entries)
      .where(and(inArray(entries.kind, BUG_KINDS), gt(entries.id, this.bugMaxId)))
      .orderBy(entries.id)
      .limit(500);
    for (const b of bugs) {
      this.bugMaxId = Math.max(this.bugMaxId, b.id);
      const high = HIGH_PRIORITIES.has((b.priority ?? "").toLowerCase());
      const prio = b.priority ? ` (${b.priority.toUpperCase()})` : "";
      events.push({ key: `b:${b.id}`, kind: "bug_new", label: `${b.kind === "audit" ? "Audit-Fund" : "Bug"}${prio}: ${short(b.title)}`, path: "/tasks", important: high });
    }

    // ── Einträge: Stufe → erledigt ──
    const doneRows = await this.db
      .select({ id: entries.id, kind: entries.kind, title: entries.title })
      .from(entries)
      .where(and(eq(entries.stage, "erledigt"), notInArray(entries.kind, NOT_AUFTRAG_KINDS)));
    const nowDone = new Set<number>();
    for (const e of doneRows) {
      nowDone.add(e.id);
      if (this.doneIds.has(e.id)) continue;
      events.push({ key: `e:${e.id}:${now}`, kind: "auftrag_done", label: `Erledigt: ${short(e.title)}`, path: "/tasks", important: false });
    }
    // Wieder geöffnete Einträge fallen heraus – wird einer später erneut erledigt, ist das ein neues Ereignis.
    this.doneIds = nowDone;

    // ── Builds: rot ──
    const red = await this.db
      .select({ id: buildRuns.id, kind: buildRuns.kind })
      .from(buildRuns)
      .where(and(eq(buildRuns.status, "red"), isNotNull(buildRuns.endedAt), gte(buildRuns.endedAt, floor)));
    for (const b of red) {
      const key = `r:${b.id}`;
      if (!this.remember(key)) continue;
      events.push({ key, kind: "build_red", label: `Build rot (${b.kind})`, path: "/overview", important: true });
    }

    // ── Nachtläufe: fertig ──
    const nights = await this.db
      .select({ id: nightRuns.id, title: nightRuns.title, status: nightRuns.status })
      .from(nightRuns)
      .where(and(isNotNull(nightRuns.endedAt), gte(nightRuns.endedAt, floor)));
    for (const n of nights) {
      const key = `n:${n.id}`;
      if (!this.remember(key)) continue;
      events.push({ key, kind: "night_done", label: t("Nachtlauf fertig: {title} ({status})", { title: short(n.title), status: n.status }), path: "/overview", important: false });
    }

    // ── Offene Fragen ──
    const openQuestions: AwayQuestion[] = [];
    const inbox = await this.db
      .select({ id: inboxItems.id, title: inboxItems.title, body: inboxItems.body, options: inboxItems.options, fingerprint: inboxItems.fingerprint })
      .from(inboxItems)
      .where(and(eq(inboxItems.status, "open"), gte(inboxItems.createdAt, this.since)))
      .orderBy(inboxItems.id)
      .limit(50);
    for (const i of inbox) {
      if ((i.fingerprint ?? "").startsWith("sort:")) continue; // Nyx' Sortier-Vorschläge sind keine Frage an den Nutzer
      openQuestions.push({ key: `i:${i.id}`, kind: "inbox", ref: i.id, title: i.title, body: i.body, options: (i.options ?? []) as { id: string; label: string }[], path: `/inbox#inbox-${i.id}` });
    }
    const pending = await this.db
      .select({ id: approvals.id, rule: approvals.rule, command: approvals.command })
      .from(approvals)
      .where(and(eq(approvals.status, "pending"), gte(approvals.createdAt, this.since)))
      .limit(50);
    for (const a of pending) {
      const rule = (GUARD_RULE_LABELS as Record<string, string>)[a.rule] ?? a.rule;
      openQuestions.push({ key: `a:${a.id}`, kind: "approval", ref: a.id, title: t("Freigabe nötig: {rule}", { rule }), body: short(a.command, 200), options: [], path: `/inbox#approval-${a.id}` });
    }
    const stuck = await this.db
      .select(sessionCols)
      .from(sessions)
      .where(
        and(
          eq(sessions.state, "waiting"),
          eq(sessions.turnOpen, true),
          eq(sessions.screenWaiting, true),
          gte(this.turnAt, lookback),
          countedSession,
        ),
      )
      .limit(20);
    // `stateObservedAt` sagt nicht, seit wann die Session WARTET (nur Start/Ende) – die Frage ging sofort raus
    // und nach jedem Flackern erneut. Jetzt: selbst gemessen, seit wann sie wartet; Frage erst nach der Schwelle,
    // je Zug genau einmal (Schlüssel = Zug, nicht Zeitpunkt der Beobachtung).
    const stillWaiting = new Set<string>();
    for (const r of stuck) {
      stillWaiting.add(r.id);
      const first = this.waitingSince.get(r.id) ?? now;
      this.waitingSince.set(r.id, first);
      if (now - first < Math.max(0, opts.waitingAfterSeconds) * 1000) continue;
      const name = sessionLabel({ ...r, baustelleLabel: r.categoryBaustelleLabel });
      const turn = r.turnObservedAt ?? r.lastActivityAt ?? r.startedAt ?? "";
      openQuestions.push({ key: `w:${r.id}:${turn}`, kind: "session", ref: r.id, title: t("Session „{name}“ wartet auf deine Eingabe", { name }), options: [], path: sessionPath(r) });
    }
    for (const id of [...this.waitingSince.keys()]) if (!stillWaiting.has(id)) this.waitingSince.delete(id);
    return { events, openQuestions };
  }
}
