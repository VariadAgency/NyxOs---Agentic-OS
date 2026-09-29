// Dateipfade kurz und lesbar — Dateiname fett, Ordner gedämpft und gekürzt, voller Pfad im
// Tooltip. Worktree-Pfade (`.claude/worktrees/<name>/…` bzw. `.worktrees/<name>/…`) werden auf den Teil im Repo gekürzt, der
// Worktree steht als kleines Kürzel davor.
import { t } from "@nyxos/shared";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SplitPath {
  name: string;
  /** Gekürzter Ordner (höchstens die letzten zwei Ebenen), leer = direkt im Projekt. */
  folder: string;
  /** Kurzname des Worktrees, falls die Datei in einem liegt. */
  worktree: string | null;
}

const WORKTREE_RE = /\/(?:\.claude\/worktrees|\.worktrees)\/([^/]+)\/(.*)$/;
const FOLDER_DEPTH = 2;

export function splitPath(path: string, cwd: string | null = null): SplitPath {
  let rest: string;
  let worktree: string | null = null;
  const wt = WORKTREE_RE.exec(path);
  if (wt?.[1] && wt[2] !== undefined) {
    worktree = wt[1];
    rest = wt[2];
  } else if (cwd && path.startsWith(`${cwd.replace(/\/$/, "")}/`)) {
    rest = path.slice(cwd.replace(/\/$/, "").length + 1);
  } else {
    rest = path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
  }
  const parts = rest.split("/").filter(Boolean);
  const name = parts.pop() ?? path;
  const folderParts = parts.length > FOLDER_DEPTH ? ["…", ...parts.slice(-FOLDER_DEPTH)] : parts;
  return { name, folder: folderParts.join("/"), worktree };
}

/** Kurzform eines Worktree-Namens: `agent-a0044331e886f968e` → `agent-a004…`. */
function shortWorktree(name: string): string {
  return name.length > 12 ? `${name.slice(0, 10)}…` : name;
}

/** Hebt alle Vorkommen von `needle` (ohne Groß/Klein) hervor. */
export function Highlight({ text, needle }: { text: string; needle: string }): ReactNode {
  const n = needle.trim().toLocaleLowerCase("de");
  if (!n) return text;
  const lower = text.toLocaleLowerCase("de");
  // Stellen stimmen nur, wenn die Kleinschreibung die Länge nicht ändert (z. B. „İ“ wird länger).
  if (lower.length !== text.length) return text;
  const out: ReactNode[] = [];
  let from = 0;
  let i = lower.indexOf(n, from);
  while (i >= 0) {
    if (i > from) out.push(text.slice(from, i));
    out.push(
      <mark key={i} className="rounded-sm bg-a-wait/30 px-px text-a-ink">
        {text.slice(i, i + n.length)}
      </mark>,
    );
    from = i + n.length;
    i = lower.indexOf(n, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export function FilePath({ path, cwd, needle = "", className }: { path: string; cwd?: string | null; needle?: string; className?: string }) {
  const p = splitPath(path, cwd ?? null);
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)} title={path}>
      <span className="shrink-0 font-semibold text-a-ink">
        <Highlight text={p.name} needle={needle} />
      </span>
      {(p.folder || p.worktree) && (
        <span className="min-w-0 truncate text-a-mut" data-testid="file-folder">
          {p.worktree && <span className="mr-1 rounded bg-a-indigo/15 px-1 text-a-indigo">{shortWorktree(p.worktree)}</span>}
          <Highlight text={p.folder} needle={needle} />
        </span>
      )}
    </span>
  );
}

/** „+12 −3" bzw. „3×" — nur wenn Zahlen vorhanden sind, sonst nichts (nie erfundene Werte). */
export function DiffStat({ added, removed, edits, className }: { added: number | null; removed: number | null; edits?: number | null; className?: string }) {
  if (added === null && removed === null && (edits === null || edits === undefined)) return null;
  return (
    <span className={cn("flex shrink-0 items-baseline gap-1.5 font-mono text-label tabular-nums", className)}>
      {edits !== null && edits !== undefined && edits > 1 && (
        <span className="text-a-mut" title={t("{n} Änderungen an dieser Datei", { n: edits })}>
          {edits}×
        </span>
      )}
      {added !== null && <span className="text-a-ok">+{added}</span>}
      {removed !== null && <span className="text-a-bad">−{removed}</span>}
    </span>
  );
}
