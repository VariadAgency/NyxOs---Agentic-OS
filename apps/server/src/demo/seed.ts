// Demo mode (`nyxos demo`): fills an empty database with the invented "Atlas" workspace so every tab
// can be clicked through. Runs once — only when the database has no session yet — and goes through
// the same code paths as real data where possible (ingest, archive, search index, maturity check).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { setLang, type HaikuSource, type Lang } from "@nyxos/shared";
import { count, eq } from "drizzle-orm";
import { loadAppSettings } from "../app-info/settings.js";
import { archivePath } from "../archive.js";
import type { Db } from "../db/client.js";
import {
  agentCatalog,
  appSettings,
  approvals,
  bridgeEvents,
  buildRuns,
  conflictEvents,
  deploys,
  entries,
  entryEvents,
  gitActions,
  gitBranches,
  gitCatchupHistory,
  gitCommits,
  gitProbeMerges,
  gitRepos,
  gitUncommitted,
  gitWorktrees,
  haikuCalls,
  haikuMessages,
  haikuReports,
  haikuSettings,
  haikuThreads,
  inboxItems,
  links,
  machines,
  nyxMemory,
  nyxMemorySuggestions,
  nyxProfile,
  nyxSchedules,
  nyxTodos,
  reservations,
  rules,
  sessionAudits,
  sessionOpens,
  sessions,
  skills,
  skillScanState,
  skillSuggestions,
  skillUses,
  skillVersions,
  sortRules,
  subtasks,
  usageDaily,
  usageEvents,
  usageSettings,
  vaultNotes,
} from "../db/schema.js";
import { entryHref } from "../haiku/entriesBridge.js";
import { generateReport } from "../haiku/report.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { localDay } from "../usage/periods.js";
import { applyMaturityToAllPlanned } from "../entries/store.js";
import { sessionHref } from "../haiku/sources.js";
import { SKILL_BACKFILL_VERSION } from "../skills/usage.js";
import { indexChatDocs } from "../search.js";
import { ingest, recordArchive } from "../store.js";
import { TranscriptCache } from "../transcript.js";
import { buildDemoData, type DemoData } from "./data.js";
import { AUTHOR } from "./data-git.js";
import { VAULT_ROOT } from "./data-nyx.js";
import { PLANNING_KEYWORDS } from "./data-work.js";
import { ago, pick } from "./text.js";

export interface SeedDemoOptions {
  archiveDir: string;
  /** Reference time; every timestamp of the demo is relative to it. */
  now?: number;
  /** Language of the invented texts; default: the stored app language (German on a fresh install). */
  lang?: Lang;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface SeedDemoResult {
  lang: Lang;
  sessions: number;
  entries: number;
  commits: number;
  usageEvents: number;
  ms: number;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Seeds the demo workspace unless the database already has sessions. Returns `null` when nothing was done. */
export async function seedDemoIfEmpty(db: Db, opts: SeedDemoOptions): Promise<SeedDemoResult | null> {
  const [row] = await db.select({ n: count() }).from(sessions);
  if ((row?.n ?? 0) > 0) return null;
  const lang = opts.lang ?? (await loadAppSettings(db)).lang;
  const now = opts.now ?? Date.now();
  const started = Date.now();
  const data = buildDemoData(now, lang);
  await seedDemo(db, data, opts.archiveDir);
  const result = {
    lang,
    sessions: data.sessions.length,
    entries: data.entries.length,
    commits: data.git.commits.length,
    usageEvents: data.usage.events.length,
    ms: Date.now() - started,
  };
  opts.log?.("demo-daten-angelegt", { ...result });
  return result;
}

async function ensureMachine(db: Db, now: number): Promise<string> {
  const [existing] = await db.select({ id: machines.id }).from(machines).limit(1);
  const id = existing?.id ?? "local";
  if (!existing) await db.insert(machines).values({ id, name: "local", tokenHash: sha256(randomBytes(32)) });
  await db.update(machines).set({ lastSeenAt: ago(now, 2) }).where(eq(machines.id, id));
  return id;
}

export async function seedDemo(db: Db, data: DemoData, archiveDir: string): Promise<void> {
  const { now, lang } = data;
  const t = (x: { de: string; en: string }) => pick(x, lang);
  const at = (min: number) => ago(now, min);
  const machineId = await ensureMachine(db, now);

  // ── app settings: language, name, onboarding done; Nyx engine off (the demo never starts AI runs) ──
  await db
    .insert(appSettings)
    .values({ id: 1, lang, userName: "Alex", onboardingDone: true, autoUpdate: false })
    .onConflictDoUpdate({ target: appSettings.id, set: { lang, userName: "Alex", onboardingDone: true } });
  setLang(lang);
  await db.insert(haikuSettings).values({ id: 1, engine: "off" }).onConflictDoUpdate({ target: haikuSettings.id, set: { engine: "off" } });

  // ── sorting rules: every repo/worktree folder is a "Baustelle"; English planning words → planning ──
  await db.insert(sortRules).values([
    ...data.sortRules.map((r) => ({ condition: { stage: "cwd", value: r.cwd }, dimension: "baustelle", targetBaustelleSlug: r.slug, targetBaustelleLabel: r.label, origin: "manuell", createdAt: at(30 * 24 * 60) })),
    { condition: { stage: "keyword", anyOf: PLANNING_KEYWORDS }, dimension: "art", targetArt: "planung", origin: "manuell", createdAt: at(30 * 24 * 60) },
  ]);

  // ── sessions: the same ingest the bridge uses, then archive + search index ──
  await ingest(
    db,
    machineId,
    data.sessions.flatMap((s) => s.items),
  );
  const cache = new TranscriptCache();
  for (const s of data.sessions) {
    for (const f of s.transcript.files) {
      const raw = Buffer.from(f.text, "utf8");
      const gz = gzipSync(raw);
      const meta = { tool: s.spec.tool, path: f.path, sha256: sha256(raw) };
      const storedPath = archivePath(archiveDir, meta);
      await mkdir(dirname(storedPath), { recursive: true });
      await writeFile(storedPath, gz);
      await recordArchive(db, machineId, { ...meta, sessionId: s.sessionId, size: raw.length, gzSize: gz.length, storedPath });
    }
    await indexChatDocs(db, cache, s.key);
    if (s.closedAt) await db.update(sessions).set({ closedAt: s.closedAt, closedBy: "web", state: "closed" }).where(eq(sessions.id, s.key));
  }
  const keyOf = new Map(data.sessions.map((s) => [s.spec.key, s.key]));
  const sk = (k: string | undefined) => (k ? (keyOf.get(k) ?? null) : null);
  const openedKeys = ["checkout-stepper", "passkey-register", "rate-limit-audit", "lcp-performance", "webhook-retries", "roadmap-q4"];
  await db.insert(sessionOpens).values(openedKeys.map((k, i) => ({ sessionKey: sk(k) ?? "", lastOpenedAt: at(5 + i * 37), openCount: 6 - i })).filter((r) => r.sessionKey));

  // ── entries: tasks, bugs, audit findings, ideas, decisions ──
  const entryId = new Map<string, number>();
  for (const e of data.entries) {
    const subs = e.subtasks ?? [];
    const total = subs.reduce((n, x) => n + (x.weight ?? 1), 0);
    const done = subs.filter((x) => x.done).reduce((n, x) => n + (x.weight ?? 1), 0);
    const [inserted] = await db
      .insert(entries)
      .values({
        kind: e.kind,
        title: t(e.title),
        description: e.description ? t(e.description) : null,
        stage: e.stage,
        priority: e.priority ?? null,
        baustelleSlug: e.baustelle?.slug ?? null,
        baustelleLabel: e.baustelle?.label ?? null,
        progressDoneWeight: done,
        progressTotalWeight: total,
        progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
        sourceType: "demo",
        sourceId: e.findingId ?? e.key,
        fileScope: e.fileScope ?? [],
        modelSuggestion: e.modelSuggestion ?? null,
        estimate: e.estimate === undefined ? null : typeof e.estimate === "string" ? e.estimate : t(e.estimate),
        startedSessionKey: sk(e.startedBy),
        createdAt: at(e.createdMin),
        updatedAt: at(e.updatedMin),
      })
      .returning({ id: entries.id });
    if (!inserted) continue;
    entryId.set(e.key, inserted.id);
    if (subs.length > 0) {
      await db.insert(subtasks).values(
        subs.map((x, i) => ({
          entryId: inserted.id,
          title: t(x.title),
          weight: x.weight ?? 1,
          done: !!x.done,
          doneBySessionKey: x.done ? sk(x.done.session) : null,
          doneAt: x.done ? at(x.done.min) : null,
          createdAt: at(e.createdMin - i),
        })),
      );
    }
    const events: (typeof entryEvents.$inferInsert)[] = [{ entryId: inserted.id, ts: at(e.createdMin), kind: "angelegt", source: e.from ? "mcp" : "api", data: e.from ? { sessionKey: sk(e.from) } : {} }];
    for (const x of subs) if (x.done) events.push({ entryId: inserted.id, ts: at(x.done.min), kind: "teilaufgabe_erledigt", source: "mcp", data: { title: t(x.title), sessionKey: sk(x.done.session) } });
    for (const n of e.notes ?? []) events.push({ entryId: inserted.id, ts: at(n.min), kind: "fortschritt", source: "mcp", data: { note: t(n.text), sessionKey: sk(n.session) } });
    await db.insert(entryEvents).values(events);
  }
  const linkRows: (typeof links.$inferInsert)[] = [];
  for (const e of data.entries) {
    const id = entryId.get(e.key);
    if (!id) continue;
    for (const k of e.sessions ?? []) if (sk(k)) linkRows.push({ fromType: "entry", fromId: String(id), toType: "session", toId: sk(k) ?? "", relation: "session", createdAt: at(e.createdMin) });
    if (e.from && sk(e.from)) linkRows.push({ fromType: "entry", fromId: String(id), toType: "session", toId: sk(e.from) ?? "", relation: "entstand_aus", createdAt: at(e.createdMin) });
  }
  for (const x of data.entryLinks) {
    const from = entryId.get(x.from);
    const to = entryId.get(x.to);
    if (from && to) linkRows.push({ fromType: "entry", fromId: String(from), toType: "entry", toId: String(to), relation: x.relation, createdAt: at(60) });
  }
  if (linkRows.length > 0) await db.insert(links).values(linkRows).onConflictDoNothing();
  // The maturity check (never set by hand) decides which planned tasks are "startklar".
  await applyMaturityToAllPlanned(db);

  // ── decisions inbox + approvals ──
  const inboxId = new Map<string, number>();
  for (const q of data.inbox) {
    const sessionKey = sk(q.session);
    const sources: HaikuSource[] = [];
    if (sessionKey) sources.push(await sessionSource(db, sessionKey));
    const eid = q.entry ? entryId.get(q.entry) : undefined;
    if (eid) sources.push({ kind: "entry", id: String(eid), label: t(data.entries.find((e) => e.key === q.entry)?.title ?? q.title).slice(0, 80), href: entryHref(data.entries.find((e) => e.key === q.entry)?.kind ?? "aufgabe", eid) });
    const [row] = await db
      .insert(inboxItems)
      .values({
        kind: q.kind,
        title: t(q.title),
        body: q.body ? t(q.body) : null,
        options: q.options.map((o) => ({ id: o.id, label: t(o.label), detail: o.detail ? t(o.detail) : null })),
        status: q.status,
        answer: q.answer ?? null,
        sessionKey,
        entryId: eid ?? null,
        baustelle: q.baustelle ?? null,
        sources,
        createdBy: q.createdBy,
        estimateMinutes: q.estimateMinutes,
        yesNo: q.yesNo ?? false,
        escalation: q.escalation ?? null,
        delivery: q.status === "answered" ? { toSession: "sent", decisionCommit: null, note: null } : null,
        fingerprint: `demo:${q.key}`,
        createdAt: at(q.createdMin),
        answeredAt: q.answeredMin !== undefined ? at(q.answeredMin) : null,
      })
      .returning({ id: inboxItems.id });
    if (row) inboxId.set(q.key, row.id);
  }
  for (const a of data.approvals) {
    await db.insert(approvals).values({
      status: a.status,
      rule: a.rule,
      reason: t(a.reason),
      tool: a.tool,
      command: a.command,
      commandHash: sha256(`${a.command}|${sk(a.session) ?? ""}`),
      cwd: data.sessions.find((s) => s.spec.key === a.session)?.cwd ?? null,
      sessionKey: sk(a.session),
      worktree: a.worktree ?? null,
      createdAt: at(a.createdMin),
      decidedAt: a.decidedMin !== undefined ? at(a.decidedMin) : null,
      decidedBy: a.decidedMin !== undefined ? "web" : null,
      consumedAt: a.status === "consumed" && a.decidedMin !== undefined ? at(a.decidedMin - 1) : null,
    });
  }

  // ── git ──
  const g = data.git;
  await db.insert(gitRepos).values(
    g.repos.map((r) => {
      const head = [...g.commits].reverse().find((c) => c.repoId === r.id && c.branch === r.currentBranch);
      return { id: r.id, label: r.label, kind: r.kind, root: r.root, currentBranch: r.currentBranch, headSha: head?.sha ?? null, tags: r.kind === "app" ? ["v2.2.0", "v2.3.0-rc2"] : [], scannedAt: at(2), parentId: r.parentId, mainBranch: r.mainBranch, lastActivityAt: head?.at ?? null };
    }),
  );
  for (let i = 0; i < g.commits.length; i += 200) {
    await db.insert(gitCommits).values(
      g.commits.slice(i, i + 200).map((c) => ({
        repoId: c.repoId,
        sha: c.sha,
        authorDate: c.at,
        committedAt: c.at,
        subject: c.subject,
        branch: c.branch,
        authorName: c.author,
        parentCount: c.parentCount,
        files: c.files,
        filesChanged: c.files.length,
        insertions: c.files.reduce((n, f) => n + f.add, 0),
        deletions: c.files.reduce((n, f) => n + f.del, 0),
        sessionKey: c.sessionKey,
        sessionConfidence: c.sessionKey ? "sicher" : "keine",
        sessionReason: c.sessionKey ? pick({ de: "git commit in dieser Session", en: "git commit in this session" }, lang) : null,
        attributedAt: c.at,
      })),
    );
  }
  await db.insert(gitBranches).values(g.branches);
  await db.insert(gitUncommitted).values(g.uncommitted.map((u) => ({ repoId: u.repoId, path: u.path, statusCode: u.statusCode, group: u.group, fromPath: u.fromPath ?? null })));
  await db.insert(gitWorktrees).values(g.worktrees);
  await db.insert(gitProbeMerges).values(g.probes.map((p) => ({ ...p, checksumBefore: sha256(`${p.branch}:before`).slice(0, 16), checksumAfter: sha256(`${p.branch}:before`).slice(0, 16) })));
  await db.insert(gitCatchupHistory).values(g.catchups.map((c) => ({ repoId: c.repoId, worktreePath: c.worktreePath, branch: c.branch, outcome: c.outcome, mainShaBefore: c.before, mainShaAfter: c.after, detail: c.detail, at: c.at })));
  await db.insert(gitActions).values(g.actions.map((a) => ({ ...a, identity: `${AUTHOR} <alex@lumenlabs.example>` })));

  // ── conflicts, reservations, lesson book ──
  await db.insert(reservations).values(data.reservations.map((r) => ({ pathGlob: r.pathGlob, label: t(r.label), sessionKey: sk(r.session), createdAt: at(r.createdMin), until: r.untilMin === null ? null : at(r.untilMin) })));
  await db.insert(conflictEvents).values(data.conflictEvents.map((c) => ({ kind: c.kind, folder: c.folder, path: c.path, detectedAt: at(c.min) })));
  await db.insert(rules).values(data.rules.map((r) => ({ kind: r.kind, condition: r.condition, action: r.action, origin: r.origin, hitCount: r.hitCount, createdAt: at(r.createdMin), lastHitAt: r.lastHitMin === null ? null : at(r.lastHitMin) })));

  // ── build watcher + deploys ──
  await db.insert(buildRuns).values(
    data.builds.map((b) => ({ sessionKey: sk(b.session), kind: b.kind, command: b.command, status: b.status, exitCode: b.exitCode, logExcerpt: b.log, trigger: b.trigger, startedAt: at(b.startedMin), endedAt: ago(now - b.durSec * 1000, b.startedMin), folder: b.folder })),
  );
  await db.insert(deploys).values(data.deploys.map((d) => ({ project: "nyxos", containerName: d.containerName, imageId: d.imageId, gitRev: d.gitRev, source: d.source, createdAt: at(d.createdMin) })));

  // ── usage ──
  for (let i = 0; i < data.usage.events.length; i += 300) await db.insert(usageEvents).values(data.usage.events.slice(i, i + 300));
  for (let i = 0; i < data.usage.daily.length; i += 300) await db.insert(usageDaily).values(data.usage.daily.slice(i, i + 300));
  await db
    .insert(usageSettings)
    .values({ id: 1, defaultRange: "30", goalScope: "all", goalMonthTokens: 3_000_000_000, goalWeekTokens: 750_000_000, warnWindowPct: 80, warnDailyTokens: 200_000_000 })
    .onConflictDoNothing();

  // ── agents & skills ──
  await db.insert(agentCatalog).values([
    ...data.agents.map((a) => ({
      kind: "agent",
      name: a.name,
      description: a.description,
      path: a.source === "user" ? `/Users/demo/.claude/agents/${a.name}.md` : `/Users/demo/projects/atlas-web/.claude/agents/${a.name}.md`,
      source: a.source,
      machineId,
      seenAt: at(3),
      details: { model: a.model, tools: a.tools, color: a.color, prompt: a.prompt },
    })),
    ...data.skills.map((s) => ({ kind: "skill", name: s.key, description: s.description, path: `/Users/demo/.claude/skills/${s.key}/SKILL.md`, source: "user", machineId, seenAt: at(3), details: null })),
  ]);
  for (const s of data.skills) {
    const content = s.improved ?? s.content;
    await db.insert(skills).values({
      key: s.key,
      name: s.name,
      description: s.description,
      source: s.source,
      plugin: s.plugin,
      dir: s.plugin ? `/Users/demo/.claude/plugins/${s.plugin}/skills/${s.key}` : `/Users/demo/.claude/skills/${s.key}`,
      skillPath: s.plugin ? `/Users/demo/.claude/plugins/${s.plugin}/skills/${s.key}/SKILL.md` : `/Users/demo/.claude/skills/${s.key}/SKILL.md`,
      writable: !s.plugin,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      files: [{ rel: "SKILL.md", bytes: Buffer.byteLength(content) }],
      seenAt: at(3),
    });
    await db.insert(skillVersions).values({ skillKey: s.key, sha256: sha256(s.content), content: s.content, reason: "erfasst", createdAt: at(25 * 24 * 60) });
    if (s.improved) await db.insert(skillVersions).values({ skillKey: s.key, sha256: sha256(s.improved), content: s.improved, reason: "verbessert", createdAt: at(4 * 24 * 60) });
  }
  // Skill calls from the session events, already checked (so no background check re-runs them).
  const skillCalls = data.sessions.flatMap((s) =>
    s.events
      .filter((e) => e.kind === "tool_call" && (e.data as { name?: unknown }).name === "Skill" && typeof (e.data as { target?: unknown }).target === "string")
      .map((e) => ({ eventId: e.id, skill: String((e.data as { target: string }).target), sessionKey: s.key, ts: e.ts, via: "tool", toolUseId: typeof (e.data as { toolUseId?: unknown }).toolUseId === "string" ? String((e.data as { toolUseId: string }).toolUseId) : null, checkedAt: at(1), signal: s.spec.key === "deploy-staging" ? "korrektur" : null })),
  );
  if (skillCalls.length > 0) await db.insert(skillUses).values(skillCalls).onConflictDoNothing();
  await db.insert(skillScanState).values({ id: 1, lastReceivedAt: at(0), syncedAt: at(3), backfillVersion: SKILL_BACKFILL_VERSION }).onConflictDoNothing();
  const deployUse = skillCalls.find((c) => c.skill === data.skillSuggestion.skillKey && c.signal);
  await db.insert(skillSuggestions).values({ ...data.skillSuggestion, sessionKey: deployUse?.sessionKey ?? null, eventId: deployUse?.eventId ?? null, author: "nyx", status: "open", createdAt: at(5 * 60), updatedAt: at(5 * 60) });

  // ── notes vault (brain graph) ──
  await db.insert(vaultNotes).values(
    data.vault.map((n) => ({
      path: n.path,
      machineId,
      root: VAULT_ROOT,
      title: n.title,
      heading: n.title,
      folder: n.folder,
      tags: n.tags,
      links: n.links,
      mentions: n.mentionKeys.map((k) => data.sessions.find((s) => s.spec.key === k)?.sessionId ?? "").filter(Boolean),
      mtime: at(n.mtimeMin),
      size: n.size,
      excerpt: n.excerpt,
      syncId: "demo",
    })),
  );

  // ── Nyx: threads, plan, memory, schedules, calls, profile ──
  const threadIds = new Map<string, number>();
  for (const th of data.threads) {
    const startMs = now - th.startMin * 60_000;
    const last = Math.max(...th.messages.map((m) => m.at));
    const [row] = await db
      .insert(haikuThreads)
      .values({ scope: "full", topic: th.topic, day: localDay(new Date(startMs)), title: t(th.title).slice(0, 80), createdAt: new Date(startMs).toISOString(), updatedAt: new Date(startMs + last * 60_000).toISOString() })
      .returning({ id: haikuThreads.id });
    if (!row) continue;
    threadIds.set(th.key, row.id);
    for (const m of th.messages) {
      const sources: HaikuSource[] = [];
      for (const ref of m.sources ?? []) {
        if (ref.kind === "session") {
          const key = sk(ref.key);
          if (key) sources.push(await sessionSource(db, key));
        } else {
          const id = entryId.get(ref.key);
          const e = data.entries.find((x) => x.key === ref.key);
          if (id && e) sources.push({ kind: "entry", id: String(id), label: t(e.title).slice(0, 80), href: entryHref(e.kind, id) });
        }
      }
      await db.insert(haikuMessages).values({ threadId: row.id, role: m.role, text: t(m.text), sources, channel: m.channel ?? "web", createdAt: new Date(startMs + m.at * 60_000).toISOString() });
    }
    if (th.todos) await db.insert(nyxTodos).values({ threadId: row.id, revision: 3, items: th.todos.map((x, i) => ({ id: String(i + 1), content: t(x.content), status: x.status })), updatedAt: new Date(startMs + last * 60_000).toISOString() });
  }
  await db.insert(nyxMemory).values(data.memory.map((m, i) => ({ category: m.category, fact: t(m.fact), createdBy: m.createdBy, createdAt: at(20 * 24 * 60 - i * 1_000), updatedAt: at(20 * 24 * 60 - i * 1_000) })));
  await db.insert(nyxMemorySuggestions).values({ action: data.memorySuggestion.action, category: data.memorySuggestion.category, fact: t(data.memorySuggestion.fact), reason: t(data.memorySuggestion.reason), sourceThreadId: threadIds.get("passkeys") ?? null, status: "open", createdAt: at(40) });
  await db.insert(nyxSchedules).values(
    data.schedules.map((s) => ({
      name: t(s.name),
      prompt: t(s.prompt),
      mode: s.mode,
      kind: s.kind,
      cron: s.cron ?? null,
      event: s.event ?? null,
      deliver: s.deliver,
      paused: s.paused,
      nextRunAt: s.nextMin === null ? null : at(s.nextMin),
      lastRunAt: s.lastMin === null ? null : at(s.lastMin),
      lastStatus: s.lastStatus,
      lastOutput: s.lastOutput ? t(s.lastOutput) : null,
      runCount: s.runCount,
      createdBy: "nyx",
      createdAt: at(20 * 24 * 60),
      updatedAt: at(s.lastMin ?? 60),
    })),
  );
  await db.insert(haikuCalls).values(
    data.haikuCalls.map((c) => ({ kind: c.kind, engine: "claude-cli", model: "claude-haiku-4-5", status: "ok", inputTokens: c.tokensIn, outputTokens: c.tokensOut, costUsd: c.cost, durationMs: c.durationMs, createdAt: at(c.min), endedAt: ago(now - c.durationMs, c.min) })),
  );
  await db
    .insert(nyxProfile)
    .values({ id: 1, userProfile: data.profile.user, personality: data.profile.personality, sliders: data.profile.sliders, activePreset: null })
    .onConflictDoUpdate({ target: nyxProfile.id, set: { userProfile: data.profile.user, personality: data.profile.personality, sliders: data.profile.sliders } });

  // ── session reviews + bridge connection history ──
  for (const a of data.sessionAudits) {
    const key = sk(a.session);
    if (key) await db.insert(sessionAudits).values({ sessionKey: key, status: "done", result: a.result, itemsRead: 40, itemsTotal: 40, createdAt: at(3 * 60), finishedAt: at(3 * 60 - 1) });
  }
  await db.insert(bridgeEvents).values([
    { machineId, at: at(26 * 60), state: "online", reason: null },
    { machineId, at: at(15 * 60), state: "offline", reason: pick({ de: "Rechner schläft oder ist offline", en: "computer is asleep or offline" }, lang) },
    { machineId, at: at(7 * 60 + 40), state: "online", reason: null },
    { machineId, at: at(3 * 60 + 12), state: "reconnecting", reason: null },
    { machineId, at: at(3 * 60 + 11), state: "online", reason: null },
  ]);

  // ── morning briefing + evening recap, written from the finished demo data ──
  await writeReports(db, data);
}

async function sessionSource(db: Db, key: string): Promise<HaikuSource> {
  const [row] = await db
    .select({ id: sessions.id, sessionId: sessions.sessionId, title: sessions.title, categoryArt: sessions.categoryArt, categoryBaustelleSlug: sessions.categoryBaustelleSlug })
    .from(sessions)
    .where(eq(sessions.id, key))
    .limit(1);
  return { kind: "session", id: key, label: (row?.title ?? key).slice(0, 80), href: row ? sessionHref(row) : null };
}

/**
 * Briefing and recap go through the real report writer (all figures and charts from the live data).
 * No AI run: the writer gets a stand-in that answers "engine off", then the demo adds Nyx' headline
 * and suggestion, like a normal morning. Later rewrites (the page does one when the data changed)
 * run with the engine switched off and fall back to the rule-based text — honest, never an AI call.
 */
async function writeReports(db: Db, data: DemoData): Promise<void> {
  const { now, lang } = data;
  const offline = { db, run: async () => ({ type: "error" as const, code: "disabled", message: "demo", callId: null }) } as unknown as HaikuRuntime;
  const texts = {
    briefing: {
      headline: pick({ de: "Drei Dinge brauchen dich heute – der Rest läuft von allein.", en: "Three things need you today – the rest runs on its own." }, lang),
      suggestion: pick(
        {
          de: "Zuerst die Passkey-Frage beantworten (1 Minute), dann den Android-Absturz fortsetzen lassen. Das Audit kann bis nach dem Mittag warten.",
          en: "Answer the passkey question first (1 minute), then let the Android crash session resume. The audit can wait until after lunch.",
        },
        lang,
      ),
      title: pick({ de: "Vorschlag für heute", en: "Suggestion for today" }, lang),
    },
    recap: {
      headline: pick({ de: "Ein produktiver Tag: Webhooks fertig, Staging aktuell, zwei Features in Arbeit.", en: "A productive day: webhooks done, staging up to date, two features in progress." }, lang),
      suggestion: pick(
        { de: "Morgen zuerst den roten Passkey-Test reparieren, dann Checkout v2 pushen.", en: "Tomorrow, fix the red passkey test first, then push checkout v2." },
        lang,
      ),
      title: pick({ de: "Vorschlag für morgen", en: "Suggestion for tomorrow" }, lang),
    },
  };
  // Recap: the evening of the current day if it is already evening, otherwise yesterday evening.
  const berlinHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
  const recapAt = berlinHour >= 21 ? now : now - (berlinHour + 3) * 3_600_000;
  const plan: { kind: "briefing" | "recap"; at: number }[] = [
    { kind: "recap", at: recapAt },
    { kind: "briefing", at: berlinHour >= 7 ? now - Math.min(berlinHour - 7, 2) * 3_600_000 : now },
  ];
  for (const p of plan) {
    const report = await generateReport(offline, p.kind, new Date(p.at));
    const tx = texts[p.kind];
    const [row] = await db.select().from(haikuReports).where(eq(haikuReports.id, report.id)).limit(1);
    if (!row) continue;
    const content = row.content as Record<string, unknown> & { sections?: { title: string; statements: unknown[] }[]; headline?: Record<string, unknown> | null };
    const sections = (content.sections ?? []).filter((s) => !/^(Als Nächstes|Vorschlag|Next|Suggestion)/.test(s.title));
    sections.push({ title: tx.title, statements: [{ text: tx.suggestion, sources: [], estimate: false, author: "haiku" }] });
    await db
      .update(haikuReports)
      .set({
        content: { ...content, mode: "ok", modeReason: null, headline: { text: tx.headline, sources: content.headline?.sources ?? [], estimate: false, author: "haiku" }, sections, highlights: ["needs_you", "sessions_active", "commits"] },
        createdAt: new Date(p.at).toISOString(),
      })
      .where(eq(haikuReports.id, report.id));
  }
}
