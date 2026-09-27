// Skill-Bibliothek (Server): Stand von der Brücke übernehmen, Verlauf führen (Hermes `skill_ledger`:
// ein Eintrag je neuem SHA-256), Kacheln und Detail zusammenstellen, Vorschläge erzeugen (Takt), Zurücksetzen.
import {
  BRIDGE_CAP_SKILLS,
  dailySeries,
  sessionLabel,
  t,
  type BridgeSkill,
  type SkillDetail,
  type SkillJob,
  type SkillJobKind,
  type SkillReadResult,
  type SkillRestoreResult,
  type SkillSignal,
  type SkillsListResult,
  type SkillsOverview,
  type SkillSource,
  type SkillSuggestion,
  type SkillSuggestionStatus,
  type SkillTile,
  type SkillUse,
  type SkillVersion,
  type SkillVersionReason,
} from "@nyxos/shared";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, skillJobs, skillScanState, skillSuggestions, skillUses, skillVersions, skills } from "../db/schema.js";
import { sessionHref } from "../haiku/sources.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { ruleSuggestion, type SuggestionWriter } from "./suggest.js";
import { detectSignal, eventsAfter, markChecked, scanSkillUses, uncheckedUses } from "./usage.js";

// Session-Namen nach derselben Regel wie überall (`sessionLabel`) – nie „Session ohne Titel“.
const labelColumns = {
  title: sessions.title,
  titleSource: sessions.titleSource,
  tool: sessions.tool,
  cwd: sessions.cwd,
  baustelleLabel: sessions.categoryBaustelleLabel,
  startedAt: sessions.startedAt,
  lastActivityAt: sessions.lastActivityAt,
};
const labelOf = (r: { title: string | null; titleSource: string | null; tool: string | null; cwd: string | null; baustelleLabel: string | null; startedAt: string | null; lastActivityAt: string | null }) => sessionLabel(r);

const SYNC_MIN_GAP_MS = 60_000;
const DAY_MS = 86_400_000;
/** Neue Stände so lange nach einem Opus-Auftrag gehören zu ihm („mit Opus verbessert“). */
const JOB_ATTRIBUTION_MS = 12 * 3_600_000;
/** Höchstens so viele Nyx-Vorschläge je Takt (Budget schonen). */
const WRITER_PER_TICK = 3;
const READ_BATCH = 100;

export type BridgeState = SkillsOverview["bridge"];

export interface SkillServiceDeps {
  db: Db;
  bridgeHub: BridgeHub;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  writer: SuggestionWriter | null;
  /** Nach Änderungen (neue Vorschläge, Stände) das Web neu laden lassen. */
  notify: () => void;
}

export class SkillServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 | 503,
  ) {
    super(message);
  }
}

type SkillRow = typeof skills.$inferSelect;

export class SkillService {
  private lastSyncAt = 0;
  private syncing: Promise<BridgeState> | null = null;
  private ticking = false;
  /** Letzte Wurzeln von der Brücke (Arbeitsordner, Ziel-Ordner für neue Skills). */
  roots: Pick<SkillsListResult, "projectRoot" | "targets"> | null = null;

  constructor(readonly d: SkillServiceDeps) {}

  bridgeState(): BridgeState {
    if (!this.d.bridgeHub.online) return "offline";
    return this.d.bridgeHub.supports(BRIDGE_CAP_SKILLS) ? "online" : "zu_alt";
  }

  /** Stand von der Brücke holen (höchstens einmal je Minute, außer `force`). Mehrere Anfragen teilen sich einen Lauf. */
  async sync(force = false): Promise<BridgeState> {
    const state = this.bridgeState();
    if (state !== "online") return state;
    if (!force && Date.now() - this.lastSyncAt < SYNC_MIN_GAP_MS) return state;
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<BridgeState> {
    const { db, bridgeHub, log } = this.d;
    const r = await bridgeHub.rpc("skills_list", {}, 20_000);
    if (!r.ok) {
      log("skills-sync-fehler", { code: r.code, error: r.error });
      return r.code === "bridge_offline" ? "offline" : "online";
    }
    const list = r.result as SkillsListResult;
    this.roots = { projectRoot: list.projectRoot, targets: list.targets };
    this.lastSyncAt = Date.now();
    const now = new Date().toISOString();
    for (const s of list.skills) {
      const values = { name: s.name, description: s.description, source: s.source, plugin: s.plugin, dir: s.dir, skillPath: s.skillPath, writable: s.writable, sha256: s.sha256, bytes: s.bytes, files: s.files, seenAt: now, missingSince: null };
      await db.insert(skills).values({ key: s.key, ...values }).onConflictDoUpdate({ target: skills.key, set: values });
    }
    const keys = list.skills.map((s) => s.key);
    // Nicht mehr auf dem Rechner: sichtbar lassen, als „fehlt“ markieren (nie still löschen).
    await db
      .update(skills)
      .set({ missingSince: now })
      .where(and(isNull(skills.missingSince), keys.length > 0 ? sql`${skills.key} not in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})` : sql`true`));
    await this.recordVersions(list.skills);
    await db.insert(skillScanState).values({ id: 1, syncedAt: now }).onConflictDoUpdate({ target: skillScanState.id, set: { syncedAt: now } });
    return "online";
  }

  /** Neue SKILL.md-Stände als Version ablegen (Inhalt per `skill_read`), an Opus-Aufträge hängen. */
  private async recordVersions(list: BridgeSkill[]): Promise<void> {
    const { db } = this.d;
    const latest = await this.latestVersions(list.map((s) => s.key));
    const changed = list.filter((s) => latest.get(s.key)?.sha256 !== s.sha256);
    for (let i = 0; i < changed.length; i += READ_BATCH) {
      const batch = changed.slice(i, i + READ_BATCH);
      const r = await this.d.bridgeHub.rpc("skill_read", { paths: batch.map((s) => s.skillPath) }, 20_000);
      if (!r.ok) {
        this.d.log("skills-lesen-fehler", { code: r.code, error: r.error });
        return;
      }
      const files = (r.result as SkillReadResult).files;
      for (const s of batch) {
        const content = files.find((f) => f.path === s.skillPath)?.content;
        if (content == null) continue;
        const prev = latest.get(s.key);
        const job = await this.attributableJob(s.key);
        const reason: SkillVersionReason = job ? (job.kind === "create" && !prev ? "erstellt" : "verbessert") : prev ? "geaendert" : "erfasst";
        await db.insert(skillVersions).values({ skillKey: s.key, sha256: s.sha256, content, reason, jobId: job?.id ?? null });
        if (job?.suggestionId) {
          await db.update(skillSuggestions).set({ status: "umgesetzt", updatedAt: new Date().toISOString() }).where(eq(skillSuggestions.id, job.suggestionId));
        }
      }
    }
  }

  private async latestVersions(keys: string[]): Promise<Map<string, { id: number; sha256: string; content: string }>> {
    if (keys.length === 0) return new Map();
    const rows = await this.d.db
      .selectDistinctOn([skillVersions.skillKey], { skillKey: skillVersions.skillKey, id: skillVersions.id, sha256: skillVersions.sha256, content: skillVersions.content })
      .from(skillVersions)
      .where(inArray(skillVersions.skillKey, keys))
      .orderBy(skillVersions.skillKey, desc(skillVersions.id));
    return new Map(rows.map((r) => [r.skillKey, r]));
  }

  private async attributableJob(key: string): Promise<{ id: number; kind: string; suggestionId: number | null } | null> {
    const since = new Date(Date.now() - JOB_ATTRIBUTION_MS).toISOString();
    const [job] = await this.d.db
      .select({ id: skillJobs.id, kind: skillJobs.kind, suggestionId: skillJobs.suggestionId })
      .from(skillJobs)
      .where(and(eq(skillJobs.skillKey, key), eq(skillJobs.status, "running"), gte(skillJobs.createdAt, since)))
      .orderBy(desc(skillJobs.id))
      .limit(1);
    return job ?? null;
  }

  // ── Lesen ───────────────────────────────────────────────────────────────────────────────────

  async overview(): Promise<SkillsOverview> {
    const bridge = await this.sync().catch(() => this.bridgeState());
    await scanSkillUses(this.d.db).catch((e: unknown) => this.d.log("skills-scan-fehler", { error: String(e) }));
    const [state] = await this.d.db.select({ syncedAt: skillScanState.syncedAt }).from(skillScanState).where(eq(skillScanState.id, 1)).limit(1);
    return { skills: await this.tiles(), bridge, syncedAt: state?.syncedAt ?? null };
  }

  private async tiles(onlyKey?: string): Promise<SkillTile[]> {
    const { db } = this.d;
    const rows = onlyKey ? await db.select().from(skills).where(eq(skills.key, onlyKey)) : await db.select().from(skills);
    const known = new Set(rows.map((r) => r.key));
    const usage = await db
      .select({ skill: skillUses.skill, via: skillUses.via, uses: sql<number>`count(*)::int`, last: sql<string>`max(${skillUses.ts})` })
      .from(skillUses)
      .where(onlyKey ? eq(skillUses.skill, onlyKey) : undefined)
      .groupBy(skillUses.skill, skillUses.via);
    const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const recent = await db
      .select({ skill: skillUses.skill, via: skillUses.via, ts: skillUses.ts })
      .from(skillUses)
      .where(and(gte(skillUses.ts, since), onlyKey ? eq(skillUses.skill, onlyKey) : undefined));
    // Befehle zählen nur für bekannte Skills; Skill-Aufrufe ohne Datei = eingebaute Skills (artifact-design …).
    const counts = (k: string) => usage.filter((u) => u.skill === k && (u.via === "tool" || known.has(k)));
    const builtins = [...new Set(usage.filter((u) => u.via === "tool" && !known.has(u.skill)).map((u) => u.skill))];
    const open = await db
      .select({ key: skillSuggestions.skillKey, n: sql<number>`count(*)::int` })
      .from(skillSuggestions)
      .where(eq(skillSuggestions.status, "open"))
      .groupBy(skillSuggestions.skillKey);
    const improved = await db
      .select({ key: skillVersions.skillKey, at: sql<string>`max(${skillVersions.createdAt})` })
      .from(skillVersions)
      .where(inArray(skillVersions.reason, ["verbessert", "erstellt", "zurueckgesetzt"]))
      .groupBy(skillVersions.skillKey);
    const running = await this.runningJobs();

    const tile = (key: string, row: SkillRow | null): SkillTile => {
      const u = counts(key);
      const last = u.map((x) => x.last).sort().at(-1) ?? null;
      return {
        key,
        name: row?.name ?? key,
        description: row?.description ?? null,
        source: (row?.source ?? "builtin") as SkillSource,
        plugin: row?.plugin ?? null,
        writable: row?.writable ?? false,
        pinned: row?.pinned ?? false,
        missing: row?.missingSince != null,
        uses: u.reduce((n, x) => n + x.uses, 0),
        lastUsedAt: last ? new Date(last).toISOString() : null,
        daily: dailySeries(recent.filter((x) => x.skill === key && (x.via === "tool" || known.has(key))).map((x) => x.ts)),
        openSuggestions: open.find((o) => o.key === key)?.n ?? 0,
        lastImprovedAt: (() => {
          const at = improved.find((i) => i.key === key)?.at;
          return at ? new Date(at).toISOString() : null;
        })(),
        runningJob: running.get(key) ?? null,
        files: (row?.files ?? []).length,
        bytes: row?.bytes ?? 0,
      };
    };
    const out = [...rows.map((r) => tile(r.key, r)), ...(onlyKey && known.has(onlyKey) ? [] : builtins.filter((b) => !onlyKey || b === onlyKey).map((b) => tile(b, null)))];
    return out.sort((a, b) => b.uses - a.uses || a.key.localeCompare(b.key));
  }

  /** Laufende Aufträge je Skill (Session läuft noch). */
  private async runningJobs(): Promise<Map<string, SkillTile["runningJob"]>> {
    const jobs = await this.jobs();
    const out = new Map<string, SkillTile["runningJob"]>();
    for (const j of jobs) if (j.status === "running" && j.skillKey && !out.has(j.skillKey)) out.set(j.skillKey, { id: j.id, kind: j.kind, sessionHref: j.sessionHref });
    return out;
  }

  async jobs(skillKey?: string): Promise<SkillJob[]> {
    const rows = await this.d.db
      .select({ job: skillJobs, s: { sessionId: sessions.sessionId, categoryArt: sessions.categoryArt, categoryBaustelleSlug: sessions.categoryBaustelleSlug, status: sessions.status } })
      .from(skillJobs)
      .leftJoin(sessions, eq(sessions.id, skillJobs.sessionKey))
      .where(skillKey ? eq(skillJobs.skillKey, skillKey) : undefined)
      .orderBy(desc(skillJobs.id))
      .limit(50);
    return rows.map(({ job, s }) => ({
      id: job.id,
      kind: job.kind as SkillJobKind,
      skillKey: job.skillKey,
      model: job.model,
      // Läuft, solange die Session läuft; danach „beendet“ (der Stand zählt über `recordVersions`).
      status: job.status === "error" ? "error" : s && s.status !== "running" ? "ended" : "running",
      sessionKey: job.sessionKey,
      sessionHref: s?.sessionId ? sessionHref({ sessionId: s.sessionId, categoryArt: s.categoryArt, categoryBaustelleSlug: s.categoryBaustelleSlug }) : null,
      error: job.error,
      at: new Date(job.createdAt).toISOString(),
    }));
  }

  async detail(key: string): Promise<SkillDetail | null> {
    const { db } = this.d;
    await this.sync().catch(() => undefined);
    const [tile] = await this.tiles(key);
    if (!tile) return null;
    const [row] = await db.select().from(skills).where(eq(skills.key, key)).limit(1);
    const versions = await db
      .select({ id: skillVersions.id, sha256: skillVersions.sha256, reason: skillVersions.reason, at: skillVersions.createdAt, jobId: skillVersions.jobId, content: skillVersions.content })
      .from(skillVersions)
      .where(eq(skillVersions.skillKey, key))
      .orderBy(desc(skillVersions.id));
    const uses = await db
      .select({ at: skillUses.ts, via: skillUses.via, sessionKey: skillUses.sessionKey, signal: skillUses.signal, sessionId: sessions.sessionId, art: sessions.categoryArt, slug: sessions.categoryBaustelleSlug, ...labelColumns })
      .from(skillUses)
      .leftJoin(sessions, eq(sessions.id, skillUses.sessionKey))
      .where(eq(skillUses.skill, key))
      .orderBy(desc(skillUses.ts))
      .limit(100);
    return {
      skill: { ...tile, dir: row?.dir ?? null, skillPath: row?.skillPath ?? null, fileList: row?.files ?? [] },
      content: versions[0]?.content ?? null,
      uses: uses.map(
        (u): SkillUse => ({
          at: new Date(u.at).toISOString(),
          via: u.via as SkillUse["via"],
          sessionKey: u.sessionKey,
          sessionTitle: u.sessionId ? labelOf(u) : null,
          sessionHref: u.sessionId ? sessionHref({ sessionId: u.sessionId, categoryArt: u.art, categoryBaustelleSlug: u.slug }) : null,
          signal: (u.signal as SkillSignal | null) ?? null,
        }),
      ),
      versions: versions.map((v): SkillVersion => ({ id: v.id, sha256: v.sha256, reason: v.reason as SkillVersionReason, at: new Date(v.at).toISOString(), jobId: v.jobId, bytes: Buffer.byteLength(v.content) })),
      suggestions: await this.suggestions(key),
      jobs: await this.jobs(key),
    };
  }

  async suggestions(key: string): Promise<SkillSuggestion[]> {
    const rows = await this.d.db
      .select({ s: skillSuggestions, sessionId: sessions.sessionId, art: sessions.categoryArt, slug: sessions.categoryBaustelleSlug, ...labelColumns })
      .from(skillSuggestions)
      .leftJoin(sessions, eq(sessions.id, skillSuggestions.sessionKey))
      .where(eq(skillSuggestions.skillKey, key))
      .orderBy(desc(skillSuggestions.id));
    return rows.map(({ s, sessionId, art, slug, ...label }) => ({
      id: s.id,
      skillKey: s.skillKey,
      signal: s.signal as SkillSignal,
      problem: s.problem,
      evidence: s.evidence,
      idea: s.idea,
      author: s.author === "nyx" ? "nyx" : "regel",
      status: s.status as SkillSuggestionStatus,
      sessionKey: s.sessionKey,
      sessionTitle: sessionId ? labelOf(label) : null,
      sessionHref: sessionId ? sessionHref({ sessionId, categoryArt: art, categoryBaustelleSlug: slug }) : null,
      at: new Date(s.createdAt).toISOString(),
      jobId: s.jobId,
    }));
  }

  /** Inhalt einer Version und der Stand davor (für den Vergleich). */
  async version(key: string, id: number): Promise<{ content: string; previous: string | null } | null> {
    const rows = await this.d.db
      .select({ id: skillVersions.id, content: skillVersions.content })
      .from(skillVersions)
      .where(eq(skillVersions.skillKey, key))
      .orderBy(desc(skillVersions.id));
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    return { content: rows[i]?.content ?? "", previous: rows[i + 1]?.content ?? null };
  }

  /** Eine Zusatzdatei des Skills lesen (nur Pfade aus der gemeldeten Dateiliste). */
  async file(key: string, rel: string): Promise<{ content: string | null; truncated: boolean }> {
    const [row] = await this.d.db.select().from(skills).where(eq(skills.key, key)).limit(1);
    if (!row?.dir || !(row.files ?? []).some((f) => f.rel === rel)) throw new SkillServiceError(t("Diese Datei gehört nicht zum Skill."), 404);
    if (this.bridgeState() !== "online") throw new SkillServiceError(t("Der Rechner ist gerade nicht verbunden. Sobald er online ist, geht es."), 503);
    const r = await this.d.bridgeHub.rpc("skill_read", { paths: [`${row.dir}/${rel}`] });
    if (!r.ok) throw new SkillServiceError(t("Die Datei ließ sich gerade nicht lesen. Bitte gleich noch einmal."), 502);
    const f = (r.result as SkillReadResult).files[0];
    return { content: f?.content ?? null, truncated: f?.truncated ?? false };
  }

  // ── Schreiben (nur auf des Nutzers Klick) ────────────────────────────────────────────────────

  async setPinned(key: string, pinned: boolean): Promise<boolean> {
    const res = await this.d.db.update(skills).set({ pinned }).where(eq(skills.key, key)).returning({ key: skills.key });
    return res.length > 0;
  }

  async setSuggestionStatus(id: number, status: "open" | "verworfen"): Promise<boolean> {
    const res = await this.d.db.update(skillSuggestions).set({ status, updatedAt: new Date().toISOString() }).where(eq(skillSuggestions.id, id)).returning({ id: skillSuggestions.id });
    return res.length > 0;
  }

  /** Rückgängig: früheren Stand zurückschreiben (Brücke sichert vorher und prüft den Hash). */
  async restore(key: string, versionId: number): Promise<SkillVersion> {
    const { db } = this.d;
    const [row] = await db.select().from(skills).where(eq(skills.key, key)).limit(1);
    if (!row) throw new SkillServiceError(t("Diesen Skill gibt es nicht mehr."), 404);
    if (!row.writable || !row.skillPath || !row.sha256) throw new SkillServiceError(t("Diesen Skill kann NyxOS nicht ändern (Plugin oder Claude.ai)."), 409);
    const [version] = await db.select().from(skillVersions).where(and(eq(skillVersions.id, versionId), eq(skillVersions.skillKey, key))).limit(1);
    if (!version) throw new SkillServiceError(t("Diesen Stand gibt es nicht."), 404);
    if (this.bridgeState() !== "online") throw new SkillServiceError(t("Der Rechner ist gerade nicht verbunden. Sobald er online ist, geht es."), 503);
    const r = await this.d.bridgeHub.rpc("skill_restore", { skillPath: row.skillPath, content: version.content, expectSha256: row.sha256 });
    if (!r.ok) {
      if (r.code === "skill_conflict") throw new SkillServiceError(t("Der Skill wurde inzwischen geändert. Bitte neu laden und dann noch einmal."), 409);
      throw new SkillServiceError(t("Das Zurücksetzen hat nicht geklappt. Bitte gleich noch einmal."), 502);
    }
    const res = r.result as SkillRestoreResult;
    await db.update(skills).set({ sha256: res.sha256, bytes: Buffer.byteLength(version.content) }).where(eq(skills.key, key));
    const [v] = await db.insert(skillVersions).values({ skillKey: key, sha256: res.sha256, content: version.content, reason: "zurueckgesetzt", backupDir: res.backupDir }).returning();
    this.d.notify();
    if (!v) throw new SkillServiceError(t("Das Zurücksetzen hat nicht geklappt. Bitte gleich noch einmal."), 502);
    return { id: v.id, sha256: v.sha256, reason: "zurueckgesetzt", at: new Date(v.createdAt).toISOString(), jobId: null, bytes: Buffer.byteLength(v.content) };
  }

  // ── Takt: Nutzung einlesen, Signale prüfen, Vorschläge schreiben lassen ────────────────────

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await scanSkillUses(this.d.db);
      const created = await this.checkSignals(now);
      if (created > 0) this.d.notify();
    } finally {
      this.ticking = false;
    }
  }

  private async checkSignals(now: number): Promise<number> {
    const { db } = this.d;
    const uses = await uncheckedUses(db, now);
    if (uses.length === 0) return 0;
    const rows = await db.select().from(skills).where(inArray(skills.key, [...new Set(uses.map((u) => u.skill))]));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    let created = 0;
    let written = 0;
    for (const use of uses) {
      const row = byKey.get(use.skill);
      // Vorschläge nur für eigene Skills (änderbar), nicht angepinnt, noch vorhanden.
      if (!row || !row.writable || row.pinned || row.missingSince) {
        await markChecked(db, use.eventId, null);
        continue;
      }
      const finding = detectSignal(use, await eventsAfter(db, use));
      await markChecked(db, use.eventId, finding?.signal ?? null);
      if (!finding) continue;
      // Ein offener Vorschlag je Skill und Session genügt.
      const [dup] = await db
        .select({ id: skillSuggestions.id })
        .from(skillSuggestions)
        .where(and(eq(skillSuggestions.skillKey, use.skill), eq(skillSuggestions.sessionKey, use.sessionKey), eq(skillSuggestions.status, "open")))
        .limit(1);
      if (dup) continue;
      let text = ruleSuggestion(finding.signal, finding.evidence);
      let author: "nyx" | "regel" = "regel";
      if (this.d.writer && written < WRITER_PER_TICK) {
        written++;
        const latest = (await this.latestVersions([use.skill])).get(use.skill);
        const byNyx = await this.d
          .writer({ skillKey: use.skill, description: row.description, skillText: latest?.content ?? null, signal: finding.signal, evidence: finding.evidence, context: finding.context })
          .catch((e: unknown) => {
            this.d.log("skills-vorschlag-fehler", { skill: use.skill, error: String(e) });
            return null;
          });
        if (byNyx) {
          text = byNyx;
          author = "nyx";
        }
      }
      const res = await db
        .insert(skillSuggestions)
        .values({ skillKey: use.skill, sessionKey: use.sessionKey, eventId: use.eventId, signal: finding.signal, problem: text.problem, evidence: text.evidence, idea: text.idea, author })
        .onConflictDoNothing()
        .returning({ id: skillSuggestions.id });
      created += res.length;
    }
    return created;
  }
}
