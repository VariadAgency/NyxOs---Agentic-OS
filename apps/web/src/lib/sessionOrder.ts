// Reine Sortier-/Gruppierlogik für die Sessions-Übersicht. Kein React, leicht testbar.
import { t } from "@nyxos/shared";
import type { Session, SessionState } from "./api";

export interface SessionRow {
  session: Session;
  /** Sub-Agenten dieser Session (gleiches `tool`, `parentId === session.id`) — erscheinen nicht als eigene Karte. */
  subagents: Session[];
}

export interface GroupedSessions {
  /** Offene Haupt-Sessions (nicht geschlossen, state !== null), sortiert nach Zustand dann Aktivität. */
  open: SessionRow[];
  /** Vom Nutzer geschlossen (`state === "closed"`). */
  closed: Session[];
  /** Sauber beendet, kein Zustand (`state === null`, Status "ended"). */
  ended: Session[];
}

/** Reihenfolge: wartet auf dich → läuft → abgestürzt → ruht. */
const STATE_RANK: Record<Exclude<SessionState, null>, number> = {
  waiting: 0,
  running: 1,
  crashed: 2,
  idle: 3,
  closed: 99,
};

export function stateRank(state: SessionState): number {
  if (state === null) return 100;
  return STATE_RANK[state] ?? 100;
}

function activityTs(session: Session): number {
  const raw = session.lastActivityAt ?? session.startedAt;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Gruppiert eine flache Session-Liste (schon nach Art/Baustelle/Werkzeug gefiltert) für die
 * Übersicht: Sub-Agenten wandern unter ihre Eltern-Session, offene Sessions werden nach Zustand
 * sortiert, geschlossene/beendete Sessions bilden eigene, einklappbare Listen.
 */
export function groupSessions(sessions: Session[]): GroupedSessions {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentId && byId.has(s.parentId)) {
      childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s]);
    }
  }

  const isTopLevel = (s: Session) => !s.parentId || !byId.has(s.parentId);
  const topLevel = sessions.filter(isTopLevel);

  const closed: Session[] = [];
  const ended: Session[] = [];
  const openRows: SessionRow[] = [];

  for (const session of topLevel) {
    const subagents = (childrenOf.get(session.id) ?? []).sort((a, b) => activityTs(a) - activityTs(b));
    if (session.state === "closed") {
      closed.push(session);
    } else if (session.state === null) {
      ended.push(session);
    } else {
      openRows.push({ session, subagents });
    }
  }

  openRows.sort((a, b) => {
    const rankDiff = stateRank(a.session.state) - stateRank(b.session.state);
    if (rankDiff !== 0) return rankDiff;
    return activityTs(b.session) - activityTs(a.session);
  });

  closed.sort((a, b) => activityTs(b) - activityTs(a));
  ended.sort((a, b) => activityTs(b) - activityTs(a));

  return { open: openRows, closed, ended };
}

/** So viele Einträge zeigt die Übersicht für diese (schon gefilterte) Liste: offen + geschlossen + beendet. */
export function listedCount(sessions: Session[]): number {
  const { open, closed, ended } = groupSessions(sessions);
  return open.length + closed.length + ended.length;
}

export interface TabCount {
  art: string;
  count: number;
  baustellen: { slug: string | null; label: string; count: number }[];
}

/**
 * Reiter-Zähler (Art, „Alle“, Baustelle) aus DERSELBEN Liste und nach
 * DERSELBEN Regel wie die Übersicht darunter. `sessions` ist schon nach Werkzeug und Temporär-Filter
 * gefiltert, genau wie die Liste. Jede Zahl ist, was ein Klick auf den Reiter zeigt (inkl. Geschlossen,
 * Beendet und Kind-Sessions, deren Eltern-Session woanders liegt). Jede Baustelle, in der Sessions
 * liegen, bekommt einen Reiter — auch eine, in der nur Kind-Sessions liegen.
 */
export function tabCounts(sessions: Session[]): TabCount[] {
  const byArt = new Map<string, Session[]>();
  for (const s of sessions) byArt.set(s.art, [...(byArt.get(s.art) ?? []), s]);
  return [...byArt].map(([art, list]) => {
    const byBaustelle = new Map<string | null, Session[]>();
    for (const s of list) {
      const slug = s.baustelle?.slug ?? null;
      byBaustelle.set(slug, [...(byBaustelle.get(slug) ?? []), s]);
    }
    const baustellen = [...byBaustelle]
      .map(([slug, inside]) => ({
        slug,
        label: slug === null ? t("Ohne Baustelle") : (inside.find((s) => s.baustelle?.label)?.baustelle?.label ?? slug),
        count: listedCount(inside),
      }))
      // Größte zuerst, „Ohne Baustelle“ am Ende.
      .sort((a, b) => Number(a.slug === null) - Number(b.slug === null) || b.count - a.count || a.label.localeCompare(b.label, "de"));
    return { art, count: listedCount(list), baustellen };
  });
}

export interface StateCounts {
  running: number;
  waiting: number;
  idle: number;
  crashed: number;
}

/** Zählt offene Haupt-Sessions je Zustand — Grundlage für den Status-Zähler-Satz im Kopf. */
export function countStates(rows: SessionRow[]): StateCounts {
  const counts: StateCounts = { running: 0, waiting: 0, idle: 0, crashed: 0 };
  for (const row of rows) {
    const state = row.session.state;
    if (state === "running" || state === "waiting" || state === "idle" || state === "crashed") counts[state]++;
  }
  return counts;
}

const STATE_WORDS: Record<keyof StateCounts, string> = {
  running: "{n} läuft",
  waiting: "{n} wartet auf dich",
  idle: "{n} ruht",
  crashed: "{n} abgestürzt",
};

/** "2 läuft · 1 wartet auf dich" — lässt Zustände mit 0 weg, nie erfunden. */
export function statusCounterSentence(rows: SessionRow[]): string {
  const counts = countStates(rows);
  const order: (keyof StateCounts)[] = ["running", "waiting", "crashed", "idle"];
  const parts = order.filter((key) => counts[key] > 0).map((key) => t(STATE_WORDS[key], { n: counts[key] }));
  return parts.join(" · ");
}
