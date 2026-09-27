// Probe-Merge. `git merge-tree --write-tree` ist reines
// Plumbing: es liest nur Bäume aus der Objekt-Datenbank und schreibt höchstens einen NEUEN,
// unbenutzten Baum-Eintrag — Arbeitskopie, Index und HEAD bleiben immer unangetastet. Der
// Nachweis dafür (Prüfsumme vor/nach) ist trotzdem Teil des Ergebnisses, nicht nur eine Behauptung.
import { createHash } from "node:crypto";
import type { ProbeMergeResult } from "@nyxos/shared";
import { runGit } from "./exec.js";

/** Prüfsumme des Arbeitsbaums: HEAD + voller `status --porcelain=v2` (erfasst jede ungesicherte
 * Änderung). Ändert sich diese zwischen "vor" und "nach" einem Probe-Merge, ist etwas falsch. */
export async function workingTreeChecksum(root: string): Promise<string> {
  const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (await runGit(root, ["status", "--porcelain=v2", "--branch"])).stdout;
  return createHash("sha256").update(head).update("\n").update(status).digest("hex");
}

/** Parst die Konflikt-Ausgabe von `git merge-tree --write-tree` (Git ≥ 2.38): nach dem Baum-OID
 * folgt bei Konflikten eine Leerzeile, danach je Konflikt "<info-zeilen>" und am Ende, durch NUL
 * getrennt, die betroffenen Pfade — wir extrahieren robust jede Zeile, die wie ein Pfad aussieht
 * (kein führendes "info"/eine der bekannten Meldungszeilen), statt das Format strikt zu parsen. */
function parseConflictFiles(stdout: string): string[] {
  const files = new Set<string>();
  // "CONFLICT (content): Merge conflict in <pfad>" bzw. "... Merge conflict in file <pfad>" —
  // jede Zeile direkt gegen beide Formen prüfen (kein Vorfilter nötig, der versehentlich genau
  // diese Zeilen wieder ausschließt).
  for (const line of stdout.split("\n")) {
    const m = /Merge conflict in (?:file )?(.+)$/.exec(line.trim());
    if (m?.[1]) files.add(m[1].trim());
  }
  return [...files];
}

/** Ein Probe-Merge für EINEN Zweig gegen `mainBranch`. Verändert nie das Repo (nur `merge-tree
 * --write-tree`, s. Kommentar oben). `checkedAt` immer gesetzt, auch bei einem Git-Fehler
 * (z. B. Zweig lokal nicht mehr vorhanden) — dann `status: "conflict"` mit erklärendem Eintrag,
 * damit ein stiller Ausfall nie als "clean" durchgeht. */
export async function probeMerge(root: string, mainBranch: string, branch: string): Promise<ProbeMergeResult> {
  const before = await workingTreeChecksum(root);
  const result = await runGit(root, ["merge-tree", "--write-tree", mainBranch, branch]);
  const after = await workingTreeChecksum(root);
  const checkedAt = new Date().toISOString();
  if (result.ok) {
    return { branch, status: "clean", conflictFiles: [], checkedAt, workingTreeChecksumBefore: before, workingTreeChecksumAfter: after };
  }
  if (result.stderr && !result.stdout) {
    // Echter Fehler (z. B. Zweig existiert nicht) statt eines Merge-Konflikts — als Konflikt mit
    // Klartext melden, niemals als "clean" ausgeben.
    return { branch, status: "conflict", conflictFiles: [`(Probe-Merge fehlgeschlagen: ${result.stderr.trim().slice(0, 200)})`], checkedAt, workingTreeChecksumBefore: before, workingTreeChecksumAfter: after };
  }
  return { branch, status: "conflict", conflictFiles: parseConflictFiles(result.stdout), checkedAt, workingTreeChecksumBefore: before, workingTreeChecksumAfter: after };
}

export async function probeMergeAll(root: string, mainBranch: string, branches: string[]): Promise<ProbeMergeResult[]> {
  const out: ProbeMergeResult[] = [];
  for (const b of branches.filter((b) => b !== mainBranch)) out.push(await probeMerge(root, mainBranch, b));
  return out;
}
