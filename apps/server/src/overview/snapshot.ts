// EIN Schnappschuss der Lage „jetzt“ — Quelle für Überblick-Kopf, Kacheln, „Kritische Sessions“,
// Briefing/Recap (Sätze + „Braucht dich“/„Läuft ohne dich“) und den Haiku-Rundgang. Vorher zählte jede
// Stelle selbst (Kopf ohne Grenze, „Braucht dich“ 24 h, Briefing seit gestern 0 Uhr, Sub-Agenten mal
// mit, mal ohne) — daher „1 läuft, 2 warten“ neben „Keine Session läuft, nichts braucht dich“.
//
// Regeln (überall gleich):
// - Nur Haupt-Sessions (keine Sub-Agenten), nicht geschlossen, nicht archiviert (`db/visible.ts`).
// - „abgestürzt“ = Zustand `crashed` — der gilt dank C1 nur bis zur Altersgrenze (Einstellung).
// - Build-Fehler = rote Gruppen der letzten 24 h, ohne die, die im selben Ordner schon wieder grün sind.
// - „verwaist“ (wartet > 1 Tag, nie eine Nachricht, `isOrphanedSession`) zählt NICHT als „wartet“ –
//   dieselbe Regel wie in der Web-App. Namen überall aus `sessionLabel` (nie eine Kennung).
// - gleiche Sortier-Vorschläge von Nyx sind EIN Eintrag und zählen nicht in die roten offenen Fragen.
import { BUILD_KIND_LABEL, bundleInboxItems, formatBuildCount, isOrphanedSession, sessionLabel, situationSentence, t, type BuildGroup, type HaikuSource, type InboxItem, type OpenQuestionCounts, type OverviewCounts, type PendingDeliveries, type ReportItem } from "@nyxos/shared";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { pendingApprovalSql } from "../approvals/store.js";
import { recentBuildGroups } from "../builds/notify.js";
import { conflictModelFor } from "../conflicts/model.js";
import type { Db } from "../db/client.js";
import { approvals, entries, inboxItems, sessionDeliveries, sessions } from "../db/schema.js";
import { countedSession } from "../db/visible.js";
import { toInboxItem } from "../haiku/inbox.js";
import { sessionHref } from "../haiku/sources.js";

/** Fenster, in dem rote Builds als „offen“ gelten (wie die Push-Bündelung). */
export const BUILD_WINDOW_MS = 24 * 3600_000;

export interface SnapSession {
  id: string;
  sessionId: string;
  title: string | null;
  tool: string;
  state: string | null;
  categoryArt: string | null;
  categoryBaustelleSlug: string | null;
  lastActivityAt: string | null;
  /** für den Namen (`sessionLabel`) – optional, weil nicht jede Abfrage alles liest. */
  titleSource?: string | null;
  cwd?: string | null;
  categoryBaustelleLabel?: string | null;
  startedAt?: string | null;
}

export interface LiveSnapshot {
  at: string;
  counts: OverviewCounts;
  lage: string;
  /** Jüngste Aktivität zuerst. */
  running: SnapSession[];
  waiting: SnapSession[];
  /** leere Geister-Sessions (wartet > 1 Tag, keine Nachricht) – nicht in `waiting`/`counts.waiting`. */
  orphaned: SnapSession[];
  crashed: SnapSession[];
  pendingApprovals: { id: number; rule: string; command: string; reason: string | null }[];
  /** offene Fragen (Freigaben + Entscheidungs-Karten + lebende Konflikt-Fragen), exakt gezählt. */
  openQuestions: OpenQuestionCounts;
  /** Dateien mit Konflikt zwischen lebenden Sessions (Kachel „Konflikte“). */
  activeConflicts: number;
  /** Zustell-Warteschlange (Kachel-Zeile im Überblick, Abschnitt „Betrieb“). */
  pendingDeliveries: PendingDeliveries;
  openInbox: InboxItem[];
  redBuilds: BuildGroup[];
  needsYou: ReportItem[];
  runsWithoutYou: ReportItem[];
  fingerprint: string;
}

const STATES = ["running", "waiting", "idle", "crashed"] as const;

type TitleInput = Pick<SnapSession, "title"> &
  Partial<Pick<SnapSession, "sessionId" | "tool" | "titleSource" | "cwd" | "categoryBaustelleLabel" | "startedAt" | "lastActivityAt">>;
/** nie eine Kennung statt eines Titels – EIN Name wie in der Web-App (`sessionLabel`). */
export const sessionTitle = (s: TitleInput) =>
  sessionLabel({
    title: s.title,
    titleSource: s.titleSource ?? null,
    tool: s.tool ?? null,
    cwd: s.cwd ?? null,
    baustelleLabel: s.categoryBaustelleLabel ?? null,
    startedAt: s.startedAt ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
  });
export const sessionSource = (r: Pick<SnapSession, "id" | "sessionId" | "title" | "categoryArt" | "categoryBaustelleSlug"> & TitleInput): HaikuSource => ({ kind: "session", id: r.id, label: sessionTitle(r), href: sessionHref(r) });

/** Definition „offene Frage“ — nur, was der Nutzer selbst entscheiden kann. */
export async function countOpenQuestions(db: Db, now = new Date()): Promise<OpenQuestionCounts> {
  const [a, open, model] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(pendingApprovalSql(now)),
    db.select({ id: inboxItems.id, title: inboxItems.title, sessionKey: inboxItems.sessionKey }).from(inboxItems).where(eq(inboxItems.status, "open")),
    conflictModelFor(db).get(),
  ]);
  // (Audit Punkt 3): Sortier-Vorschläge gebündelt und getrennt gezählt – sie sind Kleinkram und
  // sollen nicht mit einer roten Zahl locken.
  const bundles = bundleInboxItems(open);
  const sorting = bundles.filter((b) => b.type === "sort").length;
  const q = { approvals: a[0]?.n ?? 0, inbox: bundles.length - sorting, conflicts: model.summary.totals.openDecisions };
  return { ...q, sorting, total: q.approvals + q.inbox + q.conflicts };
}

/** wartende (oder gerade gesendete), nicht abgelaufene Zustellungen – je Session, älteste zuerst. */
async function pendingDeliveriesOf(db: Db, now: Date): Promise<PendingDeliveries> {
  const rows = await db
    .select({
      sessionId: sessions.sessionId,
      title: sessions.title,
      titleSource: sessions.titleSource,
      tool: sessions.tool,
      cwd: sessions.cwd,
      startedAt: sessions.startedAt,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      categoryBaustelleLabel: sessions.categoryBaustelleLabel,
      n: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${sessionDeliveries.createdAt})`,
    })
    .from(sessionDeliveries)
    .innerJoin(sessions, eq(sessions.id, sessionDeliveries.sessionKey))
    .where(and(inArray(sessionDeliveries.status, ["queued", "sending"]), gt(sessionDeliveries.expiresAt, now.toISOString())))
    .groupBy(sessions.id)
    .orderBy(asc(sql`min(${sessionDeliveries.createdAt})`), sessions.id);
  const first = rows[0];
  return {
    count: rows.reduce((sum, r) => sum + r.n, 0),
    sessions: rows.length,
    href: first ? sessionHref(first) : null,
    title: first ? sessionTitle(first) : null,
  };
}

export async function takeSnapshot(db: Db, now = new Date()): Promise<LiveSnapshot> {
  const [open, startklarRows, pend, inboxRows, builds, openQuestions, conflictModel, pendingDeliveries] = await Promise.all([
    db
      .select({
        id: sessions.id,
        sessionId: sessions.sessionId,
        title: sessions.title,
        tool: sessions.tool,
        state: sessions.state,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        lastActivityAt: sessions.lastActivityAt,
        titleSource: sessions.titleSource,
        cwd: sessions.cwd,
        categoryBaustelleLabel: sessions.categoryBaustelleLabel,
        startedAt: sessions.startedAt,
        parsedEventCount: sessions.parsedEventCount,
        tokensTotal: sessions.tokensTotal,
      })
      .from(sessions)
      .where(and(isNull(sessions.parentId), isNull(sessions.closedAt), countedSession, inArray(sessions.state, [...STATES])))
      .orderBy(desc(sessions.lastActivityAt), sessions.id),
    db.select({ n: sql<number>`count(*)::int` }).from(entries).where(eq(entries.stage, "startklar")),
    db.select({ id: approvals.id, rule: approvals.rule, command: approvals.command, reason: approvals.reason }).from(approvals).where(pendingApprovalSql(now)).orderBy(desc(approvals.createdAt)).limit(50),
    db.select().from(inboxItems).where(eq(inboxItems.status, "open")).orderBy(desc(inboxItems.createdAt)).limit(100),
    recentBuildGroups(db, new Date(now.getTime() - BUILD_WINDOW_MS)),
    countOpenQuestions(db, now),
    conflictModelFor(db).get(),
    pendingDeliveriesOf(db, now),
  ]);

  const nowMs = now.getTime();
  const snap = ({ parsedEventCount: _p, tokensTotal: _t, ...r }: (typeof open)[number]): SnapSession => r;
  const byState = (s: string) => open.filter((r) => r.state === s);
  const running = byState("running").map(snap);
  const orphaned = byState("waiting")
    .filter((r) => isOrphanedSession(r, nowMs))
    .map(snap);
  const waiting = byState("waiting")
    .filter((r) => !isOrphanedSession(r, nowMs))
    .map(snap);
  const crashed = byState("crashed").map(snap);
  const counts: OverviewCounts = {
    running: running.length,
    waiting: waiting.length,
    idle: byState("idle").length,
    crashed: crashed.length,
    startklar: startklarRows[0]?.n ?? 0,
  };
  const openInbox = inboxRows.map(toInboxItem);
  const redBuilds = builds.filter((g) => g.state === "red");

  const runsWithoutYou: ReportItem[] = [];
  const needsYou: ReportItem[] = [];
  for (const a of pend) {
    needsYou.push({
      id: `approval:${a.id}`,
      kind: "approval",
      title: t("Freigabe: {command}", { command: a.command.slice(0, 80) }),
      detail: a.reason,
      minutes: 1,
      zeroEnergy: true,
      href: `/inbox#approval-${a.id}`,
      sources: [{ kind: "approval", id: String(a.id), label: t("Freigabe #{id}", { id: a.id }), href: `/inbox#approval-${a.id}` }],
      action: { type: "approval", approvalId: a.id },
    });
  }
  for (const bundle of bundleInboxItems(openInbox)) {
    // mehrere gleiche Sortier-Vorschläge = EIN Eintrag (beantwortet wird gesammelt auf „Entscheidungen“).
    if (bundle.type === "sort" && bundle.items.length > 1) {
      const first = bundle.items[0];
      needsYou.push({
        id: `sort:${bundle.items.map((i) => i.id).join("+")}`,
        kind: "question",
        title: t("{n} Sessions nach „{target}“ sortieren?", { n: bundle.items.length, target: bundle.target }),
        detail: t("Vorschlag von Nyx: „{subject}“", { subject: bundle.subject }),
        minutes: 1,
        zeroEnergy: true,
        href: first ? `/inbox#inbox-${first.id}` : "/inbox",
        sources: bundle.items.map((i) => ({ kind: "inbox" as const, id: String(i.id), label: i.title.slice(0, 80), href: `/inbox#inbox-${i.id}` })),
        action: null,
      });
      continue;
    }
    const i = bundle.type === "item" ? bundle.item : bundle.items[0];
    if (!i) continue;
    const src: HaikuSource[] = [{ kind: "inbox", id: String(i.id), label: i.title.slice(0, 80), href: `/inbox#inbox-${i.id}` }];
    if (i.kind === "plan") {
      runsWithoutYou.push({ id: `inbox:${i.id}`, kind: "plan", title: i.title, detail: i.body, minutes: 0, zeroEnergy: true, href: `/inbox#inbox-${i.id}`, sources: src, action: { type: "inbox", inboxId: i.id, options: i.options } });
    } else {
      needsYou.push({ id: `inbox:${i.id}`, kind: "question", title: i.title, detail: i.body, minutes: i.estimateMinutes, zeroEnergy: i.yesNo && !i.escalation, href: `/inbox#inbox-${i.id}`, sources: src, action: { type: "inbox", inboxId: i.id, options: i.options } });
    }
  }
  for (const s of waiting) needsYou.push({ id: `session:${s.id}`, kind: "session", title: t("Wartet: {title}", { title: sessionTitle(s) }), detail: null, minutes: 5, zeroEnergy: false, href: sessionHref(s), sources: [sessionSource(s)], action: null });
  for (const s of crashed) needsYou.push({ id: `crashed:${s.id}`, kind: "crashed", title: t("Abgestürzt: {title}", { title: sessionTitle(s) }), detail: t("Neu starten oder schließen"), minutes: 2, zeroEnergy: false, href: sessionHref(s), sources: [sessionSource(s)], action: null });
  // ein Eintrag je Fehler (gleiches Projekt + gleiche Signatur) mit Zähler; oben ein Satz,
  // die Rohmeldung nur unter „Details“. „Nicht eingerichtet“ ist kein roter Build und steht hier nicht.
  for (const g of redBuilds.slice(0, 10)) {
    needsYou.push({
      id: `build:${g.lastId}`,
      kind: "build",
      title: g.headline,
      detail: `${g.sentence} · ${formatBuildCount(g)}`,
      rawDetail: g.details,
      count: g.count,
      minutes: 10,
      zeroEnergy: false,
      href: "/server",
      sources: [{ kind: "build", id: String(g.lastId), label: g.headline, href: "/server" }],
      action: null,
    });
  }
  // Null-Energie zuerst, dann nach Dauer (stabil: gleiche Dauer behält die Reihenfolge oben).
  needsYou.sort((a, b) => Number(b.zeroEnergy) - Number(a.zeroEnergy) || a.minutes - b.minutes);

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ counts, openQuestions, needs: needsYou.map((i) => [i.id, i.count ?? 1]), runs: runsWithoutYou.map((i) => i.id) }))
    .digest("hex")
    .slice(0, 16);

  return {
    at: now.toISOString(),
    counts,
    lage: situationSentence(counts),
    running,
    waiting,
    orphaned,
    crashed,
    pendingApprovals: pend,
    openQuestions,
    activeConflicts: conflictModel.summary.totals.conflicts,
    pendingDeliveries,
    openInbox,
    redBuilds,
    needsYou,
    runsWithoutYou,
    fingerprint,
  };
}

/** „NyxOS (4× in Folge)“ — Kurzform einer Build-Gruppe für Sätze. */
export const buildGroupLabel = (g: BuildGroup) => `${BUILD_KIND_LABEL[g.kind]}${g.count > 1 ? ` (${g.count}× in Folge)` : ""}`;
