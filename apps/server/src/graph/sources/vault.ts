// PG: Quelle „Vault" — Obsidian-Notizen (Knoten), Wiki-Links (Kanten), Notiz ↔ Session.
import { t, type GraphLink } from "@nyxos/shared";
import { and, eq, like, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionFiles, sessions, vaultNotes } from "../../db/schema.js";
import type { GraphSource, SourceNode, SourceResult } from "../build.js";
import { createResolver } from "../wikilinks.js";
import { isoTs, sessionNodeId } from "./sessions.js";

export const noteNodeId = (path: string) => `note:${path}`;
/** Nur verlinkte, (noch) nicht existierende Notiz — wie Obsidians „nicht erstellte Datei". */
export const ghostNodeId = (target: string) => `note:?${target.toLowerCase()}`;

/**
 * Paketname, wenn die Quelldatei einer Code-Notiz in einer Fremd-Bibliothek liegt (Swift-Pakete
 * unter `.build/checkouts` bzw. Xcodes `SourcePackages/checkouts`, Carthage, CocoaPods, npm), sonst null.
 */
export function libPackage(source: string | null | undefined): string | null {
  if (!source) return null;
  const p = source.replace(/\\/g, "/");
  const m = /(?:^|\/)(?:\.build|SourcePackages)\/checkouts\/([^/]+)\//.exec(p) ?? /(?:^|\/)Carthage\/Checkouts\/([^/]+)\//.exec(p) ?? /(?:^|\/)Pods\/([^/]+)\//.exec(p);
  if (m?.[1]) return m[1].slice(0, 200);
  const npm = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  return npm?.[1] ? npm[1].slice(0, 200) : null;
}

const vaultName = (root: string) => root.replace(/\/+$/, "").split("/").pop() ?? root;
const topFolder = (folder: string) => (folder ? (folder.split("/")[0] ?? folder) : "(Wurzel)");

export function vaultSource(db: Db): GraphSource {
  return {
    name: "vault",
    async load(): Promise<SourceResult> {
      const notes = await db
        .select({ path: vaultNotes.path, root: vaultNotes.root, title: vaultNotes.title, folder: vaultNotes.folder, links: vaultNotes.links, mtime: vaultNotes.mtime, sourcePath: vaultNotes.sourcePath })
        .from(vaultNotes)
        .orderBy(vaultNotes.path);
      if (notes.length === 0) return { nodes: [], links: [] };

      const nodes: SourceNode[] = [];
      const links: GraphLink[] = [];
      const resolve = createResolver(notes.map((n) => n.path));
      const ghosts = new Map<string, string>();

      for (const n of notes) {
        const lib = libPackage(n.sourcePath);
        nodes.push({ id: noteNodeId(n.path), type: "note", label: n.title, group: topFolder(n.folder), ts: isoTs(n.mtime), ...(lib ? { lib } : {}), ref: { kind: "note", path: n.path, vault: vaultName(n.root) } });
        for (const target of n.links) {
          const resolved = resolve(target, n.path);
          if (resolved) {
            if (resolved !== n.path) links.push({ source: noteNodeId(n.path), target: noteNodeId(resolved), kind: "wikilink", weight: 1 });
            continue;
          }
          const label = target.slice(target.lastIndexOf("/") + 1).trim();
          if (!label) continue;
          const id = ghostNodeId(target.trim());
          if (!ghosts.has(id)) ghosts.set(id, label);
          links.push({ source: noteNodeId(n.path), target: id, kind: "wikilink", weight: 1 });
        }
      }
      for (const [id, label] of ghosts) nodes.push({ id, type: "note", label, group: t("(nicht erstellt)"), state: "unresolved", ref: { kind: "note", path: null } });

      return { nodes, links };
    },
  };
}

/**
 * Notiz ↔ Session (eigene, kleine Quelle „vault-links", damit ein Session-Ingest NICHT die 5.000
 * Notizen neu lesen muss): Notiz nennt die Session-ID, bzw. die Session hat die Notiz geschrieben
 * (Pfad in `session_files` liegt im Vault).
 */
export function vaultSessionLinksSource(db: Db): GraphSource {
  return {
    name: "vault-links",
    async load(): Promise<SourceResult> {
      const links: GraphLink[] = [];
      const mentioning = await db
        .select({ path: vaultNotes.path, mentions: vaultNotes.mentions })
        .from(vaultNotes)
        .where(sql`jsonb_array_length(${vaultNotes.mentions}) > 0`);
      if (mentioning.length > 0) {
        const rows = await db.select({ id: sessions.id, sessionId: sessions.sessionId }).from(sessions);
        const byUuid = new Map(rows.map((r) => [r.sessionId.toLowerCase(), r.id]));
        for (const n of mentioning) {
          for (const m of n.mentions) {
            const key = byUuid.get(m.toLowerCase());
            if (key) links.push({ source: noteNodeId(n.path), target: sessionNodeId(key), kind: "note_session", weight: 1 });
          }
        }
      }
      const roots = await db.selectDistinct({ root: vaultNotes.root }).from(vaultNotes);
      for (const { root } of roots) {
        const prefix = root.replace(/\/+$/, "") + "/";
        // Nur geschriebene Dateien im Vault, die es als Notiz gibt (Join statt alle Pfade zu laden).
        const written = await db
          .select({ sessionKey: sessionFiles.sessionKey, path: vaultNotes.path })
          .from(sessionFiles)
          .innerJoin(vaultNotes, sql`${sessionFiles.path} = ${prefix} || ${vaultNotes.path}`)
          .where(and(eq(sessionFiles.mode, "write"), like(sessionFiles.path, `${prefix.replace(/[\\%_]/g, "\\$&")}%`)));
        for (const w of written) links.push({ source: noteNodeId(w.path), target: sessionNodeId(w.sessionKey), kind: "note_session", weight: 1 });
      }
      return { nodes: [], links };
    },
  };
}
