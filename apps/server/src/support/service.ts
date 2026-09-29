// "Feedback & Unterstützen": bug reports and ideas go through the outbox (`support_outbox`) to the support service
// of the project website; donations get a payment page from it that the sheet embeds. Contract: docs/support-api.md.
//
// - With an address: forward right away. Reached → `sent`. Not reachable / busy (timeout, 429, 5xx) → `waiting`,
//   goes out by itself in the server's 60-s tick (`flush`, with growing pauses). Rejected (other 4xx) → `rejected`,
//   with the service's sentence, no new attempt.
// - Without an address: `waiting` ("wartet auf Verbindung") until one is set; then out by itself.
// - Drafts (`draft`) are what Nyx may prepare; they never go out by themselves.
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import {
  sanitizeDiagnostics,
  sanitizeDiagnosticText,
  SUPPORT_LIMITS,
  SUPPORT_URL_DEFAULT,
  supportTitle,
  t,
  type SupportBug,
  type SupportDonate,
  type SupportDonateResult,
  type SupportDraft,
  type SupportIdea,
  type SupportOutboxItem,
  type SupportOutboxStatus,
  type SupportSendResult,
  type SupportState,
} from "@nyxos/shared";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { supportOutbox } from "../db/schema.js";
import { privateUrlsAllowed, type HostResolver } from "../net/safeFetch.js";
import { loadAppSettings } from "../app-info/settings.js";
import { checkSupportUrl, isLoopbackHost, resolveSupportTarget, saveSettingUrl, type SupportTarget } from "./config.js";
import { forwardToSupport, type ForwardResult, type SupportEndpoint } from "./client.js";
import { RecentErrors } from "./recent-errors.js";

export interface SupportServiceDeps {
  db: Db;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  version: string;
  mode: "local" | "server" | "unknown";
  errors: RecentErrors;
  /** Tests: fake support service. */
  fetch?: typeof fetch;
  /** Tests: environment (`NYXOS_SUPPORT_URL`, `NYXOS_ALLOW_PRIVATE_URLS`). */
  env?: NodeJS.ProcessEnv;
  /** Tests: DNS without network. */
  resolve?: HostResolver;
  now?: () => number;
  /** Tests: default address instead of `SUPPORT_URL_DEFAULT`. */
  defaultUrl?: string;
}

type Row = typeof supportOutbox.$inferSelect;
type Kind = "bug" | "idea";

/** Items shown in the sheet (newest first). */
const LIST_LIMIT = 8;
/** Reports sent per tick at most (the rest follows in the next tick). */
const FLUSH_BATCH = 5;
/** Pause after the n-th failed attempt: 1, 2, 4 … minutes, at most 6 hours. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 3600_000;
/** A `sending` row older than this was interrupted (server restart) and waits again. */
const STALE_SENDING_MS = 5 * 60_000;

const ENDPOINT: Record<Kind, SupportEndpoint> = { bug: "v1/bug", idea: "v1/idea" };

function iso(v: string | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

function toItem(r: Row): SupportOutboxItem {
  return {
    id: r.id,
    kind: r.kind === "idea" ? "idea" : "bug",
    title: r.title,
    status: r.status as SupportOutboxStatus,
    createdAt: new Date(r.createdAt).toISOString(),
    sentAt: iso(r.sentAt),
    attempts: r.attempts,
    lastError: r.lastError,
    reference: r.reference,
  };
}

/** After sending (or rejection) the screenshot itself is not kept, only what it was. */
function withoutScreenshotData(payload: Record<string, unknown>): Record<string, unknown> {
  const shot = payload.screenshot as { name?: string; type?: string; dataBase64?: string } | null | undefined;
  if (!shot?.dataBase64) return payload;
  return { ...payload, screenshot: { name: shot.name, type: shot.type, bytes: Math.floor((shot.dataBase64.length * 3) / 4) } };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class SupportService {
  private flushing: Promise<number> | null = null;
  private origin: string | null = null;

  constructor(private readonly d: SupportServiceDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  async target(): Promise<SupportTarget> {
    const target = await resolveSupportTarget(this.d.db, this.env, this.d.defaultUrl ?? SUPPORT_URL_DEFAULT);
    this.origin = target.origin;
    return target;
  }

  /** Last known origin of the support service — for the `frame-src` of the page (synchronous, see app.ts). */
  frameOrigin(): string | null {
    return this.origin;
  }

  /** Personal words the diagnostics must not contain: the name in NyxOS, the account and computer name. */
  private async personalWords(): Promise<string[]> {
    const words: string[] = [];
    try {
      const name = (await loadAppSettings(this.d.db)).userName;
      if (name) words.push(...name.split(/\s+/));
    } catch {
      // no settings table (old test database)
    }
    try {
      words.push(userInfo().username);
    } catch {
      // no account name (container without passwd entry)
    }
    try {
      const host = hostname();
      words.push(host, host.replace(/\.local$/i, ""));
    } catch {
      // ignore
    }
    return words.filter((w) => w && w.length >= 3);
  }

  private forwardOptions(key?: string) {
    return {
      fetch: this.d.fetch ?? fetch,
      version: this.d.version,
      allowPrivate: privateUrlsAllowed(this.env),
      ...(this.d.resolve ? { resolve: this.d.resolve } : {}),
      ...(key ? { idempotencyKey: key } : {}),
    };
  }

  /** Who sends: app, version, run mode and the language the user reads NyxOS in (for the service's answers). */
  private async client() {
    let locale = "de";
    try {
      locale = (await loadAppSettings(this.d.db)).lang;
    } catch {
      // keep German (the default language)
    }
    return { app: "nyxos", version: this.d.version, mode: this.d.mode, locale };
  }

  async state(): Promise<SupportState> {
    const target = await this.target();
    const db = this.d.db;
    const rows = await db
      .select()
      .from(supportOutbox)
      .where(inArray(supportOutbox.status, ["waiting", "sending", "sent", "rejected"]))
      .orderBy(desc(supportOutbox.createdAt), desc(supportOutbox.id))
      .limit(LIST_LIMIT);
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(supportOutbox)
      .where(inArray(supportOutbox.status, ["waiting", "sending"]));
    const drafts = await db.select().from(supportOutbox).where(eq(supportOutbox.status, "draft")).orderBy(desc(supportOutbox.updatedAt));
    const draftOf = (kind: Kind) => {
      const r = drafts.find((x) => x.kind === kind);
      return r ? { id: r.id, draft: { kind, ...r.payload } as SupportDraft, updatedAt: new Date(r.updatedAt).toISOString() } : null;
    };
    const words = await this.personalWords();
    return {
      configured: target.base !== null,
      origin: target.origin,
      source: target.source,
      settingUrl: target.settingUrl,
      envLocked: target.envLocked,
      problem: target.problem,
      outbox: { waiting: Number(counted?.n ?? 0), items: rows.map(toItem) },
      drafts: { bug: draftOf("bug"), idea: draftOf("idea") },
      diagnostics: {
        version: this.d.version,
        mode: this.d.mode,
        errors: this.d.errors.list().map((e) => ({ ...e, message: clip(sanitizeDiagnosticText(e.message, { words }), SUPPORT_LIMITS.errorChars) })),
      },
    };
  }

  /** Bug report or idea: store in the outbox, forward right away when possible. */
  async submit(kind: "bug", input: SupportBug): Promise<{ httpStatus: 200 | 202 | 502; result: SupportSendResult }>;
  async submit(kind: "idea", input: SupportIdea): Promise<{ httpStatus: 200 | 202 | 502; result: SupportSendResult }>;
  async submit(kind: Kind, input: SupportBug | SupportIdea): Promise<{ httpStatus: 200 | 202 | 502; result: SupportSendResult }> {
    const { draftId, ...rest } = input;
    let payload: Record<string, unknown> = rest;
    if (kind === "bug") {
      const bug = rest as Omit<SupportBug, "draftId">;
      // The browser cleaned the diagnostics already (the preview); the server cleans again with what only it knows.
      payload = { ...bug, diagnostics: bug.diagnostics ? sanitizeDiagnostics(bug.diagnostics, { words: await this.personalWords() }) : null };
    }
    const target = await this.target();
    const nowIso = new Date(this.now()).toISOString();
    const [row] = await this.d.db
      .insert(supportOutbox)
      .values({
        kind,
        status: target.base ? "sending" : "waiting",
        title: supportTitle(kind, payload as { what?: string; title?: string }),
        payload,
        clientId: randomUUID(),
        lastError: target.base ? null : (target.problem ?? t("Die Meldestelle ist noch nicht eingerichtet.")),
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    if (!row) throw new Error("support_outbox insert returned nothing");
    if (draftId) await this.d.db.delete(supportOutbox).where(and(eq(supportOutbox.id, draftId), eq(supportOutbox.status, "draft")));
    this.d.log("support-meldung", { kind, id: row.id, configured: target.base !== null });

    if (!target.base) {
      return {
        httpStatus: 202,
        result: { status: "queued", item: toItem(row), message: t("Gespeichert im Postausgang – geht raus, sobald die Meldestelle eingerichtet ist.") },
      };
    }
    const outcome = await this.send(target.base, row);
    const item = toItem(outcome.row);
    if (outcome.result.ok) return { httpStatus: 200, result: { status: "sent", item, message: outcome.message } };
    if (outcome.result.retry) {
      return { httpStatus: 202, result: { status: "queued", item, message: t("{reason} Deine Meldung wartet im Postausgang und geht von selbst raus.", { reason: outcome.result.error }) } };
    }
    return { httpStatus: 502, result: { status: "queued", item, message: outcome.result.error } };
  }

  /** Sends one row (status must already be `sending`) and stores the outcome. */
  private async send(base: URL, row: Row): Promise<{ row: Row; result: ForwardResult; message: string | null }> {
    const kind: Kind = row.kind === "idea" ? "idea" : "bug";
    const body = { id: row.clientId, createdAt: new Date(row.createdAt).toISOString(), client: await this.client(), ...row.payload };
    const result = await forwardToSupport(base, ENDPOINT[kind], body, this.forwardOptions(row.clientId));
    const now = this.now();
    const attempts = row.attempts + 1;
    let patch: Partial<typeof supportOutbox.$inferInsert>;
    let message: string | null = null;
    if (result.ok) {
      const ref = result.body.id;
      const msg = result.body.message;
      message = typeof msg === "string" && msg.trim() ? clip(msg.trim(), 300) : null;
      patch = {
        status: "sent",
        attempts,
        lastError: null,
        reference: typeof ref === "string" || typeof ref === "number" ? clip(String(ref), 100) : null,
        sentAt: new Date(now).toISOString(),
        nextAttemptAt: null,
        payload: withoutScreenshotData(row.payload),
      };
    } else if (result.retry) {
      const pause = Math.max(Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS), result.retryAfterMs ?? 0);
      patch = { status: "waiting", attempts, lastError: result.error, nextAttemptAt: new Date(now + pause).toISOString() };
    } else {
      patch = { status: "rejected", attempts, lastError: result.error, nextAttemptAt: null, payload: withoutScreenshotData(row.payload) };
    }
    const [updated] = await this.d.db
      .update(supportOutbox)
      .set({ ...patch, updatedAt: new Date(now).toISOString() })
      .where(eq(supportOutbox.id, row.id))
      .returning();
    this.d.log(result.ok ? "support-gesendet" : result.retry ? "support-wartet" : "support-abgelehnt", { id: row.id, kind, status: result.ok ? result.status : result.status });
    return { row: updated ?? row, result, message };
  }

  /**
   * Sends waiting reports that are due (called in the server's 60-s tick and right after the address changed).
   * Only one run at a time; returns how many went out.
   */
  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushNow(): Promise<number> {
    const db = this.d.db;
    const now = this.now();
    // Interrupted sends (server stopped mid-request) wait again.
    await db
      .update(supportOutbox)
      .set({ status: "waiting" })
      .where(and(eq(supportOutbox.status, "sending"), lte(supportOutbox.updatedAt, new Date(now - STALE_SENDING_MS).toISOString())));
    const target = await this.target();
    if (!target.base) return 0;
    const due = await db
      .select({ id: supportOutbox.id })
      .from(supportOutbox)
      .where(and(eq(supportOutbox.status, "waiting"), or(isNull(supportOutbox.nextAttemptAt), lte(supportOutbox.nextAttemptAt, new Date(now).toISOString()))))
      .orderBy(supportOutbox.id)
      .limit(FLUSH_BATCH);
    if (due.length === 0) return 0;
    const claimed = await db
      .update(supportOutbox)
      .set({ status: "sending", updatedAt: new Date(now).toISOString() })
      .where(and(inArray(supportOutbox.id, due.map((r) => r.id)), eq(supportOutbox.status, "waiting")))
      .returning();
    let sent = 0;
    for (const row of claimed) {
      const { result } = await this.send(target.base, row);
      if (result.ok) sent++;
    }
    return sent;
  }

  /** "Jetzt senden": all waiting reports are due right now. */
  async retryNow(): Promise<number> {
    await this.d.db.update(supportOutbox).set({ nextAttemptAt: null }).where(eq(supportOutbox.status, "waiting"));
    return this.flush();
  }

  /** Nyx (or the sheet) prepares a draft; one per kind, never sent by itself. */
  async saveDraft(draft: SupportDraft): Promise<number> {
    const { kind, ...fields } = draft;
    const nowIso = new Date(this.now()).toISOString();
    const [existing] = await this.d.db
      .select({ id: supportOutbox.id })
      .from(supportOutbox)
      .where(and(eq(supportOutbox.status, "draft"), eq(supportOutbox.kind, kind)))
      .limit(1);
    const values = { title: supportTitle(kind, fields as { what?: string; title?: string }), payload: fields, updatedAt: nowIso };
    if (existing) {
      await this.d.db.update(supportOutbox).set(values).where(eq(supportOutbox.id, existing.id));
      return existing.id;
    }
    const [row] = await this.d.db
      .insert(supportOutbox)
      .values({ kind, status: "draft", clientId: randomUUID(), createdAt: nowIso, ...values })
      .returning({ id: supportOutbox.id });
    return row?.id ?? 0;
  }

  /** Removes a draft, a waiting or a rejected report. Sent ones stay (they are the user's record). */
  async remove(id: number): Promise<boolean> {
    const gone = await this.d.db
      .delete(supportOutbox)
      .where(and(eq(supportOutbox.id, id), inArray(supportOutbox.status, ["draft", "waiting", "rejected"])))
      .returning({ id: supportOutbox.id });
    return gone.length > 0;
  }

  /** New address from the sheet ("" = back to the default). Waiting reports go out right after. */
  async saveSettings(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = url.trim();
    if (trimmed) {
      const checked = checkSupportUrl(trimmed, this.env);
      if (!checked.ok) return checked;
    }
    await saveSettingUrl(this.d.db, trimmed);
    await this.d.db.update(supportOutbox).set({ nextAttemptAt: null }).where(eq(supportOutbox.status, "waiting"));
    await this.target();
    return { ok: true };
  }

  /** "Buy me Tokens": the support service opens a payment session and returns the page to embed. */
  async donate(input: SupportDonate): Promise<{ ok: true; result: SupportDonateResult } | { ok: false; status: 409 | 502; code: string; error: string }> {
    const target = await this.target();
    if (!target.base || !target.origin) return { ok: false, status: 409, code: "not_configured", error: t("Bezahlen wird gerade eingerichtet – danke, dass du helfen willst!") };
    const body = { client: await this.client(), ...input };
    const res = await forwardToSupport(target.base, "v1/donate/session", body, this.forwardOptions(randomUUID()));
    if (!res.ok) return { ok: false, status: 502, code: "support_unavailable", error: res.error };
    const raw = res.body.embedUrl;
    const embed = typeof raw === "string" ? this.checkEmbedUrl(raw, target.origin) : null;
    if (!embed) return { ok: false, status: 502, code: "bad_embed_url", error: t("Die Meldestelle hat keine gültige Bezahlseite geschickt.") };
    this.d.log("support-spende-sitzung", { interval: input.interval });
    return { ok: true, result: { embedUrl: embed, origin: target.origin } };
  }

  /** The payment page must come from exactly the support origin (https; http only for localhost in development). */
  private checkEmbedUrl(raw: string, origin: string): string | null {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.origin !== origin || u.username || u.password) return null;
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && isLoopbackHost(u.hostname) && privateUrlsAllowed(this.env)) return u.toString();
    return null;
  }
}
