// Ideen-Link: Links je Person (Token nur als SHA-256), Ablauf, Widerruf, Ratenbegrenzung.
import { createHash, randomBytes } from "node:crypto";
import type { IdeaLink } from "@nyxos/shared";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ideaLinkHits, ideaLinks } from "../db/schema.js";

/** Token-Format: 32 Byte base64url (256 Bit Zufall) – nicht erratbar, nie gespeichert. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const hashIdeaToken = (token: string) => createHash("sha256").update(`idealink:${token}`).digest("hex");

/** Obergrenze über ALLE Links zusammen (schützt das Haiku-Budget, egal wie viele Links es gibt). */
export const GLOBAL_RATE_PER_HOUR = 60;

type Row = typeof ideaLinks.$inferSelect;

export function toIdeaLink(r: Row, now = new Date()): IdeaLink {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    ratePerHour: r.ratePerHour,
    uses: r.uses,
    ideasCreated: r.ideasCreated,
    lastUsedAt: r.lastUsedAt,
    active: !r.revokedAt && new Date(r.expiresAt).getTime() > now.getTime(),
  };
}

export async function createIdeaLink(db: Db, input: { name: string; expiresInDays: number; ratePerHour: number }, now = new Date()): Promise<{ link: IdeaLink; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(ideaLinks)
    .values({ name: input.name.trim(), tokenHash: hashIdeaToken(token), ratePerHour: input.ratePerHour, expiresAt: new Date(now.getTime() + input.expiresInDays * 86400_000).toISOString() })
    .returning();
  return { link: toIdeaLink(row as Row, now), token };
}

export async function listIdeaLinks(db: Db, now = new Date()): Promise<IdeaLink[]> {
  const rows = await db.select().from(ideaLinks).orderBy(desc(ideaLinks.createdAt)).limit(200);
  return rows.map((r) => toIdeaLink(r, now));
}

export async function revokeIdeaLink(db: Db, id: number, now = new Date()): Promise<IdeaLink | null> {
  const [row] = await db.update(ideaLinks).set({ revokedAt: now.toISOString() }).where(and(eq(ideaLinks.id, id), isNull(ideaLinks.revokedAt))).returning();
  if (row) return toIdeaLink(row, now);
  const [existing] = await db.select().from(ideaLinks).where(eq(ideaLinks.id, id)).limit(1);
  return existing ? toIdeaLink(existing, now) : null;
}

/** Nur aktive Links (nicht widerrufen, nicht abgelaufen). Falsches Format → gar keine DB-Abfrage. */
export async function resolveIdeaToken(db: Db, token: string, now = new Date()): Promise<Row | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db.select().from(ideaLinks).where(eq(ideaLinks.tokenHash, hashIdeaToken(token))).limit(1);
  if (!row || row.revokedAt || new Date(row.expiresAt).getTime() <= now.getTime()) return null;
  return row;
}

/** Gleitendes Stundenfenster je Link + global. true = erlaubt (und gezählt). */
export async function takeRateSlot(db: Db, link: Row, now = new Date()): Promise<{ ok: true } | { ok: false; scope: "link" | "global" }> {
  const since = new Date(now.getTime() - 3600_000).toISOString();
  const chat = eq(ideaLinkHits.kind, "chat");
  const [mine] = await db.select({ n: count() }).from(ideaLinkHits).where(and(chat, eq(ideaLinkHits.linkId, link.id), gte(ideaLinkHits.at, since)));
  if ((mine?.n ?? 0) >= link.ratePerHour) return { ok: false, scope: "link" };
  const [all] = await db.select({ n: count() }).from(ideaLinkHits).where(and(chat, gte(ideaLinkHits.at, since)));
  if ((all?.n ?? 0) >= GLOBAL_RATE_PER_HOUR) return { ok: false, scope: "global" };
  await db.insert(ideaLinkHits).values({ linkId: link.id, at: now.toISOString() });
  await db
    .update(ideaLinks)
    .set({ uses: sql`${ideaLinks.uses} + 1`, lastUsedAt: now.toISOString() })
    .where(eq(ideaLinks.id, link.id));
  return { ok: true };
}

export async function countIdeaCreated(db: Db, linkId: number): Promise<void> {
  await db
    .update(ideaLinks)
    .set({ ideasCreated: sql`${ideaLinks.ideasCreated} + 1` })
    .where(eq(ideaLinks.id, linkId));
}

// ─── Obergrenze für neue Ideen: je Link und global, gleitende 24 h ───

const DAY_MS = 86400_000;

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** Ist die Ideen-Obergrenze (je Link oder global) schon erreicht? Nur lesen – für die freundliche Absage vorab. */
export async function ideaQuotaReached(db: Db, linkId: number, limits: { perLink: number; global: number }, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const idea = eq(ideaLinkHits.kind, "idea");
  const [mine] = await db.select({ n: count() }).from(ideaLinkHits).where(and(idea, eq(ideaLinkHits.linkId, linkId), gte(ideaLinkHits.at, since)));
  if ((mine?.n ?? 0) >= limits.perLink) return true;
  const [all] = await db.select({ n: count() }).from(ideaLinkHits).where(and(idea, gte(ideaLinkHits.at, since)));
  return (all?.n ?? 0) >= limits.global;
}

/** Reserviert einen Platz für eine neue Idee – in EINER Anweisung (Prüfen + Zählen), false = Grenze erreicht. */
export async function reserveIdeaSlot(db: Db, linkId: number, limits: { perLink: number; global: number }, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const res = await db.execute(sql`
    insert into ${ideaLinkHits} (link_id, at, kind)
    select ${linkId}, ${now.toISOString()}, 'idea'
    where (select count(*) from ${ideaLinkHits} where kind = 'idea' and link_id = ${linkId} and at >= ${since}) < ${limits.perLink}
      and (select count(*) from ${ideaLinkHits} where kind = 'idea' and at >= ${since}) < ${limits.global}
    returning id`);
  return rowsOf(res).length > 0;
}
