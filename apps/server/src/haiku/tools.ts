// Werkzeuge von Haiku. EINE Liste, jedes Werkzeug nennt die Umfänge (`scopes`), in denen es
// existiert. Die Prüfung passiert HIER auf dem Server (nicht im Prompt): ein Lauf mit Umfang
// "idealink" kann andere Werkzeuge weder sehen (`listFor`) noch aufrufen (`call` → Fehler), egal was
// im Prompt steht oder was das Modell versucht (Prompt-Injection-fest).
import { groupBuildRuns, IDEA_LINK_TOOLS, t, uncommittedCaption, type BuildGroup, type BuildRunRow, type HaikuCallKind, type HaikuSource, type NyxChannel, dateTimeFormat, timeZone } from "@nyxos/shared";
import { and, desc, eq, gte, ilike, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { approvals, buildRuns, inboxItems, sessions } from "../db/schema.js";
import type { ToolDef, ToolScope } from "./engine.js";
import { countIdeaCreated, reserveIdeaSlot } from "../idealink/store.js";
import { createInboxItem, ESCALATIONS, PLAN_OPTIONS, YES_NO } from "./inbox.js";
import { loadHaikuSettings } from "./settings.js";
import { ref, resolveSource, sessionHref } from "./sources.js";
import { sessionTitle, takeSnapshot } from "../overview/snapshot.js";
import { visibleSession } from "../db/visible.js";
import { APPROVAL_TRUTH } from "../nyx/honesty.js";
import { latestActivityView, loadLatestActivity } from "./latestActivity.js";
import { getUncommittedTotals, getVisibleRepos } from "../git/dashboard.js";

/** Ideen-Ablage (P4 `entries` mit kind "idee"). Als Schnittstelle, damit W-4 ohne P4-Code testbar bleibt. */
export interface IdeaRepo {
  search(text: string, limit: number): Promise<{ title: string; stage: string; createdAt: string }[]>;
  create(input: { title: string; description: string; origin: string; sourceKey: string }): Promise<{ id: number; title: string; stage: string }>;
}

export interface ToolContext {
  db: Db;
  scope: ToolScope;
  /** Nur bei scope "idealink": vom SERVER gesetzt (aus dem Link), nie aus Modell-Eingaben. */
  ideaLink: { id: number; name: string; conversationId: string } | null;
  ideas: IdeaRepo | null;
  /** Zusätzliche Werkzeuge anderer Phasen – gleiche Prüfung. */
  onInboxChange?: () => void;
  /** Faden/Nachricht/Art des Laufs – vom SERVER gesetzt (Herkunft im Gedächtnis, To-do je Faden,
   * keine neuen Pläne aus einem geplanten Lauf heraus). Nie aus Modell-Eingaben. */
  threadId?: number | null;
  messageId?: number | null;
  kind?: HaikuCallKind;
  /** app_api: Kanal, über den der Nutzer selbst gefragt hat – vom SERVER gesetzt (nur Nyx-Runden). Fehlt er
   * (geplante Aufgabe, Verdichtung, Knöpfe), dürfen Werkzeuge nur lesen. */
  channel?: NyxChannel | null;
  callId?: number;
}

export interface ToolSpec<A = unknown> {
  name: string;
  description: string;
  scopes: ToolScope[];
  input: z.ZodType<A>;
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
}

export class ToolDeniedError extends Error {
  constructor(name: string, scope: ToolScope) {
    super(`Werkzeug „${name}“ ist im Umfang „${scope}“ nicht erlaubt`);
  }
}

export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec<never>>();
  /** Demo: only these tools exist for every scope (null = no limit). Applies to tools registered later, too. */
  private allowOnly: ReadonlySet<string> | null = null;

  /** Limits every scope to `names` (the demo: read-only tools only). */
  limitTo(names: Iterable<string>): this {
    this.allowOnly = new Set(names);
    return this;
  }

  register<A>(spec: ToolSpec<A>): this {
    this.specs.set(spec.name, spec as unknown as ToolSpec<never>);
    return this;
  }

  namesFor(scope: ToolScope): string[] {
    const names = [...this.specs.values()].filter((s) => s.scopes.includes(scope) && (!this.allowOnly || this.allowOnly.has(s.name))).map((s) => s.name);
    // Harte zweite Sperre für W-4: selbst ein falsch registriertes Werkzeug kommt nie in "idealink".
    return scope === "idealink" ? names.filter((n) => (IDEA_LINK_TOOLS as readonly string[]).includes(n)) : names;
  }

  listFor(scope: ToolScope): ToolDef[] {
    return this.namesFor(scope).map((name) => {
      const s = this.specs.get(name) as ToolSpec<never>;
      const schema = z.toJSONSchema(s.input as z.ZodType) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: s.description, inputSchema: schema };
    });
  }

  async call(scope: ToolScope, name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    if (!this.namesFor(scope).includes(name)) throw new ToolDeniedError(name, scope);
    const spec = this.specs.get(name) as unknown as ToolSpec<unknown>;
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`Ungültige Eingabe: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300)}`);
    return spec.handler(parsed.data, { ...ctx, scope });
  }
}

const STATES = ["running", "waiting", "idle", "crashed", "closed"] as const;
const STATE_DE: Record<string, string> = { running: "läuft", waiting: "wartet auf den Nutzer", idle: "ruht", crashed: "abgestürzt", closed: "geschlossen" };

/** Zeit in der Zeitzone des Nutzers, damit Haiku nicht mit UTC-Zeiten rechnet („seit gestern Nacht“-Fehler). */
export function localStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dateTimeFormat({ weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Aktionen, die nur der Nutzer freigibt – Haiku legt sie als Freigabe-Karte an (`freigabe_anfragen`). */
export const FREIGABE_AKTIONEN = ["push", "merge", "deploy", "migration", "loeschen", "session_schliessen", "session_pausieren", "sonstiges"] as const;
export const FREIGABE_OPTIONS = [
  { id: "freigeben", label: "Freigeben" },
  { id: "ablehnen", label: "Ablehnen" },
];

/** Session-Kennung aus dem, was Haiku schreibt: „[[session:claude:x]]“, „session:claude:x“ oder „claude:x“/UUID.
 * Prüfstand-Fund: Haiku ließ oft nur die Klammern weg → „Session nicht gefunden“, Zusammenfassung scheiterte. */
export function sessionKeyOf(s: string): string {
  return s
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/^session:/, "");
}

/** Beginn eines Zeitraums in Zeitzone des Nutzers (heute = seit 0 Uhr), als SQL-Ausdruck. */
export function sinceSql(span: "heute" | "gestern" | "7tage") {
  const days = span === "heute" ? 0 : span === "gestern" ? 1 : 7;
  return sql`((date_trunc('day', now() at time zone ${timeZone()}) - make_interval(days => ${days})) at time zone ${timeZone()})`;
}

/** Zeilen aus `db.execute` (PGlite liefert `{ rows }`, postgres-js ein Array). */
export function rowsOf(r: unknown): Record<string, unknown>[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/**
 * offene Freigabe-Karten aus `freigabe_anfragen` (Inbox, Fingerabdruck „freigabe:…“). Sie zählen für
 * Nyx genauso als offene Freigabe wie ein blockierter Befehl – in `lage`, `freigaben_liste` und der Prüfstand-Wahrheit.
 */
export const APPROVAL_CARD_FINGERPRINT = "freigabe:%";
export async function countOpenApprovalCards(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(and(eq(inboxItems.status, "open"), like(inboxItems.fingerprint, APPROVAL_CARD_FINGERPRINT)));
  return Number(r?.n ?? 0);
}

function short(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function buildDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();

  // Prüfstand: vorher nur Text + Zustand, höchstens 30 Treffer und keine Gesamtzahl — Haiku zählte
  // dann die (gekürzte) Liste ab und nannte falsche Zahlen. Jetzt: Filter wie im Überblick, `gesamt` immer
  // exakt, Sortierung wählbar, Tokens und Zweig dabei.
  reg.register({
    name: "sessions_suchen",
    description:
      "Sucht Claude-/Codex-Sessions. Filter: text (Titel/Ordner), zustand, werkzeug (claude/codex), baustelle, art, aktivSeit (heute/gestern/7tage). sortierung: zuletzt (Standard), tokens (meiste zuerst), wartet_am_laengsten. `gesamt` ist die EXAKTE Zahl aller Treffer – für „wie viele“ immer `gesamt` nennen, nie die Liste abzählen. Offene Zustände zählen wie im Überblick (ohne geschlossene, ohne Sub-Agenten).",
    scopes: ["full"],
    input: z.object({
      text: z.string().max(200).optional(),
      zustand: z.enum(STATES).optional(),
      werkzeug: z.enum(["claude", "codex"]).optional(),
      baustelle: z.string().max(200).optional(),
      art: z.string().max(60).optional(),
      aktivSeit: z.enum(["heute", "gestern", "7tage"]).optional(),
      sortierung: z.enum(["zuletzt", "tokens", "wartet_am_laengsten"]).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    handler: async (a, { db }) => {
      const conds = [sql`${sessions.parentId} is null`, visibleSession];
      // HB: geschlossen = closed_at gesetzt (der Zustand kann danach noch „wartet“ lauten, s. Überblick).
      if (a.zustand === "closed") conds.push(sql`(${sessions.closedAt} is not null or ${sessions.state} = 'closed')`);
      else if (a.zustand) conds.push(and(eq(sessions.state, a.zustand), sql`${sessions.closedAt} is null`) ?? sql`false`);
      if (a.werkzeug) conds.push(eq(sessions.tool, a.werkzeug));
      if (a.baustelle) conds.push(or(ilike(sessions.categoryBaustelleLabel, `%${a.baustelle}%`), ilike(sessions.categoryBaustelleSlug, `%${a.baustelle}%`)) ?? sql`true`);
      if (a.art) conds.push(ilike(sessions.categoryArt, a.art));
      if (a.text) conds.push(or(ilike(sessions.title, `%${a.text}%`), ilike(sessions.cwd, `%${a.text}%`), ilike(sessions.sessionId, `${a.text}%`)) ?? sql`true`);
      if (a.aktivSeit) conds.push(sql`${sessions.lastActivityAt} >= ${sinceSql(a.aktivSeit)}`);
      const where = and(...conds);
      const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(sessions).where(where)) as [{ n: number }];
      const order =
        a.sortierung === "tokens" ? [desc(sessions.tokensTotal)] : a.sortierung === "wartet_am_laengsten" ? [sql`${sessions.lastActivityAt} asc nulls last`] : [sql`${sessions.lastActivityAt} desc nulls last`];
      const rows = await db
        .select({ id: sessions.id, title: sessions.title, sid: sessions.sessionId, state: sessions.state, tool: sessions.tool, art: sessions.categoryArt, baustelle: sessions.categoryBaustelleLabel, last: sessions.lastActivityAt, tokens: sessions.tokensTotal, branch: sessions.gitBranch, closedAt: sessions.closedAt })
        .from(sessions)
        .where(where)
        .orderBy(...order, sessions.id)
        .limit(a.limit ?? 15);
      return {
        gesamt: n,
        gezeigt: rows.length,
        sessions: rows.map((r) => ({ ref: ref("session", r.id), titel: short(sessionTitle({ title: r.title, sessionId: r.sid, lastActivityAt: r.last }), 120), zustand: r.closedAt ? STATE_DE.closed : (STATE_DE[r.state ?? ""] ?? "beendet"), werkzeug: r.tool, art: r.art, baustelle: r.baustelle, zweig: r.branch, tokens: r.tokens, zuletzt: localStamp(r.last) })),
      };
    },
  });

  reg.register({
    name: "lage",
    description:
      "Die Lage JETZT, mit genau den Zahlen des Überblicks: offene Sessions je Zustand (läuft/wartet/ruht/abgestürzt, mit Liste), offene Freigaben, Inbox-Punkte, offene Build-Fehler, startklare Aufgaben, heute aktive/geschlossene Sessions, Sessions gesamt je Werkzeug. `wartet` zählt ohne verwaiste Sessions (die stehen unter `verwaist`); „offene Fragen“ = `offene_fragen` (ohne Sortier-Vorschläge, die stehen in `sortier_vorschlaege`). Für „Was ist los?“ und fast jede „Wie viele …?“-Frage zuerst dieses Werkzeug.",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      const snap = await takeSnapshot(db);
      const cards = await countOpenApprovalCards(db);
      //: ohne Titel „Session vom 24.09., 20:02“ wie Überblick/Briefing – nie nur die Kennung.
      const list = (rows: typeof snap.waiting) => rows.slice(0, 10).map((s) => ({ ref: ref("session", s.id), titel: short(sessionTitle(s), 100), werkzeug: s.tool, zuletzt: localStamp(s.lastActivityAt) }));
      const today = sinceSql("heute");
      const [todayRow] = (await db.execute(sql`
        select
          count(*) filter (where last_activity_at >= ${today})::int as aktiv,
          count(*) filter (where last_activity_at >= ${today} and tool = 'claude')::int as aktiv_claude,
          count(*) filter (where last_activity_at >= ${today} and tool = 'codex')::int as aktiv_codex,
          count(*) filter (where closed_at >= ${today})::int as geschlossen,
          count(*) filter (where tool = 'claude')::int as claude,
          count(*) filter (where tool = 'codex')::int as codex
        from sessions where parent_id is null`).then(rowsOf)) as [Record<string, number>];
      return {
        stand: localStamp(snap.at),
        satz: snap.lage,
        laeuft: { anzahl: snap.counts.running, sessions: list(snap.running) },
        wartet: { anzahl: snap.counts.waiting, sessions: list(snap.waiting), hinweis: "Liste: zuletzt aktive zuerst; ohne verwaiste" },
        // verwaiste Geister-Sessions (wartet > 1 Tag, nie eine Nachricht) zählen NICHT als „wartet“.
        verwaist: { anzahl: snap.orphaned.length, sessions: list(snap.orphaned), hinweis: "nie benutzt, warten seit über einem Tag – Aufräum-Kandidaten, nicht „wartet auf dich“" },
        ruht: snap.counts.idle,
        abgestuerzt: { anzahl: snap.counts.crashed, sessions: list(snap.crashed) },
        offen_gesamt: snap.counts.running + snap.counts.waiting + snap.orphaned.length + snap.counts.idle + snap.counts.crashed,
        // dieselbe Zahl wie `freigaben_liste` – blockierte Befehle UND Freigabe-Karten (sonst
        // „Null offen“ direkt nach dem Anlegen einer Karte, weil Nyx für „Wie viele …?“ zuerst `lage` fragt).
        freigaben_offen: snap.pendingApprovals.length + cards,
        freigaben: { blockierte_befehle: snap.pendingApprovals.length, freigabe_karten: cards, hinweis: "Freigabe-Karten liegen in der Inbox und zählen auch in inbox_offen" },
        inbox_offen: snap.openInbox.length,
        // dieselbe Zahl wie der rote Zähler (Leiste, Überblick): Sortier-Vorschläge zählen extra.
        offene_fragen: snap.openQuestions.total,
        sortier_vorschlaege: snap.openQuestions.sorting ?? 0,
        build_fehler_offen: snap.redBuilds.length,
        startklare_aufgaben: snap.counts.startklar,
        heute: { aktiv: todayRow?.aktiv ?? 0, aktiv_claude: todayRow?.aktiv_claude ?? 0, aktiv_codex: todayRow?.aktiv_codex ?? 0, geschlossen: todayRow?.geschlossen ?? 0 },
        sessions_gesamt: { claude: todayRow?.claude ?? 0, codex: todayRow?.codex ?? 0, hinweis: "ohne Sub-Agenten" },
      };
    },
  });

  reg.register({
    name: "sessions_zaehlen",
    description:
      "Zählt Sessions gruppiert: nach baustelle, art, werkzeug, modell oder zustand (meiste zuerst). Optional nur aktivSeit (heute/gestern/7tage) oder nurOffen. Für „Welche Baustelle/Art/welches Modell hat die meisten …?“. `gesamt` = Zahl der Sessions (exakt), `gruppen_gesamt` = Zahl aller Gruppen (die Liste zeigt höchstens 15).",
    scopes: ["full"],
    input: z.object({ nach: z.enum(["baustelle", "art", "werkzeug", "modell", "zustand"]), aktivSeit: z.enum(["heute", "gestern", "7tage"]).optional(), nurOffen: z.boolean().optional() }),
    handler: async (a, { db }) => {
      const conds = [sql`parent_id is null`];
      if (a.aktivSeit) conds.push(sql`last_activity_at >= ${sinceSql(a.aktivSeit)}`);
      if (a.nurOffen) conds.push(sql`closed_at is null and state in ('running','waiting','idle','crashed')`);
      const where = sql.join(conds, sql` and `);
      const col = { baustelle: sql`category_baustelle_label`, art: sql`category_art`, werkzeug: sql`tool`, zustand: sql`case when closed_at is not null then 'closed' else state end`, modell: sql`m` }[a.nach];
      const from = a.nach === "modell" ? sql`sessions, jsonb_array_elements_text(models) as m` : sql`sessions`;
      // `gruppen_gesamt` (vor dem Kürzen auf 15) und `gesamt` (Sessions, nicht Summe der Gruppen – bei „modell“
      // zählt eine Session in mehreren Gruppen), sonst zählte Haiku wieder eine gekürzte Liste ab.
      const rows = await db.execute(sql`select ${col} as name, count(*)::int as n, count(*) over ()::int as groups from ${from} where ${where} group by 1 order by 2 desc, 1 limit 15`).then(rowsOf);
      const [total] = await db.execute(sql`select count(*)::int as n from sessions where ${where}`).then(rowsOf);
      return {
        gesamt: Number(total?.n ?? 0),
        gruppen_gesamt: Number(rows[0]?.groups ?? 0),
        gruppen: rows.map((r) => ({ name: a.nach === "zustand" ? (STATE_DE[String(r.name)] ?? "beendet") : (r.name ?? "ohne"), anzahl: Number(r.n) })),
      };
    },
  });

  // „Was war die letzte Session / letzte Änderung? Woran wurde zuletzt gearbeitet?“ – genaue Daten in einem Zug.
  reg.register({
    name: "letzte_aktivitaet",
    description:
      "Für „Was war die letzte Session?“, „Was war die letzte Änderung / der letzte Commit?“, „Woran wurde zuletzt gearbeitet?“: jüngste Session (Titel, Werkzeug, Projekt, Zweig, Zustand, zuletzt aktiv, zuletzt gefragt/geantwortet) und jüngster Commit (Nachricht, Repo, Zweig, Zeit, Autor, Umfang), plus fertige Sätze satz_session/satz_aenderung. sessions/commits = wie viele insgesamt (Standard 3).",
    scopes: ["full"],
    input: z.object({ sessions: z.number().int().min(1).max(10).optional(), commits: z.number().int().min(1).max(10).optional() }),
    handler: async (a, { db }) => latestActivityView(await loadLatestActivity(db, { sessions: a.sessions ?? 3, commits: a.commits ?? 3 }), new Date()),
  });

  reg.register({
    name: "git_lage",
    description: "Git-Stand: beobachtete Repos und Worktrees (Zweig), ungesicherte Dateien (dieselbe Zahl wie Überblick und Git-Seite), Commits heute (Anzahl über alle Repos) und die letzten Commits.",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      // dieselbe Auswahl wie Git-Seite und Überblick — gelöschte Worktrees zählen nicht mit.
      const visible = await getVisibleRepos(db);
      const repos = [...visible].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
      const unc = await getUncommittedTotals(db, visible);
      const [c] = await db.execute(sql`select count(distinct sha)::int as n from git_commits where coalesce(committed_at, author_date) >= ${sinceSql("heute")}`).then(rowsOf);
      const last = await db.execute(sql`select c.subject, c.branch, r.label, coalesce(c.committed_at, c.author_date) as at from git_commits c join git_repos r on r.id = c.repo_id order by at desc limit 5`).then(rowsOf);
      return {
        repos_gesamt: repos.length,
        worktrees: repos.filter((r) => r.kind === "worktree").length,
        repos: repos.slice(0, 20).map((r) => ({ name: r.label, art: r.kind, zweig: r.currentBranch })),
        ungesichert: { dateien: unc.files, in_repos: unc.repoFiles, in_worktrees: unc.worktreeFiles, text: uncommittedCaption(unc) },
        commits_heute: Number(c?.n ?? 0),
        letzte_commits: last.map((r) => ({ titel: short(String(r.subject), 100), repo: r.label, zweig: r.branch, zeit: localStamp(r.at instanceof Date ? r.at.toISOString() : String(r.at)) })),
      };
    },
  });

  reg.register({
    name: "nachtlaeufe",
    description: "Nachtläufe (Nachtmodus): eingeplante, laufende und die letzten fertigen.",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      const rows = await db.execute(sql`select id, title, status, runs_on, started_at, ended_at from night_runs order by id desc limit 20`).then(rowsOf);
      const count = (s: string) => rows.filter((r) => r.status === s).length;
      return {
        eingeplant: count("queued"),
        laufen: count("running"),
        laeufe: rows.slice(0, 10).map((r) => ({ ref: ref("night", String(r.id)), titel: r.title, status: r.status, nacht: r.runs_on })),
      };
    },
  });

  reg.register({
    name: "freigabe_anfragen",
    description:
      "Für alles, was NUR der Nutzer freigeben darf (Push, Merge in main, Deploy, Migration, Löschen, Session schließen, Sessions pausieren): NICHT ablehnen und NICHT so tun, als wäre es erledigt – hiermit als Freigabe-Karte in die Inbox legen. Der Nutzer entscheidet mit einem Klick. Sessions als ref-IDs mitgeben, wenn es um bestimmte Sessions geht.",
    scopes: ["full"],
    input: z.object({
      aktion: z.enum(FREIGABE_AKTIONEN),
      titel: z.string().min(3).max(200),
      begruendung: z.string().max(1500).optional(),
      sessions: z.array(z.string().max(200)).max(30).optional(),
    }),
    handler: async (a, { db, onInboxChange }) => {
      const keys = (a.sessions ?? []).map(sessionKeyOf);
      // HB: jede betroffene Session als anklickbare Quelle (nur echte, gegen die DB geprüft) —
      // vorher stand bei mehreren nur „Betrifft 2 Session(s)“, ohne welche.
      const sources: HaikuSource[] = [];
      for (const k of keys) {
        const src = await resolveSource(db, "session", k);
        if (src && !sources.some((s) => s.id === src.id)) sources.push(src);
      }
      const body = [a.begruendung, keys.length ? t("Betrifft {n} Session(s).", { n: keys.length }) : null].filter(Boolean).join("\n\n") || null;
      const { item, created } = await createInboxItem(db, {
        kind: "frage",
        title: t("Freigabe: {label}", { label: a.titel }),
        body,
        options: FREIGABE_OPTIONS,
        sources,
        sessionKey: sources.length === 1 ? (sources[0]?.id ?? null) : null,
        createdBy: "haiku",
        estimateMinutes: 1,
        fingerprint: `freigabe:${a.aktion}:${keys.join(",")}:${a.titel.toLowerCase().trim()}`,
      });
      if (created) onInboxChange?.();
      return {
        ref: ref("inbox", item.id),
        angelegt: created,
        hinweis: "Liegt jetzt als Freigabe in der Inbox. Ausgeführt ist nichts – auch „Freigeben“ hält nur seine Entscheidung fest, die Aktion selbst macht der Nutzer bzw. die Session. Versprich nicht, dass danach etwas von allein läuft.",
        // (Prüfstand L5/L9): der Satz, den Nyx sagen soll – wörtlich.
        sag_so: `Die Freigabe-Karte liegt in der Inbox. ${APPROVAL_TRUTH}`,
      };
    },
  });

  reg.register({
    name: "session_lesen",
    description: "Details einer Session (Zustand, Ordner, Zweig, Modelle, Tokens, geänderte Dateien). Eingabe: ref-ID ohne Klammern oder Session-UUID.",
    scopes: ["full"],
    input: z.object({ session: z.string().min(1).max(200) }),
    handler: async (a, { db }) => {
      const key = sessionKeyOf(a.session);
      const [r] = await db.select().from(sessions).where(or(eq(sessions.id, key), eq(sessions.sessionId, key))).limit(1);
      if (!r) return { fehler: "Session nicht gefunden" };
      return {
        ref: ref("session", r.id),
        titel: sessionTitle(r),
        zustand: STATE_DE[r.state ?? ""] ?? "beendet",
        ordner: r.cwd,
        zweig: r.gitBranch,
        gestartet: localStamp(r.startedAt),
        zuletzt: localStamp(r.lastActivityAt),
        modelle: r.models,
        tokens: r.tokensTotal,
        art: r.categoryArt,
        baustelle: r.categoryBaustelleLabel,
        link: sessionHref(r),
      };
    },
  });

  reg.register({
    name: "freigaben_liste",
    description:
      "Alle offenen Freigaben: blockierte Befehle aus Auftrags-Sessions (D6) UND die Freigabe-Karten in der Inbox (auch die von freigabe_anfragen). `anzahl_offen` ist die Summe (dieselbe Zahl wie freigaben_offen in lage), die Listen sind auf 30 gekürzt. Nur der Nutzer kann freigeben.",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      const rows = await db.select().from(approvals).where(eq(approvals.status, "pending")).orderBy(desc(approvals.createdAt)).limit(30);
      // Die Karte aus `freigabe_anfragen` liegt in der Inbox (Fingerabdruck „freigabe:…“) – vorher
      // meldete Nyx direkt nach dem Anlegen „Null offene Freigaben“.
      const cards = await db
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.status, "open"), like(inboxItems.fingerprint, APPROVAL_CARD_FINGERPRINT)))
        .orderBy(desc(inboxItems.createdAt))
        .limit(30);
      // echte Anzahl, nicht die Länge der gekürzten Listen.
      const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, "pending"));
      return {
        anzahl_offen: Number(pending?.n ?? 0) + (await countOpenApprovalCards(db)),
        blockierte_befehle: rows.map((r) => ({ ref: ref("approval", r.id), regel: r.rule, befehl: short(r.command, 200), grund: r.reason, session: r.sessionKey ? ref("session", r.sessionKey) : null, seit: localStamp(r.createdAt) })),
        freigabe_karten: cards.map((c) => ({ ref: ref("inbox", c.id), titel: c.title, seit: localStamp(c.createdAt) })),
      };
    },
  });

  reg.register({
    name: "inbox_liste",
    description: "Offene Punkte der Entscheidungs-Inbox (Fragen, Pläne, Eskalationen).",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      const rows = await db.select().from(inboxItems).where(eq(inboxItems.status, "open")).orderBy(desc(inboxItems.createdAt)).limit(30);
      return rows.map((r) => ({ ref: ref("inbox", r.id), art: r.kind, titel: r.title, optionen: (r.options as { label: string }[]).map((o) => o.label), eskalation: r.escalation }));
    },
  });

  reg.register({
    name: "frage_stellen",
    description:
      "Legt eine Frage für den Nutzer in die Entscheidungs-Inbox. Nur wenn die Antwort NICHT in ENTSCHEIDUNGEN.md oder im Auftrag steht. Ja/Nein-Fragen mit jaNein=true. Eskalationsfälle: produkt, datenverlust, budget, build_rot, fremder_bereich.",
    scopes: ["full"],
    input: z.object({
      titel: z.string().min(3).max(200),
      text: z.string().max(2000).optional(),
      jaNein: z.boolean().optional(),
      optionen: z.array(z.string().min(1).max(120)).max(5).optional(),
      session: z.string().max(200).optional(),
      eskalation: z.enum(ESCALATIONS).optional(),
      minuten: z.number().int().min(1).max(120).optional(),
    }),
    handler: async (a, { db, onInboxChange }) => {
      const options = a.jaNein ? YES_NO : (a.optionen ?? []).map((label, i) => ({ id: `o${i + 1}`, label }));
      const sessionKey = a.session ? sessionKeyOf(a.session) : null;
      const { item, created } = await createInboxItem(db, {
        kind: a.eskalation ? "eskalation" : "frage",
        title: a.titel,
        body: a.text ?? null,
        options,
        sessionKey,
        createdBy: "haiku",
        escalation: a.eskalation ?? null,
        estimateMinutes: a.minuten,
        fingerprint: `haiku:${sessionKey ?? "-"}:${a.titel.toLowerCase().trim()}`,
      });
      if (created) onInboxChange?.();
      return { ref: ref("inbox", item.id), angelegt: created };
    },
  });

  reg.register({
    name: "plan_vorschlagen",
    description: "Schlägt der Nutzer einen Plan vor (z. B. „heute Nacht A02“). Erscheint als Karte mit „Ändern“/„Freigeben“. Nichts startet ohne Freigabe.",
    scopes: ["full"],
    input: z.object({ titel: z.string().min(3).max(200), text: z.string().min(1).max(3000), schritte: z.array(z.string().max(300)).max(10).optional() }),
    handler: async (a, { db, onInboxChange }) => {
      const body = a.schritte?.length ? `${a.text}\n\n${a.schritte.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : a.text;
      const { item, created } = await createInboxItem(db, { kind: "plan", title: a.titel, body, options: PLAN_OPTIONS, createdBy: "haiku", estimateMinutes: 1, fingerprint: `plan:${a.titel.toLowerCase().trim()}` });
      if (created) onInboxChange?.();
      return { ref: ref("inbox", item.id), angelegt: created };
    },
  });

  reg.register({
    name: "builds_liste",
    description: "Letzte Build-/Test-Läufe (Build-Wächter), gleiche Fehler gebündelt (anzahl). nurRot = die offenen Fehler, genau wie im Überblick (24 Std, behobene fehlen).",
    scopes: ["full"],
    input: z.object({ nurRot: z.boolean().optional() }),
    handler: async (a, { db }) => {
      const toDto = (g: BuildGroup) => ({ ref: ref("build", g.lastId), art: g.kind, status: g.state, anzahl: g.count, satz: g.sentence, seit: localStamp(g.firstAt), zuletzt: localStamp(g.lastAt) });
      // BC: „offene Fehler“ genau wie Überblick, Briefing und „Braucht dich“ (Schnappschuss: 24 h,
      // gebündelt, im selben Ordner wieder grün = behoben) — vorher 3 Tage ohne Aufräumen, Haiku nannte
      // dann Fehler, die überall sonst längst behoben waren.
      if (a.nurRot) return (await takeSnapshot(db)).redBuilds.slice(0, 20).map(toDto);
      const since = new Date(Date.now() - 3 * 86400_000).toISOString();
      const rows = await db.select().from(buildRuns).where(gte(buildRuns.startedAt, since)).orderBy(desc(buildRuns.startedAt)).limit(200);
      // gebündelt wie in „Braucht dich“ — alte „spawn … ENOENT“-Läufe gelten als „nicht eingerichtet“.
      return groupBuildRuns(rows as BuildRunRow[])
        .slice(0, 20)
        .map(toDto);
    },
  });

  // ─── W-4: die EINZIGEN Werkzeuge der Ideen-Link-Seite ───
  reg.register({
    name: "ideen_suchen",
    description: "Sucht, ob es eine Idee schon gibt. Liefert nur Titel, Stand und Datum – sonst nichts.",
    scopes: ["idealink", "full"],
    input: z.object({ text: z.string().min(2).max(200) }),
    handler: async (a, { ideas }) => {
      if (!ideas) return { fehler: "Ideen-Ablage gerade nicht verfügbar" };
      const hits = await ideas.search(a.text, 8);
      return hits.map((h) => ({ titel: h.title, stand: h.stage, seit: h.createdAt.slice(0, 10) }));
    },
  });

  reg.register({
    name: "idee_anlegen",
    description: "Legt eine NEUE Idee im Eingang an (nur wenn es sie noch nicht gibt). Titel kurz, Beschreibung in den Worten der Person.",
    scopes: ["idealink", "full"],
    input: z.object({ titel: z.string().min(3).max(120), beschreibung: z.string().min(3).max(2000) }),
    handler: async (a, { db, ideas, ideaLink }) => {
      if (!ideas) return { fehler: "Ideen-Ablage gerade nicht verfügbar" };
      //: Obergrenze je Link und Tag + global – serverseitig, atomar reserviert.
      if (ideaLink) {
        const s = await loadHaikuSettings(db);
        const ok = await reserveIdeaSlot(db, ideaLink.id, { perLink: s.ideaLinkIdeasPerLinkDay, global: s.ideaLinkIdeasPerDay });
        if (!ok) return { angelegt: false, hinweis: "Für heute sind hier genug Ideen eingegangen. Sag freundlich: morgen gerne wieder." };
      }
      // Herkunft kommt IMMER vom Server (Link-Name), nie aus der Modell-Eingabe.
      const origin = ideaLink ? `Link: ${ideaLink.name}` : "Haiku";
      const sourceKey = ideaLink ? `${ideaLink.id}:${ideaLink.conversationId}:${a.titel.toLowerCase().trim()}` : `haiku:${a.titel.toLowerCase().trim()}`;
      const created = await ideas.create({ title: a.titel, description: a.beschreibung, origin, sourceKey });
      if (ideaLink) await countIdeaCreated(db, ideaLink.id);
      return { angelegt: true, titel: created.title, stand: created.stage };
    },
  });

  return reg;
}

/** Nur für Tests/Übersicht: welche Werkzeuge ein Umfang sieht. */
export function scopeTools(reg: ToolRegistry, scope: ToolScope): string[] {
  return reg.namesFor(scope);
}

