// Menü „⋯“ an jedem Nyx-Faden. Löschen (echt, samt Nachrichten – wie der Ablauf temporärer
// Fäden; die Rückfrage stellt die Oberfläche), Zusammenfassen (Nyx fasst zusammen → Karte im Faden),
// Zu Auftrag machen (Aufgabe über den Eintrags-Speicher wie `POST /api/entries`, Link-Karte zurück) und
// In Obsidian ablegen (Brücke `vault_note`, die Brücke wählt Ordner und Dateinamen selbst).
// Archivieren läuft über `PATCH /api/haiku/threads/:id` (routes/haiku.ts).
import { BRIDGE_CAP_VAULT_NOTE, type HaikuErrorCode, type HaikuMessage, type HaikuNoteKind, type HaikuSource, type HaikuThreadObsidianResult, type HaikuThreadTaskResult, type VaultNoteResult, t, timeZone } from "@nyxos/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { entries, haikuMessages, haikuThreads } from "../db/schema.js";
import { applyMaturity, createEntry } from "../entries/store.js";
import type { GraphService } from "../graph/service.js";
import { entryHref } from "../haiku/entriesBridge.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { localStamp } from "../haiku/tools.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";
import type { LiveHub } from "../live.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";

export interface ThreadActionDeps {
  db: Db;
  runtime: HaikuRuntime;
  hub: LiveHub;
  bridgeHub: BridgeHub | null;
  graph?: GraphService;
  notify: (what: string) => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  toMessage: (r: typeof haikuMessages.$inferSelect) => HaikuMessage;
}

/** Aus diesem Verlauf fasst Nyx zusammen (jüngste Zeichen zählen, ältere werden abgeschnitten). */
const SUMMARY_INPUT_CHARS = 16_000;
/** `CreateEntrySchema.description` erlaubt 10 000 Zeichen – die Aufgabe hält sich daran. */
const TASK_DESCRIPTION_CHARS = 10_000;
const TASK_TITLE_CHARS = 200;
const OBSIDIAN_TIMEOUT_MS = 15_000;

export const SUMMARY_SYSTEM = `Du fasst ein Gespräch zwischen dem Nutzer und Nyx (seinem Assistenten in NyxOS) zusammen.
- Einfach, ohne Einleitung und ohne Schlusssatz.
- Höchstens 8 Stichpunkte: Worum ging es, was ist geklärt, was ist offen, was ist der nächste Schritt.
- Zahlen, Namen und Entscheidungen wörtlich aus dem Gespräch übernehmen, nichts dazuerfinden.`;

/** Was der Nutzer sieht, wenn Nyx nicht zusammenfassen kann (nie Technik-Meldungen). Deutsche Schlüssel, übersetzt beim Antworten. */
const SUMMARY_ERROR: Partial<Record<HaikuErrorCode, string>> = {
  disabled: "Nyx ist ausgeschaltet. Schalte Nyx in den Einstellungen ein und versuch es dann noch einmal.",
  not_ready: "Nyx ist gerade nicht bereit. Drück in den Einstellungen auf „Motor testen“ und versuch es dann noch einmal.",
  budget: "Das Tagesbudget für Nyx ist aufgebraucht. Morgen geht es weiter – oder du erhöhst das Budget in den Einstellungen.",
  timeout: "Nyx hat für die Zusammenfassung zu lange gebraucht. Bitte noch einmal versuchen.",
  busy: "Nyx ist gerade beschäftigt. Bitte gleich noch einmal versuchen.",
  rate_limit: "Nyx ist gerade beschäftigt. Bitte gleich noch einmal versuchen.",
};
const SUMMARY_FAILED = "Die Zusammenfassung hat nicht geklappt. Bitte noch einmal versuchen.";
/** Diese Gründe liegen nicht am Faden, sondern am Motor → 503 (später noch einmal). */
const ENGINE_UNAVAILABLE: readonly HaikuErrorCode[] = ["disabled", "not_ready", "budget"];

const OBSIDIAN_OFFLINE = "Dein Mac ist gerade nicht verbunden. Sobald er wieder online ist, kannst du den Faden in Obsidian ablegen.";
const OBSIDIAN_OUTDATED = "Die Brücke auf deinem Mac ist noch auf altem Stand. Nach ihrem nächsten Update klappt das Ablegen in Obsidian.";
const OBSIDIAN_FAILED = "Die Notiz konnte nicht in Obsidian abgelegt werden. Bitte noch einmal versuchen.";

type ThreadRow = typeof haikuThreads.$inferSelect;
type MessageRow = typeof haikuMessages.$inferSelect;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Nur die Gesprächsrunden (Fragen + Antworten), ohne Karten, älteste zuerst. */
function turns(rows: MessageRow[]): MessageRow[] {
  return rows.filter((m) => m.role === "user" || m.role === "assistant");
}

const who = (role: string) => (role === "user" ? t("Nutzer") : "Nyx");

function transcript(rows: MessageRow[], maxChars: number): string {
  const parts = turns(rows).map((m) => `${who(m.role)}: ${m.text.trim()}`);
  let out = "";
  // Von hinten auffüllen: die jüngsten Runden zählen, der Anfang wird notfalls abgeschnitten.
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `${parts[i]}\n\n${out}`;
    if (next.length > maxChars) return `${t("(Ältere Nachrichten ausgelassen)")}\n\n${out}`.trim();
    out = next;
  }
  return out.trim();
}

function latestSummary(rows: MessageRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i] as MessageRow;
    if (m.role === "note" && m.noteKind === "summary") return m.text;
  }
  return null;
}

function obsidianMarkdown(thread: ThreadRow, rows: MessageRow[], now: Date): string {
  const summary = latestSummary(rows);
  const lines = [
    "---",
    `datum: ${thread.day}`,
    "typ: nyx-chat",
    "quelle: NyxOS",
    `faden: ${thread.id}`,
    "themen: [nyx]",
    "---",
    "",
    `# ${thread.title.replace(/\s+/g, " ").trim() || t("Nyx-Faden")}`,
    "",
    `> ${t("Gespräch mit Nyx vom {day}, abgelegt am {at} ({zone}).", { day: thread.day, at: localStamp(now.toISOString()) ?? now.toISOString(), zone: timeZone() })}`,
    "",
  ];
  if (summary) lines.push(`## ${t("Zusammenfassung")}`, "", summary.trim(), "");
  lines.push(`## ${t("Verlauf")}`, "");
  for (const m of turns(rows)) {
    const at = localStamp(m.createdAt);
    lines.push(`### ${who(m.role)}${at ? ` · ${at}` : ""}`, "", m.text.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function registerHaikuThreadActions(app: Hono<Env>, deps: ThreadActionDeps): void {
  const { db, runtime, log } = deps;

  const loadThread = async (raw: string): Promise<ThreadRow | null> => {
    const id = parseSerialId(raw);
    if (id === null) return null;
    const [row] = await db.select().from(haikuThreads).where(and(eq(haikuThreads.id, id), eq(haikuThreads.scope, "full"))).limit(1);
    return row ?? null;
  };
  const loadMessages = (threadId: number) => db.select().from(haikuMessages).where(eq(haikuMessages.threadId, threadId)).orderBy(haikuMessages.id).limit(2000);

  const addNote = async (threadId: number, kind: HaikuNoteKind, text: string, sources: HaikuSource[] = [], callId: number | null = null): Promise<HaikuMessage> => {
    const [row] = await db.insert(haikuMessages).values({ threadId, role: "note", noteKind: kind, text, sources, callId }).returning();
    // Eine Karte ist Arbeit am Faden – er rückt in der Liste nach oben (wie nach einer Antwort).
    await db.update(haikuThreads).set({ updatedAt: new Date().toISOString() }).where(eq(haikuThreads.id, threadId));
    deps.notify("threads");
    return deps.toMessage(row as MessageRow);
  };

  // ─── Löschen ───
  app.delete("/api/haiku/threads/:id", async (c) => {
    const thread = await loadThread(c.req.param("id"));
    if (!thread) return c.json(NOT_FOUND, 404);
    // Nachrichten hängen per Fremdschlüssel (ON DELETE CASCADE) am Faden.
    await db.delete(haikuThreads).where(eq(haikuThreads.id, thread.id));
    log("nyx-faden-geloescht", { thread: thread.id });
    deps.notify("threads");
    return c.json({ deleted: thread.id });
  });

  // ─── Zusammenfassen ───
  app.post("/api/haiku/threads/:id/summary", async (c) => {
    const thread = await loadThread(c.req.param("id"));
    if (!thread) return c.json(NOT_FOUND, 404);
    const rows = await loadMessages(thread.id);
    if (turns(rows).length === 0) return c.json({ error: t("Der Faden ist noch leer – es gibt nichts zusammenzufassen.") }, 409);
    const res = await runtime.run({
      kind: "auswertung",
      scope: "none",
      thinking: false,
      threadId: thread.id,
      systemPrompt: SUMMARY_SYSTEM,
      prompt: `Gespräch „${thread.title}“ (älteste Nachricht zuerst):\n\n${transcript(rows, SUMMARY_INPUT_CHARS)}`,
    });
    if (res.type === "error") {
      log("nyx-zusammenfassung-fehler", { thread: thread.id, code: res.code });
      const status = ENGINE_UNAVAILABLE.includes(res.code) ? 503 : 502;
      return c.json({ error: t(SUMMARY_ERROR[res.code] ?? SUMMARY_FAILED), code: res.code }, status);
    }
    const text = res.text.trim();
    if (!text) return c.json({ error: t(SUMMARY_FAILED) }, 502);
    return c.json({ message: await addNote(thread.id, "summary", text, res.sources, res.callId) });
  });

  // ─── Zu Auftrag machen ───
  app.post("/api/haiku/threads/:id/task", async (c) => {
    const thread = await loadThread(c.req.param("id"));
    if (!thread) return c.json(NOT_FOUND, 404);
    const rows = await loadMessages(thread.id);
    if (turns(rows).length === 0) return c.json({ error: t("Der Faden ist noch leer – daraus lässt sich noch keine Aufgabe machen.") }, 409);
    // Schon einmal übernommen? Dann dieselbe Aufgabe zeigen statt eine doppelte anzulegen.
    const [existing] = await db
      .select({ id: entries.id, title: entries.title, kind: entries.kind })
      .from(entries)
      .where(and(eq(entries.sourceType, "nyx_thread"), eq(entries.sourceId, String(thread.id)), inArray(entries.kind, ["aufgabe", "bug"])))
      .orderBy(desc(entries.id))
      .limit(1);
    if (existing) return c.json({ entry: { id: existing.id, title: existing.title, href: entryHref(existing.kind, existing.id) }, existing: true });

    const title = clip(thread.title.replace(/\s+/g, " ").trim() || t("Aufgabe aus Nyx-Faden"), TASK_TITLE_CHARS);
    const summary = latestSummary(rows);
    const head = t("Aus dem Nyx-Faden „{title}“ vom {day}.", { title, day: thread.day });
    const summaryBlock = summary ? `\n\n## ${t("Zusammenfassung")}\n\n${summary.trim()}` : "";
    const room = TASK_DESCRIPTION_CHARS - head.length - summaryBlock.length - 40;
    const history = room > 200 ? `\n\n## ${t("Verlauf")}\n\n${transcript(rows, room)}` : "";
    const description = clip(`${head}${summaryBlock}${history}`, TASK_DESCRIPTION_CHARS);

    const created = await createEntry(db, { kind: "aufgabe", title, description, source: "nyx", sourceType: "nyx_thread", sourceId: String(thread.id) });
    await applyMaturity(db, created.id);
    deps.hub.broadcast({ type: "entry", entryId: created.id });
    deps.graph?.markDirty(["entries"]);
    const href = entryHref("aufgabe", created.id);
    const message = await addNote(thread.id, "task", t("Als Aufgabe angelegt: „{title}“", { title }), [{ kind: "entry", id: String(created.id), label: title, href }]);
    log("nyx-faden-aufgabe", { thread: thread.id, entry: created.id });
    return c.json({ entry: { id: created.id, title, href }, message } satisfies HaikuThreadTaskResult, 201);
  });

  // ─── In Obsidian ablegen ───
  app.post("/api/haiku/threads/:id/obsidian", async (c) => {
    const thread = await loadThread(c.req.param("id"));
    if (!thread) return c.json(NOT_FOUND, 404);
    const rows = await loadMessages(thread.id);
    if (turns(rows).length === 0) return c.json({ error: t("Der Faden ist noch leer – es gibt nichts abzulegen.") }, 409);
    const bridge = deps.bridgeHub;
    if (!bridge?.online) return c.json({ error: t(OBSIDIAN_OFFLINE), reason: "offline" }, 503);
    if (!bridge.supports(BRIDGE_CAP_VAULT_NOTE)) return c.json({ error: t(OBSIDIAN_OUTDATED), reason: "bridge_outdated" }, 409);
    const out = await bridge.rpc("vault_note", { day: thread.day, title: thread.title.replace(/\s+/g, " ").trim() || t("Nyx-Faden"), markdown: obsidianMarkdown(thread, rows, new Date()) }, OBSIDIAN_TIMEOUT_MS);
    if (!out.ok) {
      log("nyx-obsidian-fehler", { thread: thread.id, code: out.code, error: out.error });
      if (out.code === "bridge_offline") return c.json({ error: t(OBSIDIAN_OFFLINE), reason: "offline" }, 503);
      return c.json({ error: t(OBSIDIAN_FAILED), reason: "failed" }, 502);
    }
    const { relPath } = out.result as VaultNoteResult;
    const message = await addNote(thread.id, "obsidian", t("In Obsidian abgelegt: `{path}`", { path: relPath }));
    log("nyx-obsidian", { thread: thread.id, path: relPath });
    return c.json({ relPath, message } satisfies HaikuThreadObsidianResult);
  });
}
