// „Dateien wie der Finder“: Vertrag zwischen Web (`apps/web/src/features/finder`), Server
// (`apps/server/src/finder`, `routes/finder.ts`) und Brücke (`apps/bridge/src/finder/fs.ts`).
//
// Die Dateien liegen nur auf dem Rechner. Der Server reicht jede Anfrage als EIN RPC `finder` an die Brücke
// weiter (Unter-Befehl in `op`), die Brücke prüft jeden Pfad selbst (Wurzel + relativer Pfad, realpath,
// kein Ausbruch, keine versteckten Ordner beim Schreiben) — der Server ist nur Durchreiche + zweite Prüfung.
import { z } from "zod";
import { t } from "./i18n/index.js";

/** Fähigkeit, die die Brücke im `hello` meldet (ältere Brücken kennen den Finder noch nicht). */
export const BRIDGE_CAP_FINDER = "finder";

/**
 * Favoriten = die einzigen Wurzeln, unter denen gelesen (und bei `writable` geschrieben) werden darf.
 * `base`: „project“ = relativ zum Projektordner der Brücke, „home“ = relativ zum
 * Benutzerordner, „screenshots“ = Ablageort für Bildschirmfotos (macOS-Einstellung, sonst Schreibtisch).
 */
export const FINDER_ROOTS = [
  { id: "project", label: "Projekt", base: "project", rel: "", writable: true, icon: "◆" },
  { id: "downloads", label: "Downloads", base: "home", rel: "Downloads", writable: false, icon: "↓" },
  { id: "screenshots", label: "Bildschirmfotos", base: "screenshots", rel: "", writable: false, icon: "▢" },
] as const;

export type FinderRootId = (typeof FINDER_ROOTS)[number]["id"];
export const FINDER_ROOT_IDS = FINDER_ROOTS.map((r) => r.id) as [FinderRootId, ...FinderRootId[]];
export const FinderRootIdSchema = z.enum(FINDER_ROOT_IDS);

/** Größter Block je `read`-RPC (Base64 über den Brücken-Kanal). Größere Dateien kommen in Blöcken. */
export const FINDER_CHUNK_BYTES = 4 * 1024 * 1024;
/** Bis zu dieser Größe öffnet der Editor eine Textdatei (darüber: nur Herunterladen). */
export const FINDER_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Höchstens so viele Einträge je Ordner (sehr große Ordner werden gekürzt und das gesagt). */
export const FINDER_LIST_MAX = 5000;
export const FINDER_SEARCH_MAX = 200;
/** Nur diese Arten dürfen über die Oberfläche gespeichert werden (Markdown bearbeiten). */
export const FINDER_WRITABLE_EXT = [".md", ".markdown", ".txt"] as const;

/**
 * Relativer Pfad unter einer Wurzel: `/` als Trenner, kein führender `/`, kein `..`/`.`-Segment,
 * kein Backslash, kein NUL. Leer = die Wurzel selbst. Dieselbe Regel in Server und Brücke.
 */
export function finderRelOk(rel: string): boolean {
  if (rel === "") return true;
  if (rel.length > 1000 || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
export const FinderRelSchema = z.string().max(1000).refine(finderRelOk, { error: () => t("Pfad nicht erlaubt") });

/** Versteckt = irgendein Segment beginnt mit „.“ (`.git`, `.env`, `.claude` …). Dort wird nie geschrieben. */
export function finderRelHidden(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith("."));
}

/** Dateien, die nach Zugangsdaten aussehen — weder Vorschau noch Download (wie der Doku-Spiegel). */
// vorher fehlten u. a. `.envrc`, `prod.env`, `.npmrc`/`.netrc`/`.pgpass`, Apple-Schlüssel `*.p8`,
// SSH-Schlüssel mit eigenem Namen (`id_server`), Keystores, `.mcp.json` (MCP-Token) und `.git/config`.
const SECRET_NAME = [
  /^\.env/i, // .env, .env.local, .envrc, .env-prod …
  /\.env$/i, // prod.env
  /\.(pem|key|p8|p12|pfx|jks|keystore|ppk|kdbx|gpg|age|tfvars|tfstate|mobileprovision)$/i,
  /^id_[a-z0-9_-]+(\.pub)?$/i, // id_rsa, id_ed25519, id_server …
  /credentials/i,
  /^\.?(secrets?|tokens?)(\..*)?$/i, // secrets.json, .token
  /\.(secrets?|token)$/i, // gh.token
  /^\.(npmrc|netrc|pgpass|htpasswd|git-credentials|mcp\.json|pypirc|dockercfg)$/i,
  /\.keychain(-db)?$/i,
];
/** Ordner, deren Inhalt komplett als Zugangsdaten gilt (`.git` wegen Token in der Remote-Adresse). */
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".gcloud", ".password-store", ".git"]);
export function finderSecretName(name: string): boolean {
  return SECRET_NAME.some((re) => re.test(name));
}
/** Pfad (relativ, `/`) zeigt auf Zugangsdaten: Dateiname oder ein Ordner auf dem Weg. */
export function finderSecretPath(rel: string): boolean {
  const segs = rel.split("/");
  const name = segs.pop() ?? "";
  return finderSecretName(name) || segs.some((s) => SECRET_DIRS.has(s.toLowerCase()));
}

export function finderExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

export function finderWritableName(name: string): boolean {
  return (FINDER_WRITABLE_EXT as readonly string[]).includes(finderExt(name));
}

// ───────────────────────────── Art einer Datei (für Symbol, Vorschau, Öffnen) ─────────────────────────────

export type FinderKind = "folder" | "image" | "pdf" | "markdown" | "code" | "text" | "audio" | "video" | "archive" | "other";

const KIND_BY_EXT: Record<string, FinderKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image", ".heif": "image", ".avif": "image", ".bmp": "image", ".tif": "image", ".tiff": "image", ".svg": "image",
  ".pdf": "pdf",
  ".md": "markdown", ".markdown": "markdown", ".mdx": "markdown",
  ".ts": "code", ".tsx": "code", ".js": "code", ".jsx": "code", ".mjs": "code", ".cjs": "code", ".json": "code", ".swift": "code", ".py": "code", ".sh": "code", ".zsh": "code", ".css": "code", ".html": "code", ".htm": "code", ".xml": "code", ".yml": "code", ".yaml": "code", ".toml": "code", ".sql": "code", ".go": "code", ".rs": "code", ".kt": "code", ".java": "code", ".c": "code", ".h": "code", ".m": "code", ".rb": "code", ".php": "code", ".plist": "code", ".pbxproj": "code", ".scad": "code", ".ini": "code", ".conf": "code", ".dockerfile": "code",
  ".txt": "text", ".log": "text", ".csv": "text", ".tsv": "text", ".env.example": "text", ".rtf": "text",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio", ".ogg": "audio", ".opus": "audio",
  ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video", ".mkv": "video",
  ".zip": "archive", ".gz": "archive", ".tgz": "archive", ".tar": "archive", ".7z": "archive", ".rar": "archive", ".dmg": "archive", ".pkg": "archive", ".xip": "archive",
};

/** Dateinamen ohne Endung, die trotzdem Text sind. */
const TEXT_NAMES = new Set(["Dockerfile", "Makefile", "Caddyfile", "LICENSE", "NOTICE", "README", "Podfile", "Gemfile", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc"]);

export function finderKindOf(name: string, isDir: boolean): FinderKind {
  if (isDir) return "folder";
  if (TEXT_NAMES.has(name)) return "text";
  return KIND_BY_EXT[finderExt(name)] ?? "other";
}

/** Kann der Editor/die Dokumentansicht das öffnen? */
export function finderIsTextKind(kind: FinderKind): boolean {
  return kind === "markdown" || kind === "code" || kind === "text";
}

export const FINDER_KIND_LABEL: Record<FinderKind, string> = {
  folder: "Ordner",
  image: "Bild",
  pdf: "PDF-Dokument",
  markdown: "Markdown-Dokument",
  code: "Quelltext",
  text: "Textdatei",
  audio: "Audio",
  video: "Video",
  archive: "Archiv",
  other: "Dokument",
};

/** Mime-Typ fürs Ausliefern. Aktive Inhalte (HTML, SVG, JS …) liefert der Server nie „inline“ aus (s. routes/finder.ts). */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm",
  ".json": "application/json", ".zip": "application/zip", ".gz": "application/gzip",
};
export function finderMimeOf(name: string): string {
  const mime = MIME_BY_EXT[finderExt(name)];
  if (mime) return mime;
  return finderIsTextKind(finderKindOf(name, false)) ? "text/plain; charset=utf-8" : "application/octet-stream";
}

// ───────────────────────────── Anfragen (Server → Brücke, RPC `finder`) ─────────────────────────────

const RootRel = { root: FinderRootIdSchema, rel: FinderRelSchema };

export const FinderRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("roots") }),
  z.object({ op: z.literal("list"), ...RootRel }),
  z.object({ op: z.literal("stat"), ...RootRel }),
  /** Finder-Tempo: Kinderzahlen der Unterordner eines großen Ordners, nachgeladen nach `list`. */
  z.object({ op: z.literal("counts"), ...RootRel }),
  z.object({
    op: z.literal("read"),
    ...RootRel,
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().positive().max(FINDER_CHUNK_BYTES).default(FINDER_CHUNK_BYTES),
  }),
  z.object({ op: z.literal("thumb"), ...RootRel, size: z.number().int().min(32).max(1024).default(320) }),
  z.object({ op: z.literal("search"), ...RootRel, q: z.string().trim().min(1).max(200) }),
  z.object({
    op: z.literal("write"),
    ...RootRel,
    content: z.string().max(FINDER_TEXT_MAX_BYTES),
    /** Prüfsumme des Stands, den der Editor geladen hat — weicht die Datei jetzt ab, ist das ein Konflikt. */
    baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    baseMtimeMs: z.number().nonnegative(),
  }),
]);
export type FinderRequest = z.input<typeof FinderRequestSchema>;
export type FinderRequestParsed = z.infer<typeof FinderRequestSchema>;

// ───────────────────────────── Antworten ─────────────────────────────

export interface FinderRootInfo {
  id: FinderRootId;
  label: string;
  icon: string;
  /** Absoluter Pfad auf dem Rechner (für die Zuordnung von Session-Dateien). */
  abs: string;
  exists: boolean;
  writable: boolean;
}

export interface FinderEntry {
  name: string;
  /** Pfad relativ zur Wurzel. */
  rel: string;
  kind: FinderKind;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** Anzahl Einträge (nur Ordner, `null` = nicht lesbar). */
  children: number | null;
  hidden: boolean;
  /** Sieht nach Zugangsdaten aus — keine Vorschau, kein Download. */
  secret: boolean;
  /** Symbolischer Link (zeigt innerhalb der Wurzel, sonst gar nicht gelistet). */
  link: boolean;
}

export interface FinderListResult {
  root: FinderRootId;
  rel: string;
  entries: FinderEntry[];
  truncated: boolean;
  writable: boolean;
  /**
   * Finder-Tempo: Großer Ordner — die Kinderzahlen der Unterordner fehlen (`children: null`) und kommen
   * über `counts` nach. Fehlt bei alten Brücken.
   */
  childrenPending?: boolean;
}

/** Kinderzahlen je Unterordner-Name (`null` = nicht lesbar). */
export interface FinderCountsResult {
  root: FinderRootId;
  rel: string;
  counts: Record<string, number | null>;
}

export interface FinderStatResult {
  root: FinderRootId;
  entry: FinderEntry;
  writable: boolean;
}

export interface FinderReadResult {
  b64: string;
  offset: number;
  size: number;
  mtimeMs: number;
  /** Nur, wenn der Block die ganze Datei ist. */
  sha256: string | null;
  eof: boolean;
}

export interface FinderThumbResult {
  b64: string;
  mime: string;
}

export interface FinderSearchResult {
  root: FinderRootId;
  rel: string;
  q: string;
  hits: FinderEntry[];
  truncated: boolean;
}

export interface FinderWriteResult {
  mtimeMs: number;
  sha256: string;
  size: number;
  /** Wo die Sicherungskopie des vorigen Stands liegt (nur Anzeige). */
  backup: string;
}

/** Fehlercodes der Brücke (RPC `code`) — die Web-App zeigt dazu verständliche Sätze. */
export const FINDER_ERR = {
  badPath: "finder_bad_path",
  notFound: "finder_not_found",
  notAFile: "finder_not_a_file",
  secret: "finder_secret",
  readOnly: "finder_read_only",
  conflict: "finder_conflict",
  tooLarge: "finder_too_large",
  noThumb: "finder_no_thumb",
  /**
   * macOS fragt gerade (Datenschutz-Dialog), ob die Brücke den Ordner lesen darf — das erste Lesen der
   * Wurzel hängt, bis der Nutzer am Rechner antwortet. Die Brücke sagt das nach kurzer Zeit, statt den Server warten zu lassen.
   */
  macosPermission: "macos_freigabe_offen",
} as const;

/** der Satz zu `FINDER_ERR.macosPermission` (Brücke und Oberfläche sagen dasselbe). */
export function finderPermissionText(label: string): string {
  return t("macOS fragt gerade, ob NyxOS den Ordner „{label}“ lesen darf. Bitte am Mac auf „Erlauben“ klicken – danach lädt die Liste von selbst.", { label });
}

// ───────────────────────────── Web ↔ Server (HTTP) ─────────────────────────────

/** `GET /api/finder/text` — Textdatei für Editor/Dokumentansicht. */
export interface FinderTextResponse {
  root: FinderRootId;
  rel: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  writable: boolean;
}

/** `GET /api/finder/roots` */
export interface FinderRootsResponse {
  bridge: "online" | "offline" | "outdated";
  roots: FinderRootInfo[];
}

/** `POST /api/finder/write` */
export const FinderWriteBodySchema = z.object({
  root: FinderRootIdSchema,
  rel: FinderRelSchema,
  content: z.string().max(FINDER_TEXT_MAX_BYTES),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseMtimeMs: z.number().nonnegative(),
});
export type FinderWriteBody = z.infer<typeof FinderWriteBodySchema>;

/** Antwort bei einem Konflikt (409): die Datei wurde inzwischen woanders geändert. */
export interface FinderConflictResponse {
  error: string;
  code: typeof FINDER_ERR.conflict;
  current: { mtimeMs: number; sha256: string } | null;
}
