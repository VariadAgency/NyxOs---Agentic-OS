// Skill-Bibliothek: gemeinsame Typen für Brücke (liest Skills auf dem Rechner), Server (Nutzung,
// Verlauf, Vorschläge, Opus-Aufträge) und Web (Tab „Skills“). Nur Daten, keine Nebenwirkungen.
//
// Übernommene Muster (MIT, s. NOTICE): Hermes Agent `tools/skill_ledger.py` (Verlauf mit SHA-256 und
// Rückgängig), `tools/write_approval.py` (Vorschlag statt direkt schreiben), `tools/skill_usage.py`
// (Nutzung getrennt von der SKILL.md, „veraltet“ nach 30 Tagen).
import { z } from "zod";
import { t } from "./i18n/index.js";
import { lazyRecord } from "./lazy-text.js";

/**
 * Das Modell für „Neuer Skill“, „Verbessern“ und „Vorschlag umsetzen“ – FEST Opus 5.5, nie Haiku (des Nutzers
 * Wortlaut „Mit Opus 5.5 werden Skills immer erstellt. Haiku macht das auf gar keinen Fall.“).
 * baut `resolveModel('skills.create')`; beim Zusammenführen muss die Rolle genau diesen Wert liefern.
 */
export const SKILL_JOB_MODEL = "claude-opus-5-5";

/** Welches Modell ein Skill-Auftrag bekommt – egal, was Einstellungen, Umgebung oder die Anfrage sagen. */
export function skillJobModel(_requested?: string | null): typeof SKILL_JOB_MODEL {
  return SKILL_JOB_MODEL;
}

/** Herkunft eines Skills. `builtin` = in Claude Code eingebaut (keine Datei, nur aus der Nutzung bekannt). */
export const SKILL_SOURCES = ["user", "project", "nyxos", "plugin", "synced", "builtin"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_SOURCE_LABEL: Record<SkillSource, string> = lazyRecord({
  user: "Persönlich",
  project: "Projekt",
  nyxos: "NyxOS",
  plugin: "Plugin",
  synced: "Claude.ai",
  builtin: "Eingebaut",
});

/** Wo ein neuer Skill angelegt werden darf (nur eigene Orte, nie Plugins). */
export const SKILL_CREATE_TARGETS = ["user", "project", "nyxos"] as const;
export type SkillCreateTarget = (typeof SKILL_CREATE_TARGETS)[number];

/** Skill-Name wie in Claude Code: Ordnername, klein, Ziffern und Bindestriche (agentskills.io: ≤ 64 Zeichen). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Aufruf-Name: `name` oder `plugin:name` (Plugins, Claude.ai-Skills). */
export const SKILL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63})?$/i;

/**
 * Skill-Name aus einem Roh-Wert (`input.skill`, `input.command`, `/befehl args`, `target`) –
 * führender Schrägstrich und Argumente fallen weg. `null`, wenn es kein gültiger Aufruf-Name ist
 * (Pfade wie `/Users/…` oder `../x` sind nie ein Skill).
 */
export function skillKeyFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().replace(/^\//, "").split(/\s/, 1)[0] ?? "";
  return SKILL_KEY_RE.test(first) ? first : null;
}

export interface SkillFileInfo {
  /** Pfad relativ zum Skill-Ordner, z. B. `scripts/run.sh`. */
  rel: string;
  bytes: number;
}

/** Ein Skill, wie die Brücke ihn auf dem Rechner sieht. */
export interface BridgeSkill {
  /** Aufruf-Name (`/key` bzw. `Skill(key)`), eindeutig. */
  key: string;
  /** `name` aus dem Kopf der SKILL.md (kann vom Ordnernamen abweichen). */
  name: string;
  description: string | null;
  source: SkillSource;
  /** Plugin-Name bei `source = plugin`. */
  plugin: string | null;
  /** Absoluter Pfad des Skill-Ordners bzw. der SKILL.md. */
  dir: string;
  skillPath: string;
  /** Eigene Skills (Persönlich, Projekt) lassen sich verbessern; Plugins und Claude.ai-Skills nicht. */
  writable: boolean;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  files: SkillFileInfo[];
}

export interface SkillsListResult {
  skills: BridgeSkill[];
  /** Arbeitsordner für neue Skill-Sessions (Projektordner) und die Skill-Wurzeln je Ziel. */
  projectRoot: string;
  targets: Record<SkillCreateTarget, string>;
}

const AbsPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/"), { error: () => t("absoluter Pfad nötig") })
  .refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), { error: () => t("kein .. im Pfad") })
  // eslint-disable-next-line no-control-regex -- Steuerzeichen im Pfad gezielt ablehnen
  .refine((p) => !/[\u0000-\u001f]/.test(p), { error: () => t("keine Steuerzeichen") });

/** Brücke: Dateien aus Skill-Ordnern lesen (nur unter den erlaubten Wurzeln). */
export const SkillReadRequestSchema = z.object({ paths: z.array(AbsPath).min(1).max(100) });
export type SkillReadRequest = z.infer<typeof SkillReadRequestSchema>;
export interface SkillReadResult {
  files: { path: string; content: string | null; sha256: string | null; truncated: boolean }[];
}

/** Brücke: ganzen Skill-Ordner sichern (vor jedem Überschreiben). */
export const SkillBackupRequestSchema = z.object({ dir: AbsPath, label: z.string().regex(/^[a-z0-9-]{1,40}$/) });
export type SkillBackupRequest = z.infer<typeof SkillBackupRequestSchema>;
export interface SkillBackupResult {
  backupDir: string;
  sha256: string | null;
  content: string | null;
}

/** Brücke: früheren Stand der SKILL.md zurückschreiben – nur wenn die Datei noch `expectSha256` hat (sonst Konflikt). */
export const SkillRestoreRequestSchema = z.object({
  skillPath: AbsPath,
  content: z.string().max(512 * 1024),
  expectSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SkillRestoreRequest = z.infer<typeof SkillRestoreRequestSchema>;
export interface SkillRestoreResult {
  sha256: string;
  backupDir: string;
}

/** Fähigkeit der Brücke (aus `hello`) – ältere Brücken kennen die Skill-Befehle nicht. */
export const BRIDGE_CAP_SKILLS = "skills";

// ── Server ↔ Web ─────────────────────────────────────────────────────────────────────────────

export const SKILL_JOB_KINDS = ["create", "improve", "apply"] as const;
export type SkillJobKind = (typeof SKILL_JOB_KINDS)[number];

export const SKILL_JOB_KIND_LABEL: Record<SkillJobKind, string> = {
  create: "Neuer Skill",
  improve: "Verbessern",
  apply: "Vorschlag umsetzen",
};

export const SkillJobRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    name: z.string().regex(SKILL_NAME_RE),
    target: z.enum(SKILL_CREATE_TARGETS),
    brief: z.string().trim().min(10).max(4000),
  }),
  z.object({ kind: z.literal("improve"), skillKey: z.string().regex(SKILL_KEY_RE), brief: z.string().trim().max(4000).default("") }),
  z.object({ kind: z.literal("apply"), suggestionId: z.number().int().positive(), brief: z.string().trim().max(4000).default("") }),
]);
export type SkillJobRequest = z.infer<typeof SkillJobRequestSchema>;

export type SkillVersionReason = "erfasst" | "geaendert" | "vor_aenderung" | "verbessert" | "erstellt" | "zurueckgesetzt";

export const SKILL_VERSION_REASON_LABEL: Record<SkillVersionReason, string> = lazyRecord({
  erfasst: "Erster Stand",
  geaendert: "Geändert",
  vor_aenderung: "Sicherung vor Opus",
  verbessert: "Mit Opus 5.5 verbessert",
  erstellt: "Mit Opus 5.5 erstellt",
  zurueckgesetzt: "Zurückgesetzt",
});

export type SkillSignal = "fehler_aufruf" | "abbruch" | "korrektur" | "fehler_danach";

export const SKILL_SIGNAL_LABEL: Record<SkillSignal, string> = lazyRecord({
  fehler_aufruf: "Aufruf gescheitert",
  abbruch: "Abgebrochen",
  korrektur: "Korrektur danach",
  fehler_danach: "Fehler danach",
});

export type SkillSuggestionStatus = "open" | "in_arbeit" | "umgesetzt" | "verworfen";

export interface SkillSuggestion {
  id: number;
  skillKey: string;
  signal: SkillSignal;
  problem: string;
  evidence: string;
  idea: string;
  /** Wer den Text geschrieben hat: Nyx (Haiku) oder die Regel (Nyx war nicht erreichbar). */
  author: "nyx" | "regel";
  status: SkillSuggestionStatus;
  sessionKey: string | null;
  sessionTitle: string | null;
  sessionHref: string | null;
  at: string;
  jobId: number | null;
}

export interface SkillTile {
  key: string;
  name: string;
  description: string | null;
  source: SkillSource;
  plugin: string | null;
  writable: boolean;
  pinned: boolean;
  /** Datei fehlt inzwischen (gelöscht/verschoben) – bleibt sichtbar, wird nie still entfernt. */
  missing: boolean;
  uses: number;
  lastUsedAt: string | null;
  /** 30 Werte, ältester Tag zuerst (heute zuletzt). */
  daily: number[];
  openSuggestions: number;
  lastImprovedAt: string | null;
  runningJob: { id: number; kind: SkillJobKind; sessionHref: string | null } | null;
  files: number;
  bytes: number;
}

export interface SkillsOverview {
  skills: SkillTile[];
  /** Ist die Brücke da? Ohne sie gilt der zuletzt gesehene Stand. */
  bridge: "online" | "offline" | "zu_alt";
  syncedAt: string | null;
}

export interface SkillVersion {
  id: number;
  sha256: string;
  reason: SkillVersionReason;
  at: string;
  jobId: number | null;
  bytes: number;
}

export interface SkillUse {
  at: string;
  via: "tool" | "command";
  sessionKey: string;
  sessionTitle: string | null;
  sessionHref: string | null;
  signal: SkillSignal | null;
}

export interface SkillJob {
  id: number;
  kind: SkillJobKind;
  skillKey: string | null;
  model: string;
  status: "running" | "ended" | "error";
  sessionKey: string | null;
  sessionHref: string | null;
  error: string | null;
  at: string;
}

export interface SkillDetail {
  skill: SkillTile & { dir: string | null; skillPath: string | null; fileList: SkillFileInfo[] };
  content: string | null;
  uses: SkillUse[];
  versions: SkillVersion[];
  suggestions: SkillSuggestion[];
  jobs: SkillJob[];
}

/** Kopf einer SKILL.md (YAML-Frontmatter) ohne YAML-Bibliothek: `name`, `description` (auch mehrzeilig `>`/`|`). */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { name: null, description: null, body: text };
  const block = m[1] ?? "";
  const lines = block.split(/\r?\n/);
  const field = (key: string): string | null => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i < 0) return null;
    const first = (lines[i] ?? "").slice(key.length + 1).trim();
    if (first && first !== ">" && first !== "|" && first !== ">-" && first !== "|-") return first.replace(/^["']|["']$/g, "");
    const cont: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (!/^\s+/.test(l)) break;
      cont.push(l.trim());
    }
    return cont.join(" ").trim() || null;
  };
  return { name: field("name"), description: field("description"), body: text.slice(m[0].length) };
}

/** Tages-Reihe (30 Tage, ältester zuerst) aus Zeitpunkten – Grundlage der Sparkline auf der Kachel. */
export function dailySeries(dates: string[], now: number = Date.now(), days = 30): number[] {
  const out = new Array<number>(days).fill(0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * 86_400_000;
  for (const d of dates) {
    const t = Date.parse(d);
    if (!Number.isFinite(t) || t < start || t > now) continue;
    const idx = Math.min(days - 1, Math.floor((t - start) / 86_400_000));
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}
