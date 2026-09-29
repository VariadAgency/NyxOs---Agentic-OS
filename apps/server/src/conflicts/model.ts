// Konflikte-Seite ohne Hänger. Vorher lud die Web-App alle 5 s (und bei JEDER Live-
// Nachricht) die ganze Kollisionskarte: 3.322 Einträge, 1,57 MB, jedes Mal neu berechnet. Jetzt:
// - ein billiger Fingerabdruck (eine SQL-Abfrage) sagt, ob sich etwas geändert hat;
// - nur dann wird die Karte neu berechnet und zwischengespeichert (`buildConflictModel`);
// - der Fingerabdruck ist zugleich der ETag → unverändert = 304 ohne Inhalt.
import { createHash } from "node:crypto";
import { buildConflictModel, type ConflictModel, type ConflictSessionMeta, type DecisionDismissal } from "@nyxos/shared";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conflictDismissals, sessions } from "../db/schema.js";
import { visibleSessionSql } from "../db/visible.js";
import { computeCollisionMap, listReservations } from "./store.js";

export class ConflictModelService {
  private cached: { version: string; model: ConflictModel } | null = null;
  /** Laufender Aufbau JE Stand — ein Aufbau für einen älteren Stand wird nie für einen neueren ausgegeben. */
  private building = new Map<string, Promise<ConflictModel>>();
  /** Gleichzeitige Aufrufe (Live-Bündel, mehrere Tabs) teilen sich EINE Fingerabdruck-Abfrage. */
  private fp: Promise<string> | null = null;
  private startedSeq = 0;
  private storedSeq = 0;

  constructor(
    private readonly db: Db,
    private readonly bridgeOnline: () => boolean = () => false,
  ) {}

  /** Nach eigenen Schreib-Aktionen: eine schon laufende (ältere) Fingerabdruck-Abfrage nicht mehr teilen
   * (sonst zeigte die Seite nach „Ignorieren“ kurz den alten Stand, und man klickt doppelt). */
  invalidate(): void {
    this.fp = null;
  }

  version(): Promise<string> {
    if (this.fp) return this.fp;
    const value = this.fingerprint().finally(() => {
      if (this.fp === value) this.fp = null;
    });
    this.fp = value;
    return value;
  }

  async get(): Promise<ConflictModel> {
    const version = await this.version();
    if (this.cached?.version === version) return this.cached.model;
    const running = this.building.get(version);
    if (running) return running;
    const p = this.build(version).finally(() => this.building.delete(version));
    this.building.set(version, p);
    return p;
  }

  private async fingerprint(): Promise<string> {
    const result = (await this.db.execute(sql`
      select
        (select count(*)::text || ':' || coalesce(max(sf.first_seen_at)::text, '')
           from session_files sf join sessions s on s.id = sf.session_key where s.closed_at is null and ${visibleSessionSql("s")}) as files,
        (select coalesce(md5(string_agg(s.id || '|' || coalesce(s.title, '') || '|' || coalesce(s.tmux_name, '') || '|' || s.attachable::text || '|' || coalesce(s.state, '') || '|' || coalesce(s.temporary_reason, ''), ',' order by s.id)), '')
           from sessions s where s.closed_at is null and ${visibleSessionSql("s")} and exists (select 1 from session_files sf where sf.session_key = s.id)) as sess,
        (select count(*)::text || ':' || coalesce(max(id), 0)::text from reservations) as res,
        (select count(*)::text || ':' || coalesce(max(id), 0)::text || ':' || coalesce(max(updated_at)::text, '') from conflict_dismissals) as dis
    `)) as unknown as { rows: Record<string, unknown>[] } | Record<string, unknown>[];
    const rows = Array.isArray(result) ? result : result.rows;
    const raw = JSON.stringify(rows[0] ?? {}) + `|bridge:${this.bridgeOnline() ? 1 : 0}`;
    return createHash("sha1").update(raw).digest("hex").slice(0, 20);
  }

  private async build(version: string): Promise<ConflictModel> {
    const seq = ++this.startedSeq;
    const [map, reservationRows, dismissalRows] = await Promise.all([computeCollisionMap(this.db), listReservations(this.db), this.db.select().from(conflictDismissals)]);
    const keys = [...new Set(map.flatMap((e) => e.writers.map((w) => w.sessionKey)))];
    const sessionRows = keys.length
      ? await this.db
          .select({ id: sessions.id, title: sessions.title, tool: sessions.tool, tmuxName: sessions.tmuxName, attachable: sessions.attachable })
          .from(sessions)
          .where(inArray(sessions.id, keys))
      : [];
    const meta = new Map<string, ConflictSessionMeta>(sessionRows.map((s) => [s.id, { title: s.title, tool: s.tool, inNyxOS: Boolean(s.tmuxName && s.attachable) }]));
    const model = buildConflictModel({
      map,
      reservations: reservationRows,
      dismissals: new Map(dismissalRows.map((d) => [d.decisionKey, d.status as DecisionDismissal])),
      sessions: meta,
      version,
      generatedAt: new Date().toISOString(),
      bridgeOnline: this.bridgeOnline(),
    });
    // Ein langsamer Aufbau, der VOR einem anderen gestartet wurde, darf dessen neueren Stand nicht überschreiben.
    if (seq > this.storedSeq) {
      this.storedSeq = seq;
      this.cached = { version, model };
    }
    return model;
  }
}

/** EIN Konflikt-Modell je Datenbank — die Route registriert ihres, der Schnappschuss
 * (offene Fragen, Kachel „Konflikte“) liest dasselbe (gleicher Zwischenspeicher, gleiche Zahl). */
const registry = new WeakMap<Db, ConflictModelService>();

export function registerConflictModel(db: Db, model: ConflictModelService): void {
  registry.set(db, model);
}

export function conflictModelFor(db: Db): ConflictModelService {
  let model = registry.get(db);
  if (!model) {
    model = new ConflictModelService(db);
    registry.set(db, model);
  }
  return model;
}

export async function setDismissal(db: Db, decisionKey: string, status: DecisionDismissal): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(conflictDismissals)
    .values({ decisionKey, status })
    .onConflictDoUpdate({ target: conflictDismissals.decisionKey, set: { status, updatedAt: now } });
}

export async function clearDismissal(db: Db, decisionKey: string): Promise<boolean> {
  const rows = await db.delete(conflictDismissals).where(eq(conflictDismissals.decisionKey, decisionKey)).returning({ id: conflictDismissals.id });
  return rows.length > 0;
}

/** Tmux-Namen der Sessions (nur offene, nur solche in der NyxOS). */
export async function nyxosSessions(db: Db, keys: string[]): Promise<Map<string, { title: string | null; tmuxName: string | null; attachable: boolean; state: string | null }>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ id: sessions.id, title: sessions.title, tmuxName: sessions.tmuxName, attachable: sessions.attachable, state: sessions.state })
    .from(sessions)
    .where(sql`${inArray(sessions.id, keys)} and ${isNull(sessions.closedAt)}`);
  return new Map(rows.map((r) => [r.id, { title: r.title, tmuxName: r.tmuxName, attachable: r.attachable, state: r.state }]));
}
