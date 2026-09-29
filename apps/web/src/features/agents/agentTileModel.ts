// Agenten als Kacheln. Reine Funktion: Läufe (je Agent-Typ) + Bestand (Agenten-Dateien mit
// Modell/Werkzeugen/Prompt) → eine Kachel je Agent. `agentName` ist bei Claude die Kurzbeschreibung des
// Einsatzes („Recherche Hermes“), der eigentliche Agent steht in `agentType` („general-purpose“).
import { locale, t } from "@nyxos/shared";
import type { AgentRun, CatalogRow } from "./api";

export type AgentOrigin = "projekt" | "eigen" | "eingebaut" | "codex" | "sonstig";
export type AgentState = "laeuft" | "aktiv" | "ruht" | "neu";

export interface AgentTileData {
  key: string;
  label: string;
  origin: AgentOrigin;
  description: string | null;
  model: string | null;
  tools: string[];
  prompt: string | null;
  path: string | null;
  color: string;
  /** Neueste zuerst. */
  runs: AgentRun[];
  total: number;
  runs7d: number;
  running: number;
  lastAt: string | null;
  judged: number;
  passRate: number | null;
  avgDurationMs: number | null;
  state: AgentState;
}

const DAY_MS = 86_400_000;
const CODEX_KEY = "codex";

/** Eingebaute Claude-Code-Agenten: kurze Beschreibung in einfachen Worten (sie haben keine Datei im Bestand). */
const BUILTIN: Record<string, string> = {
  "general-purpose": t("Allzweck-Helfer: recherchiert, sucht im Code und erledigt mehrstufige Aufgaben selbstständig."),
  Explore: t("Such-Helfer: liest schnell viele Dateien und fasst zusammen, ändert nichts."),
  Plan: t("Planer: entwirft Schritt für Schritt, wie etwas umgesetzt wird, ändert nichts."),
  fork: t("Abzweig der laufenden Session: arbeitet mit dem ganzen bisherigen Gesprächsstand weiter."),
  "claude-code-guide": t("Kennt Claude Code, die Schnittstelle und das SDK und beantwortet Fragen dazu."),
  "statusline-setup": t("Richtet die Statuszeile von Claude Code ein."),
};

const COLOR_NAMES: Record<string, string> = {
  purple: "var(--a-violet)",
  violet: "var(--a-violet)",
  indigo: "var(--a-indigo)",
  blue: "var(--a-done)",
  cyan: "var(--a-teal)",
  teal: "var(--a-teal)",
  green: "var(--a-lime)",
  lime: "var(--a-lime)",
  orange: "var(--a-claude)",
  pink: "var(--a-conf)",
  yellow: "var(--a-wait)",
  red: "var(--a-bad)",
};
/** Kachel-Farben ohne Zustandsfarben (grün/gelb/rot), damit eine Kachel nie wie ein Zustand aussieht. */
const PALETTE = ["var(--a-teal)", "var(--a-violet)", "var(--a-indigo)", "var(--a-lime)", "var(--a-temp)", "var(--a-done)", "var(--a-conf)"];

/** Also used for the agents in the session chat (same color per agent type). */
export function agentPaletteColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? "var(--a-teal)";
}

function runKey(r: AgentRun): string {
  if (r.agentType) return r.agentType;
  if (r.tool === "codex") return CODEX_KEY;
  return r.agentName ?? t("unbekannt");
}

const startOf = (r: AgentRun) => r.startedAt ?? r.endedAt ?? "";

export function buildAgentTiles(runs: AgentRun[], catalog: CatalogRow[], now: number = Date.now()): AgentTileData[] {
  const byKey = new Map<string, AgentRun[]>();
  for (const r of runs) {
    const k = runKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const agents = new Map(catalog.filter((c) => c.kind === "agent").map((c) => [c.name, c]));
  const keys = new Set([...byKey.keys(), ...agents.keys()]);

  const tiles: AgentTileData[] = [...keys].map((key) => {
    const rs = [...(byKey.get(key) ?? [])].sort((a, b) => startOf(b).localeCompare(startOf(a)));
    const cat = agents.get(key) ?? null;
    const details = cat?.details ?? null;
    const origin: AgentOrigin = cat ? (cat.source === "project" ? "projekt" : "eigen") : key === CODEX_KEY ? "codex" : key in BUILTIN ? "eingebaut" : "sonstig";
    const judged = rs.filter((r) => r.verdict !== null);
    const durations = rs.map((r) => r.durationMs).filter((d): d is number => d !== null);
    const running = rs.filter((r) => r.running).length;
    const runs7d = rs.filter((r) => Date.parse(startOf(r)) >= now - 7 * DAY_MS).length;
    const lastAt = rs[0] ? startOf(rs[0]) || null : null;
    const state: AgentState = running > 0 ? "laeuft" : rs.length === 0 ? "neu" : runs7d > 0 ? "aktiv" : "ruht";
    const color = key === CODEX_KEY ? "var(--a-codex)" : ((details?.color ? COLOR_NAMES[details.color.toLowerCase()] : undefined) ?? agentPaletteColor(key));
    return {
      key,
      label: key === CODEX_KEY ? t("Codex-Helfer") : key,
      origin,
      description: cat?.description ?? BUILTIN[key] ?? (key === CODEX_KEY ? t("Unter-Agenten, die Codex selbst startet (je Einsatz mit eigenem Namen).") : null),
      model: details?.model ?? null,
      tools: details?.tools ?? [],
      prompt: details?.prompt ? details.prompt : null,
      path: cat?.path ?? null,
      color,
      runs: rs,
      total: rs.length,
      runs7d,
      running,
      lastAt,
      judged: judged.length,
      // „Bestanden“ = PASS oder PASS mit Hinweisen; nur BLOCK ist ein Nicht-Bestehen.
      passRate: judged.length ? Math.round((judged.filter((r) => r.verdict !== "BLOCK").length / judged.length) * 100) : null,
      avgDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      state,
    };
  });

  const stateRank: Record<AgentState, number> = { laeuft: 0, aktiv: 1, ruht: 2, neu: 3 };
  return tiles.sort((a, b) => stateRank[a.state] - stateRank[b.state] || b.runs7d - a.runs7d || b.total - a.total || a.label.localeCompare(b.label, locale()));
}

/** „sonnet“ → „Sonnet“, „inherit“/leer → „wie die Session“. */
export function modelLabel(tile: Pick<AgentTileData, "model" | "origin">): string {
  if (tile.origin === "codex") return "Codex";
  const m = tile.model?.trim();
  if (!m || m === "inherit") return t("wie die Session");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export const ORIGIN_LABEL: Record<AgentOrigin, string> = {
  projekt: t("Projekt"),
  eigen: t("Eigener"),
  eingebaut: t("Eingebaut"),
  codex: "Codex",
  sonstig: t("Weitere"),
};

export const STATE_META: Record<AgentState, { label: string; hint: string; color: string }> = {
  laeuft: { label: t("läuft"), hint: t("Läuft gerade in einer Session."), color: "var(--a-ok)" },
  aktiv: { label: t("diese Woche"), hint: t("In den letzten 7 Tagen genutzt."), color: "var(--a-acc)" },
  ruht: { label: t("ruht"), hint: t("Seit mehr als 7 Tagen nicht genutzt."), color: "var(--a-done)" },
  neu: { label: t("unbenutzt"), hint: t("Ist eingerichtet, wurde aber noch nie genutzt."), color: "var(--a-violet)" },
};
