// Session-Steuerung (Modell wechseln, Denkaufwand, Komprimieren) – EINE Stelle, die weiß, was
// welches Werkzeug wirklich kann. Nur Daten und reine Funktionen (Web zeigt, Server baut den Befehl).
//
// Am echten Programm geprüft:
// - Claude Code 2.1.284: `/model <name>` (Kurzname „opus“ oder voller Name) und `/effort <stufe>` sind
//   Befehle mit Wert. Stufen: low, medium, high, xhigh, max, auto – welche ein Modell kann, steht fest im
//   Programm (ältere Modelle: gar keine bzw. ohne xhigh/max). `/compact` gibt es.
// - Codex 0.158.0: `/model` öffnet NUR ein Auswahlmenü; `/model gpt-5.5` geht als normale Nachricht an das
//   Modell (ausprobiert). Modell/Denkaufwand lassen sich also nicht per Text wechseln → nicht angeboten.
//   `/compact` gibt es.
// - OpenCode (1.18): NyxOS kennt heute nur Claude- und Codex-Sessions (die Brücke findet keine anderen) –
//   sobald es andere Werkzeuge gibt, kommen sie hier mit ihrer eigenen Liste dazu.
import { z } from "zod";
import { MODEL_CATALOG } from "./access.js";
import { t } from "./i18n/index.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Lesbarer Name einer Stufe (einfach, ohne Fachwort). */
export function effortLabel(level: EffortLevel): string {
  switch (level) {
    case "low":
      return t("Wenig");
    case "medium":
      return t("Mittel");
    case "high":
      return t("Hoch");
    case "xhigh":
      return t("Sehr hoch");
    case "max":
      return t("Maximal");
    case "auto":
      return t("Automatisch");
  }
}

export interface SessionControlModel {
  id: string;
  name: string;
  /** Kurzer Satz, wofür das Modell gut ist (aus dem Modell-Katalog). */
  hint: string | null;
  current: boolean;
}

export interface SessionControlsView {
  tool: string;
  currentModel: string | null;
  model: { canSwitch: boolean; reason: string | null; options: SessionControlModel[] };
  effort: { canSet: boolean; reason: string | null; levels: EffortLevel[] };
  compact: { available: boolean; reason: string | null };
}

export const SessionControlRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), model: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal("effort"), level: z.enum(EFFORT_LEVELS) }),
]);
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>;

export interface SessionControlResult {
  status: "sent" | "queued";
  /** Ein Satz, was gerade passiert. */
  message: string;
  command: string;
}

/** „claude-haiku-4-5-20251001“ → „claude-haiku-4-5“, „claude-opus-4-6[1m]“ → „claude-opus-4-6“. */
function baseClaudeId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
}

const NO_EFFORT = new Set(["claude-opus-4-0", "claude-opus-4-1", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-haiku-4-5"]);
const NO_XHIGH = new Set([...NO_EFFORT, "claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]);
const NO_MAX = new Set([...NO_EFFORT, "claude-opus-4-5"]);

/**
 * Denkaufwand-Stufen, die Claude Code für dieses Modell annimmt (wie im Programm selbst: Claude 3 und die
 * genannten älteren Modelle gar nicht; xhigh/max erst ab den neueren). Leer = kein Denkaufwand einstellbar.
 */
export function claudeEffortLevels(model: string | null): EffortLevel[] {
  if (!model) return [];
  const id = baseClaudeId(model);
  if (!id.startsWith("claude-") || id.startsWith("claude-3-") || NO_EFFORT.has(id)) return [];
  const levels: EffortLevel[] = ["low", "medium", "high"];
  if (!NO_XHIGH.has(id)) levels.push("xhigh");
  if (!NO_MAX.has(id)) levels.push("max");
  levels.push("auto");
  return levels;
}

/** Die Anthropic-Modelle, die Claude Code per `/model` annimmt (aus dem gemeinsamen Katalog). */
export function claudeModelOptions(current: string | null): SessionControlModel[] {
  const cur = current ? baseClaudeId(current) : null;
  return MODEL_CATALOG.filter((m) => m.provider === "anthropic").map((m) => ({
    id: m.id,
    name: m.name,
    hint: m.strength ?? null,
    current: cur !== null && (baseClaudeId(m.id) === cur || (m.aliases ?? []).includes(cur)),
  }));
}

const codexNoSwitch = () => t("Codex wechselt Modell und Denkaufwand nur im eigenen Auswahlmenü (im Terminal „/model“) – das geht nicht per Knopf.");
const unknownTool = () => t("Für dieses Programm kennt NyxOS noch keinen Weg, das Modell zu wechseln.");

/** Was die Session-Steuerung für dieses Werkzeug + Modell anbietet. Nie mehr, als das Werkzeug kann. */
export function sessionControlsFor(tool: string, currentModel: string | null): SessionControlsView {
  if (tool === "claude") {
    const levels = claudeEffortLevels(currentModel);
    return {
      tool,
      currentModel,
      model: { canSwitch: true, reason: null, options: claudeModelOptions(currentModel) },
      effort: {
        canSet: levels.length > 0,
        reason: levels.length > 0 ? null : currentModel ? t("Dieses Modell kennt keinen einstellbaren Denkaufwand.") : t("Sobald das Modell bekannt ist, zeige ich hier den Denkaufwand."),
        levels,
      },
      compact: { available: true, reason: null },
    };
  }
  if (tool === "codex") {
    return {
      tool,
      currentModel,
      model: { canSwitch: false, reason: codexNoSwitch(), options: [] },
      effort: { canSet: false, reason: codexNoSwitch(), levels: [] },
      compact: { available: true, reason: null },
    };
  }
  return {
    tool,
    currentModel,
    model: { canSwitch: false, reason: unknownTool(), options: [] },
    effort: { canSet: false, reason: unknownTool(), levels: [] },
    compact: { available: false, reason: t("Für dieses Programm kennt NyxOS keinen Komprimieren-Befehl.") },
  };
}

export type ControlCommand = { ok: true; command: string } | { ok: false; reason: string };

/** Den Befehl bauen, den die Session bekommt – nur, was das Werkzeug für DIESES Modell annimmt. */
export function buildControlCommand(tool: string, currentModel: string | null, req: SessionControlRequest): ControlCommand {
  const view = sessionControlsFor(tool, currentModel);
  if (req.kind === "model") {
    if (!view.model.canSwitch) return { ok: false, reason: view.model.reason ?? unknownTool() };
    const pick = view.model.options.find((m) => m.id === req.model);
    if (!pick) return { ok: false, reason: t("Dieses Modell gibt es in dieser Session nicht.") };
    if (pick.current) return { ok: false, reason: t("Die Session nutzt schon {name}.", { name: pick.name }) };
    return { ok: true, command: `/model ${pick.id}` };
  }
  if (!view.effort.canSet) return { ok: false, reason: view.effort.reason ?? unknownTool() };
  if (!view.effort.levels.includes(req.level)) return { ok: false, reason: t("Diese Stufe kennt das Modell nicht.") };
  return { ok: true, command: `/effort ${req.level}` };
}
