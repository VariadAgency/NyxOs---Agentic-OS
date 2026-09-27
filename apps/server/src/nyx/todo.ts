// Plan/To-do je Faden. Übernommen (angepasst, nach TypeScript) aus Hermes Agent `tools/todo_tool.py`
// (MIT, © 2025 Nous Research): Liste = Priorität, `merge` aktualisiert nach id, Revisionszähler, jede Antwort mit der
// kompletten Liste, offene Einträge werden nach der Verdichtung wieder eingespielt. Strenger als Hermes (und OpenClaw
// `progress-card-tool`, MIT): höchstens EIN Eintrag „in Arbeit“ und „erledigt“ nur mit Prüf-Beleg (`evidence`) –
// gegen die Nutzer-Kritik „bewertet sich selbst zu gut“. Jede Änderung → Ereignis `nyx.task` über den WebSocket.
import { NyxTodoStatusSchema, t, type NyxStepStatus, type NyxTaskEvent, type NyxTodoItem, type NyxTodoList } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { nyxTodos } from "../db/schema.js";

export const MAX_TODO_ITEMS = 50;

export const TodoItemInputSchema = z.object({
  id: z.string().trim().min(1).max(40),
  content: z.string().trim().min(1).max(300).optional(),
  status: NyxTodoStatusSchema.optional(),
  evidence: z.string().trim().min(3).max(300).optional(),
});
export type TodoItemInput = z.infer<typeof TodoItemInputSchema>;

export async function getTodos(db: Db, threadId: number): Promise<NyxTodoList> {
  const [row] = await db.select().from(nyxTodos).where(eq(nyxTodos.threadId, threadId)).limit(1);
  return { threadId, revision: row?.revision ?? 0, items: (row?.items ?? []) as NyxTodoItem[], updatedAt: row?.updatedAt ?? new Date(0).toISOString() };
}

export type TodoWriteResult = { ok: true; list: NyxTodoList; changed: NyxTodoItem[] } | { ok: false; error: string; list: NyxTodoList };

/** Schreibt die Liste (ersetzen oder `merge` nach id). Regeln werden am Endergebnis geprüft. */
export async function writeTodos(db: Db, threadId: number, input: { todos: TodoItemInput[]; merge?: boolean }): Promise<TodoWriteResult> {
  const current = await getTodos(db, threadId);
  const before = new Map(current.items.map((i) => [i.id, i]));
  let next: NyxTodoItem[];
  if (input.merge) {
    next = current.items.map((i) => ({ ...i }));
    for (const t of input.todos) {
      const existing = next.find((i) => i.id === t.id);
      if (existing) {
        if (t.content) existing.content = t.content;
        if (t.status) existing.status = t.status;
        if (t.evidence) existing.evidence = t.evidence;
      } else {
        if (!t.content) return { ok: false, error: `Neuer Eintrag „${t.id}“ braucht einen Text (content).`, list: current };
        next.push({ id: t.id, content: t.content, status: t.status ?? "pending", ...(t.evidence ? { evidence: t.evidence } : {}) });
      }
    }
  } else {
    const ids = new Set<string>();
    next = [];
    for (const t of input.todos) {
      if (ids.has(t.id)) return { ok: false, error: `Die Kennung „${t.id}“ steht doppelt in der Liste.`, list: current };
      ids.add(t.id);
      const old = before.get(t.id);
      const content = t.content ?? old?.content;
      if (!content) return { ok: false, error: `Eintrag „${t.id}“ braucht einen Text (content).`, list: current };
      const evidence = t.evidence ?? old?.evidence;
      next.push({ id: t.id, content, status: t.status ?? old?.status ?? "pending", ...(evidence ? { evidence } : {}) });
    }
  }
  if (next.length > MAX_TODO_ITEMS) return { ok: false, error: `Höchstens ${MAX_TODO_ITEMS} Einträge – größere Schritte zusammenfassen.`, list: current };
  const inProgress = next.filter((i) => i.status === "in_progress");
  if (inProgress.length > 1) return { ok: false, error: `Nur EIN Eintrag darf „in Arbeit“ sein (jetzt ${inProgress.length}: ${inProgress.map((i) => i.id).join(", ")}).`, list: current };
  // Erledigt erst nach Prüfung: wer NEU auf completed springt, braucht einen Beleg.
  const unproven = next.filter((i) => i.status === "completed" && before.get(i.id)?.status !== "completed" && !i.evidence);
  if (unproven.length) return { ok: false, error: `„Erledigt“ erst nach Prüfung: nenne im Feld evidence, womit du es geprüft hast (${unproven.map((i) => i.id).join(", ")}).`, list: current };
  const changed = next.filter((i) => {
    const b = before.get(i.id);
    return !b || b.status !== i.status || b.content !== i.content;
  });
  const revision = current.revision + 1;
  const updatedAt = new Date().toISOString();
  await db
    .insert(nyxTodos)
    .values({ threadId, revision, items: next, updatedAt })
    .onConflictDoUpdate({ target: nyxTodos.threadId, set: { revision, items: next, updatedAt } });
  return { ok: true, list: { threadId, revision, items: next, updatedAt }, changed };
}

const STATUS_DE: Record<NyxTodoItem["status"], string> = { pending: "offen", in_progress: "in Arbeit", completed: "erledigt", cancelled: "abgebrochen" };

/** Offene Einträge für den Prompt (Hermes `format_for_injection`) – nur pending/in_progress, sonst leer. */
export function openTodosBlock(list: NyxTodoList): string {
  const open = list.items.filter((i) => i.status === "pending" || i.status === "in_progress");
  if (open.length === 0) return "";
  return `[Deine offene Aufgabenliste in diesem Gespräch (Revision ${list.revision}) – blieb erhalten:]\n${open.map((i) => `- [${STATUS_DE[i.status]}] ${i.id}: ${i.content}`).join("\n")}`;
}

/** Kurzer Text für `nyx.task`: was sich zuletzt geändert hat. */
export function todoPhaseText(changed: NyxTodoItem[], list: NyxTodoList): { phase: "started" | "step" | "done"; text: string } {
  const all = list.items;
  if (all.length > 0 && all.every((i) => i.status === "completed" || i.status === "cancelled")) return { phase: "done", text: t("Fertig: {done} von {n} erledigt", { done: all.filter((i) => i.status === "completed").length, n: all.length }) };
  const doing = all.find((i) => i.status === "in_progress");
  if (changed.length === all.length && all.every((i) => i.status === "pending" || i.status === "in_progress")) return { phase: "started", text: doing ? t("Plan mit {n} Schritten – jetzt: {step}", { n: all.length, step: doing.content }) : t("Plan mit {n} Schritten", { n: all.length }) };
  const last = changed.at(-1);
  if (last?.status === "completed") return { phase: "step", text: t("Erledigt: {step}", { step: last.content }) };
  return { phase: "step", text: doing ? t("Jetzt: {step}", { step: doing.content }) : (last ? `${t(STATUS_DE[last.status])}: ${last.content}` : t("Plan aktualisiert")) };
}

const STEP_STATUS: Record<NyxTodoItem["status"], NyxStepStatus> = { pending: "pending", in_progress: "running", completed: "done", cancelled: "cancelled" };

/** Karten-ID des Plans eines Fadens im Reiter „Aufgaben live“ (eine Karte je Faden, die sich fortschreibt). */
export const planTaskId = (threadId: number) => `plan-${threadId}`;

/**
 * Eine Plan-Änderung als `nyx.task`-Ereignisse im gemeinsamen Format (nyx-live): je GEÄNDERTEM Eintrag
 * ein Schritt (Index = Platz in der Liste, `total` = Länge, damit gestrichene Einträge aus der Karte fallen).
 * Neuer Plan → erstes Ereignis `started`; alles erledigt/verworfen → letztes `done`.
 */
export function todoTaskEvents(list: NyxTodoList, changed: NyxTodoItem[]): NyxTaskEvent[] {
  const p = todoPhaseText(changed, list);
  const total = list.items.length;
  const changedIds = new Set(changed.map((c) => c.id));
  const steps = list.items.map((item, index) => ({ item, index })).filter((x) => changedIds.has(x.item.id));
  // Nichts am Inhalt geändert (nur Reihenfolge/Beleg) oder Liste geleert: eine Meldung ohne Schritt.
  if (steps.length === 0) return [{ taskId: planTaskId(list.threadId), phase: p.phase, title: planTitle(total), text: p.text, tool: "todo", threadId: list.threadId }];
  return steps.map(({ item, index }, i) => ({
    taskId: planTaskId(list.threadId),
    phase: p.phase === "started" && i === 0 ? "started" : p.phase === "done" && i === steps.length - 1 ? "done" : "step",
    title: planTitle(total),
    text: p.text.slice(0, 500),
    tool: "todo",
    threadId: list.threadId,
    step: { index, total: Math.max(total, 1), label: item.content.slice(0, 200) || item.id, status: STEP_STATUS[item.status] },
  }));
}

function planTitle(total: number): string {
  return total === 1 ? t("Plan: 1 Schritt") : t("Plan: {n} Schritte", { n: total });
}

export function formatTodosForTool(list: NyxTodoList) {
  return { revision: list.revision, eintraege: list.items.map((i) => ({ id: i.id, text: i.content, status: i.status, ...(i.evidence ? { beleg: i.evidence } : {}) })) };
}
