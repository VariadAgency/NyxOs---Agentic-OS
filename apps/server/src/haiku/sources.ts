// Quellen: Haiku zitiert mit Markern `[[art:id]]` (die Werkzeuge liefern sie fertig als `ref`).
// Der Server prüft JEDEN Marker gegen die DB – nur existierende Objekte werden zu anklickbaren
// Quellen, erfundene fallen weg. Eine Antwort ohne gültige Quelle ist eine „Einschätzung“.
import { describeBuildRun, sessionLabel, t, type BuildRunRow, type HaikuSource, type HaikuSourceKind } from "@nyxos/shared";
import { eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { parseSerialId } from "../ids.js";
import { approvals, buildRuns, haikuReports, inboxItems, sessions } from "../db/schema.js";

const MARKER_RE = /\[\[(session|entry|doc|approval|inbox|build|night|report|commit|usage):([^\]\s]{1,300})\]\]/g;

export const ref = (kind: HaikuSourceKind, id: string | number) => `[[${kind}:${id}]]`;

/**
 * (Audit Punkt 1): derselbe Name wie überall (`sessionLabel` aus `@nyxos/shared`): Titel → Auftrag →
 * erste Nachricht gekürzt → Baustelle/Ordner + Startzeit. Nie die Kennung.
 */
export function untitledSessionLabel(s: {
  title: string | null;
  titleSource?: string | null;
  tool?: string | null;
  cwd?: string | null;
  categoryBaustelleLabel?: string | null;
  startedAt?: string | null;
  lastActivityAt?: string | null;
}): string {
  return sessionLabel({ ...s, baustelleLabel: s.categoryBaustelleLabel ?? null });
}

export function sessionHref(row: { sessionId: string; categoryArt: string | null; categoryBaustelleSlug: string | null }): string {
  return `/sessions/${row.categoryArt ?? "unsortiert"}/${row.categoryBaustelleSlug ?? "_"}/${row.sessionId}`;
}

/** Zusätzliche Auflöser (z. B. Einträge/Dokumente aus P4), ohne diese Datei zu ändern. */
export type SourceResolver = (db: Db, id: string) => Promise<HaikuSource | null>;
const extraResolvers = new Map<HaikuSourceKind, SourceResolver>();
export function registerSourceResolver(kind: HaikuSourceKind, fn: SourceResolver): void {
  extraResolvers.set(kind, fn);
}

export async function resolveSource(db: Db, kind: HaikuSourceKind, id: string): Promise<HaikuSource | null> {
  const extra = extraResolvers.get(kind);
  if (extra) return extra(db, id);
  switch (kind) {
    case "session": {
      const [row] = await db
        .select({
          id: sessions.id,
          sessionId: sessions.sessionId,
          title: sessions.title,
          titleSource: sessions.titleSource,
          tool: sessions.tool,
          cwd: sessions.cwd,
          categoryArt: sessions.categoryArt,
          categoryBaustelleSlug: sessions.categoryBaustelleSlug,
          categoryBaustelleLabel: sessions.categoryBaustelleLabel,
          startedAt: sessions.startedAt,
          lastActivityAt: sessions.lastActivityAt,
        })
        .from(sessions)
        .where(or(eq(sessions.id, id), eq(sessions.sessionId, id)))
        .limit(1);
      // derselbe Name wie Überblick/Briefing/Web – nie nur die Kennung.
      return row ? { kind, id: row.id, label: untitledSessionLabel(row), href: sessionHref(row) } : null;
    }
    case "approval": {
      const n = parseSerialId(id);
      if (n === null) return null;
      const [row] = await db.select({ id: approvals.id, command: approvals.command }).from(approvals).where(eq(approvals.id, n)).limit(1);
      return row ? { kind, id: String(row.id), label: t("Freigabe #{id}", { id: row.id }), href: `/inbox#approval-${row.id}` } : null;
    }
    case "inbox": {
      const n = parseSerialId(id);
      if (n === null) return null;
      const [row] = await db.select({ id: inboxItems.id, title: inboxItems.title }).from(inboxItems).where(eq(inboxItems.id, n)).limit(1);
      return row ? { kind, id: String(row.id), label: row.title.slice(0, 80), href: `/inbox#inbox-${row.id}` } : null;
    }
    case "build": {
      const n = parseSerialId(id);
      if (n === null) return null;
      const [row] = await db
        .select({ id: buildRuns.id, kind: buildRuns.kind, status: buildRuns.status, command: buildRuns.command, logExcerpt: buildRuns.logExcerpt })
        .from(buildRuns)
        .where(eq(buildRuns.id, n))
        .limit(1);
      // Zustand in einfacher Sprache (alte „spawn … ENOENT“-Läufe = nicht eingerichtet).
      return row ? { kind, id: String(row.id), label: `${describeBuildRun(row as Pick<BuildRunRow, "kind" | "status" | "command" | "logExcerpt">).headline} (#${row.id})`, href: "/server" } : null;
    }
    case "report": {
      const n = parseSerialId(id);
      if (n === null) return null;
      const [row] = await db.select({ id: haikuReports.id, kind: haikuReports.kind, day: haikuReports.day }).from(haikuReports).where(eq(haikuReports.id, n)).limit(1);
      return row ? { kind, id: String(row.id), label: `${row.kind === "recap" ? "Recap" : "Briefing"} ${row.day}`, href: "/briefing" } : null;
    }
    default:
      return null;
  }
}

/** Ersetzt gültige Marker durch `[n]` (n = Nummer in `sources`) und entfernt ungültige spurlos. */
export async function extractSources(db: Db, text: string): Promise<{ text: string; sources: HaikuSource[] }> {
  const sources: HaikuSource[] = [];
  const index = new Map<string, number | null>();
  for (const m of text.matchAll(MARKER_RE)) {
    const key = `${m[1]}:${m[2]}`;
    if (index.has(key)) continue;
    const src = await resolveSource(db, m[1] as HaikuSourceKind, m[2] as string);
    if (src) {
      const dup = sources.findIndex((s) => s.kind === src.kind && s.id === src.id);
      if (dup >= 0) index.set(key, dup + 1);
      else {
        sources.push(src);
        index.set(key, sources.length);
      }
    } else index.set(key, null);
  }
  const cleaned = text
    .replace(MARKER_RE, (_all, k: string, id: string) => {
      const n = index.get(`${k}:${id}`);
      return n ? `[${n}]` : "";
    })
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text: cleaned, sources };
}

/** Marker in einem Streaming-Stück ausblenden (die Nummern kommen erst mit `done`). */
export function stripMarkersForStream(text: string): string {
  return text.replace(MARKER_RE, "");
}
