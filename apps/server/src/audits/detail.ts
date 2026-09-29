// Audit-Detail. Der Nutzer: „Wenn ich die einzelnen Audits öffne, sehe ich viel zu wenig … nicht nur den
// lokalen Graph, sondern auch den kompletten Inhalt und den Text als Vorschau.“
//
// Quelle der Werte ist die Plan-Zeile im MASSNAHMENPLAN.md (liegt als Import-Spiegel auf dem Server,
// `import_files`). Die Zeile verlinkt die Originalstelle — diese Audit-Datei liest der Server frisch vom
// Mac (RPC `finder`, Wurzel „project“) und legt sie in den Doku-Spiegel (`docs`). Ist der Rechner zu, gilt
// der gespiegelte Stand; gab es noch keinen, bleibt der Text ehrlich leer (die Werte der Plan-Zeile stehen).
import type { AuditDetail, AuditFindingMeta, AuditRelated, AuditSource, AuditTaskRef, EntryStage, FileSession, FinderReadResult } from "@nyxos/shared";
import { FINDER_CHUNK_BYTES, FINDER_TEXT_MAX_BYTES } from "@nyxos/shared";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { posix } from "node:path";
import type { Db } from "../db/client.js";
import { entries, importFiles, sessionFiles } from "../db/schema.js";
import { getDoc, isMirrorable, mirrorDocs } from "../entries/docMirror.js";
import { sessionsForFile } from "../files/query.js";
import { finderCall, type FinderHub } from "../finder/service.js";

/** | Rang | Stufe | [ID — Titel](Link) | Schwere | R | Aufwand | Paket | Vorher | */
const ROW_RE = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\[([^—\]]+?)\s*—\s*([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*(\d*)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;
/** | Paket | Befunde (Komma-Liste) | Aufwand | Gemeinsame Arbeit | */
const PACKAGE_RE = /^\|\s*(P-[^|\s]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/;
const ID_RE = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+/g;

interface PlanRow extends AuditFindingMeta {
  link: string;
  /** Audit-Datei repo-relativ (aus dem Link, relativ zum Plan aufgelöst), `null` = zeigt aus App/docs hinaus. */
  sourcePath: string | null;
}

interface Plan {
  path: string;
  rows: Map<string, PlanRow>;
  packages: Map<string, { ids: string[]; arbeit: string | null }>;
}

/** `decodeURIComponent` wirft bei kaputter %-Folge — ein Tippfehler im Plan darf das Detail nicht kippen. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

const dash = (s: string) => (s === "" || s === "—" || s === "-" ? null : s);
const num = (s: string) => (s === "" ? null : Number(s));

export function parsePlan(path: string, text: string): Plan {
  const rows = new Map<string, PlanRow>();
  const packages = new Map<string, { ids: string[]; arbeit: string | null }>();
  const dir = posix.dirname(path);
  for (const line of text.split("\n")) {
    const m = ROW_RE.exec(line);
    if (m) {
      const id = (m[3] ?? "").trim();
      const link = (m[5] ?? "").trim();
      const file = link.split("#")[0] ?? "";
      const decoded = file && !/^[a-z]+:/i.test(file) ? safeDecode(file) : null;
      const resolved = decoded ? posix.normalize(posix.join(dir, decoded)) : null;
      if (!id || rows.has(id)) continue;
      rows.set(id, {
        id,
        title: (m[4] ?? "").trim(),
        rang: num(m[1] ?? ""),
        stufe: num(m[2] ?? ""),
        schwere: dash((m[6] ?? "").trim()),
        risiko: num((m[7] ?? "").trim()),
        aufwand: dash((m[8] ?? "").trim()),
        paket: dash((m[9] ?? "").trim()),
        vorher: (m[10] ?? "").match(ID_RE) ?? [],
        paketArbeit: null,
        link,
        sourcePath: resolved && resolved.startsWith("App/docs/") && resolved.endsWith(".md") ? resolved : null,
      });
      continue;
    }
    const p = PACKAGE_RE.exec(line);
    if (p && p[1] && !packages.has(p[1])) packages.set(p[1], { ids: (p[2] ?? "").match(ID_RE) ?? [], arbeit: dash((p[4] ?? "").trim()) });
  }
  for (const row of rows.values()) if (row.paket) row.paketArbeit = packages.get(row.paket)?.arbeit ?? null;
  return { path, rows, packages };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Abschnitt eines Befunds: ab der Überschrift mit der ID bis zur nächsten gleich- oder höherrangigen. */
export function extractSection(markdown: string, id: string): string | null {
  const lines = markdown.split("\n");
  const head = new RegExp(`^(#{1,6})\\s+\\[?${escapeRe(id)}\\]?(?=[\\s:—–.)-]|$)`);
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    if (start === -1) {
      const m = head.exec(line);
      if (m) {
        start = i;
        level = (m[1] ?? "").length;
      }
      continue;
    }
    const h = /^(#{1,6})\s/.exec(line);
    if (h && (h[1] ?? "").length <= level) return lines.slice(start, i).join("\n").trimEnd();
  }
  return start === -1 ? null : lines.slice(start).join("\n").trimEnd();
}

async function loadPlans(db: Db): Promise<Plan[]> {
  const rows = await db
    .select({ path: importFiles.path, content: importFiles.content })
    .from(importFiles)
    .where(and(isNull(importFiles.removedAt), like(importFiles.path, "%MASSNAHMENPLAN.md")));
  return rows.map((r) => parsePlan(r.path, r.content));
}

/** Audit-Datei frisch vom Mac lesen (und spiegeln); sonst Spiegel; sonst leer. */
async function loadSource(db: Db, hub: FinderHub, path: string): Promise<Pick<AuditSource, "content" | "origin" | "updatedAt">> {
  const parts: Buffer[] = [];
  let offset = 0;
  let mtimeMs: number | null = null;
  let live = true;
  for (;;) {
    const out = await finderCall<FinderReadResult>(hub, { op: "read", root: "project", rel: path, offset, length: FINDER_CHUNK_BYTES }, 10_000);
    if (!out.ok) {
      live = false;
      break;
    }
    const buf = Buffer.from(out.value.b64, "base64");
    parts.push(buf);
    offset += buf.length;
    mtimeMs = out.value.mtimeMs;
    if (out.value.eof || buf.length === 0) break;
    if (offset > FINDER_TEXT_MAX_BYTES) {
      live = false;
      break;
    }
  }
  if (live) {
    const content = Buffer.concat(parts).toString("utf8");
    if (isMirrorable(path)) await mirrorDocs(db, [{ path, content }]);
    return { content, origin: "mac", updatedAt: mtimeMs !== null ? new Date(mtimeMs).toISOString() : null };
  }
  const doc = isMirrorable(path) ? await getDoc(db, path) : null;
  if (!doc) return { content: null, origin: null, updatedAt: null };
  const at = doc.updatedAt as unknown;
  return { content: doc.content, origin: "spiegel", updatedAt: at instanceof Date ? at.toISOString() : String(at) };
}

async function sessionsForRel(db: Db, rel: string): Promise<FileSession[]> {
  const rows = await db
    .selectDistinct({ path: sessionFiles.path })
    .from(sessionFiles)
    .where(like(sessionFiles.path, `%/${rel.replace(/[%_\\]/g, (c) => `\\${c}`)}`))
    .limit(20);
  const byKey = new Map<string, FileSession>();
  for (const r of rows) for (const s of await sessionsForFile(db, r.path)) if (!byKey.has(s.key)) byKey.set(s.key, s);
  return [...byKey.values()].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

async function tasksMentioning(db: Db, id: string): Promise<AuditTaskRef[]> {
  const files = await db
    .select({ path: importFiles.path })
    .from(importFiles)
    .where(and(isNull(importFiles.removedAt), like(importFiles.path, "%GOAL.md"), sql`${importFiles.content} ~ ${`(^|[^A-Za-z0-9-])${escapeRe(id)}([^0-9]|$)`}`));
  if (files.length === 0) return [];
  const rows = await db
    .select({ id: entries.id, title: entries.title, stage: entries.stage, sourceId: entries.sourceId })
    .from(entries)
    .where(and(eq(entries.sourceType, "goal"), inArray(entries.sourceId, files.map((f) => f.path))));
  return rows.map((r) => ({ entryId: r.id, title: r.title, stage: r.stage as EntryStage, path: r.sourceId ?? "" }));
}

export async function auditDetail(db: Db, hub: FinderHub, entryId: number): Promise<AuditDetail | null> {
  const [entry] = await db.select({ id: entries.id, kind: entries.kind, sourceId: entries.sourceId }).from(entries).where(eq(entries.id, entryId));
  if (!entry || entry.kind !== "audit") return null;
  const id = entry.sourceId ?? "";
  const plans = await loadPlans(db);
  const plan = plans.find((p) => p.rows.has(id)) ?? null;
  const row = plan?.rows.get(id) ?? null;

  let source: AuditSource | null = null;
  if (row?.sourcePath) {
    const loaded = await loadSource(db, hub, row.sourcePath);
    source = {
      path: row.sourcePath,
      name: posix.basename(row.sourcePath),
      section: loaded.content ? extractSection(loaded.content, id) : null,
      finderRel: row.sourcePath,
      ...loaded,
    };
  }

  // Verwandte: erst „muss vorher fertig sein“, dann gleiches Paket, dann gleiche Audit-Datei.
  const related: AuditRelated[] = [];
  const seen = new Set<string>([id]);
  const add = (fid: string, reason: AuditRelated["reason"]) => {
    if (seen.has(fid)) return;
    seen.add(fid);
    const other = plans.map((p) => p.rows.get(fid)).find(Boolean);
    related.push({ findingId: fid, title: other?.title ?? fid, entryId: null, stage: null, schwere: other?.schwere ?? null, reason });
  };
  if (row && plan) {
    for (const v of row.vorher) add(v, "vorher");
    if (row.paket) for (const other of plan.rows.values()) if (other.paket === row.paket) add(other.id, "paket");
    if (row.sourcePath) for (const other of plan.rows.values()) if (other.sourcePath === row.sourcePath) add(other.id, "datei");
  }
  const related50 = related.slice(0, 50);
  if (related50.length > 0) {
    const found = await db
      .select({ id: entries.id, sourceId: entries.sourceId, stage: entries.stage })
      .from(entries)
      .where(and(eq(entries.sourceType, "audit"), inArray(entries.sourceId, related50.map((r) => r.findingId))));
    const byId = new Map(found.map((f) => [f.sourceId, f]));
    for (const r of related50) {
      const f = byId.get(r.findingId);
      if (f) {
        r.entryId = f.id;
        r.stage = f.stage as EntryStage;
      }
    }
  }

  return {
    entryId,
    finding: row ? { id: row.id, title: row.title, rang: row.rang, stufe: row.stufe, schwere: row.schwere, risiko: row.risiko, aufwand: row.aufwand, paket: row.paket, vorher: row.vorher, paketArbeit: row.paketArbeit } : null,
    planPath: plan?.path ?? null,
    source,
    related: related50,
    tasks: id ? await tasksMentioning(db, id) : [],
    sessions: source ? await sessionsForRel(db, source.path) : [],
  };
}
