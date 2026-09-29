// "Git-Wächter (Grundform)": Commit mit [<Eintrag-Kürzel>] im Text → Verknüpfung +
// Verlaufseintrag. Die volle Git-Seite (Zweige, Konflikte, automatisches Nachziehen) kommt erst in P5
// — hier nur das Erkennen + Verknüpfen einer einzelnen Commit-Nachricht, damit die Automatik schon
// funktioniert, sobald P5 den echten `git log`-Feed anschließt.
import { eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries } from "../db/schema.js";
import { linkObjects } from "./store.js";

/** Kürzel in eckigen Klammern, z. B. `[BUG-42]`, `[a02]`, `[17]`. Mehrere pro Commit möglich. */
const TOKEN_RE = /\[([A-Za-z0-9][A-Za-z0-9_-]{0,19})\]/g;

export function extractEntryTokens(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(TOKEN_RE)) if (m[1]) out.push(m[1]);
  return [...new Set(out)];
}

export interface ApplyCommitOptions {
  sha: string;
  message: string;
}

/** Ordnet die Kürzel einer Commit-Nachricht bestehenden Einträgen zu (per numerischer ID oder
 * `sourceId`, groß-/kleinschreibungsunabhängig) und verknüpft sie mit dem Commit. Unbekannte Kürzel
 * werden ignoriert (kein Fehler — die meisten Commits haben gar kein Kürzel). */
export async function applyCommitToEntries(db: Db, opts: ApplyCommitOptions): Promise<number[]> {
  const tokens = extractEntryTokens(opts.message);
  if (tokens.length === 0) return [];
  const matched: number[] = [];
  for (const token of tokens) {
    const asId = Number(token);
    const rows = await db
      .select({ id: entries.id })
      .from(entries)
      .where(Number.isInteger(asId) && asId > 0 ? or(eq(entries.id, asId), eq(entries.sourceId, token)) : eq(entries.sourceId, token));
    for (const r of rows) {
      await linkObjects(db, { fromType: "entry", fromId: String(r.id), toType: "commit", toId: opts.sha, relation: "commit", source: "git-waechter" });
      matched.push(r.id);
    }
  }
  return [...new Set(matched)];
}
