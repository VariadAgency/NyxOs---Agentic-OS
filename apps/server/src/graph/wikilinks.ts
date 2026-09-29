// PG: Auflösung von `[[Wiki-Links]]` wie in Obsidian (Standard-Einstellung „kürzester Pfad").
// Ziel mit `/` → Pfad-Endung muss passen; sonst Dateiname. Mehrere Treffer → erst derselbe Ordner
// wie die verlinkende Notiz, dann der kürzeste Pfad, dann alphabetisch (deterministisch).

const stripMd = (p: string) => p.replace(/\.md$/i, "");
const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

export type Resolver = (target: string, fromPath: string) => string | null;

export function createResolver(paths: Iterable<string>): Resolver {
  const byBase = new Map<string, string[]>();
  const byFull = new Map<string, string>();
  for (const path of paths) {
    const key = stripMd(path).toLowerCase();
    byFull.set(key, path);
    const base = key.slice(key.lastIndexOf("/") + 1);
    const list = byBase.get(base);
    if (list) list.push(path);
    else byBase.set(base, [path]);
  }
  for (const list of byBase.values()) list.sort((a, b) => a.length - b.length || a.localeCompare(b));

  return (rawTarget, fromPath) => {
    const target = stripMd(rawTarget.trim().replace(/^\.?\//, "")).toLowerCase();
    if (!target) return null;
    const full = byFull.get(target);
    if (full) return full;
    const base = target.slice(target.lastIndexOf("/") + 1);
    const candidates = byBase.get(base);
    if (!candidates || candidates.length === 0) return null;
    const matching = target.includes("/") ? candidates.filter((c) => stripMd(c).toLowerCase().endsWith("/" + target)) : candidates;
    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0] ?? null;
    const fromDir = dirOf(fromPath).toLowerCase();
    return matching.find((c) => dirOf(c).toLowerCase() === fromDir) ?? matching[0] ?? null;
  };
}
