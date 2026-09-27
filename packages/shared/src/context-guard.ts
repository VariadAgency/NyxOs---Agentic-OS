// Kontext-Wächter. Vertrag zwischen Server (`apps/server/src/context-guard`,
// `apps/server/src/routes/context-guard.ts`) und Web (`apps/web/src/features/context-guard`).
//
// Zwei Schwellen (50–100 % des Kontextfensters):
// - `hinweisPct`   — ab hier ein Hinweis + Empfehlung ("Komprimieren empfohlen").
// - `erzwingenPct` — ab hier schickt die NyxOS selbst `/compact` (nur wenn die Session gerade
//   wartet UND in tmux läuft) bzw. setzt beim Start eine Auto-Compact-Grenze im Werkzeug selbst.
//   `erzwingenEnabled = false` schaltet nur das ERZWINGEN ab — der Hinweis bleibt aktiv.
//
// Auflösung (s. `resolveContextGuardThresholds`): Session-Override > Modell-Override > Standard;
// für eine Haiku-Session (P7-Laufzeit) ersetzt der Haiku-Eintrag den Standard, Session-Override
// bleibt weiter das Stärkste. `computeContextPct`/`ContextRing` selbst gehören P6 (W-1-Vorarbeit
// dort) — dieses Modul dupliziert das NICHT, sondern nimmt den Kontext-Anteil (0–100 oder `null` =
// unbekannt) als reinen Eingabewert entgegen.
import { z } from "zod";
import { t } from "./i18n/index.js";

export const CONTEXT_GUARD_MIN_PCT = 50;
export const CONTEXT_GUARD_MAX_PCT = 100;

export const ContextGuardScopeSchema = z.enum(["default", "model", "session", "haiku"]);
export type ContextGuardScope = z.infer<typeof ContextGuardScopeSchema>;

const Pct = z.number().int().min(CONTEXT_GUARD_MIN_PCT).max(CONTEXT_GUARD_MAX_PCT);

/** Eingabe fürs Speichern (PUT) — eine Schwellen-Zeile, unabhängig vom Geltungsbereich. */
export const ContextGuardThresholdsInputSchema = z
  .object({
    hinweisPct: Pct,
    erzwingenEnabled: z.boolean().default(true),
    erzwingenPct: Pct.nullable().default(null),
  })
  .refine((v) => !v.erzwingenEnabled || v.erzwingenPct !== null, { error: () => t("erzwingenPct fehlt (oder erzwingenEnabled auf false setzen)"), path: ["erzwingenPct"] })
  .refine((v) => v.erzwingenPct === null || v.hinweisPct <= v.erzwingenPct, { error: () => t("hinweisPct darf erzwingenPct nicht überschreiten"), path: ["hinweisPct"] });
export type ContextGuardThresholdsInput = z.infer<typeof ContextGuardThresholdsInputSchema>;

/** Eine gespeicherte Zeile, wie sie `GET /api/context-guard/settings` liefert. */
export interface ContextGuardThresholdsRow {
  hinweisPct: number;
  erzwingenEnabled: boolean;
  erzwingenPct: number | null;
  updatedAt: string;
}

export interface ContextGuardModelRow extends ContextGuardThresholdsRow {
  model: string;
}

export interface ContextGuardSessionRow extends ContextGuardThresholdsRow {
  sessionKey: string;
}

export interface ContextGuardSettingsSnapshot {
  default: ContextGuardThresholdsRow;
  haiku: ContextGuardThresholdsRow;
  models: ContextGuardModelRow[];
  sessions: ContextGuardSessionRow[];
}

/** Fest verdrahteter Start-Standard (Wunsch vom Nutzer: 60 % Hinweis, 80 % Erzwingen). Nur die
 * erste, lazy angelegte Zeile in der DB benutzt das (wie `push_settings`/`night_settings`). */
export const CONTEXT_GUARD_DEFAULT: ContextGuardThresholdsInput = { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 };

export type ContextGuardThresholdsSource = "session" | "model" | "haiku" | "default";

export interface ResolvedContextGuardThresholds {
  hinweisPct: number;
  erzwingenEnabled: boolean;
  erzwingenPct: number | null;
  source: ContextGuardThresholdsSource;
}

/**
 * Reine Auflösungsfunktion (kein DB-Zugriff) — Session > Modell > Standard, Haiku ersetzt den
 * Standard für Haiku-Sessions (aber Session-Override sticht auch dort). `model` ist der Modell-
 * Name der Session (z. B. aus `session.models[0]`), `null` wenn (noch) unbekannt.
 */
export function resolveContextGuardThresholds(input: {
  defaults: ContextGuardThresholdsInput;
  haiku: ContextGuardThresholdsInput;
  modelOverride: ContextGuardThresholdsInput | null;
  sessionOverride: ContextGuardThresholdsInput | null;
  isHaiku: boolean;
}): ResolvedContextGuardThresholds {
  if (input.sessionOverride) return { ...input.sessionOverride, source: "session" };
  if (input.isHaiku) return { ...input.haiku, source: "haiku" };
  if (input.modelOverride) return { ...input.modelOverride, source: "model" };
  return { ...input.defaults, source: "default" };
}

/** Prozent des Kontextfensters → Token-Grenze für `-c model_auto_compact_token_limit=<n>` (Codex).
 * Reine Rechenfunktion; die Fensterngröße kommt von außen (live von Codex selbst gemeldet, s. P6). */
export function pctToTokenLimit(pct: number, contextWindow: number): number {
  return Math.max(1, Math.round((pct / 100) * contextWindow));
}

/**
 * Übergangs-Fenstergrößen NUR für die Start-Umgebung von Codex (`model_auto_compact_token_limit`
 * braucht Tokens, keinen Prozentsatz), solange P6 (`computeContextPct`, echte, teils live gemeldete
 * Fenstergrößen aus `packages/shared/src/usage.ts`) noch nicht in main ist. Nach dem Merge ersetzt
 * `apps/server/src/routes/terminal.ts` diese Quelle 1:1 durch P6s Tabelle (kein weiterer Umbau
 * nötig, s. Übergabe-Notiz im Bericht). Bewusst nur eine kleine, grobe Tabelle — nie geraten für
 * unbekannte Modelle, dann `codexFallbackContextWindow` → `null` → kein `-c`-Flag gesetzt.
 */
const CODEX_FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5.6-terra": 272_000,
  "gpt-6-astra": 258_400,
};
export function codexFallbackContextWindow(model: string | null): number | null {
  if (!model) return null;
  return CODEX_FALLBACK_CONTEXT_WINDOWS[model] ?? null;
}

/** Zustand einer Schwellen-Überschreitung je Session (`context_guard_state`, s. Server-Schema). */
export interface ContextGuardSessionState {
  sessionKey: string;
  lastPct: number | null;
  hinweisNotifiedAt: string | null;
  erzwingenAttemptedAt: string | null;
  updatedAt: string;
}

export type ContextGuardEventAction = "notified" | "compact_sent" | "compact_skipped_not_waiting" | "compact_skipped_not_attachable" | "compact_failed";
export type ContextGuardEventKind = "hinweis" | "erzwingen" | "manuell";

export interface ContextGuardEventRow {
  id: number;
  sessionKey: string;
  kind: ContextGuardEventKind;
  pctAtTrigger: number | null;
  action: ContextGuardEventAction;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** Live-Zustand einer Session fürs Badge/Ring im Vollbild (`GET /api/context-guard/sessions/:id`). */
export interface ContextGuardSessionView {
  sessionKey: string;
  thresholds: ResolvedContextGuardThresholds;
  pct: number | null;
  hint: boolean;
  forced: boolean;
  attachable: boolean;
  state: string | null;
}
