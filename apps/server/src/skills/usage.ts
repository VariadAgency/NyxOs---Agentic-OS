// Skill-Nutzung aus den Session-Ereignissen – inkrementell (Lese-Stand `skill_scan_state`), nie im Kopf der
// SKILL.md (wie Hermes `skill_usage.py`). Zwei Formen stehen im Verlauf (an des Nutzers echten Protokollen geprüft):
//   - Claude ruft den Skill selbst:  `tool_call` mit `name = "Skill"`, Ziel = Skill-Name (`parse/claude.ts`)
//   - Der Nutzer tippt `/ideen`:         `prompt` mit `command = "/ideen"` (eingebaute Befehle wie /compact kommen
//                                     als `system` an und zählen darum nie)
// Befehle zählen nur, wenn ein Skill so heißt (sonst wären `/goal`, `/effort` … Kacheln).
//
// Danach die Heuristik für Vorschläge: Was passierte in den 15 Minuten nach dem Aufruf in derselben Session?
// Signale nach der Hermes-Lernschleife (`background_review.py`, MIT): gescheiterter Aufruf, Abbruch durch
// der Nutzer, Korrektur („nein“, „falsch“, „zu lang“ …), gehäufte Fehler.
import { isObj, parseJsonLine, skillKeyFrom, t, type SkillSignal } from "@nyxos/shared";
import { and, asc, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { archive, sessionEvents, skillScanState, skillUses } from "../db/schema.js";
import { readGzLines } from "../transcript.js";

const SCAN_BATCH = 5000;
const EPOCH = "1970-01-01T00:00:00.000Z";
/**
 * Stand des einmaligen Nachzählens. Ist `skill_scan_state.backfill_version` kleiner, liest der nächste
 * Lauf ALLE Ereignisse neu (mit der verbesserten Namens-Ableitung) und holt Skill-Aufrufe ohne Namen aus dem
 * Session-Archiv nach. Doppelte fängt der Primärschlüssel `skill_uses.event_id` ab. Neue Ableitungs-Regeln →
 * Zahl hochsetzen.
 */
export const SKILL_BACKFILL_VERSION = 1;
/** So lange nach dem Aufruf wird geschaut – danach gilt das Fenster als vollständig. */
export const SIGNAL_WINDOW_MS = 15 * 60_000;
const SIGNAL_MAX_EVENTS = 40;
const CHECK_BATCH = 200;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

/**
 * Skill-Name aus einem Ereignis. Formen im Verlauf (an der Live-DB geprüft):
 *   - `tool_call` `Skill` mit `target` (Parser ab P2-3) – ältere Ereignisse haben `target: null` und keinen Namen;
 *     falls die Eingabe mitkommt: `input.skill` bzw. die ältere Form `input.command`
 *   - `prompt` mit `command: "/ideen"` (getippter Befehl) oder als reine Textzeile `/ideen …`
 * Ob ein Befehl wirklich ein Skill ist, entscheidet erst die Kachel (nur bekannte Skills zählen).
 */
export function skillNameFromEvent(kind: string, data: Record<string, unknown>): string | null {
  if (kind === "tool_call") {
    if (data.name !== "Skill") return null;
    const input = isObj(data.input) ? data.input : {};
    return skillKeyFrom(data.target) ?? skillKeyFrom(input.skill) ?? skillKeyFrom(input.command) ?? skillKeyFrom(data.skill) ?? skillKeyFrom(data.commandName);
  }
  if (kind === "prompt") {
    if (typeof data.command === "string") return skillKeyFrom(data.command);
    // Nur eine einzelne getippte Zeile „/name …“ – nie ein Schrägstrich mitten im Text oder ein Pfad.
    if (typeof data.text === "string" && /^\/[a-z0-9][\w.:-]*(\s[^\n]*)?$/i.test(data.text.trim())) return skillKeyFrom(data.text);
  }
  return null;
}

/** Skill-Name aus einer Roh-Zeile des Claude-Protokolls für genau diesen Aufruf (Aufruf- oder Ergebnis-Zeile). */
export function skillFromTranscriptLine(line: string, toolUseId: string): string | null {
  if (!line.includes(toolUseId)) return null;
  const o = parseJsonLine(line);
  if (!o) return null;
  const msg = isObj(o.message) ? o.message : {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "tool_use" && c.id === toolUseId && isObj(c.input)) {
      const name = skillKeyFrom(c.input.skill) ?? skillKeyFrom(c.input.command);
      if (name) return name;
    }
    if (c.type === "tool_result" && c.tool_use_id === toolUseId && isObj(o.toolUseResult)) {
      const name = skillKeyFrom(o.toolUseResult.commandName);
      if (name) return name;
    }
  }
  return null;
}

/**
 * Sucht in EINER Archiv-Datei die Namen zu allen noch offenen `toolUseId`s (trägt Funde in `found` ein).
 * Liest gestreamt über `readGzLines` (eigene `error`-Listener – ein nacktes `.pipe()` würde bei ENOENT den
 * ganzen Prozess abschießen, s. transcript.ts) und hört auf, sobald alles gefunden ist.
 */
async function namesFromArchiveFile(storedPath: string, wanted: string[], found: Map<string, string>): Promise<void> {
  try {
    for await (const line of readGzLines(storedPath)) {
      for (const id of wanted) {
        if (found.has(id)) continue;
        const name = skillFromTranscriptLine(line, id);
        if (name) found.set(id, name);
      }
      if (wanted.every((id) => found.has(id))) return;
    }
  } catch {
    // Kaputte oder fehlende Archiv-Datei: diese Aufrufe bleiben ohne Namen (ehrlich nicht gezählt).
  }
}

/** Skill-Aufrufe ohne Namen (ältere Ereignisse) aus dem Session-Archiv nachholen. Liefert die Zahl neuer Zeilen. */
async function backfillFromArchive(db: Db): Promise<number> {
  const open = rowsOf<{ id: string; session_key: string; ts: string; data: Record<string, unknown> }>(
    await db.execute(sql`
      select e.id, e.session_key, e.ts, e.data from session_events e
      left join skill_uses u on u.event_id = e.id
      where e.kind = 'tool_call' and e.data->>'name' = 'Skill' and u.event_id is null
      order by e.session_key, e.ts
    `),
  );
  const bySession = new Map<string, typeof open>();
  for (const e of open) {
    if (typeof e.data.toolUseId !== "string" || !e.data.toolUseId) continue;
    const list = bySession.get(e.session_key) ?? [];
    list.push(e);
    bySession.set(e.session_key, list);
  }
  let inserted = 0;
  for (const [sessionKey, events] of bySession) {
    // Die Pfade stammen aus der Archiv-Tabelle (vom Server selbst unter dem Archiv-Ordner angelegt), nie aus Ereignisdaten.
    const files = (await db.select({ path: archive.path, storedPath: archive.storedPath }).from(archive).where(eq(archive.sessionKey, sessionKey))).filter((f) => f.path.endsWith(".jsonl"));
    // Hauptdatei und die Subagent-Dateien der gesuchten Aufrufe zuerst, der Rest danach – jede Datei höchstens einmal.
    const agents = new Set(events.map((e) => (typeof e.data.agentId === "string" ? e.data.agentId : null)));
    const likely = (p: string) => (p.includes("/subagents/") ? [...agents].some((a) => a !== null && p.endsWith(`/agent-${a}.jsonl`)) : agents.has(null));
    const ordered = [...files.filter((f) => likely(f.path)), ...files.filter((f) => !likely(f.path))];
    const wanted = events.map((e) => e.data.toolUseId as string);
    const found = new Map<string, string>();
    for (const f of ordered) {
      await namesFromArchiveFile(f.storedPath, wanted, found);
      if (wanted.every((id) => found.has(id))) break;
    }
    const values = events.flatMap((e) => {
      const toolUseId = e.data.toolUseId as string;
      const skill = found.get(toolUseId);
      return skill ? [{ eventId: e.id, skill, sessionKey, ts: new Date(e.ts).toISOString(), via: "tool", toolUseId }] : [];
    });
    if (values.length === 0) continue;
    const res = await db.insert(skillUses).values(values).onConflictDoNothing().returning({ id: skillUses.eventId });
    inserted += res.length;
  }
  return inserted;
}

/** Laufende Scans je DB: Takt und Abruf teilen sich einen Lauf (kein doppeltes Nachzählen). */
const scanning = new WeakMap<Db, Promise<number>>();

/** Neue Skill-Aufrufe seit dem letzten Lauf in `skill_uses` übernehmen. Liefert die Zahl neuer Zeilen. */
export function scanSkillUses(db: Db): Promise<number> {
  const running = scanning.get(db);
  if (running) return running.then(() => 0);
  const run = scanOnce(db).finally(() => scanning.delete(db));
  scanning.set(db, run);
  return run;
}

async function scanOnce(db: Db): Promise<number> {
  const [state] = await db.select().from(skillScanState).where(eq(skillScanState.id, 1)).limit(1);
  const backfill = (state?.backfillVersion ?? 0) < SKILL_BACKFILL_VERSION;
  const lastSeen = state?.lastReceivedAt ? new Date(state.lastReceivedAt).toISOString() : EPOCH;
  const since = backfill ? EPOCH : lastSeen;
  let inserted = 0;
  let cursor = since;
  for (;;) {
    // `>=` statt `>`: gleiche Empfangszeit mehrerer Ereignisse – Doppelte fängt der Primärschlüssel ab.
    const rows = rowsOf<{ id: string; session_key: string; ts: string; kind: string; data: Record<string, unknown>; received_at: string }>(
      await db.execute(sql`
        select id, session_key, ts, kind, data, received_at from session_events
        where received_at >= ${cursor}
          and ((kind = 'tool_call' and data->>'name' = 'Skill')
            or (kind = 'prompt' and (data ? 'command' or ltrim(data->>'text') like '/%')))
        order by received_at asc
        limit ${SCAN_BATCH}
      `),
    );
    if (rows.length === 0) break;
    const values = rows
      .map((r) => {
        const isTool = r.kind === "tool_call";
        const skill = skillNameFromEvent(r.kind, r.data);
        if (!skill) return null;
        return {
          eventId: r.id,
          skill,
          sessionKey: r.session_key,
          ts: new Date(r.ts).toISOString(),
          via: isTool ? "tool" : "command",
          toolUseId: isTool && typeof r.data.toolUseId === "string" ? r.data.toolUseId : null,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (values.length > 0) {
      const res = await db.insert(skillUses).values(values).onConflictDoNothing().returning({ id: skillUses.eventId });
      inserted += res.length;
    }
    const last = rows.at(-1)?.received_at;
    const next = last ? new Date(last).toISOString() : cursor;
    if (rows.length < SCAN_BATCH || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  if (backfill) inserted += await backfillFromArchive(db);
  // Beim Nachzählen nie hinter den alten Lese-Stand zurückfallen.
  if (cursor < lastSeen) cursor = lastSeen;
  if (backfill || cursor !== since || !state) {
    const set = { lastReceivedAt: cursor, backfillVersion: SKILL_BACKFILL_VERSION };
    await db.insert(skillScanState).values({ id: 1, ...set }).onConflictDoUpdate({ target: skillScanState.id, set });
  }
  return inserted;
}

/** Korrektur-Wörter vom Nutzer direkt nach einem Skill (Hermes: „Frustration signals … are FIRST-CLASS“). */
const CORRECTION_RE =
  /(^|[\s,.!?„"])(nein|falsch|nicht so|so nicht|stimmt nicht|zu lang|zu kurz|zu viel|funktioniert nicht|geht nicht|klappt nicht|schon wieder|immer noch|hör auf|lass das|das war nicht|warum hast du|nochmal|noch mal von vorn|rückgängig)([\s,.!?“"]|$)/i;
const INTERRUPT_RE = /\[Request interrupted by user/;

export interface SignalFinding {
  signal: SkillSignal;
  /** Wörtliches Zitat (gekürzt) – Beleg für den Vorschlag. */
  evidence: string;
  /** Die Nutzer-Texte und Fehler nach dem Aufruf, für Nyx. */
  context: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Heuristik: was folgte in derselben Session auf den Skill-Aufruf? `null` = nichts Auffälliges. */
export function detectSignal(use: { toolUseId: string | null }, events: { kind: string; data: Record<string, unknown> }[]): SignalFinding | null {
  const context: string[] = [];
  let callFailed = false;
  let errors = 0;
  let interrupted: string | null = null;
  let correction: string | null = null;
  for (const e of events) {
    // Ein weiterer Skill-Aufruf beginnt: ab hier gehört das Geschehen zu ihm.
    if (e.kind === "tool_call" && e.data.name === "Skill") break;
    if (e.kind === "tool_result" && e.data.isError === true) {
      errors++;
      if (use.toolUseId && e.data.toolUseId === use.toolUseId) callFailed = true;
      context.push("[Werkzeug-Fehler]");
    }
    if (e.kind === "prompt" && typeof e.data.text === "string") {
      const text = e.data.text.trim();
      if (!text) continue;
      context.push(`Nutzer: ${clip(text, 400)}`);
      if (INTERRUPT_RE.test(text)) interrupted ??= text;
      else if (CORRECTION_RE.test(text)) correction ??= text;
    }
  }
  const firstUserText = context.find((c) => c.startsWith("Nutzer: ") && !INTERRUPT_RE.test(c))?.slice("Nutzer: ".length) ?? null;
  if (callFailed) return { signal: "fehler_aufruf", evidence: clip(firstUserText ?? t("Der Aufruf des Skills ist gescheitert."), 280), context };
  if (interrupted) return { signal: "abbruch", evidence: clip(correction ?? firstUserText ?? t("Der Nutzer hat die Antwort abgebrochen."), 280), context };
  if (correction) return { signal: "korrektur", evidence: clip(correction, 280), context };
  if (errors >= 3) return { signal: "fehler_danach", evidence: clip(firstUserText ?? t("{n} Fehler direkt nach dem Skill.", { n: errors }), 280), context };
  return null;
}

export interface UncheckedUse {
  eventId: string;
  skill: string;
  sessionKey: string;
  ts: string;
  toolUseId: string | null;
}

/** Aufrufe, deren 15-Minuten-Fenster vorbei ist und die noch nicht geprüft wurden. */
export async function uncheckedUses(db: Db, now: number): Promise<UncheckedUse[]> {
  return db
    .select({ eventId: skillUses.eventId, skill: skillUses.skill, sessionKey: skillUses.sessionKey, ts: skillUses.ts, toolUseId: skillUses.toolUseId })
    .from(skillUses)
    .where(and(isNull(skillUses.checkedAt), lt(skillUses.ts, new Date(now - SIGNAL_WINDOW_MS).toISOString())))
    .orderBy(asc(skillUses.ts))
    .limit(CHECK_BATCH);
}

export async function eventsAfter(db: Db, use: UncheckedUse): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  const until = new Date(Date.parse(use.ts) + SIGNAL_WINDOW_MS).toISOString();
  const rows = await db
    .select({ kind: sessionEvents.kind, data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionKey, use.sessionKey), gt(sessionEvents.ts, use.ts), lte(sessionEvents.ts, until)))
    .orderBy(asc(sessionEvents.ts))
    .limit(SIGNAL_MAX_EVENTS);
  return rows.map((r) => ({ kind: r.kind, data: (r.data ?? {}) as Record<string, unknown> }));
}

export async function markChecked(db: Db, eventId: string, signal: SkillSignal | null): Promise<void> {
  await db.update(skillUses).set({ checkedAt: new Date().toISOString(), signal }).where(eq(skillUses.eventId, eventId));
}
