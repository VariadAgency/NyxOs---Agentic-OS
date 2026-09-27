// PG: Adapter für P4 (Tabellen `entries` + `links`). `dbEntriesProvider` (I5-Zusammenbau) liest die
// echten Tabellen; `entriesSource(provider)` hängt in `defaultGraphSources` ein.
import type { GraphLink, GraphNodeType } from "@nyxos/shared";
import type { Db } from "../../db/client.js";
import { entries as entriesTable, links as linksTable } from "../../db/schema.js";
import type { GraphSource, SourceNode, SourceResult } from "../build.js";
import { fileNodeId, sessionNodeId } from "./sessions.js";

/** Eine P4-Zeile, reduziert auf das, was der Graph braucht. `art` wie in P4 (bug · aufgabe · …). */
export interface EntryRecord {
  id: string;
  art: string;
  title: string;
  state?: string | null;
  createdAt?: string | null;
}

/** Ein Ende einer P4-`links`-Zeile. `session.id` = Session-Schlüssel (`claude:<uuid>`). */
export interface EntryLinkEnd {
  type: "entry" | "session" | "file" | "commit" | "doc";
  id: string;
}

export interface EntryLinkRecord {
  from: EntryLinkEnd;
  to: EntryLinkEnd;
  relation?: string | null;
}

export interface EntriesProvider {
  list(): Promise<{ entries: EntryRecord[]; links: EntryLinkRecord[] }>;
}

/** P4-Art → Knotenart. Unbekannte Arten landen bei „Aufgaben" statt zu verschwinden. */
const ART_TO_TYPE: Record<string, GraphNodeType> = {
  bug: "bug",
  aufgabe: "task",
  audit: "finding",
  idee: "idea",
  entscheidung: "decision",
  frage: "question",
  problem: "problem",
};
/** Beziehungen, die als „Idee → Aufgabe" gelten (P4 benennt sie beim Umwandeln). */
const IDEA_TASK_RELATIONS = new Set(["wurde_aufgabe", "idee_zu_aufgabe", "idea_task", "converted"]);

export const entryNodeId = (id: string) => `entry:${id}`;

function endId(end: EntryLinkEnd): string {
  switch (end.type) {
    case "entry":
      return entryNodeId(end.id);
    case "session":
      return sessionNodeId(end.id);
    case "file":
    case "doc":
      return fileNodeId(end.id);
    case "commit":
      return `commit:${end.id}`; // Zusammenbau: `<repo>:<sha>` wie in git.ts
  }
}

export function entriesSource(provider: EntriesProvider): GraphSource {
  return {
    name: "entries",
    async load(): Promise<SourceResult> {
      const { entries, links: raw } = await provider.list();
      const nodes: SourceNode[] = entries.map((e) => ({
        id: entryNodeId(e.id),
        type: ART_TO_TYPE[e.art] ?? "task",
        label: e.title,
        group: e.art,
        state: e.state ?? null,
        ts: e.createdAt ?? null,
        ref: { kind: "entry", id: e.id, entryKind: e.art },
      }));
      const typeById = new Map(nodes.map((n) => [n.id, n.type]));
      const links: GraphLink[] = raw.map((l) => {
        const source = endId(l.from);
        const target = endId(l.to);
        const ideaTask = typeById.get(source) === "idea" && (typeById.get(target) === "task" || IDEA_TASK_RELATIONS.has(l.relation ?? ""));
        return { source, target, kind: ideaTask ? "idea_task" : "entry_link", weight: 1 };
      });
      return { nodes, links };
    },
  };
}

/**
 * I5-Zusammenbau: echter `EntriesProvider` über die P4-Tabellen `entries`/`links`. "Idee → Aufgabe"
 * hat in P4 KEINE eigene `links`-Zeile — `promote` (routes/entries.ts) ändert `entries.kind` einfach
 * in derselben Zeile von "idee" auf "aufgabe"/"bug" — der Knoten wechselt deshalb von selbst die Art
 * (ART_TO_TYPE oben), sobald der Graph neu gebaut wird; `IDEA_TASK_RELATIONS` bleibt als Vorkehrung
 * für eine künftige, explizite Umwandlungs-Kante bestehen, trifft heute nie zu (kein Produktfehler).
 * `fromId`/`toId` von `entry`-Enden sind die Serial-ID als Text (wie `links.from_id`/`to_id`).
 */
export function dbEntriesProvider(db: Db): EntriesProvider {
  return {
    async list() {
      const rows = await db.select({ id: entriesTable.id, kind: entriesTable.kind, title: entriesTable.title, stage: entriesTable.stage, createdAt: entriesTable.createdAt }).from(entriesTable);
      const linkRows = await db
        .select({ fromType: linksTable.fromType, fromId: linksTable.fromId, toType: linksTable.toType, toId: linksTable.toId, relation: linksTable.relation })
        .from(linksTable);
      return {
        entries: rows.map((r) => ({ id: String(r.id), art: r.kind, title: r.title, state: r.stage, createdAt: r.createdAt })),
        links: linkRows.map((l) => ({
          from: { type: l.fromType as EntryLinkEnd["type"], id: l.fromId },
          to: { type: l.toType as EntryLinkEnd["type"], id: l.toId },
          relation: l.relation,
        })),
      };
    },
  };
}
