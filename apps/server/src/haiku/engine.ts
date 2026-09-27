// Motor-Schicht: eine Schnittstelle, hinter der entweder das offizielle `claude`-CLI
// (Max-Plan, `claude -p --model haiku`) oder ein Anthropic-kompatibles Modell per API-Schlüssel
// (Reserve-Motor, z. B. MiniMax) läuft. Die Laufzeit (`runtime.ts`) kennt nur diese Schnittstelle.
import type { HaikuCallKind, HaikuEngineKind, HaikuEngineState } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import type { McpServerSpec } from "../mcp/client.js";

/** Welche Werkzeuge ein Lauf sehen darf. "idealink" = NUR `ideen_suchen` + `idee_anlegen`. */
/** "review" = Hintergrund-Lernprüfung, sieht NUR `memory_suggest` (legt Vorschläge an, speichert nie selbst). */
export type ToolScope = "full" | "idealink" | "review" | "none";

export interface EngineRequest {
  kind: HaikuCallKind;
  systemPrompt: string;
  prompt: string;
  /** The user's own words of a chat turn (without history or notes), if the caller knows them (demo answers). */
  question?: string;
  /** Fortsetzen eines Fadens (CLI: `--resume <id>`). */
  resumeSessionId: string | null;
  scope: ToolScope;
  /** Einmal-Token dieses Laufs für die MCP-Brücke (`/haiku-mcp/*`), bindet den Lauf an `scope`. */
  runToken: string;
  /** Erlaubte Werkzeugnamen (ohne MCP-Präfix), serverseitig aus `scope` abgeleitet. */
  tools: string[];
  timeoutMs: number;
  signal: AbortSignal;
  /** Prüfstand: `false` = ohne Denkpause (claude-CLI: MAX_THINKING_TOKENS=0). Fürs reine Umformulieren
   * (Briefing/Recap) halbiert das die Zeit; fehlt es, gilt der Standard des Motors. */
  thinking?: boolean;
  /** Obergrenze Ausgabe-Tokens (`behaviorHints.maxTokens`); API-Motor `max_tokens`, CLI
   * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. */
  maxTokens?: number;
  /** Prompt verbessern: Modell NUR für diesen Lauf (CLI `--model`); fehlt es, gilt das Modell des Motors. */
  model?: string;
  /** Denkstufe NUR für diesen Lauf (CLI `--effort`); fehlt sie, gilt der Standard des Programms. */
  effort?: EngineEffort;
  /** Für Motoren ohne MCP (Reserve-API): Werkzeug-Beschreibungen + direkter, ebenso scope-geprüfter Aufruf. */
  toolDefs: ToolDef[];
  callTool: (name: string, args: unknown) => Promise<unknown>;
  /** eingeschaltete MCP-Konnektoren (mit Token, nur im Speicher). Claude-Programm: zusätzlich in
   * `--mcp-config`; Fremd-Anbieter: Werkzeuge über den kleinen MCP-Client. Nur bei scope "full". */
  mcpServers?: McpServerSpec[];
}

export type EngineEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Prüfstand: Kontextgröße der LETZTEN Modell-Runde (Eingabe + Cache), nicht die Summe über alle Werkzeug-Runden. */
  contextTokens?: number | null;
}

export type EngineEvent =
  | { type: "session"; sessionId: string; model: string | null }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | {
      type: "result";
      text: string;
      usage: EngineUsage;
      model: string | null;
      /** alle Modelle, die der Lauf laut Programm benutzt hat (Prüfung „lief wirklich mit Sonnet“). */
      models?: string[];
      sessionId: string | null;
      isError: boolean;
      error: string | null;
    };

export interface EngineAvailability {
  ok: boolean;
  /** Fehlt er, gilt `ok ? "ready" : "error"`. */
  state?: Exclude<HaikuEngineState, "off">;
  /** Einfache Worte für den Nutzer: was los ist und was er tun kann – keine Technik-Meldung. */
  reason: string | null;
  model: string | null;
  /** Version des claude-CLI (nur Anzeige). */
  version?: string | null;
}

/** Die Gründe, die der Nutzer sieht (UI zeigt sie wörtlich). Keine Technik-Wörter. Deutsche Texte als Schlüssel — übersetzt beim Melden (`t`). */
export const ENGINE_REASON = {
  off: "Nyx ist ausgeschaltet.",
  waitingToken: "Wartet auf Token vom Nutzer.",
  tokenRejected: "Der Token wurde abgelehnt (abgelaufen oder falsch) – bitte einen neuen erzeugen.",
  notConnected: "Der Nyx-Motor auf dem Server läuft gerade nicht. Claude startet ihn beim nächsten Deploy neu.",
  cliMissingRemote: "Im Nyx-Motor fehlt das Claude-Programm – der Motor muss beim nächsten Deploy neu gebaut werden.",
  cliMissingLocal: "Das Claude-Programm ist auf diesem Rechner nicht installiert.",
  cliBroken: "Das Claude-Programm startet nicht richtig.",
  reserveMissing: "Für die Reserve ist kein Schlüssel hinterlegt.",
} as const;

/** Meldet das CLI/die API eine abgelehnte Anmeldung? (Ungültiger/abgelaufener Token.) */
export function looksLikeAuthError(message: string): boolean {
  return /invalid api key|please run \/login|oauth token|authentication[_ ]error|unauthori[sz]ed|\b401\b|not logged in/i.test(message);
}

export interface HaikuEngine {
  readonly kind: Exclude<HaikuEngineKind, "off">;
  /** Optional: wechselt, wenn der Motor neu angebunden wurde (Agent-Container neu verbunden) – setzt „Token abgelehnt“ zurück. */
  readonly epoch?: string | null;
  available(): Promise<EngineAvailability>;
  run(req: EngineRequest): AsyncIterable<EngineEvent>;
}

export class EngineTimeoutError extends Error {
  constructor(ms: number) {
    super(t("Zeitlimit {s} s überschritten", { s: Math.round(ms / 1000) }));
  }
}

/** Präfix, unter dem Claude Code die Werkzeuge des MCP-Servers "nyxos" führt. */
export const MCP_SERVER_NAME = "nyxos";
export const mcpToolName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`;
