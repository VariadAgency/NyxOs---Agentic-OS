// Diffs in einer gemeinsamen Zeilenform (`DiffLine`) — aus `git diff`-Text, aus Claudes
// `structuredPatch` (echte Zeilennummern) und als Rückfall aus zwei Textständen (Edit ohne Ergebnis).
import type { DiffFile, DiffLine } from "./conflicts.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** Text von `git diff`/`git show` bzw. einem Codex-Patch in Dateien + Zeilen zerlegen. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const ensureFile = (): DiffFile => {
    if (!file) {
      file = { oldPath: null, newPath: null, binary: false, lines: [] };
      files.push(file);
    }
    return file;
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, binary: false, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      const f = ensureFile();
      f.oldPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const f = ensureFile();
      f.newPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("Binary files ")) {
      ensureFile().binary = true;
      continue;
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      inHunk = true;
      ensureFile().lines.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    const f = ensureFile();
    if (line.startsWith("+")) f.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) f.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (line.startsWith(" ")) f.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    else if (line === "") continue; // Leerzeile am Textende
    else inHunk = false; // Kopfzeile der nächsten Datei (index …, new file mode …)
  }
  return files;
}

export interface StructuredHunk {
  oldStart: number;
  oldLines?: number;
  newStart: number;
  newLines?: number;
  lines: string[];
}

/** Claudes `toolUseResult.structuredPatch` → Zeilen mit echten Zeilennummern. */
export function structuredPatchToLines(hunks: StructuredHunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    out.push({ kind: "hunk", oldNo: null, newNo: null, text: `@@ -${h.oldStart},${h.oldLines ?? 0} +${h.newStart},${h.newLines ?? 0} @@` });
    for (const l of h.lines) {
      if (l.startsWith("+")) out.push({ kind: "add", oldNo: null, newNo: newNo++, text: l.slice(1) });
      else if (l.startsWith("-")) out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: l.slice(1) });
      else if (l.startsWith("\\")) continue;
      else out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: l.startsWith(" ") ? l.slice(1) : l });
    }
  }
  return out;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Neue Datei: jede Zeile hinzugefügt. */
export function addedLines(content: string, start = 1): DiffLine[] {
  return splitLines(content).map((text, i) => ({ kind: "add", oldNo: null, newNo: start + i, text }));
}

/** Gelöschte Datei: jede Zeile entfernt. */
export function removedLines(content: string, start = 1): DiffLine[] {
  return splitLines(content).map((text, i) => ({ kind: "del", oldNo: start + i, newNo: null, text }));
}

/** Größte LCS-Tabelle (Zeilen × Zeilen), die noch zeilengenau verglichen wird. */
const MAX_LCS_CELLS = 2_000_000;

/**
 * Zeilen-Diff zweier Textstände (Rückfall, wenn kein `structuredPatch` vorliegt): klassisches LCS,
 * gemeinsame Anfangs-/Endzeilen vorher abgeschnitten. Zu groß → alles alt entfernt, alles neu dazu.
 */
export function lineDiff(before: string, after: string, start = 1, maxCells = MAX_LCS_CELLS): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = [];
  let oldNo = start;
  let newNo = start;
  for (let i = 0; i < head; i++) out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[i] as string });
  if (midA.length * midB.length > maxCells) {
    for (const t of midA) out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: t });
    for (const t of midB) out.push({ kind: "add", oldNo: null, newNo: newNo++, text: t });
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] = midA[i] === midB[j] ? (table[(i + 1) * (m + 1) + j + 1] as number) + 1 : Math.max(table[(i + 1) * (m + 1) + j] as number, table[i * (m + 1) + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: midA[i] as string });
        i++;
        j++;
      } else if (i < n && (j >= m || (table[(i + 1) * (m + 1) + j] as number) >= (table[i * (m + 1) + j + 1] as number))) {
        // Entfernen vor Hinzufügen — liest sich wie `git diff`.
        out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: midA[i] as string });
        i++;
      } else {
        out.push({ kind: "add", oldNo: null, newNo: newNo++, text: midB[j] as string });
        j++;
      }
    }
  }
  for (let k = a.length - tail; k < a.length; k++) out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[k] as string });
  return out;
}

/** Eine Zeile der Nebeneinander-Ansicht: links alt, rechts neu (je null = leer). */
export interface SplitRow {
  kind: "hunk" | "pair";
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Zeilen für „nebeneinander": Entfernen/Hinzufügen-Blöcke paarweise nebeneinander legen. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "hunk") rows.push({ kind: "hunk", left: l, right: l });
      else rows.push({ kind: "pair", left: l, right: l });
    }
  }
  flush();
  return rows;
}
