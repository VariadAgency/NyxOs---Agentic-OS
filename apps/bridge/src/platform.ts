// Betriebssystem-Unterschiede an einer Stelle: macOS und Linux (andere Systeme laufen, aber ohne Dienst).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type OsKind = "darwin" | "linux" | "other";

export function osKind(platform: NodeJS.Platform = process.platform): OsKind {
  return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "other";
}

export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** Typische Programm-Ordner, die ein Dienst (launchd/systemd) nicht im PATH hat. */
export const EXTRA_BIN_DIRS: readonly string[] = IS_MAC
  ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  : ["/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/sbin", "/sbin", "/snap/bin"];

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sucht ein Programm im PATH (plus `extra`-Ordnern) und liefert den absoluten Pfad, sonst `null`.
 * Kein `which`-Aufruf: das kostet einen Prozess und fehlt auf manchen Minimal-Systemen.
 */
export function findOnPath(name: string, path: string = process.env.PATH ?? "", extra: readonly string[] = []): string | null {
  const seen = new Set<string>();
  for (const dir of [...path.split(delimiter), ...extra]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

/** Wie `findOnPath`, sucht aber immer auch in den typischen Programm-Ordnern des Systems. */
export function findBin(name: string, path: string = process.env.PATH ?? ""): string | null {
  return findOnPath(name, path, EXTRA_BIN_DIRS);
}

/**
 * Pfadvergleich passend zum Dateisystem: macOS (APFS/HFS+) unterscheidet Groß-/Kleinschreibung
 * standardmäßig nicht, Linux schon.
 */
export function foldCase(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? p.toLowerCase() : p;
}
