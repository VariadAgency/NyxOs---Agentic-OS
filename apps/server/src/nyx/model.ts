// Modellwahl für Nyx an EINER Stelle.
// Jeder Nyx-Lauf trägt seine N5-Rolle (`nyx.chat` | `nyx.voice` | `nyx.briefing`) bis in den Motor-Wähler
// der Laufzeit (`HaikuRuntime.gate` → `engineForRun(kind, role)` → `ModelService.resolveModel(role)`, routes/models.ts):
// Hat der Nutzer der Rolle einen Anbieter zugewiesen, läuft sie dort, sonst über den Standard (Claude-Programm, Haiku).
// Die N14-Hinweise des Kanals (`behaviorHints`: Token-Grenze, Denkpause) fließen ebenfalls nur hier hinein.
// `skills.create` gehört nicht hierher: Skills entstehen immer mit Opus 5.5 in einer eigenen Session.
import type { ModelRole, NyxAnswerLength, NyxChannel } from "@nyxos/shared";
import { behaviorHints, type NyxProfile } from "./personaDefault.js";

export type NyxRole = Extract<ModelRole, "nyx.chat" | "nyx.briefing" | "nyx.voice">;

export interface NyxCallOptions {
  /** Rolle, unter der N5 Anbieter/Modell auflöst (`resolveModel(role)`). */
  role: NyxRole;
  thinking?: boolean;
  maxTokens?: number;
  /**
   * „schnell“: ein schnelles Modell bevorzugen. Wirkt heute als „ohne Denkpause“ (der Standard ist schon Haiku);
   * eine fest zugewiesene Rolle bleibt, wie der Nutzer sie gewählt hat.
   */
  preferFastModel?: boolean;
}

export function roleForChannel(channel: NyxChannel): NyxRole {
  return channel === "voice" ? "nyx.voice" : "nyx.chat";
}

/** Aufruf-Optionen für einen Nyx-Lauf: Rolle + Profil-Hinweise des Kanals. */
export function nyxCallOptions(role: NyxRole, profile: NyxProfile | null, channel: NyxChannel = "web", chosen?: NyxAnswerLength): NyxCallOptions {
  const hints = behaviorHints(profile, channel, chosen);
  const thinking = hints.preferFastModel ? false : hints.thinking;
  return {
    role,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(hints.maxTokens ? { maxTokens: hints.maxTokens } : {}),
    ...(hints.preferFastModel ? { preferFastModel: true } : {}),
  };
}
