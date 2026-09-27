// (Produkt-Audit P2, Punkt 1–3): Namen und „verwaist“ – EINE Regel für Server und Web.
//
// Vorher baute jede Stelle den Namen selbst: „(noch ohne Titel)“ in 12 Dateien, „Session vom …“ im Briefing,
// die rohe UUID im Brotkrümel. Jetzt gilt überall `sessionLabel()`:
//   1. eigener Titel (von Nyx/Haiku oder aus dem Index) – außer Kennungen und Müll wie „OK“
//   2. Titel aus dem Auftrag („/goal …/P3-terminal/GOAL.md“ → „Terminal“)
//   3. die erste Nutzer-Nachricht, gekürzt auf ein Wort-Ende
//   4. Baustelle bzw. Repo/Ordner + Startzeit („NyxOS · Session vom 24.09., 20:02“)
// Nie leer, nie eine UUID.

import { dateTimeFormat } from "./format.js";

/** Was es für einen Namen braucht (alles außer `title` ist optional, damit jede Abfrage passt). */
export interface SessionLabelInput {
  title: string | null;
  /** "prompt" = der Titel IST die erste Nutzer-Nachricht (wird gekürzt), sonst ein echter Titel. */
  titleSource?: string | null;
  tool?: string | null;
  cwd?: string | null;
  baustelleLabel?: string | null;
  startedAt?: string | null;
  lastActivityAt?: string | null;
}

/** Längster Name, der aus einer Nutzer-Nachricht entsteht (danach „…“ am Wort-Ende). */
export const SESSION_LABEL_PROMPT_MAX = 60;
/** Harte Obergrenze für jeden Namen. */
export const SESSION_LABEL_MAX = 64;

const UUID_LIKE = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}(-[0-9a-f]{12})?$/i;
const TOOL_PREFIXED_ID = /^(claude|codex):[0-9a-f-]{8,}$/i;
const GOAL_PATH = /(?:^|[\s/])(?:([A-Za-z]+\d+[a-z]?)-)?([^/\s]+)\/GOAL\.md/;
const TOOL_NAME: Record<string, string> = { claude: "Claude", codex: "Codex" };


function isJunkTitle(t: string): boolean {
  return t.length < 3 || UUID_LIKE.test(t) || TOOL_PREFIXED_ID.test(t);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** „/goal …/P3-terminal/GOAL.md“ → „P3 · Terminal“, „…/auth/GOAL.md“ → „Auth“ (sonst null). */
export function auftragLabel(text: string): string | null {
  const m = GOAL_PATH.exec(text);
  if (!m) return null;
  const name = capitalize((m[2] ?? "").replace(/[-_]+/g, " ").trim());
  return m[1] ? `${m[1]} · ${name}` : name;
}

/**
 * Zerlegt in sichtbare Zeichen (Graphem-Cluster): ein Emoji wie „👩‍💻“ oder ein „ä“ aus zwei Code-Punkten zählt als
 * EIN Zeichen und wird nie mittendrin zerschnitten (sonst stünde ein kaputtes Ersatzzeichen „�“ im Namen).
 */
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("de", { granularity: "grapheme" }) : null;
function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (g) => g.segment) : Array.from(text);
}

function clamp(text: string, max: number): string {
  const chars = graphemes(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 2).join("");
  const space = cut.lastIndexOf(" ");
  const head = space > cut.length / 2 ? cut.slice(0, space) : cut;
  // Kein „Hallo, …“ – Satzzeichen am Schnitt fallen weg.
  return `${head.replace(/[\s,;:.–—-]+$/u, "")} …`;
}

/** Erste Zeile der Nachricht, ohne Slash-Befehl vorn, Leerraum zusammengezogen. */
function promptLabel(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text;
  const cleaned = firstLine
    .replace(/^\/[a-z-]+\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clamp(cleaned, SESSION_LABEL_PROMPT_MAX);
}

/** Letzter sinnvoller Ordnername: bei Worktrees („…/NyxOS/.claude/worktrees/agent-x“) das Repo. */
export function folderName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const base = cwd.split(/\/\.(?:claude|codex)\/worktrees\//)[0] ?? cwd;
  const parts = base.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** „24.09., 20:02“ (Zeitzone des Nutzers) oder null. */
export function sessionStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : dateTimeFormat({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

/** Der Name einer Session – überall derselbe (Reiter, Karte, Kopf, Brotkrümel, Briefing, Nyx). */
export function sessionLabel(s: SessionLabelInput): string {
  const title = s.title?.trim() ?? "";
  if (title && !isJunkTitle(title)) {
    const fromGoal = auftragLabel(title);
    if (fromGoal) return fromGoal;
    // Echte Titel bleiben ganz (die Oberfläche kürzt sichtbar per CSS, voller Text im Tooltip).
    return s.titleSource === "prompt" ? promptLabel(title) : title.replace(/\s+/g, " ");
  }
  const place = s.baustelleLabel?.trim() || folderName(s.cwd);
  const stamp = sessionStamp(s.startedAt ?? s.lastActivityAt);
  const when = stamp ? `Session vom ${stamp}` : null;
  if (place && when) return clamp(`${place} · ${when}`, SESSION_LABEL_MAX);
  if (when) return when;
  if (place) return `${place} · Session`;
  const tool = TOOL_NAME[s.tool ?? ""];
  return tool ? `${tool}-Session` : "Session ohne Namen";
}

// ───────────────────────────── verwaist ─────────────────────────────

/** Ab so langer Stille gilt eine leere, „wartende“ Session als verwaist. */
export const ORPHANED_AFTER_MS = 24 * 3_600_000;

export interface OrphanInput {
  state: string | null;
  /** Hat die Session einen echten Titel, gab es eine Nachricht – dann ist sie nie verwaist (optional für alte Aufrufer). */
  title?: string | null;
  parsedEventCount: number;
  tokensTotal: number;
  lastActivityAt: string | null;
  startedAt?: string | null;
}

/**
 * Geister-Session: „wartet auf dich“ seit mehr als einem Tag, aber ohne eine einzige Nachricht (kein
 * gelesener Verlauf, keine Tokens) – typischerweise ein Terminal, das gestartet und nie benutzt wurde.
 * Sie zählt NICHT zu „wartet auf dich“ (Überblick, Briefing, Nyx) und zeigt sich ruhig als „verwaist“.
 */
export function isOrphanedSession(s: OrphanInput, now: number): boolean {
  if (s.state !== "waiting") return false;
  if (s.parsedEventCount > 0 || s.tokensTotal > 0) return false;
  // ein Titel stammt aus einer Nachricht (oder von Nyx) – so eine Session ist benutzt worden,
  // auch wenn der Verlauf (noch) nicht eingelesen ist. Nur echte Geister (kein Titel, kein Verlauf) sind verwaist.
  if (s.title?.trim()) return false;
  const last = Date.parse(s.lastActivityAt ?? s.startedAt ?? "");
  if (Number.isNaN(last)) return false;
  return now - last > ORPHANED_AFTER_MS;
}

// ───────────────────────────── Sortier-Vorschläge ─────────────────────────────

const SORT_TITLE = /^Sortier-Vorschlag von (?:Nyx|Haiku): „(.+)“ → (.+?)\?\s*$/;
/** dieselbe Karte, wenn die App beim Anlegen auf Englisch stand */
const SORT_TITLE_EN = /^Sorting suggestion from Nyx: “(.+)” → (.+?)\?\s*$/;

/** „Sortier-Vorschlag von Nyx: „Titel“ → Ziel?“ → { subject, target } (sonst null). */
export function parseSortSuggestion(title: string): { subject: string; target: string } | null {
  const m = SORT_TITLE.exec(title.trim()) ?? SORT_TITLE_EN.exec(title.trim());
  return m ? { subject: m[1] ?? "", target: m[2] ?? "" } : null;
}

const normalizeSubject = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export interface BundleableItem {
  id: number;
  title: string;
  sessionKey: string | null;
}

export type InboxBundle<T extends BundleableItem> = { type: "item"; item: T } | { type: "sort"; key: string; subject: string; target: string; items: T[] };

/**
 * Gleiche Sortier-Vorschläge (gleiches Ziel, gleicher Wortlaut bis auf Groß-/Kleinschreibung und Satzzeichen)
 * werden zu EINER Karte gebündelt. Die Reihenfolge folgt dem ersten Auftreten; alle anderen Karten bleiben einzeln.
 */
export function bundleInboxItems<T extends BundleableItem>(items: T[]): InboxBundle<T>[] {
  const out: InboxBundle<T>[] = [];
  const byKey = new Map<string, Extract<InboxBundle<T>, { type: "sort" }>>();
  for (const item of items) {
    const sort = parseSortSuggestion(item.title);
    if (!sort) {
      out.push({ type: "item", item });
      continue;
    }
    const key = `${sort.target.toLowerCase()}|${normalizeSubject(sort.subject)}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.items.push(item);
      continue;
    }
    const bundle = {
      type: "sort" as const,
      key,
      subject: sort.subject,
      target: sort.target,
      items: [item],
    };
    byKey.set(key, bundle);
    out.push(bundle);
  }
  return out;
}
