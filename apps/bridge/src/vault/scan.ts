import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { VaultNote } from "@nyxos/shared";
import { parseNote } from "./parse.js";

/** Ordner, die nie zum Vault-Inhalt gehören (zusätzlich zu allen versteckten `.xyz`-Ordnern). */
const IGNORED_DIRS = new Set(["node_modules"]);
const MAX_PATH = 1024;

/** true = dieser Pfad (relativ zur Vault-Wurzel, beliebiger Trenner) wird nie gelesen. */
export function isIgnoredRel(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || IGNORED_DIRS.has(seg));
}

export const isNoteFile = (name: string) => /\.md$/i.test(name);

interface CacheEntry {
  mtimeMs: number;
  size: number;
  note: VaultNote;
}

/**
 * Liest alle Notizen eines Vaults — nur lesend, folgt keinen Symlinks. Merkt sich je Pfad
 * Änderungszeit + Größe, damit ein erneuter Vollabgleich unveränderte Dateien nicht neu parst.
 */
export class VaultScanner {
  private readonly cache = new Map<string, CacheEntry>();
  /** Wie oft wirklich geparst wurde (für Tests/Status). */
  parsedCount = 0;
  /** Lesefehler im letzten `scanAll` (Wurzel fehlt, Ordner/Datei nicht lesbar) — dann gilt der
   * Scan als unvollständig und darf auf dem Server nichts löschen. */
  lastScanErrors = 0;

  constructor(readonly root: string) {}

  get size(): number {
    return this.cache.size;
  }

  async scanAll(): Promise<VaultNote[]> {
    const seen = new Set<string>();
    const notes: VaultNote[] = [];
    let errors = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        // Unterordner während des Scans gelöscht: normal. Wurzel weg oder nicht lesbar: Fehler.
        if (dir === this.root || (e as NodeJS.ErrnoException).code !== "ENOENT") errors++;
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && isNoteFile(e.name)) {
          const rel = this.rel(abs);
          const r = await this.read(rel);
          if (r.kind === "note") {
            seen.add(rel);
            notes.push(r.note);
          } else if (r.kind === "error") {
            errors++;
            seen.add(rel); // Zwischenspeicher behalten — die Datei gibt es ja noch
          }
        }
        // Symlinks (isSymbolicLink) und alles andere: bewusst ausgelassen
      }
    };
    await walk(this.root);
    this.lastScanErrors = errors;
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);
    return notes;
  }

  /** Liest eine Notiz (relativer Pfad) — null, wenn sie fehlt, kein normales File ist oder ignoriert wird. */
  async readRel(rel: string): Promise<VaultNote | null> {
    const r = await this.read(rel);
    return r.kind === "note" ? r.note : null;
  }

  /** Wie `readRel`, unterscheidet aber „gibt es nicht" (darf gelöscht werden) von „Lesefehler"
   * (darf NICHT als gelöscht gemeldet werden). */
  async read(rel: string): Promise<{ kind: "note"; note: VaultNote } | { kind: "gone" } | { kind: "error" }> {
    const posixRel = rel.split(sep).join("/");
    if (!isNoteFile(posixRel) || isIgnoredRel(posixRel) || posixRel.length > MAX_PATH) return { kind: "gone" };
    const abs = join(this.root, ...posixRel.split("/"));
    try {
      const st = await lstat(abs);
      if (!st.isFile()) {
        this.cache.delete(posixRel);
        return { kind: "gone" };
      }
      const hit = this.cache.get(posixRel);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { kind: "note", note: hit.note };
      const content = await readFile(abs, "utf8");
      const note = parseNote(posixRel, content, st.mtimeMs, st.size);
      this.parsedCount++;
      this.cache.set(posixRel, { mtimeMs: st.mtimeMs, size: st.size, note });
      return { kind: "note", note };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache.delete(posixRel);
        return { kind: "gone" };
      }
      return { kind: "error" };
    }
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }
}
