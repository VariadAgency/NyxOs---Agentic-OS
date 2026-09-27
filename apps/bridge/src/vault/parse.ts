import { posix } from "node:path";
import type { VaultNote } from "@nyxos/shared";

/**
 * PG „Gehirn": liest aus einer Obsidian-Notiz nur Metadaten (Titel, Überschrift, Ordner, Tags,
 * Link-Ziele, genannte Session-IDs) — der Volltext verlässt den Rechner nicht. Regeln wie Obsidian:
 * Links in Code zählen nicht, Anhänge (Bilder, PDF, Canvas …) sind standardmäßig keine Knoten.
 */

const MAX = { title: 512, heading: 512, folder: 1024, tag: 200, tags: 500, link: 1024, links: 10_000, mentions: 1000, source: 1024 } as const;

/** Endungen, die Obsidian als Anhang (nicht als Notiz) behandelt. Alles andere gilt als Notizname
 * (z. B. `[[Version 1.2 Plan]]` → `Version 1.2 Plan.md`). */
const ATTACHMENT_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic", "bmp", "ico", "tif", "tiff",
  "pdf", "canvas", "base", "excalidraw",
  "mp3", "wav", "m4a", "ogg", "flac", "webm", "mp4", "mov", "mkv", "ogv", "3gp",
  "csv", "json", "html", "htm", "txt", "xml", "yaml", "yml",
  "zip", "gz", "tar", "rar", "7z",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers",
  "swift", "ts", "tsx", "js", "mjs", "py", "sql", "sh", "go",
]);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const WIKI_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;

function stripMdExt(s: string): string {
  return s.replace(/\.md$/i, "");
}

function extOf(s: string): string | null {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(s);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).trim();
  return t;
}

interface Frontmatter {
  title: string | null;
  tags: string[];
  /** R1 `path` = Quelldatei einer Code-Notiz (vom Code-Doku-Generator geschrieben). */
  source: string | null;
  body: string;
}

/** Sehr kleiner YAML-Ausschnitt: nur `title`, `tags`/`tag` (inline, Komma, Blockliste) und `path`. */
function splitFrontmatter(content: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { title: null, tags: [], source: null, body: content };
  const lines = (m[1] ?? "").split(/\r?\n/);
  let title: string | null = null;
  let source: string | null = null;
  const tags: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const value = (kv[2] ?? "").trim();
    if (key === "title" && value) title = unquote(value);
    if (key === "path" && value) source = unquote(value).slice(0, MAX.source) || null;
    if (key === "tags" || key === "tag") {
      if (value) {
        const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
        for (const part of inner.split(/[,\s]+/)) {
          const t = unquote(part).replace(/^#/, "");
          if (t) tags.push(t);
        }
      } else {
        while (i + 1 < lines.length && /^\s*-\s*/.test(lines[i + 1] ?? "")) {
          i++;
          const t = unquote((lines[i] ?? "").replace(/^\s*-\s*/, "")).replace(/^#/, "");
          if (t) tags.push(t);
        }
      }
    }
  }
  return { title, tags, source, body: content.slice(m[0].length) };
}

/** Entfernt Code-Blöcke (``` und ~~~) und Inline-Code — dort zählen weder Links noch Tags. */
function stripCode(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // Schließender Zaun: gleiches Zeichen, mindestens so lang, danach nichts mehr.
      if (f?.[1] && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      out.push("");
      continue;
    }
    if (f?.[1]) {
      fence = f[1];
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/(`+)[^\n]*?\1/g, " ");
}

/** R1 längster Notiz-Anfang (Zeichen), der an den Server geht — nur für die Info-Karte. */
export const EXCERPT_MAX = 400;

/** Notiz-Anfang als reiner Text: ohne Frontmatter, erste Hauptüberschrift, Code-Blöcke, Einbettungen,
 * HTML und Markdown-Zeichen; Links werden zu ihrem Text. Gekürzt an einer Wortgrenze. */
export function plainExcerpt(body: string): string | null {
  const lines: string[] = [];
  let fence: string | null = null;
  let droppedTitle = false;
  for (const line of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f?.[1] && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f?.[1]) {
      fence = f[1];
      continue;
    }
    if (!droppedTitle && /^# +/.test(line)) {
      droppedTitle = true;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue; // Trennlinie, Tabellenkopf-Linie
    lines.push(line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""));
    if (lines.join(" ").length > EXCERPT_MAX * 3) break;
  }
  const text = lines
    .join(" ")
    .replace(/!\[\[[^\]\n]*\]\]/g, " ")
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
      const [target = "", alias] = inner.split("|");
      return alias?.trim() || (target.split("#")[0] ?? "").split("/").pop()?.trim() || "";
    })
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~|==)/g, "")
    .replace(/(^|[\s(])[*_]+(?=\S)|(?<=\S)[*_]+(?=[\s).,;:!?]|$)/g, "$1")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function pushUnique(list: string[], seen: Set<string>, value: string, max: number, maxLen: number): void {
  if (list.length >= max) return;
  const v = value.slice(0, maxLen);
  if (!v || seen.has(v)) return;
  seen.add(v);
  list.push(v);
}

export function parseNote(relPath: string, content: string, mtimeMs: number, size: number): VaultNote {
  const path = relPath.split("\\").join("/");
  const base = posix.basename(path);
  const folderRaw = posix.dirname(path);
  const folder = folderRaw === "." ? "" : folderRaw;
  const title = stripMdExt(base).slice(0, MAX.title);

  const fm = splitFrontmatter(content);
  const text = stripCode(fm.body);

  let heading: string | null = fm.title;
  if (!heading) {
    const h = /^# +(.+?)\s*#*\s*$/m.exec(text);
    heading = h?.[1]?.trim() || null;
  }
  if (heading) heading = heading.slice(0, MAX.heading);

  const links: string[] = [];
  const seenLinks = new Set<string>();
  for (const m of text.matchAll(WIKI_RE)) {
    const target = (m[1] ?? "").split("|")[0]?.split("#")[0]?.split("^")[0]?.trim() ?? "";
    if (!target) continue;
    if (/\.md$/i.test(target)) {
      pushUnique(links, seenLinks, stripMdExt(target), MAX.links, MAX.link);
      continue;
    }
    const ext = extOf(target);
    if (ext && ATTACHMENT_EXT.has(ext)) continue;
    pushUnique(links, seenLinks, target, MAX.links, MAX.link);
  }
  for (const m of text.matchAll(MD_LINK_RE)) {
    let target = (m[1] ?? "").trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split("#")[0] ?? "";
    try {
      target = decodeURIComponent(target);
    } catch {
      // kaputte Kodierung: so lassen, wie geschrieben
    }
    if (!/\.md$/i.test(target)) continue;
    const resolved = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(folder, target));
    if (resolved === ".." || resolved.startsWith("../")) continue;
    pushUnique(links, seenLinks, stripMdExt(resolved), MAX.links, MAX.link);
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const t of fm.tags) pushUnique(tags, seenTags, t, MAX.tags, MAX.tag);
  for (const m of text.matchAll(TAG_RE)) {
    const t = (m[2] ?? "").replace(/\/+$/, "");
    if (!/[^\d/]/.test(t)) continue; // mindestens ein Nicht-Ziffer-Zeichen (Obsidian)
    pushUnique(tags, seenTags, t, MAX.tags, MAX.tag);
  }

  const mentions: string[] = [];
  const seenMentions = new Set<string>();
  for (const m of content.matchAll(UUID_RE)) pushUnique(mentions, seenMentions, m[0].toLowerCase(), MAX.mentions, 100);

  return {
    path,
    title,
    heading,
    folder: folder.slice(0, MAX.folder),
    tags,
    links,
    mentions,
    mtime: new Date(mtimeMs).toISOString(),
    size,
    excerpt: plainExcerpt(fm.body),
    source: fm.source,
  };
}
