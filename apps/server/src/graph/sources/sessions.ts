// PG: Quelle „Sessions" — Sessions, Sub-Agenten, Baustellen, Arten, (optional) Dateien.
import { artLabel, sessionLabel, type GraphLink } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessionFiles, sessions } from "../../db/schema.js";
import type { GraphSource, SourceNode, SourceResult } from "../build.js";
import { visibleSession } from "../../db/visible.js";

export const sessionNodeId = (sessionKey: string) => `session:${sessionKey}`;
export const fileNodeId = (path: string) => `file:${path}`;

/** Zeitstempel aus der DB (postgres-js/PGlite liefern „2026-09-21 10:00:00+00") → ISO. */
export function isoTs(v: string | null | undefined): string | null {
  if (!v) return null;
  const norm = (v.includes("T") ? v : v.replace(" ", "T")).replace(/([+-]\d\d)$/, "$1:00");
  const t = Date.parse(norm);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Dateien, die (fast) jede Session schreibt (memory.md, project.pbxproj, CLAUDE.md …),
 * sagen nichts über Verwandtschaft und würden eine Kanten-Clique k·(k−1)/2 erzeugen. Ab dieser
 * Schreiber-Zahl zählt eine Datei nicht für „gemeinsame Dateien" (bleibt aber als Datei-Knoten).
 */
export function hotFileThreshold(mainSessions: number): number {
  return Math.max(8, Math.ceil(mainSessions * 0.2));
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

interface SubagentJson {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

export function sessionsSource(db: Db): GraphSource {
  return {
    name: "sessions",
    async load(): Promise<SourceResult> {
      const [rows, writes] = await Promise.all([
        db
          .select({
            id: sessions.id,
            tool: sessions.tool,
            sessionId: sessions.sessionId,
            parentId: sessions.parentId,
            title: sessions.title,
            titleSource: sessions.titleSource,
            cwd: sessions.cwd,
            state: sessions.state,
            status: sessions.status,
            closedAt: sessions.closedAt,
            endedAt: sessions.endedAt,
            lastActivityAt: sessions.lastActivityAt,
            startedAt: sessions.startedAt,
            art: sessions.categoryArt,
            baustelleSlug: sessions.categoryBaustelleSlug,
            baustelleLabel: sessions.categoryBaustelleLabel,
            subagents: sessions.subagents,
          })
          .from(sessions)
          .where(visibleSession)
          .orderBy(sessions.id),
        db
          .select({ sessionKey: sessionFiles.sessionKey, path: sessionFiles.path })
          .from(sessionFiles)
          .where(eq(sessionFiles.mode, "write"))
          .orderBy(sessionFiles.sessionKey, sessionFiles.path),
      ]);

      const nodes: SourceNode[] = [];
      const links: GraphLink[] = [];
      const known = new Set(rows.map((r) => r.id));
      const arts = new Set<string>();
      const baustellen = new Map<string, string>();

      for (const r of rows) {
        const art = r.art ?? "unsortiert";
        const isChild = r.parentId !== null && known.has(r.parentId);
        const archived = r.closedAt !== null || r.endedAt !== null || r.status === "ended";
        nodes.push({
          id: sessionNodeId(r.id),
          type: isChild ? "subagent" : "session",
          // derselbe Name wie überall (`sessionLabel`), nie „(ohne Titel)“.
          label: sessionLabel(r),
          group: art,
          state: r.closedAt !== null ? "closed" : (r.state ?? (archived ? "ended" : null)),
          ts: isoTs(r.lastActivityAt ?? r.startedAt),
          archived,
          ref: { kind: "session", sessionKey: r.id, sessionId: r.sessionId, tool: r.tool, art, baustelleSlug: r.baustelleSlug },
        });
        if (isChild && r.parentId) {
          links.push({ source: sessionNodeId(r.parentId), target: sessionNodeId(r.id), kind: "parent", weight: 1 });
          continue; // Kind-Sessions hängen nur an ihrer Eltern-Session (wie im Sessions-Tab)
        }
        arts.add(art);
        links.push({ source: sessionNodeId(r.id), target: `art:${art}`, kind: "art", weight: 1 });
        if (r.baustelleSlug) {
          baustellen.set(r.baustelleSlug, r.baustelleLabel ?? r.baustelleSlug);
          links.push({ source: sessionNodeId(r.id), target: `baustelle:${r.baustelleSlug}`, kind: "baustelle", weight: 1 });
        }
        const subs = Array.isArray(r.subagents) ? (r.subagents as SubagentJson[]) : [];
        for (const sa of subs) {
          if (typeof sa.id !== "string" || !sa.id) continue;
          const id = `subagent:${r.id}:${sa.id}`;
          const label = (typeof sa.name === "string" && sa.name) || (typeof sa.type === "string" && sa.type) || "Sub-Agent";
          nodes.push({
            id,
            type: "subagent",
            label,
            group: art,
            state: null,
            ts: isoTs(r.lastActivityAt),
            archived,
            ref: { kind: "session", sessionKey: r.id, sessionId: r.sessionId, tool: r.tool, art, baustelleSlug: r.baustelleSlug },
          });
          links.push({ source: sessionNodeId(r.id), target: id, kind: "parent", weight: 1 });
        }
      }

      for (const art of arts) nodes.push({ id: `art:${art}`, type: "art", label: artLabel(art), group: art, ref: { kind: "art", art } });
      for (const [slug, label] of baustellen) nodes.push({ id: `baustelle:${slug}`, type: "baustelle", label, group: slug, ref: { kind: "baustelle", slug } });

      // Gemeinsam geschriebene Dateien: je Paar eine Kante, Gewicht = Anzahl gemeinsamer Dateien.
      const writersByPath = new Map<string, Set<string>>();
      for (const w of writes) {
        if (!known.has(w.sessionKey)) continue; // Dateien archivierter Sessions nicht als Knoten/Kante
        const set = writersByPath.get(w.path) ?? new Set<string>();
        set.add(w.sessionKey);
        writersByPath.set(w.path, set);
      }
      const pairWeight = new Map<string, number>();
      const filePaths = new Set<string>();
      const hot = hotFileThreshold(rows.filter((r) => !(r.parentId !== null && known.has(r.parentId))).length);
      for (const [path, writers] of writersByPath) {
        filePaths.add(path);
        if (writers.size >= hot) continue;
        const list = [...writers].sort();
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const key = `${list[i]}\u0000${list[j]}`;
            pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
          }
        }
      }
      for (const [key, weight] of pairWeight) {
        const [a, b] = key.split("\u0000");
        if (a && b) links.push({ source: sessionNodeId(a), target: sessionNodeId(b), kind: "shared_files", weight });
      }

      // Dateien (optional, per include=files sichtbar): Session → Datei.
      for (const path of filePaths) {
        nodes.push({ id: fileNodeId(path), type: "file", label: basename(path), group: basename(dirname(path)), ref: { kind: "file", path } });
      }
      for (const w of writes) links.push({ source: sessionNodeId(w.sessionKey), target: fileNodeId(w.path), kind: "touched_file", weight: 1 });

      return { nodes, links };
    },
  };
}
