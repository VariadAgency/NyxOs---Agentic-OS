// Nyx, der Assistent. Vertrag zwischen Server (`apps/server/src/haiku`, `routes/haiku.ts`,
// `routes/idealink.ts`) und Web (`apps/web/src/features/{haiku,inbox,idealink}`).
import { z } from "zod";
import { t, type Lang } from "./i18n/index.js";
import { NyxChannelSchema } from "./nyx.js";
import { NyxAnswerLengthSchema } from "./nyx-persona.js";
import type { BriefChartKey, BriefTileKey, BriefingFigures } from "./briefing.js";
import type { OverviewCounts } from "./overview.js";

// ───────────────────────────── Kontext + Quellen ─────────────────────────────

/** Was der Nutzer gerade sieht (Panel schickt es mit jeder Frage mit). */
export const HaikuContextSchema = z.object({
  path: z.string().max(500),
  tab: z.string().max(64).nullable(),
  /** Filter aus URL-Segmenten/Query (z. B. art, baustelle, tool). */
  filters: z.record(z.string(), z.string().max(200)).default({}),
  openSessionId: z.string().max(200).nullable(),
  openEntryId: z.string().max(64).nullable(),
  /** Sichtbarer Titel der Großansicht (Session-Titel o. ä.), nur zur Einordnung. */
  title: z.string().max(300).nullable().optional(),
});
export type HaikuContext = z.infer<typeof HaikuContextSchema>;

export const HaikuSourceKindSchema = z.enum(["session", "entry", "doc", "approval", "inbox", "build", "night", "usage", "commit", "report"]);
export type HaikuSourceKind = z.infer<typeof HaikuSourceKindSchema>;

/** Eine vom Server GEPRÜFTE Quelle (existiert wirklich). `href` = Web-Pfad zum Anklicken. */
export const HaikuSourceSchema = z.object({
  kind: HaikuSourceKindSchema,
  id: z.string(),
  label: z.string(),
  href: z.string().nullable(),
});
export type HaikuSource = z.infer<typeof HaikuSourceSchema>;

// ───────────────────────────── Chat ─────────────────────────────

export const HaikuChatRequestSchema = z.object({
  threadId: z.number().int().positive().nullable().optional(),
  message: z.string().trim().min(1).max(4000),
  context: HaikuContextSchema,
  /** nur beim ersten Senden (neuer Faden) – Wegwerf-Faden, wird nach X Stunden gelöscht. */
  temporary: z.boolean().optional(),
  /** Kanal der Frage. voice/telegram → kurze, sprechbare Antwort (Hinweis in der Nachricht, nicht im System-Prompt). */
  channel: NyxChannelSchema.optional(),
  /** Längen-Wahl an der Eingabe (Auto · Kurz · Normal · Ausführlich). Fehlt sie, gilt der Regler „Länge“. */
  length: NyxAnswerLengthSchema.optional(),
});
export type HaikuChatRequest = z.infer<typeof HaikuChatRequestSchema>;

export const HaikuUsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  durationMs: z.number().int(),
});
export type HaikuUsage = z.infer<typeof HaikuUsageSchema>;

/** "disabled" = Haiku ist ausgeschaltet; "not_ready" = eingeschaltet, aber der Motor ist nicht bereit (Grund in `message`);
 * "auth" = der Browser ist nicht angemeldet und der Anmelde-Dialog wurde geschlossen (nur Web). */
export const HaikuErrorCodeSchema = z.enum(["disabled", "not_ready", "budget", "timeout", "engine", "busy", "rate_limit", "invalid", "auth"]);
export type HaikuErrorCode = z.infer<typeof HaikuErrorCodeSchema>;

/** Eine Zeile im NDJSON-Strom von `POST /api/haiku/chat` bzw. `POST /i/:token/chat`. */
export type HaikuStreamEvent =
  | { type: "thread"; threadId: number }
  | { type: "status"; status: "queued" | "thinking" | "tool"; tool?: string; position?: number }
  | { type: "delta"; text: string }
  /**
   * Nyx-Denken: Text, den Nyx VOR einem Werkzeug schrieb – ein Gedanke, keine Antwort. Eingeklappt als
   * „Gedanken“ zeigen, NIE vorlesen. `retract`: dieser Text war schon als Antwort gestreamt → Antwort-Entwurf leeren.
   * Gilt ohnehin: der Antwort-Entwurf besteht nur aus dem Abschnitt seit dem letzten Werkzeug.
   */
  | { type: "thought"; text: string; retract?: true }
  /** genau eine kurze Zwischenmeldung beim ersten Werkzeug („Ich schau mal.“) – darf gesprochen werden, ist keine Antwort. */
  | { type: "filler"; text: string }
  | {
      type: "done";
      messageId: number;
      text: string;
      /** kurze, sprechbare Fassung (ohne Markdown/Links/Emojis) für Stimme und Telegram-Sprachnachricht. */
      speak?: string;
      sources: HaikuSource[];
      estimate: boolean;
      usage: HaikuUsage;
      /** Prüfstand: Lauf im Protokoll (`GET /api/haiku/calls/:id`). */ callId?: number;
      /** Gedanken dieser Runde (Text vor den Werkzeugen), nur zum Anzeigen – nie vorlesen. */
      thoughts?: string[];
    }
  | { type: "error"; code: HaikuErrorCode; message: string };

/** Karten, die das Menü „⋯“ in den Faden legt (keine Gesprächsrunde, geht nicht in den Verlauf an Nyx). */
export const HaikuNoteKindSchema = z.enum(["summary", "task", "obsidian"]);
export type HaikuNoteKind = z.infer<typeof HaikuNoteKindSchema>;

export interface HaikuMessage {
  id: number;
  /** `note` = Karte aus dem Menü „⋯“ (Zusammenfassung, Auftrag, Obsidian), Art in `noteKind`. */
  role: "user" | "assistant" | "note";
  text: string;
  sources: HaikuSource[];
  /** true = Aussage ohne geprüfte Quelle → als „Einschätzung“ gekennzeichnet. */
  estimate: boolean;
  createdAt: string;
  noteKind?: HaikuNoteKind | null;
  /** Der Nutzer hat Nyx beim Sprechen unterbrochen — `text` ist nur der Teil, den er gehört hat. */
  interrupted?: boolean;
}

export interface HaikuThread {
  id: number;
  title: string;
  topic: string;
  day: string;
  updatedAt: string;
  /** Wegwerf-Faden; `expiresAt` = wann er gelöscht wird (null bei normalen Fäden). */
  temporary: boolean;
  expiresAt: string | null;
  /** archiviert (aus der Liste, im Archiv zurückholbar); null = aktiv. */
  archivedAt?: string | null;
}

/** Antwort von „Zu Auftrag machen“ – die neue Aufgabe und die Karte im Faden. */
export interface HaikuThreadTaskResult {
  entry: { id: number; title: string; href: string };
  message: HaikuMessage;
}

/** Antwort von „In Obsidian ablegen“ – Pfad im Vault (relativ) und die Karte im Faden. */
export interface HaikuThreadObsidianResult {
  relPath: string;
  message: HaikuMessage;
}

// ───────────────────────────── Motor, Budget, Protokoll ─────────────────────────────

export const HaikuEngineKindSchema = z.enum(["claude-cli", "api", "off"]);
export type HaikuEngineKind = z.infer<typeof HaikuEngineKindSchema>;

/** Zustand des Motors, sichtbar BEVOR der Nutzer schreibt. `reason` sagt in einfachen Worten, was los ist. */
export const HaikuEngineStateSchema = z.enum(["ready", "waiting_token", "off", "error"]);
export type HaikuEngineState = z.infer<typeof HaikuEngineStateSchema>;

/** Ergebnis von `POST /api/haiku/selftest` („Wer bist du?“ – Knopf „Motor testen“ und `scripts/haiku-smoke.mjs`). */
export interface HaikuSelftest {
  ok: boolean;
  state: HaikuEngineState;
  reason: string | null;
  text: string | null;
  /** Dauer bis zur fertigen Antwort (Server-Sicht). */
  ms: number;
  /** Dauer bis zum ersten sichtbaren Textstück (im Panel wächst die Antwort ab da), `null` = keins. */
  firstTextMs: number | null;
}

/** review = Hintergrund-Lernprüfung, schedule = geplante Aufgabe, compact = Verdichtung eines Fadens. */
export const HaikuCallKindSchema = z.enum(["chat", "briefing", "recap", "rundgang", "idealink", "antwort", "auswertung", "sortierung", "plan", "review", "schedule", "compact", "idee", "prompt"]);
export type HaikuCallKind = z.infer<typeof HaikuCallKindSchema>;

export interface HaikuCall {
  id: number;
  kind: HaikuCallKind;
  engine: HaikuEngineKind;
  model: string | null;
  status: "queued" | "running" | "ok" | "error" | "timeout" | "budget" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

export const HaikuSettingsSchema = z.object({
  engine: HaikuEngineKindSchema,
  /** Tages-Budget als API-Gegenwert in USD (Max-Plan zahlt nicht je Aufruf, das Budget begrenzt trotzdem). */
  dailyBudgetUsd: z.number().min(0).max(100),
  briefingTime: z.string().regex(/^\d{2}:\d{2}$/),
  recapTime: z.string().regex(/^\d{2}:\d{2}$/),
  rundgangMinutes: z.number().int().min(5).max(240),
  timeoutSeconds: z.number().int().min(10).max(600),
  /** Teilbudget der Ideen-Links in % des Tagesbudgets (7): Fremde können des Nutzers Haiku nicht leerfragen. */
  ideaLinkBudgetPercent: z.number().int().min(0).max(100),
  /** Höchstens so viele neue Ideen je Link und Tag (gleitende 24 h). */
  ideaLinkIdeasPerLinkDay: z.number().int().min(0).max(100),
  /** Höchstens so viele neue Ideen über alle Links zusammen je Tag (gleitende 24 h). */
  ideaLinkIdeasPerDay: z.number().int().min(0).max(500),
});
export type HaikuSettings = z.infer<typeof HaikuSettingsSchema>;
export const HaikuSettingsPatchSchema = HaikuSettingsSchema.partial();
export type HaikuSettingsPatch = z.infer<typeof HaikuSettingsPatchSchema>;

export interface HaikuStatus {
  settings: HaikuSettings;
  engine: { kind: HaikuEngineKind; state: HaikuEngineState; available: boolean; reason: string | null; model: string | null };
  /** Reserve-Motor (API-Schlüssel): nur ob einer gesetzt ist, nie der Schlüssel selbst. */
  reserve: { configured: boolean; baseUrl: string | null; model: string | null };
  today: { day: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; budgetUsd: number };
  queue: { running: number; waiting: number };
  lastRundgang: { at: string; findings: number; calledHaiku: boolean } | null;
}

// ───────────────────────────── Briefing / Recap / Leichter Tag ─────────────────────────────

export interface ReportStatement {
  text: string;
  sources: HaikuSource[];
  /** true = ohne geprüfte Quelle (Einschätzung). */
  estimate: boolean;
  /** "regeln" = aus Daten erzeugt (keine KI), "haiku" = Satz vom Modell. */
  author: "regeln" | "haiku";
  /** Haikus Satz hatte eine Zahl, die nicht zu den Daten passte (auch nach dem Neuschreiben) —
   * hier steht stattdessen der Satz aus den Daten. */
  corrected?: boolean;
}

/** Ein Punkt, der ohne Energie erledigt ist (Freigabe, Ja/Nein) oder der Nutzer braucht (mit Dauer). */
export interface ReportItem {
  id: string;
  kind: "approval" | "question" | "plan" | "review" | "crashed" | "build" | "session";
  title: string;
  detail: string | null;
  minutes: number;
  /** true = null Energie: ein Klick (Freigabe) oder eine Ja/Nein-Frage. */
  zeroEnergy: boolean;
  href: string | null;
  sources: HaikuSource[];
  /** Nur bei Ja/Nein bzw. Freigabe: direkt beantwortbar. */
  action: { type: "approval"; approvalId: number } | { type: "inbox"; inboxId: number; options: InboxOption[] } | null;
  /** Rohmeldung (z. B. Build-Log) — nur aufklappbar unter „Details“, nie als Hauptzeile. */
  rawDetail?: string | null;
  /** gebündelte gleiche Einträge (z. B. derselbe Build-Fehler 4×). */
  count?: number;
}

/** Der Stand, aus dem ein Bericht geschrieben wurde (derselbe Schnappschuss wie der Überblick). */
export interface ReportSnapshot {
  at: string;
  counts: OverviewCounts;
  lage: string;
  needsYouCount: number;
  fingerprint: string;
}

export interface HaikuReport {
  id: number;
  kind: "briefing" | "recap";
  day: string;
  createdAt: string;
  greeting: string;
  /** Ein Satz Lage aus echten Zahlen. */
  lage: string;
  sections: { title: string; statements: ReportStatement[] }[];
  runsWithoutYou: ReportItem[];
  needsYou: ReportItem[];
  /** ok = Haiku hat formuliert; nur-daten = Motor aus/Budget weg → nur Sätze aus Regeln. */
  mode: "ok" | "nur-daten";
  /** bei „nur-daten“ der Grund in einfachen Worten (z. B. „Wartet auf Token vom Nutzer.“). */
  modeReason?: string | null;
  callId: number | null;
  /** Stand, aus dem alle Zahlen stammen (null bei Berichten von vor R1). */
  snapshot?: ReportSnapshot | null;
  /** true = seit dem Stand hat sich etwas geändert (Zahlen passen nicht mehr zum Überblick). */
  stale?: boolean;
  /** Kernaussage in einem Satz (von Nyx geprüft oder aus Regeln); null bei Berichten von vor N11. */
  headline?: ReportStatement | null;
  /** alle Kennzahlen und Diagramm-Reihen aus demselben Stand — nie aus dem Modelltext. */
  figures?: BriefingFigures | null;
  /** Kacheln, die Nyx hervorhebt (höchstens 3). */
  highlights?: BriefTileKey[];
  /** Diagramme in der Reihenfolge, die Nyx für wichtig hält. */
  chartOrder?: BriefChartKey[];
  /** App language the report was written in (missing on older reports = German); another language makes it stale. */
  lang?: Lang;
}

export interface LightDay {
  items: ReportItem[];
  /** Wie viele Punkte still auf später geschoben wurden. */
  deferred: number;
}

// ───────────────────────────── Entscheidungs-Inbox ─────────────────────────────

export const InboxOptionSchema = z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200), detail: z.string().max(500).nullable().optional() });
export type InboxOption = z.infer<typeof InboxOptionSchema>;

export const InboxKindSchema = z.enum(["frage", "plan", "eskalation"]);
export type InboxKind = z.infer<typeof InboxKindSchema>;

export interface InboxItem {
  id: number;
  kind: InboxKind;
  title: string;
  body: string | null;
  options: InboxOption[];
  status: "open" | "answered" | "dismissed";
  answer: { optionId: string | null; text: string | null } | null;
  sessionKey: string | null;
  entryId: number | null;
  baustelle: string | null;
  /** Pfad der ENTSCHEIDUNGEN.md, in die die Antwort geschrieben wird (falls bekannt). */
  decisionFile: string | null;
  sources: HaikuSource[];
  createdBy: "haiku" | "session" | "regeln";
  estimateMinutes: number;
  yesNo: boolean;
  /** Eskalationsfall (immer an den Nutzer): produkt, datenverlust, budget, build_rot, fremder_bereich. */
  escalation: string | null;
  delivery: { toSession: "sent" | "queued" | "skipped" | "failed" | null; decisionCommit: string | null; note: string | null } | null;
  createdAt: string;
  answeredAt: string | null;
}

export const InboxAnswerSchema = z
  .object({ optionId: z.string().max(40).nullable().optional(), text: z.string().max(4000).nullable().optional() })
  .refine((a) => (a.optionId ?? null) !== null || (a.text ?? "").trim().length > 0, { error: () => t("optionId oder text nötig") });
export type InboxAnswer = z.infer<typeof InboxAnswerSchema>;

/**
 * „Nyx fragen“ an jeder Entscheidung: Nyx' Einschätzung in genau drei Teilen. Nyx empfiehlt nur –
 * entscheiden (Freigeben/Ja/Nein) tut immer der Nutzer.
 */
export interface DecisionSummary {
  /** „Worum geht's“: 1–2 Sätze. */
  worum: string;
  /** „Meine Empfehlung“: welche Wahl (z. B. „Ja“, „Ablehnen“, „Option B“) + kurzer Grund. */
  empfehlung: { wahl: string; grund: string };
  /** „Wichtig zu wissen“: Risiken, Folgen, was man für die Zukunft als Regel festhalten sollte. */
  wichtig: string[];
  /** Wann Nyx die Einschätzung geschrieben hat (ISO). */
  at: string;
  /** Aus dem Server-Speicher (kein neuer Lauf, keine Kosten). */
  cached: boolean;
}

/** Welche Art Entscheidung: Karte der Inbox (Frage/Plan/Eskalation/Sortieren) oder Freigabe-Anfrage. */
export type DecisionRefKind = "inbox" | "approval";

// ───────────────────────────── Ideen-Link ─────────────────────────────

export interface IdeaLink {
  id: number;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ratePerHour: number;
  uses: number;
  ideasCreated: number;
  lastUsedAt: string | null;
  active: boolean;
}

export const IdeaLinkCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(365),
  ratePerHour: z.number().int().min(1).max(60),
});
export type IdeaLinkCreate = z.infer<typeof IdeaLinkCreateSchema>;

/** Antwort beim Anlegen: der Link mit Token wird GENAU EINMAL gezeigt (gespeichert ist nur der Hash). */
export interface IdeaLinkCreated {
  link: IdeaLink;
  url: string;
  path: string;
}

export const IdeaLinkChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** Vom Browser erzeugte Gesprächs-ID (UUID), damit ein Gespräch fortgesetzt werden kann. */
  conversationId: z.string().uuid(),
});
export type IdeaLinkChat = z.infer<typeof IdeaLinkChatSchema>;

/** Die EINZIGEN Werkzeuge, die Haiku über einen Ideen-Link je sieht (serverseitig erzwungen). */
export const IDEA_LINK_TOOLS = ["ideen_suchen", "idee_anlegen"] as const;
