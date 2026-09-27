// Bedeutungsfarben an EINER Stelle: kräftige farbige Akzente –
// vorher war fast alles Türkis. Jede Kennzahl und jeder Bereich der Seitenleiste hat eine eigene, feste Farbe.
// Die Farbe sitzt nur auf Punkt, Symbol, Linie oder Zahl-Chip – nie als Fläche und nie als einzige Aussage
// (daneben steht immer das Wort).

/** Farb-Token aus app.css (ohne `--a-`). */
export type Tone = "acc" | "teal" | "ok" | "wait" | "bad" | "done" | "conf" | "gold" | "violet" | "indigo" | "lime" | "temp" | "nyx" | "nyx-2" | "claude" | "codex" | "mut";

export const toneVar = (tone: Tone): string => `var(--a-${tone})`;

/** Kennzahl-Kacheln (Überblick, Nutzung, Server, Agenten, Skills) nach `id` der StatCard. */
export const METRIC_TONE: Record<string, Tone> = {
  // Überblick
  sessions_open: "done",
  sessions_waiting: "wait",
  tokens_today: "violet",
  tokens_7d: "violet",
  commits_7d: "ok",
  uncommitted: "bad",
  conflicts: "conf",
  builds_red: "claude",
  open_questions: "indigo",
  audits_critical: "bad",
  max_window: "teal",
  haiku_briefing: "gold",
  // Git (dieselbe Kennzahl, dieselbe Farbe wie im Überblick — Commits grün, Ungesichert rot)
  "git-today": "ok",
  "git-7d": "ok",
  "git-30d": "ok",
  "git-uncommitted": "bad",
  // Nutzung
  "usage-tokens": "violet",
  "usage-today": "teal",
  "usage-cost": "gold",
  "usage-days": "ok",
  // Server
  "srv-containers": "ok",
  "srv-cpu": "claude",
  "srv-mem": "indigo",
  "srv-troubled": "bad",
  // Agenten
  "agents-running": "ok",
  "agents-today": "done",
  "agents-pass": "lime",
  "agents-median": "violet",
  // Skills
  "skills-count": "temp",
  "skills-calls": "violet",
  "skills-suggestions": "wait",
  "skills-improved": "ok",
};

export function metricTone(id: string): Tone {
  return METRIC_TONE[id] ?? "acc";
}

/** Seitenleiste: Symbolfarbe je Bereich (wie iOS-Einstellungen, aber nur das Symbol, kein Kästchen). */
export const NAV_TONE: Record<string, Tone> = {
  nyx: "nyx",
  brief: "gold",
  inbox: "wait",
  dash: "teal",
  ses: "done",
  brain: "temp",
  task: "ok",
  agent: "indigo",
  skills: "violet",
  conf: "conf",
  git: "lime",
  srv: "nyx-2",
  use: "claude",
  idea: "gold",
  audits: "bad",
  dateien: "codex",
  settings: "mut",
};
