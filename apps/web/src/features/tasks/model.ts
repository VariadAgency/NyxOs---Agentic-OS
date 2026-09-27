// Aufgaben-Tab: reine Funktionen (ohne React) für Farben, Projekte, die Hierarchie
// Auftrag → Pakete → Schritte und die Kennzahlen im Kopf. Farben nur aus den Tokens (app.css).
import type { Entry, EntryKind, EntryStage } from "@nyxos/shared";
import { locale, t } from "@nyxos/shared";

export type TaskStage = "startklar" | "laeuft" | "pruefen" | "geplant" | "erledigt";

export interface StageTheme {
  label: string;
  /** CSS-Farbe (Token) — nie grau: jede Stufe hat ihren eigenen Farbton. */
  color: string;
  hint: string;
}

/** Reihenfolge = Dringlichkeit (was gerade läuft oder auf dich wartet, steht oben). */
export const STAGE_ORDER: TaskStage[] = ["laeuft", "pruefen", "startklar", "geplant", "erledigt"];

export const STAGE_THEME: Record<TaskStage, StageTheme> = {
  laeuft: { label: t("Läuft"), color: "var(--a-ok)", hint: t("wird gerade gebaut") },
  pruefen: { label: t("Prüfen"), color: "var(--a-wait)", hint: t("fertig, wartet auf deine Abnahme") },
  startklar: { label: t("Startklar"), color: "var(--a-teal)", hint: t("Reife-Check bestanden, ein Klick startet") },
  geplant: { label: t("Geplant"), color: "var(--a-done)", hint: t("Konzept da, noch nicht startklar") },
  erledigt: { label: t("Erledigt"), color: "var(--a-lime)", hint: t("von dir abgenommen") },
};

export function isTaskStage(stage: EntryStage): stage is TaskStage {
  return stage in STAGE_THEME;
}

/** Wie viele Stufen kommen vor? Ein Balken mit nur einer Stufe sagt nichts (alles eine Farbe). */
export function stageSpread(counts: Record<TaskStage, number>): number {
  return STAGE_ORDER.filter((s) => counts[s] > 0).length;
}

// ── Art-Filter im Aufgaben-Tab ───────────────────────────────────────────────────────
// Audit-Befunde haben einen eigenen Tab. Auf „Aufgaben“ würden sie die echten Aufträge verdecken.
// Standard ist darum „Aufträge + Bugs“, Audit per Chip.

export type TaskKindFilter = "standard" | "aufgabe" | "bug" | "audit" | "alles";

export const KIND_FILTERS: { value: TaskKindFilter; label: string }[] = [
  { value: "standard", label: t("Aufträge + Bugs") },
  { value: "aufgabe", label: t("Aufgaben") },
  { value: "bug", label: t("Bugs") },
  { value: "audit", label: t("Audit") },
  { value: "alles", label: t("Alles") },
];

/** Welche Art der Server filtern soll; `undefined` = alles holen („standard“ filtert dann hier). */
export function kindQuery(filter: TaskKindFilter): EntryKind | undefined {
  return filter === "aufgabe" || filter === "bug" || filter === "audit" ? filter : undefined;
}

export function matchesKindFilter(e: Pick<Entry, "kind">, filter: TaskKindFilter): boolean {
  if (filter === "alles") return true;
  if (filter === "standard") return e.kind !== "audit";
  return e.kind === filter;
}

/** Der Anfang des Kopf-Satzes („41 Aufträge offen“, „382 Befunde offen“). */
export function openCount(filter: TaskKindFilter, n: number): string {
  if (filter === "audit") return n === 1 ? t("{n} Befund offen", { n }) : t("{n} Befunde offen", { n });
  if (filter === "bug") return n === 1 ? t("{n} Bug offen", { n }) : t("{n} Bugs offen", { n });
  if (filter === "alles") return n === 1 ? t("{n} Eintrag offen", { n }) : t("{n} Einträge offen", { n });
  return n === 1 ? t("{n} Auftrag offen", { n }) : t("{n} Aufträge offen", { n });
}

export interface Project {
  key: string;
  label: string;
  color: string;
}

/** Feste Farbe nur für Audits; Projekte bekommen eine stabil aus dem Namen gewählte Farbe. Bewusst ohne
 * Zustandsfarben (grün/gelb/rot) und ohne Anbieter-Farben (Claude/Codex). */
const KNOWN_PROJECTS: Record<string, { label: string; color: string }> = {
  audit: { label: t("Audits"), color: "var(--a-indigo)" },
};
const PROJECT_PALETTE = ["var(--a-teal)", "var(--a-violet)", "var(--a-indigo)", "var(--a-lime)", "var(--a-temp)", "var(--a-conf)"];

export function hashColor(name: string, palette: string[] = PROJECT_PALETTE): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length] ?? "var(--a-teal)";
}

/** „12_Kunden_Sprint“ → „Kunden Sprint“, „shop-neubau-2026-09“ → „Shop Neubau (2026-09)“. */
export function humanize(segment: string): string {
  let s = segment.replace(/^\d+[_-]+/, "");
  let suffix = "";
  const date = /[-_](\d{4}-\d{2})$/.exec(s);
  if (date) {
    suffix = ` (${date[1]})`;
    s = s.slice(0, date.index);
  }
  const words = s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length > 0 ? (w[0] ?? "").toUpperCase() + w.slice(1) : w));
  return (words.join(" ") || segment) + suffix;
}

function goalPath(e: Entry): string[] | null {
  if (e.sourceType !== "goal" || !e.sourceId || !e.sourceId.includes("/")) return null;
  const parts = e.sourceId.split("/").filter(Boolean);
  if (parts[parts.length - 1]?.toLowerCase() === "goal.md") parts.pop();
  return parts.length > 0 ? parts : null;
}

export function projectOf(e: Entry): Project {
  if (e.kind === "audit") return { key: "audit", ...(KNOWN_PROJECTS.audit as { label: string; color: string }) };
  const root = goalPath(e)?.[0] ?? e.baustelle?.slug ?? null;
  if (!root) return { key: "sonstiges", label: t("Ohne Bereich"), color: "var(--a-temp)" };
  const known = KNOWN_PROJECTS[root];
  return known ? { key: root, ...known } : { key: root, label: humanize(root), color: hashColor(root) };
}

/** Ordner, die nur sortieren und nichts über den Auftrag sagen („docs“, „10-Aufgaben“ …). */
const GENERIC_DIR = /^(\d+[-_])?(aufgaben|auftraege|aufträge|docs|features|technik|implementierungsplan)$/i;

export interface GroupKey {
  key: string;
  title: string;
}

/** Zu welchem Auftrag gehört ein Paket? GOAL.md-Aufträge: der nächste sprechende Eltern-Ordner
 * (…/12_Kunden_Sprint/05_Anmeldung/GOAL.md → „Kunden Sprint“). Audits: der Bereich aus
 * der Befund-Nummer (H-CUST-68 → „H-CUST“). Sonst die Baustelle. */
export function groupOf(e: Entry): GroupKey {
  if (e.kind === "audit") {
    const area = e.sourceId ? e.sourceId.replace(/-\d+$/, "") : null;
    return area ? { key: `audit:${area}`, title: t("Audit-Bereich {area}", { area }) } : { key: "audit:_", title: t("Audit-Befunde") };
  }
  const path = goalPath(e);
  if (path) {
    const parents = path.slice(0, -1);
    for (let i = parents.length - 1; i >= 1; i--) {
      const seg = parents[i] ?? "";
      if (!GENERIC_DIR.test(seg)) return { key: `goal:${parents.slice(0, i + 1).join("/")}`, title: humanize(seg) };
    }
    const root = parents[0] ?? path[0] ?? "";
    return { key: `goal:${root}`, title: t("Einzelne Aufträge · {project}", { project: projectOf(e).label }) };
  }
  if (e.baustelle) return { key: `baustelle:${e.baustelle.slug}`, title: e.baustelle.label };
  return { key: "einzeln", title: t("Einzelne Aufgaben") };
}

/** Anzeige-Titel eines Pakets: Pfad-Titel („01_Dokumentation/…“) werden zum Ordnernamen, „GOAL “ und
 * „— `/goal`-Auftrag“ fallen weg. Die Nummer (A01, P3, 05) bleibt vorne sichtbar. */
export function packageTitle(e: Entry): string {
  const path = goalPath(e);
  const last = path?.[path.length - 1];
  const isPathTitle = path !== null && (e.title.trim() === "" || e.title.startsWith(`${path[0] ?? ""}/`));
  if (last && isPathTitle) {
    const num = /^(\d+)[_-]/.exec(last)?.[1];
    return num ? `${num} · ${humanize(last)}` : humanize(last);
  }
  return e.title
    .replace(/^GOAL\s*(—|-|·)?\s*/i, "")
    .replace(/\s*(—|-)\s*`?\/goal`?-?Auftrag\s*$/i, "")
    .replace(/\s*(—|-)\s*Auftrag\s*$/i, "")
    .trim();
}

export interface TaskGroup {
  key: string;
  title: string;
  project: Project;
  items: Entry[];
  stageCounts: Record<TaskStage, number>;
  /** 0–100: Durchschnitt der Pakete (erledigt zählt voll). */
  progress: number;
  done: number;
  active: number;
  updatedAt: string;
}

const emptyStageCounts = (): Record<TaskStage, number> => ({ laeuft: 0, pruefen: 0, startklar: 0, geplant: 0, erledigt: 0 });

const stageRank = (s: EntryStage): number => {
  const i = STAGE_ORDER.indexOf(s as TaskStage);
  return i === -1 ? STAGE_ORDER.length : i;
};

const naturalCompare = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" }).compare;

/** Nur Aufgaben-Stufen (rohe Ideen stehen im Ideen-Tab). Gruppiert, sortiert: was läuft/wartet zuerst,
 * dann Aufträge vor Audit-Bereichen, dann zuletzt geändert. */
export function groupTasks(entries: Entry[]): TaskGroup[] {
  const map = new Map<string, TaskGroup>();
  for (const e of entries) {
    if (e.kind === "idee" || !isTaskStage(e.stage)) continue;
    const g = groupOf(e);
    let group = map.get(g.key);
    if (!group) {
      group = { key: g.key, title: g.title, project: projectOf(e), items: [], stageCounts: emptyStageCounts(), progress: 0, done: 0, active: 0, updatedAt: e.updatedAt };
      map.set(g.key, group);
    }
    group.items.push(e);
    group.stageCounts[e.stage] += 1;
    if (e.updatedAt > group.updatedAt) group.updatedAt = e.updatedAt;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || naturalCompare(packageTitle(a), packageTitle(b)));
    g.done = g.stageCounts.erledigt;
    g.active = g.stageCounts.laeuft + g.stageCounts.pruefen + g.stageCounts.startklar;
    const sum = g.items.reduce((s, e) => s + (e.stage === "erledigt" ? 100 : Math.max(0, Math.min(100, e.progressPercent))), 0);
    g.progress = g.items.length ? Math.round(sum / g.items.length) : 0;
  }
  const bestRank = (g: TaskGroup) => Math.min(...g.items.map((e) => stageRank(e.stage)));
  const isAudit = (g: TaskGroup) => (g.key.startsWith("audit:") ? 1 : 0);
  return groups.sort((a, b) => bestRank(a) - bestRank(b) || isAudit(a) - isAudit(b) || b.updatedAt.localeCompare(a.updatedAt) || naturalCompare(a.title, b.title));
}

export interface ProjectStat {
  project: Project;
  total: number;
  open: number;
  stageCounts: Record<TaskStage, number>;
}

export interface TaskStats {
  total: number;
  open: number;
  inArbeit: number;
  startklar: number;
  pruefen: number;
  erledigt: number;
  fertigHeute: number;
  /** 0–100 über alle Pakete (erledigt zählt voll). */
  progress: number;
  byStage: Record<TaskStage, number>;
  byProject: ProjectStat[];
}

function sameLocalDay(iso: string, now: number): boolean {
  const d = new Date(iso);
  const n = new Date(now);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** Kennzahlen für den Kopf. „Fertig heute“ = heute (Ortszeit) auf „erledigt“ gesetzt. */
export function taskStats(entries: Entry[], now: number = Date.now()): TaskStats {
  const rows = entries.filter((e): e is Entry & { stage: TaskStage } => e.kind !== "idee" && isTaskStage(e.stage));
  const byStage = emptyStageCounts();
  const projects = new Map<string, ProjectStat>();
  let progressSum = 0;
  for (const e of rows) {
    byStage[e.stage] += 1;
    progressSum += e.stage === "erledigt" ? 100 : Math.max(0, Math.min(100, e.progressPercent));
    const p = projectOf(e);
    const stat = projects.get(p.key) ?? { project: p, total: 0, open: 0, stageCounts: emptyStageCounts() };
    stat.total += 1;
    if (e.stage !== "erledigt") stat.open += 1;
    stat.stageCounts[e.stage] += 1;
    projects.set(p.key, stat);
  }
  return {
    total: rows.length,
    open: rows.length - byStage.erledigt,
    inArbeit: byStage.laeuft + byStage.pruefen,
    startklar: byStage.startklar,
    pruefen: byStage.pruefen,
    erledigt: byStage.erledigt,
    fertigHeute: rows.filter((e) => e.stage === "erledigt" && sameLocalDay(e.updatedAt, now)).length,
    progress: rows.length ? Math.round(progressSum / rows.length) : 0,
    byStage,
    byProject: [...projects.values()].sort((a, b) => b.total - a.total || naturalCompare(a.project.label, b.project.label)),
  };
}

// ── „Aufgabe → Agent starten“ ─────────────────────────────────────────────────────────

export interface AgentStartPrefill {
  tool: "claude";
  /** Alias der Claude-CLI für das neueste Opus (Opus 5.5). */
  model: "opus";
  /** Repo relativ zum Projektordner (z. B. „atlas-web“); leer = der Projektordner selbst. */
  repo: string;
  prompt: string;
  entryId: number;
  entryTitle: string;
}

/** Aus einem Pfad relativ zum Projektordner das Git-Repo darin: der erste Ordner (jedes Projekt im
 * Projektordner ist ein eigenes Repo); eine Datei direkt im Projektordner gehört zu keinem Repo. */
function repoOf(rel: string): string {
  const parts = rel.split("/").filter(Boolean);
  return parts.length > 1 ? (parts[0] ?? "") : "";
}

const PROMPT_TEXT_MAX = 1500;

/** Vorbelegung des Dialogs „Neue Session“ für einen Auftrag. GOAL.md → `/goal <Pfad relativ zum Repo>`,
 * sonst Titel und Kurztext. Gestartet wird nie hier, nur nach deinem Klick im Dialog. */
export function agentStartPrefill(e: Entry): AgentStartPrefill {
  const base = { tool: "claude" as const, model: "opus" as const, entryId: e.id, entryTitle: packageTitle(e) };
  if (e.sourceType === "goal" && e.sourceId && /(^|\/)goal\.md$/i.test(e.sourceId)) {
    const repo = repoOf(e.sourceId);
    const inRepo = repo ? e.sourceId.slice(repo.length + 1) : e.sourceId;
    return { ...base, repo, prompt: `/goal ${inRepo}` };
  }
  const repo = repoOf(e.fileScope.find((p) => repoOf(p) !== "") ?? "");
  const text = (e.description ?? "").trim();
  const short = text.length > PROMPT_TEXT_MAX ? `${text.slice(0, PROMPT_TEXT_MAX)} …` : text;
  return { ...base, repo, prompt: short ? `${e.title}\n\n${short}` : e.title };
}

// ───────────── Audit-Bereich zusammengefasst (Klick auf „Audit-Bereich IDC“) ─────────────

export interface AuditAreaSummary {
  /** Kurzer Satz: „12 Befunde, 3 in Arbeit, 5 erledigt, 7 noch offen.“ */
  sentence: string;
  /** Befunde je Stufe (nur Stufen mit mindestens einem). */
  stages: { stage: TaskStage; count: number }[];
  /** Befunde je Dringlichkeit (P0 zuerst, ohne Angabe am Ende). */
  priorities: { label: string; count: number }[];
  /** Die wichtigsten offenen Befunde (höchstens 3), dringendste zuerst. */
  top: Entry[];
  /** Daten für „Nyx fragen“. */
  facts: string;
}

const PRIO_ORDER = ["p0", "p1", "p2", "p3"] as const;

export function auditAreaSummary(group: TaskGroup): AuditAreaSummary {
  const n = group.items.length;
  const working = group.stageCounts.laeuft + group.stageCounts.pruefen;
  const open = group.items.filter((e) => e.stage !== "erledigt");
  const sentence = `${[
    n === 1 ? t("{n} Befund", { n }) : t("{n} Befunde", { n }),
    working > 0 ? t("{n} in Arbeit", { n: working }) : null,
    group.done > 0 ? t("{n} erledigt", { n: group.done }) : null,
    open.length > 0 ? t("{n} noch offen", { n: open.length }) : t("alles erledigt"),
  ]
    .filter(Boolean)
    .join(", ")}.`;
  const stages = STAGE_ORDER.map((stage) => ({ stage, count: group.stageCounts[stage] })).filter((s) => s.count > 0);
  const prioCount = new Map<string, number>();
  for (const e of group.items) prioCount.set(e.priority ?? "none", (prioCount.get(e.priority ?? "none") ?? 0) + 1);
  const priorities = [...PRIO_ORDER, "none"].filter((p) => prioCount.has(p)).map((p) => ({ label: p === "none" ? t("ohne Angabe") : p.toUpperCase(), count: prioCount.get(p) ?? 0 }));
  const prioRank = (e: Entry) => {
    const i = e.priority ? PRIO_ORDER.indexOf(e.priority) : -1;
    return i === -1 ? PRIO_ORDER.length : i;
  };
  const top = [...open].sort((a, b) => prioRank(a) - prioRank(b) || naturalCompare(packageTitle(a), packageTitle(b))).slice(0, 3);
  const facts = [
    `${group.title}: ${sentence}`,
    t("Stufen: {list}", { list: stages.map((s) => `${STAGE_THEME[s.stage].label} ${s.count}`).join(", ") || t("keine") }),
    t("Dringlichkeit: {list}", { list: priorities.map((p) => `${p.label} ${p.count}`).join(", ") || t("keine Angabe") }),
    ...top.map((e) => t("Offen: {title}", { title: `${packageTitle(e)}${e.priority ? ` (${e.priority.toUpperCase()})` : ""}` })),
  ].join("\n");
  return { sentence, stages, priorities, top, facts };
}
