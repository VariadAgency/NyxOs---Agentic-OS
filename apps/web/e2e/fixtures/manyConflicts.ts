// Künstliche Kollisionskarte mit sehr vielen Konflikten (Stresstest „kein Hänger“).
// Form wie `session_files` im echten Betrieb: absolute Pfade unter ~/projects/atlas, 2–3 Schreiber je
// Datei, verteilt auf viele Ordner und eine Handvoll Sessions.
import type { CollisionEntry } from "@nyxos/shared";

const ROOT = "/Users/alex/projects/atlas";
const AREAS = ["docs/audit-2026-09", "backend/Sources", "ios/Atlas App", "tools/nyxos/apps/web", "tools/nyxos/apps/server", "worktrees/messenger/app"];
const SESSIONS = Array.from({ length: 12 }, (_, i) => ({
  sessionKey: `claude:synth-${i.toString().padStart(2, "0")}`,
  title: `Synthetische Session ${i + 1}: ein sehr langer Titel, der in der Kachel umbrechen muss, statt herauszuragen`,
}));

/** `conflicts` Dateien mit Konflikt (≥ 2 Schreiber) + `others` ohne Konflikt. */
export function manyConflicts(conflicts = 3200, others = 800): CollisionEntry[] {
  const out: CollisionEntry[] = [];
  const at = "2026-09-25T08:00:00.000Z";
  for (let i = 0; i < conflicts + others; i++) {
    const area = AREAS[i % AREAS.length] as string;
    const sub = `Bereich-${Math.floor(i / 40) % 60}`;
    const path = `${ROOT}/${area}/${sub}/Unterordner-mit-einem-sehr-langen-Namen-${i % 7}/Datei-${i}-mit-einem-ausgesprochen-langen-Dateinamen-der-nicht-in-die-Zeile-passt.md`;
    const isConflict = i < conflicts;
    const a = SESSIONS[i % SESSIONS.length] as (typeof SESSIONS)[number];
    const b = SESSIONS[(i + 1) % SESSIONS.length] as (typeof SESSIONS)[number];
    const c = SESSIONS[(i + 5) % SESSIONS.length] as (typeof SESSIONS)[number];
    const writers = isConflict ? (i % 5 === 0 ? [a, b, c] : [a, b]) : [a];
    out.push({
      path,
      writers: writers.map((w) => ({ ...w, firstSeenAt: at })),
      readers: [{ ...c, firstSeenAt: at }],
      reservation: null,
      state: isConflict ? "conflict" : "shared-read",
      reason: isConflict ? `${writers.length} Sessions schreiben gleichzeitig` : null,
    });
  }
  return out;
}
