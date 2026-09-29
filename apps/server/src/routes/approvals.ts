// Leitplanken: Freigabe-Anfragen (Hook → Server) + Entscheidung durch den Nutzer (Web).
// Registrierung in app.ts ist eine Zeile. Umsetzung: siehe ../approvals/store.ts.
import { ApprovalDecisionSchema, GUARD_RULE_LABELS, GuardCheckSchema, type Approval, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../app.js";
import { approveAllPending, checkGuard, decideApproval, listApprovals } from "../approvals/store.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { LiveHub } from "../live.js";
import { notify } from "../push/dispatcher.js";
import type { NotifyEnv } from "../notifications/pipeline.js";
import type { NtfySender } from "../push/ntfy.js";
import { loadOrInitSettings } from "../push/settings.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";

export interface ApprovalsRouteDeps {
  db: Db;
  hub: LiveHub;
  /** Maschinen-Token-Prüfung wie bei /ingest (setzt `machineId`). */
  machineAuth: MiddlewareHandler<Env>;
  pushSender: NtfySender;
  /** Notification environment (presence, away digest, Nyx). */
  notifyEnv?: NotifyEnv;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** nach einer Entscheidung der wartenden Auftrags-Session Bescheid sagen (tmux, P3 `send_text`). */
  tellSession?: (sessionKey: string, text: string) => Promise<unknown>;
  /** neue Freigabe-Anfrage → Karte mit Knöpfen in Telegram (Fehler dort dürfen nie den Hook stören). */
  onCreated?: (approval: Approval) => Promise<void>;
}

/** Live-Meldung an alle offenen Web-Ansichten: Freigaben neu laden. */
export const APPROVAL_LIVE_MESSAGE = { type: "haiku", what: "approval" } as const;

/** Text an die wartende Auftrags-Session nach des Nutzers Entscheidung (Hook verweigert und wartet nicht selbst). */
export function decisionText(a: Pick<Approval, "id" | "command">, decision: "approve" | "deny"): string {
  return decision === "approve"
    ? t("Freigabe #{id} vom Nutzer erteilt: Führe genau diesen Befehl jetzt einmal erneut aus (unverändert): {command}", { id: a.id, command: a.command })
    : t("Freigabe #{id} abgelehnt: Den Befehl „{command}“ nicht ausführen, ohne ihn weitermachen.", { id: a.id, command: a.command.slice(0, 200) });
}

export interface ApprovalsApi {
  /** „Alles freigeben“: gibt die offenen Anfragen frei UND sagt jeder wartenden Session Bescheid. Liefert die Anzahl. */
  approveMany: (ids: number[]) => Promise<number>;
  /** eine Entscheidung vom Nutzer (Web-Knopf oder Telegram-Knopf) — derselbe Weg inkl. Bescheid an die Session. */
  decide: (id: number, decision: "approve" | "deny", via?: string) => Promise<DecideOutcome>;
}

export type DecideOutcome = { ok: true; approval: Approval } | { ok: false; status: 404 | 409; message: string };

export function registerApprovalsRoutes(app: Hono<Env>, deps: ApprovalsRouteDeps): ApprovalsApi {
  const { db, hub, machineAuth, pushSender, log } = deps;

  async function tell(a: Approval, decision: "approve" | "deny"): Promise<void> {
    if (!a.sessionKey || !deps.tellSession) return;
    await deps.tellSession(a.sessionKey, decisionText(a, decision)).catch((e: unknown) => log("freigabe-meldung-fehler", { id: a.id, error: String(e) }));
  }

  async function announce(created: Approval): Promise<void> {
    hub.broadcast(APPROVAL_LIVE_MESSAGE);
    if (deps.onCreated) void deps.onCreated(created).catch((e: unknown) => log("freigabe-telegram-fehler", { error: String(e), approvalId: created.id }));
    try {
      const settings = await loadOrInitSettings(db);
      // push_log.session_key verweist auf sessions.id: nur eine bekannte Session mitgeben.
      const [known] = created.sessionKey ? await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, created.sessionKey)).limit(1) : [];
      await notify(
        {
          kind: "approval_needed",
          title: t("Freigabe nötig: {rule}", { rule: GUARD_RULE_LABELS[created.rule] }),
          message: `${created.auftrag ? `${created.auftrag}: ` : ""}${created.command}`.slice(0, 1000),
          // The fact for the template ("„Session“ braucht deine Freigabe: …").
          what: `${GUARD_RULE_LABELS[created.rule]} – ${created.command.replace(/\s+/g, " ").slice(0, 200)}`,
          path: "/inbox",
          sessionKey: known?.id ?? null,
          priority: "high",
        },
        { db, sender: pushSender, settings, env: deps.notifyEnv },
      );
    } catch (e) {
      log("freigabe-push-fehler", { error: String(e), approvalId: created.id });
    }
  }

  async function decide(id: number, decision: "approve" | "deny", via = "web"): Promise<DecideOutcome> {
    const out = await decideApproval(db, id, decision);
    if (!out.ok) return { ok: false, status: out.status, message: out.status === 404 ? t("Freigabe-Anfrage nicht gefunden") : t("Schon entschieden ({state})", { state: out.current ?? "?" }) };
    log("freigabe-entschieden", { id, decision, via });
    hub.broadcast(APPROVAL_LIVE_MESSAGE);
    if (out.approval) await tell(out.approval, decision);
    return { ok: true, approval: out.approval };
  }

  app.post("/guard/check", machineAuth, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = GuardCheckSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Anfrage"), details: parsed.error.issues.slice(0, 5) }, 400);
    const { result, created } = await checkGuard(db, parsed.data);
    if (created) {
      log("freigabe-angefragt", { id: created.id, rule: created.rule, sessionKey: created.sessionKey });
      // The hook waits at most 1.5 s – never wait for the notification (bridge, Nyx check up to 8 s).
      void announce(created);
    } else if (result.decision === "allow") {
      log("freigabe-verbraucht", { id: result.approvalId });
      hub.broadcast(APPROVAL_LIVE_MESSAGE);
    }
    return c.json(result);
  });

  app.get("/api/approvals", async (c) => {
    const status = c.req.query("status") === "all" ? "all" : "pending";
    return c.json({ approvals: await listApprovals(db, status) });
  });

  app.post("/api/approvals/:id/decide", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = ApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("decision muss approve oder deny sein") }, 400);
    const out = await decide(id, parsed.data.decision, "web");
    if (!out.ok) return c.json({ error: out.message }, out.status);
    return c.json({ approval: out.approval });
  });

  return {
    decide,
    approveMany: async (ids) => {
      const approved = await approveAllPending(db, ids);
      if (approved.length) {
        log("freigabe-alle", { ids: approved.map((a) => a.id) });
        hub.broadcast(APPROVAL_LIVE_MESSAGE);
      }
      //: auch bei „Alles freigeben“ jeder wartenden Session Bescheid sagen.
      for (const a of approved) await tell(a, "approve");
      return approved.length;
    },
  };
}
