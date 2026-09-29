// Bestand an Agenten/Skills + Skill-Nutzung + Auffälligkeiten.
import type { AgentDetails, Anomaly, CatalogEntry, SkillUsageStat } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentCatalog } from "../db/schema.js";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

/** Meldung der Brücke bei Änderung (`POST /ingest/catalog`) — ersetzt den ganzen Bestand EINER
 * `source` (z. B. "user"), damit gelöschte Agenten/Skills verschwinden statt für immer stehen zu
 * bleiben. Andere `source`-Werte (Projekt, Plugins) bleiben unberührt. */
export async function replaceCatalogSource(db: Db, machineId: string, source: string, items: CatalogEntry[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(agentCatalog).where(sql`${agentCatalog.source} = ${source}`);
    if (items.length > 0) {
      await tx.insert(agentCatalog).values(items.map((i) => ({ kind: i.kind, name: i.name, description: i.description, path: i.path, source: i.source, details: i.details ?? null, machineId, seenAt: sql`now()` as unknown as string })));
    }
  });
}

export async function listCatalog(db: Db): Promise<{ kind: string; name: string; description: string | null; path: string; source: string; seenAt: string; details: AgentDetails | null }[]> {
  return db
    .select({ kind: agentCatalog.kind, name: agentCatalog.name, description: agentCatalog.description, path: agentCatalog.path, source: agentCatalog.source, seenAt: agentCatalog.seenAt, details: agentCatalog.details })
    .from(agentCatalog)
    .orderBy(agentCatalog.kind, agentCatalog.name);
}

export async function getSkillUsage7d(db: Db): Promise<SkillUsageStat[]> {
  const rows = rowsOf<{ skill: string; runs: string; last_used_at: string }>(
    await db.execute(sql`
      select data->>'target' as skill, count(*) as runs, max(ts) as last_used_at
      from session_events
      where kind = 'tool_call' and data->>'name' = 'Skill' and ts > now() - interval '7 days'
      group by data->>'target'
      order by count(*) desc
    `),
  );
  return rows.filter((r) => r.skill).map((r) => ({ skill: r.skill, runs7d: Number(r.runs), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
}

/** Auffälligkeiten (regelbasiert — keine KI-Bewertung): ein Skill aus dem Bestand,
 * der seit ≥ 30 Tagen (oder nie) genutzt wurde; ein Gate-Agent, der dieselbe Eltern-Session ≥ 3× BLOCKt. */
export async function detectAnomalies(db: Db): Promise<Anomaly[]> {
  const catalog = await listCatalog(db);
  const skills = catalog.filter((c) => c.kind === "skill");
  const usage = rowsOf<{ skill: string; last_used_at: string | null }>(
    await db.execute(sql`
      select data->>'target' as skill, max(ts) as last_used_at
      from session_events
      where kind = 'tool_call' and data->>'name' = 'Skill'
      group by data->>'target'
    `),
  );
  const lastUsedBySkill = new Map(usage.map((u) => [u.skill, u.last_used_at]));
  const anomalies: Anomaly[] = [];
  const now = Date.now();
  for (const s of skills) {
    const last = lastUsedBySkill.get(s.name);
    const sinceDays = last ? Math.floor((now - new Date(last).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY;
    if (sinceDays >= 30) anomalies.push({ kind: "skill_unused", skill: s.name, sinceDays: Number.isFinite(sinceDays) ? sinceDays : -1 });
  }

  const blocks = rowsOf<{ session_key: string; agent_id: string; blocks: string }>(
    await db.execute(sql`
      select session_key, data->>'agentId' as agent_id, count(*) as blocks
      from session_events
      where kind = 'assistant' and data ? 'agentId' and coalesce(data->>'text','') ~ '\\yBLOCK\\y'
      group by session_key, data->>'agentId'
      having count(*) >= 3
    `),
  );
  for (const b of blocks) anomalies.push({ kind: "gate_repeated_block", agentName: b.agent_id, sessionKey: b.session_key, count: Number(b.blocks) });
  return anomalies;
}
