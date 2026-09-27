// Geplante Aufgaben: „erinner mich um …“ (einmalig), wiederkehrend (cron, Wandzeit des Nutzers) und
// „wenn X passiert“ (vorhandene Ereignisse: Build rot, Session fertig/wartet, Session geschlossen, neue Freigabe).
// Übernommen (angepasst, nach TypeScript) aus Hermes Agent `cron/scheduler_prompt.py` (Cron-Hinweis inkl. `[SILENT]`,
// Wake-Gate), `cron/scheduler.py` (`next_run_at` VOR dem Lauf weitersetzen), `tools/cronjob_tools.py` (Werkzeug-Form)
// – MIT, © 2025 Nous Research – und OpenClaw `docs/gateway/heartbeat.md` (`activeHours`), `docs/automation/standing-orders.md`
// (MIT, © 2026 OpenClaw Foundation). Takt: der bestehende Haiku-Minutentakt (`haiku/scheduler.ts`).
// Grundsatz: erst billig prüfen (Vorab-Prüfung/Ereignis, ohne Modell), nur bei Anlass das Modell rufen;
// reine Erinnerungen laufen ganz ohne Modell.
import { NYX_SCHEDULE_EVENT_LABELS, sessionLabel, t, type NyxDeliver, type NyxPrecheck, type NyxSchedule, type NyxScheduleCreate, type NyxScheduleEvent, type NyxScheduleMode, dateTimeFormat, timeZone } from "@nyxos/shared";
import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nyxSchedules } from "../db/schema.js";
import { localStamp, rowsOf } from "../haiku/tools.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { takeSnapshot } from "../overview/snapshot.js";
import { cronDescribe, nextCronRun, parseCron, withinActiveHours } from "./cron.js";
import type { NyxNotifier } from "./notify.js";

/** Cron-Hinweis (Hermes `_CRON_HINT`, übersetzt; `[SILENT]` bleibt wörtlich ASCII). */
export const CRON_HINT = `[WICHTIG: Du läufst als geplante Aufgabe. ZUSTELLUNG: Deine Antwort wird der Nutzer automatisch zugestellt – versuche nicht, sie selbst zu verschicken; gib einfach deinen Bericht als Antwort. STILL: Gibt es wirklich nichts Neues zu berichten, antworte exakt mit "[SILENT]" (sonst nichts), dann wird nichts zugestellt. [SILENT] ist ein festes ASCII-Steuerzeichen – nie übersetzen oder umformulieren, nie mit Inhalt kombinieren. FEHLER: Konntest du die Aufgabe nicht erledigen, schreib [CRON_FAILURE] allein in die erste Zeile und danach kurz, warum. KEINE REKURSION: Das ist ein Lauf einer BESTEHENDEN geplanten Aufgabe – erledige sie jetzt. Lege wegen Formulierungen wie „jeden Montag“ oder „täglich um 9“ NIE eine neue geplante Aufgabe an; das ist nur Kontext für diesen Lauf.]`;

export const SILENT = "[SILENT]";
export const CRON_FAILURE = "[CRON_FAILURE]";

type Row = typeof nyxSchedules.$inferSelect;

const dateFmt = () => dateTimeFormat({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function describeSchedule(r: Pick<Row, "kind" | "runAt" | "cron" | "event" | "eventFilter">): string {
  if (r.kind === "once") return r.runAt ? t("einmal am {date}", { date: dateFmt().format(new Date(r.runAt)) }) : t("einmal");
  if (r.kind === "cron") return r.cron ? cronDescribe(r.cron) : t("wiederkehrend");
  const label = r.event ? (NYX_SCHEDULE_EVENT_LABELS[r.event as NyxScheduleEvent] ?? r.event) : t("Ereignis");
  return r.eventFilter ? t("wenn: {label} („{filter}“)", { label, filter: r.eventFilter }) : t("wenn: {label}", { label });
}

export function toSchedule(r: Row): NyxSchedule {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    mode: r.mode as NyxScheduleMode,
    kind: r.kind as NyxSchedule["kind"],
    runAt: r.runAt,
    cron: r.cron,
    event: (r.event as NyxScheduleEvent | null) ?? null,
    eventFilter: r.eventFilter,
    precheck: (r.precheck as NyxPrecheck | null) ?? null,
    activeHours: r.activeStart && r.activeEnd ? { start: r.activeStart, end: r.activeEnd } : null,
    deliver: r.deliver as NyxDeliver,
    paused: r.paused,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    lastOutput: r.lastOutput,
    runCount: r.runCount,
    describe: describeSchedule(r),
    createdAt: r.createdAt,
  };
}

// ───────────────────────────── Ereignisse (deterministisch, ohne Modell) ─────────────────────────────

interface EventHit {
  text: string;
  ref: string | null;
}

/** Aktueller Stand, ab dem ein neues Ereignis zählt (beim Anlegen gesetzt: nur NEUES löst aus). */
async function eventCursorNow(db: Db, event: NyxScheduleEvent, now: Date): Promise<Record<string, unknown>> {
  if (event === "build_red") {
    const [r] = rowsOf(await db.execute(sql`select coalesce(max(id), 0)::int as n from build_runs`));
    return { lastId: Number(r?.n ?? 0) };
  }
  if (event === "approval_open") {
    const [r] = rowsOf(await db.execute(sql`select coalesce(max(id), 0)::int as n from approvals`));
    return { lastId: Number(r?.n ?? 0) };
  }
  return { since: now.toISOString() };
}

const like = (f: string) => `%${f.replace(/[%_\\]/g, "\\$&")}%`;

async function checkEvent(db: Db, event: NyxScheduleEvent, filter: string | null, cursor: Record<string, unknown>, now: Date): Promise<{ hits: EventHit[]; cursor: Record<string, unknown> }> {
  if (event === "build_red") {
    const lastId = Number(cursor.lastId ?? 0);
    const rows = rowsOf(
      await db.execute(sql`select id, kind, command, folder from build_runs where id > ${lastId} and status = 'red' ${filter ? sql`and (command ilike ${like(filter)} or coalesce(folder,'') ilike ${like(filter)})` : sql``} order by id limit 10`),
    );
    const [max] = rowsOf(await db.execute(sql`select coalesce(max(id), 0)::int as n from build_runs`));
    return { hits: rows.map((r) => ({ text: r.folder ? t("Build rot: {kind} in {folder}", { kind: String(r.kind), folder: String(r.folder) }) : t("Build rot: {kind} in unbekanntem Ordner", { kind: String(r.kind) }), ref: `[[build:${r.id}]]` })), cursor: { lastId: Math.max(lastId, Number(max?.n ?? 0)) } };
  }
  if (event === "approval_open") {
    const lastId = Number(cursor.lastId ?? 0);
    const rows = rowsOf(await db.execute(sql`select id, rule, command from approvals where id > ${lastId} and status = 'pending' ${filter ? sql`and command ilike ${like(filter)}` : sql``} order by id limit 10`));
    const [max] = rowsOf(await db.execute(sql`select coalesce(max(id), 0)::int as n from approvals`));
    return { hits: rows.map((r) => ({ text: t("Neue Freigabe-Anfrage: {command}", { command: String(r.command).slice(0, 120) }), ref: `[[approval:${r.id}]]` })), cursor: { lastId: Math.max(lastId, Number(max?.n ?? 0)) } };
  }
  const since = String(cursor.since ?? now.toISOString());
  const cond =
    event === "session_waiting"
      ? sql`state = 'waiting' and closed_at is null and last_activity_at > ${since} and last_activity_at <= ${now.toISOString()}`
      : sql`closed_at > ${since} and closed_at <= ${now.toISOString()}`;
  const rows = rowsOf(
    await db.execute(sql`select id, session_id, title, title_source, tool, cwd, category_baustelle_label, started_at, last_activity_at from sessions where parent_id is null and ${cond} ${filter ? sql`and (coalesce(title,'') ilike ${like(filter)} or coalesce(cwd,'') ilike ${like(filter)})` : sql``} order by last_activity_at desc limit 10`),
  );
  // derselbe Name wie überall (`sessionLabel`) – eigener Titel, Auftrag, erste Nachricht oder Ort + Zeit.
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : str(v));
  const title = (r: Record<string, unknown>) =>
    sessionLabel({ title: str(r.title), titleSource: str(r.title_source), tool: str(r.tool), cwd: str(r.cwd), baustelleLabel: str(r.category_baustelle_label), startedAt: iso(r.started_at), lastActivityAt: iso(r.last_activity_at) });
  return {
    hits: rows.map((r) => ({ text: event === "session_waiting" ? t("Session ist fertig und wartet: {title}", { title: title(r) }) : t("Session geschlossen: {title}", { title: title(r) }), ref: `[[session:${r.id}]]` })),
    cursor: { since: now.toISOString() },
  };
}

/** Vorab-Prüfung ohne Modell (Hermes Wake-Gate): false → kein Modellaufruf. */
export async function precheckPasses(db: Db, precheck: NyxPrecheck | null, now: Date): Promise<boolean> {
  if (!precheck) return true;
  const snap = await takeSnapshot(db, now);
  if (precheck === "build_red") return snap.redBuilds.length > 0;
  if (precheck === "sessions_waiting") return snap.waiting.length > 0;
  if (precheck === "approvals_open") return snap.pendingApprovals.length > 0;
  return snap.openInbox.length > 0;
}

// ───────────────────────────── Anlegen / Ändern ─────────────────────────────

/** Kleinster Abstand zweier Läufe im Modus „run“ (jeder Lauf kostet einen Modellaufruf). */
export const MIN_RUN_INTERVAL_MINUTES = 15;

/** Kleinster Abstand (Minuten) zwischen den nächsten Läufen eines Cron-Plans (Stichprobe der nächsten 48 Läufe). */
export function minCronGapMinutes(expr: string, from: Date, samples = 48): number {
  let prev = nextCronRun(expr, from);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; prev && i < samples; i++) {
    const next = nextCronRun(expr, prev);
    if (!next) break;
    min = Math.min(min, (next.getTime() - prev.getTime()) / 60_000);
    prev = next;
  }
  return min;
}

export type CreateResult = { ok: true; schedule: NyxSchedule } | { ok: false; error: string };

export async function createSchedule(db: Db, input: NyxScheduleCreate, opts: { createdBy: "nyx" | "user"; threadId?: number | null; now?: Date }): Promise<CreateResult> {
  const now = opts.now ?? new Date();
  const w = input.when;
  let runAt: string | null = null;
  let nextRunAt: string | null = null;
  let cursor: Record<string, unknown> | null = null;
  if (w.type === "once") {
    const at = w.at ? new Date(w.at) : w.inMinutes ? new Date(now.getTime() + w.inMinutes * 60_000) : null;
    if (!at || Number.isNaN(at.getTime())) return { ok: false, error: t("Wann genau? Bitte Uhrzeit (at) oder „in X Minuten“ (inMinutes) angeben.") };
    if (at.getTime() <= now.getTime() - 60_000) return { ok: false, error: t("Dieser Zeitpunkt liegt in der Vergangenheit.") };
    runAt = at.toISOString();
    nextRunAt = runAt;
  } else if (w.type === "cron") {
    if (!parseCron(w.cron)) return { ok: false, error: t("Diesen Zeitplan verstehe ich nicht. Form: „Minute Stunde Tag Monat Wochentag“, z. B. „0 7 * * *“ = täglich 07:00.") };
    nextRunAt = nextCronRun(w.cron, now)?.toISOString() ?? null;
    if (!nextRunAt) return { ok: false, error: t("Dieser Zeitplan trifft im nächsten Jahr nie zu.") };
    // Kosten nur bei Anlass: „run“ ruft jedes Mal das Modell – nicht öfter als alle 15 Minuten.
    if (input.mode === "run" && minCronGapMinutes(w.cron, now) < MIN_RUN_INTERVAL_MINUTES)
      return { ok: false, error: t("Eine Aufgabe, bei der Nyx arbeitet, läuft höchstens alle {n} Minuten. Für öfter: mode remind (ohne Modell) oder ein Ereignis.", { n: MIN_RUN_INTERVAL_MINUTES }) };
  } else {
    cursor = await eventCursorNow(db, w.event, now);
  }
  const [row] = await db
    .insert(nyxSchedules)
    .values({
      name: input.name,
      prompt: input.prompt,
      mode: input.mode,
      kind: w.type,
      runAt,
      cron: w.type === "cron" ? w.cron.trim() : null,
      event: w.type === "event" ? w.event : null,
      eventFilter: w.type === "event" ? (w.filter?.trim() || null) : null,
      eventCursor: cursor,
      precheck: input.precheck ?? null,
      activeStart: input.activeHours?.start ?? null,
      activeEnd: input.activeHours?.end ?? null,
      deliver: input.deliver,
      nextRunAt,
      createdBy: opts.createdBy,
      sourceThreadId: opts.threadId ?? null,
    })
    .returning();
  return { ok: true, schedule: toSchedule(row as Row) };
}

export async function listSchedules(db: Db): Promise<NyxSchedule[]> {
  return (await db.select().from(nyxSchedules).orderBy(asc(nyxSchedules.paused), desc(nyxSchedules.id)).limit(200)).map(toSchedule);
}

export async function getSchedule(db: Db, id: number): Promise<Row | null> {
  const [r] = await db.select().from(nyxSchedules).where(eq(nyxSchedules.id, id)).limit(1);
  return r ?? null;
}

export async function patchSchedule(
  db: Db,
  id: number,
  patch: { name?: string; prompt?: string; paused?: boolean; precheck?: NyxPrecheck | null; activeHours?: { start: string; end: string } | null; deliver?: NyxDeliver },
  now = new Date(),
): Promise<NyxSchedule | null> {
  const row = await getSchedule(db, id);
  if (!row) return null;
  const set: Partial<typeof nyxSchedules.$inferInsert> = { updatedAt: now.toISOString() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.deliver !== undefined) set.deliver = patch.deliver;
  if (patch.precheck !== undefined) set.precheck = patch.precheck;
  if (patch.activeHours !== undefined) {
    set.activeStart = patch.activeHours?.start ?? null;
    set.activeEnd = patch.activeHours?.end ?? null;
  }
  if (patch.paused !== undefined) {
    set.paused = patch.paused;
    // Fortsetzen: Cron ab jetzt neu rechnen (keine Nachhol-Welle), Ereignis ab jetzt beobachten.
    if (!patch.paused && row.kind === "cron" && row.cron) set.nextRunAt = nextCronRun(row.cron, now)?.toISOString() ?? null;
    if (!patch.paused && row.kind === "event" && row.event) set.eventCursor = await eventCursorNow(db, row.event as NyxScheduleEvent, now);
  }
  const [out] = await db.update(nyxSchedules).set(set).where(eq(nyxSchedules.id, id)).returning();
  return toSchedule(out as Row);
}

export async function deleteSchedule(db: Db, id: number): Promise<boolean> {
  return (await db.delete(nyxSchedules).where(eq(nyxSchedules.id, id)).returning({ id: nyxSchedules.id })).length > 0;
}

// ───────────────────────────── Ausführen ─────────────────────────────

export interface ScheduleRunnerDeps {
  runtime: HaikuRuntime;
  notifier: NyxNotifier;
  /** System-Prompt für Läufe im Modus „run“ (aktuelles Gedächtnis, alle Werkzeuge). */
  systemPrompt: () => Promise<string>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RunOutcome {
  id: number;
  status: "delivered" | "ok" | "silent" | "skipped" | "failed" | "inactive";
}

export class NyxScheduleRunner {
  private busy = false;
  constructor(private readonly deps: ScheduleRunnerDeps) {}

  private get db(): Db {
    return this.deps.runtime.db;
  }

  /** Ein Takt: fällige Zeit-Aufgaben und Ereignis-Aufgaben prüfen und ausführen. */
  async tick(now = new Date()): Promise<RunOutcome[]> {
    if (this.busy) return [];
    this.busy = true;
    const out: RunOutcome[] = [];
    try {
      const due = await this.db
        .select()
        .from(nyxSchedules)
        .where(and(eq(nyxSchedules.paused, false), isNotNull(nyxSchedules.nextRunAt), lte(nyxSchedules.nextRunAt, now.toISOString())))
        .orderBy(asc(nyxSchedules.nextRunAt))
        .limit(20);
      for (const r of due) out.push(await this.runTimed(r, now));
      const events = await this.db
        .select()
        .from(nyxSchedules)
        .where(and(eq(nyxSchedules.paused, false), eq(nyxSchedules.kind, "event")))
        .limit(50);
      for (const r of events) {
        const res = await this.runEvent(r, now);
        if (res) out.push(res);
      }
    } catch (e) {
      this.deps.log?.("nyx-plan-fehler", { error: String(e).slice(0, 300) });
    } finally {
      this.busy = false;
    }
    return out;
  }

  private active(r: Row, now: Date): boolean {
    return withinActiveHours(r.activeStart && r.activeEnd ? { start: r.activeStart, end: r.activeEnd } : null, now);
  }

  private async runTimed(r: Row, now: Date): Promise<RunOutcome> {
    // Außerhalb der aktiven Stunden: nichts ändern – läuft beim ersten Takt im Fenster (einmal, keine Nachhol-Welle).
    if (!this.active(r, now)) return { id: r.id, status: "inactive" };
    // Hermes: `next_run_at` VOR dem Lauf weitersetzen → höchstens einmal, auch bei Absturz mitten im Lauf.
    const next = r.kind === "cron" && r.cron ? (nextCronRun(r.cron, now)?.toISOString() ?? null) : null;
    await this.db.update(nyxSchedules).set({ nextRunAt: next, updatedAt: now.toISOString() }).where(eq(nyxSchedules.id, r.id));
    return this.execute(r, now, null);
  }

  private async runEvent(r: Row, now: Date): Promise<RunOutcome | null> {
    if (!r.event || !this.active(r, now)) return null; // außerhalb: Stand bleibt, Ereignis löst im Fenster aus
    const cursor = r.eventCursor ?? (await eventCursorNow(this.db, r.event as NyxScheduleEvent, now));
    const { hits, cursor: next } = await checkEvent(this.db, r.event as NyxScheduleEvent, r.eventFilter, cursor, now);
    await this.db.update(nyxSchedules).set({ eventCursor: next }).where(eq(nyxSchedules.id, r.id));
    if (hits.length === 0) return null;
    return this.execute(r, now, hits);
  }

  private readonly background = new Set<Promise<unknown>>();

  /**
   * Werkzeug `run` aus einem laufenden Chat. Der Chat hält selbst einen Modell-Platz – würde er auf den
   * Plan-Lauf warten, der seinerseits auf einen freien Platz wartet, stünde beides bis zum Zeitlimit (Verklemmung bei
   * `NYXOS_HAIKU_CONCURRENCY=1`). Darum im Hintergrund starten; das Ergebnis kommt als Meldung.
   */
  runInBackground(id: number): void {
    const p: Promise<unknown> = this.runNow(id)
      .catch((e: unknown) => this.deps.log?.("nyx-plan-fehler", { id, error: String(e).slice(0, 300) }))
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /** Tests: auf im Hintergrund gestartete Läufe warten. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Sofort ausführen (Knopf „Jetzt ausführen“ / Werkzeug `run`) – ohne den Zeitplan zu verschieben. */
  async runNow(id: number, now = new Date()): Promise<RunOutcome | null> {
    const r = await getSchedule(this.db, id);
    if (!r) return null;
    return this.execute(r, now, null);
  }

  private async finish(r: Row, now: Date, status: RunOutcome["status"], output: string | null): Promise<RunOutcome> {
    await this.db
      .update(nyxSchedules)
      .set({ lastRunAt: now.toISOString(), lastStatus: status, lastOutput: output?.slice(0, 4000) ?? r.lastOutput, runCount: r.runCount + 1, updatedAt: now.toISOString() })
      .where(eq(nyxSchedules.id, r.id));
    return { id: r.id, status };
  }

  private async execute(r: Row, now: Date, hits: EventHit[] | null): Promise<RunOutcome> {
    const anlass = hits?.length ? hits.map((h) => `- ${h.text}`).join("\n") : null;
    if (!(await precheckPasses(this.db, (r.precheck as NyxPrecheck | null) ?? null, now))) return this.finish(r, now, "skipped", null);
    const deliver = r.deliver as NyxDeliver;
    if (r.mode === "remind") {
      const text = anlass ? `${r.prompt}\n\n${t("Anlass:")}\n${anlass}` : r.prompt;
      await this.deps.notifier.notifyUser({ title: t("Erinnerung: {name}", { name: r.name }), text, deliver, scheduleId: r.id });
      return this.finish(r, now, "delivered", text);
    }
    const prompt = [
      CRON_HINT,
      `Jetzt: ${localStamp(now.toISOString())} (${timeZone()}).`,
      `Geplante Aufgabe „${r.name}“ (${describeSchedule(r)}):\n${r.prompt}`,
      anlass ? `Anlass (gerade passiert, mit Belegen):\n${hits?.map((h) => `- ${h.text}${h.ref ? ` ${h.ref}` : ""}`).join("\n")}` : "",
      r.lastOutput ? `Deine letzte Meldung zu dieser Aufgabe (nichts wiederholen, dort weitermachen):\n${r.lastOutput.slice(0, 1500)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const res = await this.deps.runtime.run({ kind: "schedule", scope: "full", systemPrompt: await this.deps.systemPrompt(), prompt, thinking: false });
    if (res.type === "error") {
      // Erst beim ersten Fehlschlag einer Serie melden (Hermes: Warnung statt Dauerfeuer).
      if (r.lastStatus !== "failed") await this.deps.notifier.notifyUser({ title: t("Geplante Aufgabe „{name}“ lief nicht", { name: r.name }), text: res.message, deliver, scheduleId: r.id });
      return this.finish(r, now, "failed", null);
    }
    const text = res.text.trim();
    if (text === SILENT || text.startsWith(SILENT)) return this.finish(r, now, "silent", null);
    const failed = text.startsWith(CRON_FAILURE);
    const body = failed ? text.slice(CRON_FAILURE.length).trim() : text;
    await this.deps.notifier.notifyUser({ title: failed ? t("„{name}“ – nicht erledigt", { name: r.name }) : r.name, text: body, deliver, scheduleId: r.id });
    return this.finish(r, now, failed ? "failed" : "ok", body);
  }
}
