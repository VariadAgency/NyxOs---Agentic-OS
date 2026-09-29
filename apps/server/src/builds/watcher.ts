// Build-Wächter — "nach jeder Stop-Runde einer Auftrags-Session": sobald
// ein `Stop`- (Claude) oder `task_complete`-Ereignis (Codex) durch den Ingest-Pfad kommt, wird eine
// passende Prüfung eingereiht. Reine, kleine Funktion — der eigentliche Seiteneffekt (Warteschlange
// befüllen) bleibt in `app.ts` einzeilig eingebunden.
import type { IngestItem } from "@nyxos/shared";
import { sessionKey as buildSessionKey } from "../store.js";
import { detectBuild } from "./detect.js";
import type { BuildQueue } from "./queue.js";

const STOP_HOOK_EVENTS = new Set(["Stop", "task_complete"]);

export interface StopSignal {
  sessionKey: string;
  cwd: string | null;
}

/** Filtert aus einem Ingest-Batch alle "Runde ist zu"-Hook-Ereignisse (eine Session kann mehrere
 * enthalten — nur die letzte pro Session zählt für den `cwd`, aber jede löst höchstens einen
 * zusätzlichen Lauf aus, Dubletten sind harmlos: `submit` legt immer eine neue Zeile an). */
export function stopSignalsFromBatch(items: IngestItem[]): StopSignal[] {
  const out: StopSignal[] = [];
  for (const item of items) {
    if (item.type !== "event" || item.event.source !== "hook") continue;
    const data = item.event.data as Record<string, unknown>;
    if (typeof data.event !== "string" || !STOP_HOOK_EVENTS.has(data.event)) continue;
    out.push({ sessionKey: buildSessionKey(item.event.tool, item.event.sessionId), cwd: typeof data.cwd === "string" ? data.cwd : null });
  }
  return out;
}

/** Reiht für jedes Stop-Signal, dessen Arbeitsordner zu einer bekannten Art passt, einen Lauf ein.
 * Kein Treffer (`detectBuild` liefert `null`, z. B. Planungs-/Audit-Ordner) → nichts zu tun. */
export async function queueBuildsForStopSignals(queue: BuildQueue, buildsDir: string, signals: StopSignal[]): Promise<number[]> {
  const ids: number[] = [];
  for (const signal of signals) {
    const plan = detectBuild(signal.cwd, buildsDir);
    if (!plan) continue;
    const id = await queue.submit({ sessionKey: signal.sessionKey, kind: plan.kind, command: plan.command, cwd: plan.cwd, derivedDataPath: plan.derivedDataPath, trigger: "stop_hook" });
    ids.push(id);
  }
  return ids;
}
