// Eine von der NyxOS gestartete Session sofort eintragen (Claude bekommt die Session-ID vorab per
// `--session-id` → die Session erscheint in der Liste, bevor die erste Verlaufszeile geschrieben ist; Codex
// erscheint mit seiner ersten Zeile). Gemeinsam für „Neue Session“ (routes/terminal.ts) und die Opus-Aufträge
// der Skill-Bibliothek (skills/jobs.ts). „Temporär“ bleibt beim Server.
import type { StartResult } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { sessionKey } from "../store.js";
import { markStartedTemporary } from "../temporary.js";

/** Liefert den Session-Schlüssel (`claude:<id>`) oder `null`, solange die ID noch nicht bekannt ist (Codex). */
export async function recordStartedSession(db: Db, opts: { started: StartResult; cwd: string; machineId: string | null; temporary: boolean }): Promise<string | null> {
  const { started, cwd, machineId, temporary } = opts;
  if (!started.sessionId) {
    if (temporary) await markStartedTemporary(db, { key: null, tmuxName: started.tmuxName });
    return null;
  }
  const key = sessionKey(started.tool, started.sessionId);
  const now = new Date().toISOString();
  await db
    .insert(sessions)
    .values({
      id: key,
      tool: started.tool,
      sessionId: started.sessionId,
      machineId,
      cwd,
      status: "running",
      state: "running",
      startedAt: now,
      lastActivityAt: now,
      tmuxName: started.tmuxName,
      attachable: true,
      startedVia: "nyxos",
      terminalObservedAt: now,
    })
    .onConflictDoUpdate({ target: sessions.id, set: { tmuxName: started.tmuxName, attachable: true, startedVia: "nyxos", terminalObservedAt: now } });
  if (temporary) await markStartedTemporary(db, { key, tmuxName: started.tmuxName });
  return key;
}
