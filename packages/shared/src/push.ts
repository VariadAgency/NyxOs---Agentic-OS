// Push aufs iPhone (ntfy). Vertrag zwischen Server (`apps/server/src/push`) und Web
// (`apps/web/src/features/push`, Einstellungen-Panel — Einbindung in die Seite macht P5).
import { z } from "zod";

/** Anlässe für Mitteilungen. `approval_needed` und `deploy_failed` sind
 * Schnittstellen für P7 (Freigabe-Fluss) bzw. P5 (Deploy-Log) — hier schon Teil des Vertrags,
 * ausgelöst wird beides erst, wenn die jeweilige Phase existiert. */
// "context_guard_hinweis" — Session über der Hinweis-Schwelle (Kontext-Wächter, s. context-guard.ts).
// "usage_warning" — Nutzung über einer Warnschwelle (5-Std-Fenster oder Tagesverbrauch, s. usage/warnings.ts).
export const PushEventKindSchema = z.enum(["session_waiting", "session_crashed", "build_red", "night_run_done", "deploy_failed", "approval_needed", "context_guard_hinweis", "usage_warning"]);
export type PushEventKind = z.infer<typeof PushEventKindSchema>;

export const PushPrioritySchema = z.enum(["min", "low", "default", "high", "urgent"]);
export type PushPriority = z.infer<typeof PushPrioritySchema>;

/** Standard-Priorität je Anlass (Vorschlag, in den Einstellungen änderbar). */
export const DEFAULT_PRIORITY_BY_KIND: Record<PushEventKind, PushPriority> = {
  session_waiting: "default",
  session_crashed: "high",
  build_red: "high",
  night_run_done: "low",
  deploy_failed: "urgent",
  approval_needed: "high",
  context_guard_hinweis: "default",
  usage_warning: "default",
};

/** Ein Anlass, den der Server an den Dispatcher gibt — noch ohne Bündelung/Ruhezeiten-Prüfung. */
export const PushNotifySchema = z.object({
  kind: PushEventKindSchema,
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  /** Web-Pfad (z. B. `/sessions/coding/nyxos/<id>`), wird beim Versand zur vollen Klick-URL. */
  path: z.string().max(500).nullable().optional(),
  sessionKey: z.string().max(200).nullable().optional(),
  priority: PushPrioritySchema.optional(),
});
export type PushNotifyInput = z.infer<typeof PushNotifySchema>;

/** Für den PATCH-Endpunkt: jede Art einzeln optional, damit ein Umschalter im Panel nur SEINE Art
 * mitschickt, ohne die übrigen zu kennen (s. `patchSettings` — merged in die bestehende Zeile). */
export const PartialEnabledKindsSchema = z.object({
  session_waiting: z.boolean().optional(),
  session_crashed: z.boolean().optional(),
  build_red: z.boolean().optional(),
  night_run_done: z.boolean().optional(),
  deploy_failed: z.boolean().optional(),
  approval_needed: z.boolean().optional(),
  context_guard_hinweis: z.boolean().optional(),
  usage_warning: z.boolean().optional(),
});
export type PartialEnabledKinds = z.infer<typeof PartialEnabledKindsSchema>;

/** Wege, auf denen eine Mitteilung ankommt. `mac` = macOS-Mitteilung über die Brücke,
 * `browser` = Web-Mitteilung im offenen NyxOS-Fenster (Live-WebSocket), `ntfy` = iPhone-App ntfy. */
export const PushChannelSchema = z.enum(["mac", "browser", "ntfy"]);
export type PushChannel = z.infer<typeof PushChannelSchema>;
export const PUSH_CHANNELS = PushChannelSchema.options;
/** Standard: Mac + Browser an (funktionieren ohne öffentlichen Port), iPhone an (schadet nicht). */
export const DEFAULT_PUSH_CHANNELS: Record<PushChannel, boolean> = { mac: true, browser: true, ntfy: true };
export const PartialChannelsSchema = z.object({ mac: z.boolean().optional(), browser: z.boolean().optional(), ntfy: z.boolean().optional() });

/** Brücken-Fähigkeit + RPC `notify`: macOS-Mitteilung auf dem Rechner zeigen. */
export const BRIDGE_CAP_NOTIFY = "notify";
export const MacNotifyRequestSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
});
export type MacNotifyRequest = z.infer<typeof MacNotifyRequestSchema>;

/** Ergebnis je Weg (Test-Knopf + Dispatcher). `skipped` = in den Einstellungen aus. */
export interface PushChannelResult {
  channel: PushChannel;
  ok: boolean;
  skipped?: boolean;
  /** Kurzer deutscher Satz, warum es (nicht) geklappt hat. */
  detail: string;
}
export interface PushTestResponse {
  results: PushChannelResult[];
}

/** Live-WebSocket-Nachricht an offene NyxOS-Fenster (Browser-Weg). */
export interface PushLiveMessage {
  type: "push";
  kind: PushEventKind | "test";
  title: string;
  message: string;
  path: string | null;
}

/** ntfy-Ziel: eigener Dienst auf dem Server (nur mit Tailscale vom iPhone erreichbar) oder der
 * öffentliche Dienst ntfy.sh (geht sofort, Inhalt läuft aber über einen fremden Server). */
export const NtfyTargetSchema = z.enum(["own", "ntfy_sh"]);
export type NtfyTarget = z.infer<typeof NtfyTargetSchema>;
export const NTFY_SH_URL = "https://ntfy.sh";

/** `GET /api/push/subscribe` — alles, was man zum Abonnieren in der iPhone-App braucht. */
export interface PushSubscribeInfo {
  target: NtfyTarget;
  /** Server-Adresse, die man in der ntfy-App einträgt; `null`, wenn das iPhone sie nicht erreicht. */
  serverUrl: string | null;
  topic: string;
  /** Kann das iPhone diesen Weg gerade erreichen? */
  reachable: boolean;
  /** Ehrlicher Satz für die Oberfläche. */
  note: string;
}

export const PushSettingsSchema = z.object({
  topic: z.string(),
  /** Ruhezeiten "HH:MM"; außerhalb `enabledKinds` mit `urgent`-Priorität weiterhin sofort. */
  quietStart: z.string().regex(/^\d{2}:\d{2}$/),
  quietEnd: z.string().regex(/^\d{2}:\d{2}$/),
  /** Gleichartige Anlässe innerhalb dieses Fensters werden zu einer Mitteilung gebündelt. */
  bundleWindowSeconds: z.number().int().min(0).max(3600),
  enabledKinds: z.record(PushEventKindSchema, z.boolean()),
  /** Wartende Session löst erst nach dieser Stille aus (Vorschlag 2 Min). */
  waitingAfterSeconds: z.number().int().min(0).max(3600),
  /** Für die Klick-URL — Vorschlag, bis Tailscale-Name feststeht (ESKALATION). */
  publicBaseUrl: z.string(),
  /** Wege an/aus. */
  channels: z.record(PushChannelSchema, z.boolean()),
  /** wohin der iPhone-Weg veröffentlicht. */
  ntfyTarget: NtfyTargetSchema,
});
export type PushSettings = z.infer<typeof PushSettingsSchema>;

export const PushSettingsPatchSchema = PushSettingsSchema.omit({ topic: true, enabledKinds: true, channels: true })
  .partial()
  .extend({ enabledKinds: PartialEnabledKindsSchema.optional(), channels: PartialChannelsSchema.optional() });
export type PushSettingsPatch = z.infer<typeof PushSettingsPatchSchema>;

export interface PushLogRow {
  id: number;
  kind: PushEventKind;
  sessionKey: string | null;
  title: string;
  message: string;
  priority: PushPriority;
  clickUrl: string | null;
  bundledCount: number;
  suppressedReason: "quiet_hours" | "bundled" | null;
  sentAt: string;
}
