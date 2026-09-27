// Push — Anlass "Session wartet auf dich" ("nach 2 Min ohne Reaktion am
// Mac"). Läuft im bestehenden 60-s-Ticker mit (s. app.ts `tickStates`/`retickIdleStates`), braucht
// also kein eigenes Intervall. Dedupe: pro Warte-Episode (identifiziert durch `stateObservedAt`,
// den Zeitpunkt des letzten Zustandswechsels) höchstens eine Mitteilung.
import { sessionLabel, t, type PushSettings } from "@nyxos/shared";
import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog, sessions } from "../db/schema.js";
import { notify } from "./dispatcher.js";
import type { NtfySender } from "./ntfy.js";
import { countedSession } from "../db/visible.js";

export function sessionPath(row: { id: string; sessionId: string; categoryArt: string | null; categoryBaustelleSlug: string | null }): string {
  const art = row.categoryArt ?? "unsortiert";
  const baustelle = row.categoryBaustelleSlug ?? "_";
  return `/sessions/${art}/${baustelle}/${row.sessionId}`;
}

export async function checkWaitingSessions(db: Db, sender: NtfySender, settings: PushSettings, now = new Date()): Promise<string[]> {
  if (settings.waitingAfterSeconds < 0) return [];
  const threshold = new Date(now.getTime() - settings.waitingAfterSeconds * 1000).toISOString();
  const rows = await db
    .select({
      id: sessions.id,
      sessionId: sessions.sessionId,
      title: sessions.title,
      titleSource: sessions.titleSource,
      tool: sessions.tool,
      cwd: sessions.cwd,
      startedAt: sessions.startedAt,
      lastActivityAt: sessions.lastActivityAt,
      categoryBaustelleLabel: sessions.categoryBaustelleLabel,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      stateObservedAt: sessions.stateObservedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.state, "waiting"), lt(sessions.stateObservedAt, threshold), countedSession));

  const notified: string[] = [];
  for (const row of rows) {
    if (row.stateObservedAt) {
      const [already] = await db
        .select({ id: pushLog.id })
        .from(pushLog)
        .where(and(eq(pushLog.kind, "session_waiting"), eq(pushLog.sessionKey, row.id), gte(pushLog.sentAt, row.stateObservedAt)))
        .limit(1);
      if (already) continue;
    }
    // derselbe Name wie überall (`sessionLabel`): nie die rohe Kennung, und eine erste Nachricht
    // steht nur gekürzt (60 Zeichen) auf dem Sperrbildschirm – nicht der ganze Prompt.
    const result = await notify(
      { kind: "session_waiting", title: t("Wartet auf dich"), message: sessionLabel({ ...row, baustelleLabel: row.categoryBaustelleLabel }), path: sessionPath(row), sessionKey: row.id },
      { db, sender, settings, now },
    );
    if (result.sent) notified.push(row.id);
  }
  return notified;
}
