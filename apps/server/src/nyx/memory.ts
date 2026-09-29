// Dauerhaftes Gedächtnis von Nyx. Übernommen (angepasst, nach TypeScript) aus Hermes Agent
// `tools/memory_tool.py` + `tools/memory_tool_store.py` (MIT, © 2025 Nous Research): festes Zeichen-Budget je
// Bereich, atomarer Stapel (`operations[]`, Budget nur am ENDERGEBNIS geprüft), `replace` ersetzt den ganzen Eintrag
// (alter Text nur zum Finden, eindeutig), Auslastungs-Anzeige im Prompt-Block, Bedrohungs-Prüfung jedes Eintrags,
// höchstens 3 gescheiterte Aufräum-Versuche je Lauf. Herkunft (Faden/Nachricht) nach OpenClaw `memory-provenance` (MIT).
// Der Block wird beim Anlegen eines Fadens EINGEFROREN (`haiku_threads.memory_snapshot`) – Änderungen wirken ab dem
// nächsten Faden (Prompt bleibt stabil). Vorschläge der Hintergrund-Prüfung landen in `nyx_memory_suggestions`.
import { NYX_MEMORY_CATEGORY_LABELS, NYX_MEMORY_LIMITS, NyxMemoryCategorySchema, type NyxMemoryCategory, type NyxMemoryEntry, type NyxMemorySuggestion, type NyxMemoryUsage, type NyxMemoryView, numberFormat, t } from "@nyxos/shared";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { nyxMemory, nyxMemorySuggestions } from "../db/schema.js";
import { scanForThreats } from "./threats.js";

export const CATEGORIES = NyxMemoryCategorySchema.options;

export const MemoryOpSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  category: NyxMemoryCategorySchema,
  /** Neuer Text (add/replace). */
  content: z.string().trim().min(3).max(600).optional(),
  /** Kurzer, eindeutiger Teil des bestehenden Eintrags (replace/remove). */
  old_text: z.string().trim().min(2).max(300).optional(),
});
export type MemoryOp = z.infer<typeof MemoryOpSchema>;

type Row = typeof nyxMemory.$inferSelect;

function toEntry(r: Row): NyxMemoryEntry {
  return {
    id: r.id,
    category: r.category as NyxMemoryCategory,
    fact: r.fact,
    sourceThreadId: r.sourceThreadId,
    sourceMessageId: r.sourceMessageId,
    createdBy: r.createdBy as NyxMemoryEntry["createdBy"],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listMemory(db: Db): Promise<NyxMemoryEntry[]> {
  return (await db.select().from(nyxMemory).orderBy(asc(nyxMemory.category), asc(nyxMemory.id))).map(toEntry);
}

/** Zeichen je Bereich (Einträge + Trenner), wie Hermes' Budget-Rechnung. */
export function memoryUsage(entries: Pick<NyxMemoryEntry, "category" | "fact">[]): NyxMemoryUsage[] {
  return CATEGORIES.map((category) => {
    const facts = entries.filter((e) => e.category === category).map((e) => e.fact);
    const chars = facts.reduce((n, f) => n + f.length, 0) + Math.max(0, facts.length - 1) * 3;
    return { category, label: t(NYX_MEMORY_CATEGORY_LABELS[category]), chars, limit: NYX_MEMORY_LIMITS[category] };
  });
}

const fmt = (n: number) => numberFormat().format(n);

/**
 * Prompt-Block (Hermes `_render_block`): je Bereich eine Kopfzeile mit Auslastung, damit das Modell selbst aufräumt.
 * Verdächtige Einträge erscheinen als „[GESPERRT …]“ (bleiben im Tab sichtbar zum Löschen).
 */
export function renderMemoryBlock(entries: NyxMemoryEntry[]): string {
  if (entries.length === 0) return "";
  const usage = memoryUsage(entries);
  const blocks: string[] = [];
  for (const u of usage) {
    const items = entries.filter((e) => e.category === u.category);
    if (items.length === 0) continue;
    const pct = Math.round((u.chars / u.limit) * 100);
    const lines = items.map((e) => {
      const threats = scanForThreats(e.fact, "strict");
      return threats.length ? `- [GESPERRT: verdächtiger Inhalt (${threats.join(", ")}) – im Tab löschen]` : `- ${e.fact}`;
    });
    blocks.push(`${u.label.toUpperCase()} (${u.category}) [${pct} % – ${fmt(u.chars)}/${fmt(u.limit)} Zeichen]\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

export interface MemoryApplyContext {
  threadId?: number | null;
  messageId?: number | null;
  createdBy?: NyxMemoryEntry["createdBy"];
}

export type MemoryApplyResult =
  | { ok: true; applied: number; skipped: string[]; usage: NyxMemoryUsage[]; hinweis: string }
  | { ok: false; error: string; usage: NyxMemoryUsage[]; eintraege?: { bereich: string; text: string }[] };

/** Eindeutiger Treffer: exakter Text vor Teilstring; mehrdeutig → Fehler (Hermes `_find_unique_match`). */
function findUnique(items: { id: number; fact: string }[], oldText: string): { id: number; fact: string } | "none" | "ambiguous" {
  const needle = oldText.trim().toLowerCase();
  const exact = items.filter((e) => e.fact.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0] as { id: number; fact: string };
  const partial = items.filter((e) => e.fact.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0] as { id: number; fact: string };
  return partial.length === 0 ? "none" : "ambiguous";
}

/**
 * Wendet einen Stapel atomar an. Budget wird nur am Endergebnis je Bereich geprüft – so kann EIN Aufruf Altes
 * entfernen/kürzen UND Neues hinzufügen, auch wenn ein einzelnes Hinzufügen überliefe.
 */
export async function applyMemoryOps(db: Db, ops: MemoryOp[], ctx: MemoryApplyContext = {}): Promise<MemoryApplyResult> {
  const rows = await db.select().from(nyxMemory);
  const state = rows.map((r) => ({ id: r.id as number | null, category: r.category as NyxMemoryCategory, fact: r.fact, changed: false, removed: false }));
  const skipped: string[] = [];
  for (const [i, op] of ops.entries()) {
    const n = i + 1;
    if ((op.action === "add" || op.action === "replace") && !op.content) return { ok: false, error: t("Schritt {n}: Text fehlt.", { n }), usage: memoryUsage(rows.map(toEntry)) };
    if ((op.action === "replace" || op.action === "remove") && !op.old_text) return { ok: false, error: t("Schritt {n}: Welcher Eintrag? (old_text fehlt)", { n }), usage: memoryUsage(rows.map(toEntry)) };
    if (op.content) {
      const threats = scanForThreats(op.content, "strict");
      if (threats.length) return { ok: false, error: t("Schritt {n}: Dieser Text sieht nach einer versteckten Anweisung oder einem Geheimnis aus ({threats}) – nicht gespeichert.", { n, threats: threats.join(", ") }), usage: memoryUsage(rows.map(toEntry)) };
    }
    const live = state.filter((s) => !s.removed && s.category === op.category);
    if (op.action === "add") {
      if (live.some((s) => s.fact.trim().toLowerCase() === (op.content ?? "").trim().toLowerCase())) {
        skipped.push(`Schritt ${n}: stand schon im Gedächtnis`);
        continue;
      }
      state.push({ id: null, category: op.category, fact: op.content ?? "", changed: true, removed: false });
      continue;
    }
    const hit = findUnique(
      live.map((s) => ({ id: state.indexOf(s), fact: s.fact })),
      op.old_text ?? "",
    );
    if (hit === "none") return { ok: false, error: t("Schritt {n}: Keinen Eintrag mit „{old_text}“ im Bereich {category} gefunden.", { n, old_text: op.old_text, category: op.category }), usage: memoryUsage(rows.map(toEntry)), eintraege: live.map((s) => ({ bereich: s.category, text: s.fact })) };
    if (hit === "ambiguous") return { ok: false, error: t("Schritt {n}: „{old_text}“ passt auf mehrere Einträge – genauer werden.", { n, old_text: op.old_text }), usage: memoryUsage(rows.map(toEntry)), eintraege: live.map((s) => ({ bereich: s.category, text: s.fact })) };
    const target = state[hit.id] as (typeof state)[number];
    if (op.action === "remove") target.removed = true;
    else {
      target.fact = op.content ?? target.fact;
      target.changed = true;
    }
  }
  const finalLive = state.filter((s) => !s.removed);
  const usage = memoryUsage(finalLive);
  const over = usage.filter((u) => u.chars > u.limit);
  if (over.length) {
    const cat = over[0] as NyxMemoryUsage;
    return {
      ok: false,
      error: t("Der Bereich „{label}“ wäre voll ({chars}/{limit} Zeichen). Schick EINEN Aufruf, der alte Einträge kürzt oder entfernt UND den neuen hinzufügt.", { label: cat.label, chars: fmt(cat.chars), limit: fmt(cat.limit) }),
      usage: memoryUsage(rows.map(toEntry)),
      eintraege: rows.filter((r) => r.category === cat.category).map((r) => ({ bereich: r.category, text: r.fact })),
    };
  }
  const now = new Date().toISOString();
  let applied = 0;
  await db.transaction(async (tx) => {
    for (const s of state) {
      if (s.id !== null && s.removed) {
        await tx.delete(nyxMemory).where(eq(nyxMemory.id, s.id));
        applied++;
      } else if (s.id !== null && s.changed) {
        await tx.update(nyxMemory).set({ fact: s.fact, updatedAt: now, sourceThreadId: ctx.threadId ?? undefined, sourceMessageId: ctx.messageId ?? undefined }).where(eq(nyxMemory.id, s.id));
        applied++;
      } else if (s.id === null && !s.removed) {
        await tx.insert(nyxMemory).values({ category: s.category, fact: s.fact, sourceThreadId: ctx.threadId ?? null, sourceMessageId: ctx.messageId ?? null, createdBy: ctx.createdBy ?? "nyx" });
        applied++;
      }
    }
  });
  return { ok: true, applied, skipped, usage, hinweis: "Gespeichert. Gilt ab dem nächsten Gespräch im Prompt – diesen Aufruf nicht wiederholen." };
}

// ───────────────────────────── Tab: bearbeiten und vergessen ─────────────────────────────

export async function updateMemoryEntry(db: Db, id: number, patch: { category?: NyxMemoryCategory; fact?: string }): Promise<{ entry: NyxMemoryEntry } | { error: string; status: 400 | 404 }> {
  const [row] = await db.select().from(nyxMemory).where(eq(nyxMemory.id, id)).limit(1);
  if (!row) return { error: t("Diesen Eintrag gibt es nicht mehr."), status: 404 };
  const next = { category: patch.category ?? (row.category as NyxMemoryCategory), fact: patch.fact ?? row.fact };
  const threats = scanForThreats(next.fact, "strict");
  if (threats.length) return { error: t("Dieser Text sieht nach einer versteckten Anweisung oder einem Geheimnis aus – nicht gespeichert."), status: 400 };
  const all = (await db.select().from(nyxMemory)).map((r) => (r.id === id ? { ...r, ...next } : { category: r.category as NyxMemoryCategory, fact: r.fact }));
  const u = memoryUsage(all).find((x) => x.category === next.category) as NyxMemoryUsage;
  if (u.chars > u.limit) return { error: t("Der Bereich „{label}“ wäre zu voll ({chars}/{limit} Zeichen). Erst etwas kürzen oder vergessen.", { label: u.label, chars: fmt(u.chars), limit: fmt(u.limit) }), status: 400 };
  const [out] = await db
    .update(nyxMemory)
    .set({ ...next, createdBy: "user", updatedAt: new Date().toISOString() })
    .where(eq(nyxMemory.id, id))
    .returning();
  return { entry: toEntry(out as Row) };
}

export async function deleteMemoryEntry(db: Db, id: number): Promise<boolean> {
  const out = await db.delete(nyxMemory).where(eq(nyxMemory.id, id)).returning({ id: nyxMemory.id });
  return out.length > 0;
}

// ───────────────────────────── Vorschläge (Hintergrund-Lernprüfung) ─────────────────────────────

type SuggestionRow = typeof nyxMemorySuggestions.$inferSelect;
function toSuggestion(r: SuggestionRow): NyxMemorySuggestion {
  return {
    id: r.id,
    action: r.action as NyxMemorySuggestion["action"],
    category: r.category as NyxMemoryCategory,
    fact: r.fact,
    memoryId: r.memoryId,
    reason: r.reason,
    sourceThreadId: r.sourceThreadId,
    status: r.status as NyxMemorySuggestion["status"],
    createdAt: r.createdAt,
  };
}

export async function listSuggestions(db: Db, status: "open" | "all" = "open"): Promise<NyxMemorySuggestion[]> {
  const rows = await db
    .select()
    .from(nyxMemorySuggestions)
    .where(status === "open" ? eq(nyxMemorySuggestions.status, "open") : undefined)
    .orderBy(desc(nyxMemorySuggestions.id))
    .limit(100);
  return rows.map(toSuggestion);
}

/** Vorschlag anlegen (Werkzeug `memory_suggest` im Umfang „review“). Doppelte offene Vorschläge werden übersprungen. */
export async function createSuggestion(
  db: Db,
  s: { action: "add" | "replace" | "remove"; category: NyxMemoryCategory; fact: string; oldText?: string | null; reason?: string | null; threadId?: number | null },
): Promise<{ ok: true; id: number; duplicate: boolean } | { ok: false; error: string }> {
  const threats = scanForThreats(s.fact, "strict");
  if (threats.length) return { ok: false, error: "Verdächtiger Inhalt – kein Vorschlag angelegt." };
  let memoryId: number | null = null;
  if (s.action !== "add") {
    const rows = await db.select({ id: nyxMemory.id, fact: nyxMemory.fact }).from(nyxMemory).where(eq(nyxMemory.category, s.category));
    const hit = findUnique(rows, s.oldText ?? s.fact);
    if (typeof hit === "string") return { ok: false, error: "Den betroffenen Eintrag gibt es nicht eindeutig." };
    memoryId = hit.id;
  } else {
    const existing = await db.select({ fact: nyxMemory.fact }).from(nyxMemory).where(eq(nyxMemory.category, s.category));
    if (existing.some((e) => e.fact.trim().toLowerCase() === s.fact.trim().toLowerCase())) return { ok: false, error: "Steht schon im Gedächtnis." };
  }
  const open = await db.select().from(nyxMemorySuggestions).where(eq(nyxMemorySuggestions.status, "open"));
  const dup = open.find((o) => o.action === s.action && o.category === s.category && o.fact.trim().toLowerCase() === s.fact.trim().toLowerCase());
  if (dup) return { ok: true, id: dup.id, duplicate: true };
  const [row] = await db
    .insert(nyxMemorySuggestions)
    .values({ action: s.action, category: s.category, fact: s.fact, memoryId, reason: s.reason ?? null, sourceThreadId: s.threadId ?? null })
    .returning({ id: nyxMemorySuggestions.id });
  return { ok: true, id: (row as { id: number }).id, duplicate: false };
}

/** Der Nutzer hakt ab: annehmen → ins Gedächtnis (gleiche Budget-Regeln), ablehnen → nur markieren. */
export async function decideSuggestion(db: Db, id: number, accept: boolean): Promise<{ suggestion: NyxMemorySuggestion } | { error: string; status: 400 | 404 | 409 }> {
  const [row] = await db.select().from(nyxMemorySuggestions).where(eq(nyxMemorySuggestions.id, id)).limit(1);
  if (!row) return { error: t("Diesen Vorschlag gibt es nicht."), status: 404 };
  if (row.status !== "open") return { error: t("Dieser Vorschlag ist schon entschieden."), status: 409 };
  if (accept) {
    const category = row.category as NyxMemoryCategory;
    let res: MemoryApplyResult;
    if (row.action === "add") res = await applyMemoryOps(db, [{ action: "add", category, content: row.fact }], { threadId: row.sourceThreadId, createdBy: "vorschlag" });
    else {
      const [target] = row.memoryId ? await db.select().from(nyxMemory).where(eq(nyxMemory.id, row.memoryId)).limit(1) : [];
      if (!target) return { error: t("Der betroffene Eintrag ist schon weg."), status: 409 };
      res = await applyMemoryOps(db, [{ action: row.action as "replace" | "remove", category, content: row.action === "replace" ? row.fact : undefined, old_text: target.fact }], { threadId: row.sourceThreadId, createdBy: "vorschlag" });
    }
    if (!res.ok) return { error: res.error, status: 400 };
  }
  const [out] = await db
    .update(nyxMemorySuggestions)
    .set({ status: accept ? "accepted" : "rejected", decidedAt: new Date().toISOString() })
    .where(eq(nyxMemorySuggestions.id, id))
    .returning();
  return { suggestion: toSuggestion(out as SuggestionRow) };
}

export async function memoryView(db: Db): Promise<NyxMemoryView> {
  const entries = await listMemory(db);
  return { entries, usage: memoryUsage(entries), suggestions: await listSuggestions(db, "open") };
}

/** Schutz vor Endlosschleifen: höchstens 3 gescheiterte Gedächtnis-Aufrufe je Lauf (Hermes). */
export const MAX_MEMORY_FAILURES_PER_CALL = 3;
