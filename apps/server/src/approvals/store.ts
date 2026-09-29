// Leitplanken: Freigabe-Anfragen in der DB. Eine Freigabe gilt GENAU einmal: der Verbrauch
// ist ein bedingtes UPDATE (`… WHERE status = 'approved' RETURNING`), zusätzlich serialisiert eine
// Transaktions-Sperre je Befehls-Hash parallele Prüfungen desselben Befehls (kein Doppelverbrauch,
// keine doppelte Anfrage). Freigaben verfallen nach 24 h (beim Lesen/Prüfen).
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Approval, ApprovalStatus, GuardCheck, GuardCheckResult, GuardRule } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals } from "../db/schema.js";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_LIST_LIMIT = 200;
export const DECIDED_BY = "user";

type Row = typeof approvals.$inferSelect;

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

export function toApproval(r: Row): Approval {
  return {
    id: r.id,
    status: r.status as ApprovalStatus,
    rule: r.rule as GuardRule,
    reason: r.reason,
    tool: r.tool,
    command: r.command,
    cwd: r.cwd,
    sessionKey: r.sessionKey,
    auftrag: r.auftrag,
    worktree: r.worktree,
    attempts: r.attempts,
    createdAt: iso(r.createdAt) ?? "",
    decidedAt: iso(r.decidedAt),
    decidedBy: r.decidedBy,
    consumedAt: iso(r.consumedAt),
  };
}

/** Pfad vergleichbar machen: `/a/b/` = `/a/b`, `/a/./b` = `/a/b`. */
export function normalizeCwd(cwd: string | null): string {
  if (!cwd) return "";
  const n = posix.normalize(cwd);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

export const sessionKeyFor = (sessionId: string | null): string | null => (sessionId ? `claude:${sessionId}` : null);

/** sha256(Befehl ∖0 cwd ∖0 Session) — eine Freigabe passt nur auf genau diesen Befehl in genau dieser Session. */
export function commandHash(command: string, cwd: string | null, sessionKey: string | null): string {
  return createHash("sha256").update(`${command}\0${normalizeCwd(cwd)}\0${sessionKey ?? ""}`).digest("hex");
}

/** Setzt offene/erteilte Freigaben älter als 24 h auf `expired`. */
/** „offen“ = pending UND noch nicht verfallen — reine Lese-Bedingung für Zähler (Überblick,
 * Leiste, Schnappschuss). Sonst zählte eine abgelaufene Anfrage dort mit, bis zufällig jemand die Liste
 * lädt (`listApprovals` räumt erst beim Lesen per `expireApprovals` auf). */
export function pendingApprovalSql(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS).toISOString();
  return and(eq(approvals.status, "pending"), gte(approvals.createdAt, cutoff));
}

export async function expireApprovals(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS).toISOString();
  await db
    .update(approvals)
    .set({ status: "expired" })
    .where(
      or(
        and(eq(approvals.status, "pending"), lt(approvals.createdAt, cutoff)),
        and(eq(approvals.status, "approved"), lt(sql`coalesce(${approvals.decidedAt}, ${approvals.createdAt})`, cutoff)),
      ),
    );
}

export interface GuardCheckOutcome {
  result: GuardCheckResult;
  /** Neu angelegte Anfrage (→ Live-Meldung + Push). */
  created: Approval | null;
}

export async function checkGuard(db: Db, input: GuardCheck, now: Date = new Date()): Promise<GuardCheckOutcome> {
  const sessionKey = sessionKeyFor(input.sessionId);
  const hash = commandHash(input.command, input.cwd, sessionKey);
  const nowIso = now.toISOString();
  await expireApprovals(db, now);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${hash}))`);
    const same = (status: ApprovalStatus, order: "asc" | "desc") =>
      sql`(select id from approvals where command_hash = ${hash} and session_key is not distinct from ${sessionKey} and status = ${status} order by id ${sql.raw(order)} limit 1)`;

    // 1) Erteilte Freigabe → genau einmal verbrauchen.
    const [used] = await tx
      .update(approvals)
      .set({ status: "consumed", consumedAt: nowIso })
      .where(and(eq(approvals.id, same("approved", "asc")), eq(approvals.status, "approved")))
      .returning();
    if (used) return { result: { decision: "allow", approvalId: used.id, message: t("Freigabe #{id} verbraucht", { id: used.id }) }, created: null };

    // 2) Schon offen → Versuch zählen, dieselbe Anfrage nennen.
    const [open] = await tx
      .update(approvals)
      .set({ attempts: sql`${approvals.attempts} + 1` })
      .where(and(eq(approvals.id, same("pending", "desc")), eq(approvals.status, "pending")))
      .returning();
    if (open) return { result: { decision: "deny", approvalId: open.id, message: t("Freigabe-Anfrage #{id} ist noch offen", { id: open.id }) }, created: null };

    // 3) Neue Anfrage.
    const [row] = await tx
      .insert(approvals)
      .values({
        status: "pending",
        rule: input.rule,
        reason: input.reason,
        tool: input.tool,
        command: input.command,
        commandHash: hash,
        cwd: input.cwd,
        sessionKey,
        auftrag: input.auftrag,
        worktree: input.worktree,
        attempts: 1,
        createdAt: nowIso,
      })
      .returning();
    if (!row) throw new Error("Freigabe-Anfrage konnte nicht angelegt werden");
    return { result: { decision: "deny", approvalId: row.id, message: t("Freigabe-Anfrage #{id} angelegt", { id: row.id }) }, created: toApproval(row) };
  });
}

export async function listApprovals(db: Db, status: "pending" | "all", now: Date = new Date()): Promise<Approval[]> {
  await expireApprovals(db, now);
  const rows = await db
    .select()
    .from(approvals)
    .where(status === "pending" ? eq(approvals.status, "pending") : undefined)
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(APPROVAL_LIST_LIMIT);
  return rows.map(toApproval);
}

export type DecideResult = { ok: true; approval: Approval } | { ok: false; status: 404 | 409; current?: ApprovalStatus };

/** Entscheidet eine offene Anfrage. Nur aus `pending` heraus; sonst 404 (gibt es nicht) bzw. 409. */
export async function decideApproval(db: Db, id: number, decision: "approve" | "deny", now: Date = new Date()): Promise<DecideResult> {
  await expireApprovals(db, now);
  const [row] = await db
    .update(approvals)
    .set({ status: decision === "approve" ? "approved" : "denied", decidedAt: now.toISOString(), decidedBy: DECIDED_BY })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning();
  if (row) return { ok: true, approval: toApproval(row) };
  const [existing] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, id)).limit(1);
  return existing ? { ok: false, status: 409, current: existing.status as ApprovalStatus } : { ok: false, status: 404 };
}

/**
 * „Alles freigeben" (Briefing): gibt die genannten, noch OFFENEN Anfragen frei; alles andere bleibt,
 * wie es ist. Die Live-Meldung (`{type:"haiku", what:"approval"}`) sendet der Aufrufer.
 */
export async function approveAllPending(db: Db, ids: number[], now: Date = new Date()): Promise<Approval[]> {
  if (ids.length === 0) return [];
  await expireApprovals(db, now);
  const rows = await db
    .update(approvals)
    .set({ status: "approved", decidedAt: now.toISOString(), decidedBy: DECIDED_BY })
    .where(and(inArray(approvals.id, ids), eq(approvals.status, "pending")))
    .returning();
  return rows.map(toApproval);
}
