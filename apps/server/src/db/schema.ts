import { sql } from "drizzle-orm";
import { bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {NyxPersonality, NyxSliders, NyxUserProfile, AgentDetails } from "@nyxos/shared";
import type { CategoryUndo } from "../categorize.js";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/**
 * `tsvector` gibt es nicht als eingebauten drizzle-orm-Typ — wir schreiben ihn selbst und immer,
 * damit derselbe Ablauf für Test (PGlite) und Produktion (Postgres 17) gilt. Der Inhalt
 * wird nie in Drizzle-Objektform gelesen, nur per SQL-Ausdruck geschrieben (`to_tsvector(...)`)
 * und über den GIN-Index gefiltert — der TS-Typ ist daher schlicht `string`.
 */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Rechner, die Events liefern (das MacBook). Token nur als SHA-256 gespeichert. */
export const machines = pgTable("machines", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
});

/** Eine Claude- oder Codex-Session. `id` = `<werkzeug>:<session-id>`. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    sessionId: text("session_id").notNull(),
    machineId: text("machine_id").references(() => machines.id),
    parentId: text("parent_id"),
    title: text("title"),
    titleSource: text("title_source"),
    status: text("status").notNull().default("running"),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    cliVersion: text("cli_version"),
    startedAt: ts("started_at"),
    lastActivityAt: ts("last_activity_at"),
    endedAt: ts("ended_at"),
    models: jsonb("models").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tokens: jsonb("tokens").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    tokensTotal: bigint("tokens_total", { mode: "number" }).notNull().default(0),
    toolCalls: jsonb("tool_calls").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    subagents: jsonb("subagents").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    limits: jsonb("limits"),
    parsedEventCount: integer("parsed_event_count").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    parseErrors: integer("parse_errors").notNull().default(0),
    stateObservedAt: ts("state_observed_at"),
    /** P2-Zustand (läuft/wartet/ruht/abgestürzt/geschlossen, …), aus `computeSessionState` — null bei sauber beendeten Sessions ohne P2-Zustand. */
    state: text("state"),
    /** Ob die aktuelle Runde offen ist (läuft) oder mit Stop/Notification/task_complete geschlossen wurde (wartet auf dich). */
    turnOpen: boolean("turn_open").notNull().default(true),
    /** Schutz gegen verspätet eintreffende, ältere Runden-Signale (wie `stateObservedAt`). */
    turnObservedAt: ts("turn_observed_at"),
    /** Gesetzt nur durch einen echten `SessionEnd`-Hook (unterscheidet sauberes Ende von Absturz). */
    sessionEndReceivedAt: ts("session_end_received_at"),
    /** Nur durch `POST /api/sessions/:id/close` gesetzt; hat Vorrang vor jedem berechneten Zustand. */
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    /** Art laut `categorize()`, z. B. "coding" / "audit" / … / "unsortiert". */
    categoryArt: text("category_art"),
    /** Baustelle (live erzeugt, z. B. aus einem Worktree-Ordner) — ohne Treffer beide `null`. */
    categoryBaustelleSlug: text("category_baustelle_slug"),
    categoryBaustelleLabel: text("category_baustelle_label"),
    /** Erklärt die Einsortierung: welche Stufe/Regel welches Merkmal getroffen hat. */
    categoryReason: jsonb("category_reason").$type<unknown[]>(),
    /** Welche `sort_rules`-Zeile (falls eine) zur Einsortierung geführt hat. */
    categoryRuleId: integer("category_rule_id").references(() => sortRules.id),
    /** Abgeleitet = `categoryManualArt || categoryManualBaustelle` (nur noch für Anzeige/
     * Altkompatibilität; die Einsortierung selbst prüft die beiden Dimensionen einzeln). */
    categoryManual: boolean("category_manual").notNull().default(false),
    /** true = die ART wurde direkt vom Nutzer korrigiert — wird von `recomputeCategories` nie
     * überschrieben. Getrennt von der Baustelle ("getrennte Dimensionen"). */
    categoryManualArt: boolean("category_manual_art").notNull().default(false),
    /** true = die BAUSTELLE wurde direkt vom Nutzer korrigiert — wird von `recomputeCategories`
     * nie überschrieben. Getrennt von der Art. */
    categoryManualBaustelle: boolean("category_manual_baustelle").notNull().default(false),
    /** Vorzustand je Dimension VOR der letzten `assignSession`-Korrektur dieser Dimension (
     * Runde 2, Migration `0005_category_undo`) — `unassignSession` liest das, um genau diesen Stand
     * wiederherzustellen (auch eine vorherige manuelle Zuordnung), statt auf die Automatik zu fallen.
     * Wird beim Wiederherstellen für die betroffene(n) Dimension(en) gelöscht (kein Mehrfach-Undo). */
    categoryUndo: jsonb("category_undo").$type<CategoryUndo | null>(),
    /** tmux-Session (`zc-<werkzeug>-<id>`), in der der Prozess läuft — null = nicht in tmux. */
    tmuxName: text("tmux_name"),
    /** Terminal kann aus der Web-App geöffnet werden (tmux-Session lebt auf dem Rechner). */
    attachable: boolean("attachable").notNull().default(false),
    /** Schritt 5: Bildschirm zeigt Freigabe-Frage/Eingabe-Aufforderung (Zusatz zu den Hooks). */
    screenWaiting: boolean("screen_waiting"),
    /** wer die tmux-Session gestartet hat: "nyxos" (Web-App) oder null (Terminal-Programm). Steuert
     * den Standard des Schalters „Nur ansehen" (an bei Terminal-Programm, aus bei NyxOS). */
    startedVia: text("started_via"),
    /** Verspätungs-Schutz für die tmux-Meldungen der Brücke. */
    terminalObservedAt: ts("terminal_observed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** Tokens + Modell der zuletzt gesehenen Antwort (nicht die Summe der Session) —
     * Grundlage für den Kontext-Anteil (`contextPct`, aus `packages/shared/src/usage.ts`
     * `computeContextPct`). `modelContextWindow` ist nur bei Codex gesetzt (Session meldet ihr
     * Kontextfenster selbst); bei Claude kommt das Kontextfenster aus der Preistabelle. */
    lastUsage: jsonb("last_usage").$type<{ input: number; output: number; cacheRead: number; cacheCreation: number }>(),
    lastUsageModel: text("last_usage_model"),
    modelContextWindow: integer("model_context_window"),
    /** seit wann die Session temporär ist (null = normale Session). Ablauf: `temporary.ts`. */
    temporarySince: ts("temporary_since"),
    /** Warum temporär: "manual" (Schalter beim Start) oder eine Auto-Regel (`TemporaryReason`). */
    temporaryReason: text("temporary_reason"),
    /** Der Nutzer hat „Behalten“ gewählt → die Auto-Regeln markieren diese Session nie wieder. */
    temporaryKept: boolean("temporary_kept").notNull().default(false),
    /** Abgelaufen: aus allen Listen und Zählern raus. Zeile, Ereignisse und Transkript-Archiv bleiben. */
    archivedAt: ts("archived_at"),
  },
  (t) => [
    uniqueIndex("sessions_tool_session_id_idx").on(t.tool, t.sessionId),
    index("sessions_last_activity_idx").on(t.lastActivityAt),
    index("sessions_state_idx").on(t.state),
    index("sessions_category_art_idx").on(t.categoryArt),
  ],
);

/**
 * Regeln vom Nutzer (manuell angelegt oder aus einer Korrektur per `POST /api/sessions/:id/assign`
 * entstanden). Haben Vorrang vor den fest im Code stehenden Standard-Regeln (`categorize.ts`) —
 * aber nur in ihrer eigenen Dimension: `dimension = 'art'` setzt nur die
 * Art, `dimension = 'baustelle'` nur die Baustelle. `condition` ist eine `RuleCondition` aus
 * `categorize.ts` (Ordner/Arbeitsordner/Skill/Titel-Wort) — Ordner-Bedingungen kommen nur bei
 * `dimension = 'baustelle'` vor (nie für Art, s. `buildCorrectionCondition`).
 */
export const sortRules = pgTable("sort_rules", {
  id: serial("id").primaryKey(),
  condition: jsonb("condition").notNull(),
  /** 'art' | 'baustelle'. Default 'baustelle' ist nur für die additive Migration relevant
   * (alte Zeilen ohne Dimension gab es nie in Produktion, s. BETRIEB.md) — neuer Code setzt es immer. */
  dimension: text("dimension").notNull().default("baustelle"),
  /** Nullable seit P2-F2: nur gesetzt, wenn `dimension = 'art'`. */
  targetArt: text("target_art"),
  targetBaustelleSlug: text("target_baustelle_slug"),
  targetBaustelleLabel: text("target_baustelle_label"),
  origin: text("origin").notNull(), // 'manuell' | 'korrektur'
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Einzelne Ereignisse. Die ID ist deterministisch → doppeltes Senden ist harmlos. */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: text("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    data: jsonb("data").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    index("session_events_session_ts_idx").on(t.sessionKey, t.ts),
    // Commit → Session sucht Werkzeug-Aufrufe (`git commit` …) in einem Zeitfenster.
    index("session_events_tool_call_ts_idx").on(t.ts).where(sql`${t.kind} = 'tool_call'`),
    // inkrementeller Skill-Nutzungs-Scan (`skills/usage.ts`) – nur Skill-Aufrufe und /befehle, darum winzig.
    index("session_events_skill_scan_idx")
      .on(t.receivedAt)
      .where(sql`(${t.kind} = 'tool_call' and ${t.data}->>'name' = 'Skill') or (${t.kind} = 'prompt' and ${t.data} ? 'command')`),
  ],
);

/** Geschriebene/gelesene Dateien je Session (Grundlage der Kollisionskarte in P5). */
export const sessionFiles = pgTable(
  "session_files",
  {
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    mode: text("mode").notNull(),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionKey, t.path, t.mode] }), index("session_files_path_idx").on(t.path)],
);

/** Archivierte Verlaufsdateien (gzip auf dem Volume) mit Prüfsumme der Rohdatei. */
export const archive = pgTable(
  "archive",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    gzSize: bigint("gz_size", { mode: "number" }).notNull(),
    storedPath: text("stored_path").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("archive_tool_path_idx").on(t.tool, t.path), index("archive_session_idx").on(t.sessionKey)],
);

/**
 * Volltext-Index: ein Dokument je gefundenem Text-Schnipsel einer Session. `field`:
 * 'title' | 'prompt' | 'file' | 'chat' (kein DB-Enum — die Web-App/Server-Konstanten in
 * `search.ts` sind die eine Quelle der Wahrheit, wie bei `sessions.status`/`state`). `position`
 * ist nur bei `field = 'chat'` gesetzt: derselbe Index, den `transcript.ts` für die aufgebaute
 * Eintragsliste verwendet (geteilte Funktion, keine zweite Zählung) — so kann `around=<position>`
 * direkt darauf aufsetzen. `text` ist der Rohtext fürs Snippet (`ts_headline`); bei `field='file'`
 * der volle Pfad. Zwei tsvector-Spalten statt einer gemeinsamen: die deutsche Konfiguration
 * (Wortstämme, z. B. „sortiert" für „Sortierung") und `simple` (exakte Begriffe, Codex-Namen,
 * Dateipfade — deutsche Stämme würden Pfade wie `categorize.ts` verstümmeln) brauchen getrennte
 * `to_tsvector`-Aufrufe und damit auch getrennte Indizes; eine Suche prüft beide mit ODER
 * (s. `search.ts`). Für `field='file'` enthält `tsv_simple` zusätzlich die an `/` in
 * Ordner-Segmente zerlegten Pfadteile, damit z. B. `categorize.ts` innerhalb eines längeren Pfades
 * trifft (NICHT zusätzlich an `.`/`_`/`-` getrennt — das würde das Segment-Lexem selbst zerstören,
 * s. Kommentar in `search.ts`) — `pg_trgm` ist in der PGlite-Testumgebung nur über ein
 * Erweiterungs-Modul ladbar, das `test/helpers.ts` (außerhalb des Schreibbereichs dieses Pakets)
 * nicht einbindet; deshalb Pfad-Zerlegung statt Trigram (s. Bericht).
 */
export const searchDocs = pgTable(
  "search_docs",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    position: integer("position"),
    text: text("text").notNull(),
    tsvGerman: tsvector("tsv_german").notNull(),
    tsvSimple: tsvector("tsv_simple").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("search_docs_tsv_german_idx").using("gin", t.tsvGerman),
    index("search_docs_tsv_simple_idx").using("gin", t.tsvSimple),
    index("search_docs_session_field_idx").on(t.sessionKey, t.field),
    index("search_docs_session_field_position_idx").on(t.sessionKey, t.field, t.position),
  ],
);

/**
 * Push. Ein-Zeilen-Tabelle (`id = 1`) mit dem geheimen ntfy-Thema + Einstellungen. Der
 * Server legt die Zeile beim ersten Zugriff selbst an (`push/settings.ts` `loadOrInitSettings`,
 * zufälliges Thema per `crypto.randomBytes`) — keine Migration muss Startwerte kennen.
 */
export const pushSettings = pgTable("push_settings", {
  id: integer("id").primaryKey().default(1),
  topic: text("topic").notNull(),
  quietStart: text("quiet_start").notNull().default("22:00"),
  quietEnd: text("quiet_end").notNull().default("08:00"),
  bundleWindowSeconds: integer("bundle_window_seconds").notNull().default(120),
  waitingAfterSeconds: integer("waiting_after_seconds").notNull().default(120),
  publicBaseUrl: text("public_base_url").notNull().default("http://127.0.0.1:47801"),
  enabledKinds: jsonb("enabled_kinds").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  /** Wege an/aus (`mac`/`browser`/`ntfy`); fehlender Schlüssel = an. */
  channels: jsonb("channels").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  /** `own` = eigener ntfy-Dienst, `ntfy_sh` = öffentlicher Dienst ntfy.sh. */
  ntfyTarget: text("ntfy_target").notNull().default("own"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Push. Jede versendete (oder bewusst unterdrückte) Mitteilung — Grundlage für Bündelung,
 * Dedupe ("schon benachrichtigt?") und den Latenz-Nachweis (< 10 s messbar). */
export const pushLog = pgTable(
  "push_log",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    sessionKey: text("session_key").references(() => sessions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    priority: text("priority").notNull(),
    clickUrl: text("click_url"),
    bundledCount: integer("bundled_count").notNull().default(1),
    /** null = wirklich verschickt; sonst warum unterdrückt/gebündelt statt eigenständig gesendet. */
    suppressedReason: text("suppressed_reason"),
    sentAt: ts("sent_at").notNull().defaultNow(),
    /** Wege mit Ergebnis (Mac/Browser/iPhone über ntfy/Telegram); null = alte Zeile oder nicht gesendet. */
    channels: jsonb("channels").$type<{ channel: string; ok: boolean; skipped?: boolean }[]>(),
    /** Sammel-Mitteilung (z. B. Abwesenheits-Bündel „3 Sachen fertig“). */
    bundle: boolean("bundle").notNull().default(false),
  },
  (t) => [index("push_log_kind_session_idx").on(t.kind, t.sessionKey, t.sentAt)],
);

/**
 * Build-Wächter. Ein Lauf je Prüfung (iOS/Backend/NyxOS). `derivedDataPath` nur bei
 * `kind = 'ios'` gesetzt (eigener Pfad je Worktree, s. `builds/runner.ts` — nie des Nutzers eigene
 * DerivedData). `logExcerpt` = letzte `BUILD_LOG_EXCERPT_LINES` Zeilen; der volle Log bleibt nur in
 * der Prozess-Ausgabe (kein eigenes Log-Volume in P8, s. Bericht "offene Punkte").
 */
export const buildRuns = pgTable(
  "build_runs",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key").references(() => sessions.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    command: text("command").notNull(),
    status: text("status").notNull().default("queued"),
    exitCode: integer("exit_code"),
    logExcerpt: text("log_excerpt"),
    derivedDataPath: text("derived_data_path"),
    trigger: text("trigger").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    /** BC: Arbeitsordner der Prüfung — ein späterer grüner Lauf im selben Ordner behebt frühere
     * rote („Braucht dich“ räumt auf, danach meldet ein neuer Fehler wieder per Push). */
    folder: text("folder"),
  },
  (t) => [index("build_runs_session_idx").on(t.sessionKey, t.startedAt), index("build_runs_kind_status_idx").on(t.kind, t.status)],
);

/**
 * Nachtmodus. Eine Zeile je Nachtlauf-Eintrag (Warteschlange + Verlauf). `taskId` zeigt auf
 * einen künftigen `entries`-Eintrag — bis dahin frei benannte IDs (s. `night/planner.ts` Tests).
 */
export const nightRuns = pgTable(
  "night_runs",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id").notNull(),
    title: text("title").notNull(),
    runsOn: text("runs_on").notNull(),
    status: text("status").notNull().default("queued"),
    /** KEIN Fremdschlüssel auf `sessions.id` (anders als `build_runs`/`push_log`): der Planer legt
     * diese Zeile schon beim Start an, bevor die frisch gestartete tmux-/Worktree-Session ihr erstes
     * Hook-Ereignis gesendet hat — `sessions` hätte dann noch keine passende Zeile (Wettlauf). */
    sessionKey: text("session_key"),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    stopReason: text("stop_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("night_runs_status_idx").on(t.status)],
);


// ───────────────────────────── Haiku, Leitplanken, Inbox, Ideen-Link ─────────────────────────────

/** Ein-Zeilen-Tabelle (`id = 1`) mit den Haiku-Einstellungen (Motor, Budget, Zeiten). Startwerte
 * legt `haiku/settings.ts` beim ersten Zugriff an. Der API-Schlüssel des Reserve-Motors steht NIE hier
 * (nur Umgebung `NYXOS_HAIKU_API_KEY`). */
export const haikuSettings = pgTable("haiku_settings", {
  id: integer("id").primaryKey().default(1),
  engine: text("engine").notNull().default("claude-cli"),
  dailyBudgetUsd: doublePrecision("daily_budget_usd").notNull().default(0.5),
  briefingTime: text("briefing_time").notNull().default("07:00"),
  recapTime: text("recap_time").notNull().default("21:30"),
  rundgangMinutes: integer("rundgang_minutes").notNull().default(15),
  timeoutSeconds: integer("timeout_seconds").notNull().default(90),
  /** (7): Teilbudget der Ideen-Links in % des Tagesbudgets + Obergrenzen für neue Ideen. */
  ideaLinkBudgetPercent: integer("idealink_budget_percent").notNull().default(20),
  ideaLinkIdeasPerLinkDay: integer("idealink_ideas_per_link_day").notNull().default(10),
  ideaLinkIdeasPerDay: integer("idealink_ideas_per_day").notNull().default(30),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Nach wie vielen Stunden Stille temporäre Sessions archiviert und Haiku-Fäden gelöscht werden (1–72). */
export const temporarySettings = pgTable("temporary_settings", {
  id: integer("id").primaryKey().default(1),
  hours: integer("hours").notNull().default(6),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** „Temporär“ beim Start einer Codex-Session – die ID kommt erst mit der ersten Verlaufszeile,
 * darum hängt die Markierung am tmux-Namen, bis die Session erscheint (danach gelöscht). */
export const temporaryMarks = pgTable("temporary_marks", {
  tmuxName: text("tmux_name").primaryKey(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Protokoll JEDES Haiku-Aufrufs (Kosten, Dauer, Ergebnis) — Grundlage für Budget + Verbrauch. */
export const haikuCalls = pgTable(
  "haiku_calls",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    engine: text("engine").notNull(),
    model: text("model"),
    status: text("status").notNull().default("queued"),
    threadId: integer("thread_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    toolCalls: jsonb("tool_calls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("haiku_calls_created_idx").on(t.createdAt), index("haiku_calls_kind_idx").on(t.kind, t.createdAt)],
);

/** Gesprächsfaden (je Tag/Thema fortsetzbar über `claude --resume <claudeSessionId>`).
 * `scope` = "full" (Panel) | "idealink" (Mini-Seite eines Ideen-Links, `ideaLinkId` gesetzt). */
export const haikuThreads = pgTable(
  "haiku_threads",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull().default("full"),
    topic: text("topic").notNull(),
    day: text("day").notNull(),
    title: text("title").notNull(),
    claudeSessionId: text("claude_session_id"),
    ideaLinkId: integer("idea_link_id"),
    conversationKey: text("conversation_key"),
    /** Wegwerf-Faden – wird X Stunden nach der letzten Nachricht gelöscht (`temporary.ts`). */
    temporary: boolean("temporary").notNull().default(false),
    /** archiviert (Menü „⋯“) – aus der Fadenliste, im Archiv zurückholbar. */
    archivedAt: ts("archived_at"),
    /** Gedächtnis-Abbild, beim Anlegen des Fadens eingefroren (Hermes: Prompt bleibt je Faden stabil). */
    memorySnapshot: text("memory_snapshot"),
    /** Verdichtung – Zusammenfassung nach festem Schema und bis zu welcher Nachricht sie reicht. */
    summary: text("summary"),
    summaryUptoId: integer("summary_upto_id"),
    /** Runden seit der letzten Gedächtnis-Pflege (Auslöser der Hintergrund-Lernprüfung alle ~10 Runden). */
    turnsSinceMemory: integer("turns_since_memory").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("haiku_threads_scope_idx").on(t.scope, t.updatedAt), uniqueIndex("haiku_threads_link_conv_idx").on(t.ideaLinkId, t.conversationKey)],
);

export const haikuMessages = pgTable(
  "haiku_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => haikuThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    text: text("text").notNull(),
    sources: jsonb("sources").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    estimate: boolean("estimate").notNull().default(false),
    context: jsonb("context"),
    callId: integer("call_id"),
    /** nur bei `role = 'note'` – summary | task | obsidian. */
    noteKind: text("note_kind"),
    /** Kanal der Frage (web/voice/telegram) bzw. sprechbare Kurzfassung der Antwort. */
    channel: text("channel"),
    speak: text("speak"),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Nyx wurde beim Sprechen unterbrochen — `text` ist nur der gehörte Teil. */
    interrupted: boolean("interrupted").notNull().default(false),
  },
  (t) => [
    index("haiku_messages_thread_idx").on(t.threadId, t.id),
    // Chat-Suche (Hermes session_search): deutscher Volltext über alle Nyx-/Haiku-Nachrichten.
    index("haiku_messages_fts_idx").using("gin", sql`to_tsvector('german', ${t.text})`),
  ],
);

/** Ablage des Nyx-Tabs — Bilder, die Nyx zeigt (`show_image`, Simulator-Screenshots), und Dateien,
 * die der Nutzer Nyx gibt. Die Bytes liegen im Archiv-Volume unter `nyx/<sha256>.<ext>` (`storedPath` relativ). */
export const nyxFiles = pgTable(
  "nyx_files",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    storedPath: text("stored_path").notNull(),
    threadId: integer("thread_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("nyx_files_kind_idx").on(t.kind, t.id)],
);

/** Briefing (morgens) und Recap (abends), je Tag die jüngste Fassung zählt. */
export const haikuReports = pgTable(
  "haiku_reports",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    day: text("day").notNull(),
    content: jsonb("content").notNull(),
    facts: jsonb("facts").notNull().default(sql`'[]'::jsonb`),
    callId: integer("call_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("haiku_reports_kind_day_idx").on(t.kind, t.day, t.createdAt)],
);

/** Eigene Notizen von Haiku (Rundgang-Befunde, Merker). `fingerprint` verhindert Wiederholungen. */
export const haikuNotes = pgTable(
  "haiku_notes",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    fingerprint: text("fingerprint"),
    data: jsonb("data"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("haiku_notes_kind_idx").on(t.kind, t.createdAt), index("haiku_notes_fp_idx").on(t.fingerprint)],
);

// ───────────────────────────── Nyx-Kern ─────────────────────────────

/** Dauerhaftes Gedächtnis (Hermes memory_tool): kurze Fakten mit festem Zeichen-Budget je Kategorie. */
export const nyxMemory = pgTable(
  "nyx_memory",
  {
    id: serial("id").primaryKey(),
    category: text("category").notNull(), // user | project | preference
    fact: text("fact").notNull(),
    sourceThreadId: integer("source_thread_id").references(() => haikuThreads.id, { onDelete: "set null" }),
    sourceMessageId: integer("source_message_id"),
    createdBy: text("created_by").notNull().default("nyx"), // nyx | user | vorschlag
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("nyx_memory_category_idx").on(t.category, t.id)],
);

/** Vorschläge der Hintergrund-Lernprüfung – nie still gespeichert, der Nutzer hakt ab. */
export const nyxMemorySuggestions = pgTable(
  "nyx_memory_suggestions",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(), // add | replace | remove
    category: text("category").notNull(),
    fact: text("fact").notNull(),
    memoryId: integer("memory_id").references(() => nyxMemory.id, { onDelete: "cascade" }),
    reason: text("reason"),
    sourceThreadId: integer("source_thread_id").references(() => haikuThreads.id, { onDelete: "set null" }),
    status: text("status").notNull().default("open"), // open | accepted | rejected
    createdAt: ts("created_at").notNull().defaultNow(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("nyx_memory_suggestions_status_idx").on(t.status, t.id)],
);

/** Plan/To-do je Faden (Hermes todo_tool) – Revision steigt mit jeder Änderung. */
export const nyxTodos = pgTable("nyx_todos", {
  threadId: integer("thread_id")
    .primaryKey()
    .references(() => haikuThreads.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  items: jsonb("items").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Geplante Aufgaben – einmalig, wiederkehrend (cron, Zeitzone des Nutzers) oder „wenn X passiert“. */
export const nyxSchedules = pgTable(
  "nyx_schedules",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    mode: text("mode").notNull().default("remind"), // remind | run
    kind: text("kind").notNull(), // once | cron | event
    runAt: ts("run_at"),
    cron: text("cron"),
    event: text("event"),
    eventFilter: text("event_filter"),
    /** Stand der Ereignis-Prüfung (höchste gesehene ID bzw. Zeit) – nur Neues löst aus. */
    eventCursor: jsonb("event_cursor").$type<Record<string, unknown>>(),
    precheck: text("precheck"),
    activeStart: text("active_start"),
    activeEnd: text("active_end"),
    deliver: text("deliver").notNull().default("web"),
    paused: boolean("paused").notNull().default(false),
    nextRunAt: ts("next_run_at"),
    lastRunAt: ts("last_run_at"),
    lastStatus: text("last_status"),
    lastOutput: text("last_output"),
    runCount: integer("run_count").notNull().default(0),
    createdBy: text("created_by").notNull().default("nyx"),
    sourceThreadId: integer("source_thread_id").references(() => haikuThreads.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("nyx_schedules_due_idx").on(t.paused, t.nextRunAt)],
);

/**
 * frühere Ablage für Bilder/Links. NICHT MEHR BENUTZT – Bilder liegen in `nyx_files` (eine Quelle
 * für Tab, Telegram, Download), Links in der Aufgaben-Karte. Tabelle bleibt (Migrationen nur additiv).
 */
export const nyxMedia = pgTable(
  "nyx_media",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // image | link
    title: text("title").notNull(),
    url: text("url"),
    file: text("file"),
    mime: text("mime"),
    bytes: integer("bytes"),
    source: text("source").notNull().default("nyx"),
    threadId: integer("thread_id").references(() => haikuThreads.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("nyx_media_created_idx").on(t.createdAt)],
);

/** Entscheidungs-Inbox: offene Fragen (Sessions, Aufträge), Pläne von Haiku, Eskalationen. */
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    options: jsonb("options").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("open"),
    answer: jsonb("answer"),
    sessionKey: text("session_key"),
    entryId: integer("entry_id"),
    baustelle: text("baustelle"),
    decisionFile: text("decision_file"),
    sources: jsonb("sources").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").notNull().default("haiku"),
    estimateMinutes: integer("estimate_minutes").notNull().default(2),
    yesNo: boolean("yes_no").notNull().default(false),
    escalation: text("escalation"),
    delivery: jsonb("delivery"),
    fingerprint: text("fingerprint"),
    createdAt: ts("created_at").notNull().defaultNow(),
    answeredAt: ts("answered_at"),
  },
  (t) => [index("inbox_items_status_idx").on(t.status, t.createdAt), index("inbox_items_fp_idx").on(t.fingerprint)],
);

/** Freigabe-Anfragen aus dem Leitplanken-Hook. Eine Freigabe erlaubt GENAU EINEN Befehl
 * (`commandHash` + Session), danach `consumed`. */
export const approvals = pgTable(
  "approvals",
  {
    id: serial("id").primaryKey(),
    status: text("status").notNull().default("pending"),
    rule: text("rule").notNull(),
    reason: text("reason").notNull(),
    tool: text("tool").notNull(),
    command: text("command").notNull(),
    commandHash: text("command_hash").notNull(),
    cwd: text("cwd"),
    sessionKey: text("session_key"),
    auftrag: text("auftrag"),
    worktree: text("worktree"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    consumedAt: ts("consumed_at"),
  },
  (t) => [index("approvals_status_idx").on(t.status, t.createdAt), index("approvals_hash_idx").on(t.commandHash, t.sessionKey)],
);

/** Ideen-Link je Person. Gespeichert ist nur der SHA-256 des Tokens. */
export const ideaLinks = pgTable("idea_links", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  ratePerHour: integer("rate_per_hour").notNull().default(10),
  uses: integer("uses").notNull().default(0),
  ideasCreated: integer("ideas_created").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  lastUsedAt: ts("last_used_at"),
});

/** Ratenbegrenzung: eine Zeile je Chat-Anfrage über einen Link (gleitendes Stundenfenster). */
export const ideaLinkHits = pgTable(
  "idea_link_hits",
  {
    id: serial("id").primaryKey(),
    linkId: integer("link_id")
      .notNull()
      .references(() => ideaLinks.id, { onDelete: "cascade" }),
    at: ts("at").notNull().defaultNow(),
    /** 'chat' = eine Anfrage (Ratenbegrenzung), 'idea' = eine angelegte Idee (Obergrenze je Link/Tag + global). */
    kind: text("kind").notNull().default("chat"),
  },
  (t) => [index("idea_link_hits_link_at_idx").on(t.linkId, t.at)],
);

/** Anmeldung: Passkeys vom Nutzer (WebAuthn). `id` = Credential-ID (base64url). */
export const authCredentials = pgTable("auth_credentials", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rpId: text("rp_id").notNull(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
});

/** Anmelde-Sitzungen (Cookie). Gespeichert nur der SHA-256 des Cookie-Werts, nie der Wert selbst. */
export const authSessions = pgTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  csrf: text("csrf").notNull(),
  credentialId: text("credential_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at"),
});

/** Einmal-Codes zum Einrichten eines Passkeys (per CLI erzeugt, 15 Min gültig, nur Hash gespeichert). */
export const authSetupCodes = pgTable("auth_setup_codes", {
  codeHash: text("code_hash").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Aufgaben, Bugs, Audit-Befunde, Ideen, Entscheidungen, Fragen, Probleme — eine Tabelle, `kind`
 * unterscheidet die Art (kein DB-Enum, wie bei `sessions.state`: `entries/store.ts` ist die eine
 * Quelle der Wahrheit für gültige Werte). `stage` deckt beide Verläufe ab: Ideen laufen
 * eingang → in_klaerung → konzept_fertig, alles andere geplant → startklar → laeuft → pruefen →
 * erledigt („In Aufgaben übernehmen" wechselt kind von idee weg und setzt stage auf geplant).
 * `stageSetBy` unterscheidet „vom Nutzer/Import gesetzt" von „nur der Reife-Check darf startklar
 * setzen" („Stufe „Startklar" setzt nur der Check, nie ein Mensch oder Agent von
 * Hand"). Fortschritt wird NIE geraten: `progressPercent` ist ein reiner Cache aus
 * `subtasks` (gewichtet, in `entries/store.ts` `recomputeProgress` neu berechnet, nie direkt gesetzt).
 */
export const entries = pgTable(
  "entries",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    stage: text("stage").notNull().default("geplant"),
    priority: text("priority"),
    baustelleSlug: text("baustelle_slug"),
    baustelleLabel: text("baustelle_label"),
    /** Gewichtete Summen aus `subtasks` ("Fortschritt = erledigte Teilaufgaben ÷
     * alle, gewichtet"), plus der daraus abgeleitete Prozentwert als Cache für Listen/Kacheln. */
    progressDoneWeight: integer("progress_done_weight").notNull().default(0),
    progressTotalWeight: integer("progress_total_weight").notNull().default(0),
    progressPercent: integer("progress_percent").notNull().default(0),
    /** Reife-Check: voller `MaturityResult` (Punkte + `passed`/`passedCount`/
     * `totalCount`, s. `entries/maturity.ts`) — kein `import type` von dort (Zirkel zu dieser
     * Datei), deshalb hier inline getippt. Nur `applyMaturity()` darf `stage` auf "startklar" setzen. */
    maturity: jsonb("maturity").$type<{ points: unknown[]; passed: boolean; passedCount: number; totalCount: number }>(),
    maturityCheckedAt: ts("maturity_checked_at"),
    /** Import-Herkunft für idempotente Läufe: `sourceType` = 'goal' | 'audit' |
     * 'idea' | 'manual' | 'mcp'; zusammen mit `sourceId` eindeutig, ändert nie von Hand gepflegte
     * Felder bei einem erneuten Import (s. `entries/import.ts`). */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    /** Die Quelle (GOAL.md, Audit-Zeile, Idee im Postfach) gibt es nicht mehr. Der Eintrag
     * bleibt (nie löschen), wird nur als „Quelle entfernt“ markiert; taucht die Quelle wieder auf,
     * setzt der nächste Import das Feld zurück auf `null`. */
    sourceRemovedAt: ts("source_removed_at"),
    fileScope: jsonb("file_scope").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    modelSuggestion: text("model_suggestion"),
    estimate: text("estimate"),
    /** Ein-Klick-Start: Worktree/Ordner + tmux-Name, sobald gestartet. */
    worktreePath: text("worktree_path"),
    gitBranch: text("git_branch"),
    tmuxName: text("tmux_name"),
    startedSessionKey: text("started_session_key").references(() => sessions.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("entries_source_idx").on(t.sourceType, t.sourceId),
    index("entries_kind_stage_idx").on(t.kind, t.stage),
    index("entries_baustelle_idx").on(t.baustelleSlug),
  ],
);

/** Teilaufgaben bzw. Reife-Punkte einer Aufgabe/eines Bugs. `doneBySessionKey` wird nur von der
 * Automatik gesetzt (MCP `teilaufgabe_erledigt`, Git-Wächter) — nie von Hand behauptet. */
export const subtasks = pgTable(
  "subtasks",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    weight: integer("weight").notNull().default(1),
    done: boolean("done").notNull().default(false),
    doneBySessionKey: text("done_by_session_key").references(() => sessions.id, { onDelete: "set null" }),
    doneAt: ts("done_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("subtasks_entry_idx").on(t.entryId)],
);

/** Beliebige Verknüpfungen zwischen Einträgen, Sessions, Dateien, Commits, Dokumenten (
 * Großansicht). `fromType`/`toType` ∈ 'entry' | 'session' | 'file' | 'commit' | 'doc'; IDs immer als
 * Text (Einträge als String der Serial-ID). `relation` ist ein freier, sprechender Text (z. B.
 * "vorgaenger", "blockiert", "verwandt", "entstand_aus", "dokument", "session") — keine DB-Enum,
 * damit neue Beziehungsarten ohne Migration dazukommen (wie bei `search_docs.field`). */
export const links = pgTable(
  "links",
  {
    id: serial("id").primaryKey(),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("links_from_idx").on(t.fromType, t.fromId),
    index("links_to_idx").on(t.toType, t.toId),
    uniqueIndex("links_unique_idx").on(t.fromType, t.fromId, t.toType, t.toId, t.relation),
  ],
);

/** Verlauf eines Eintrags (wie `session_events`, eigene Tabelle statt Wiederverwendung — Einträge
 * haben eine int-ID, keine `session_key`-Fremdschlüssel-Form). */
export const entryEvents = pgTable(
  "entry_events",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull().defaultNow(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("entry_events_entry_ts_idx").on(t.entryId, t.ts)],
);

/** Doku-Spiegel: Markdown-Dokumente aus dem Mac-Repo, damit Großansicht (und später
 * Haiku) sie lesen können, auch wenn der Rechner zu ist. `path` ist relativ zum Projektordner
 * (eindeutig), `sha256` verhindert unnötiges Neuschreiben bei unveränderten Dateien. */
export const docs = pgTable("docs", {
  path: text("path").primaryKey(),
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------------
// Git-Stand, Konflikte, Server/Deploys, Lernbuch. Additive Migration `0009_git_conflicts_server_lessons`.
// Die Brücke liest App-Repo, Worktrees und das NyxOS-Repo NUR LESEND und schickt je Repo eine
// volle Momentaufnahme (Upsert je `repoId`) — kein Ereignisstrom wie bei `session_events`, weil
// hier immer der ganze aktuelle Stand zählt, nicht die Historie einzelner Ereignisse (Ausnahme:
// `git_commits`/`git_catchup_history`/`conflict_events`, die bewusst wachsen).
// ---------------------------------------------------------------------------------------------

/** Ein gescanntes Repo: App-Repo, ein Worktree oder das NyxOS-Repo selbst. */
export const gitRepos = pgTable("git_repos", {
  id: text("id").primaryKey(), // z. B. "app", "worktree:notifications", "nyxos"
  label: text("label").notNull(),
  kind: text("kind").notNull(), // 'app' | 'worktree' | 'nyxos'
  root: text("root").notNull(),
  currentBranch: text("current_branch"),
  headSha: text("head_sha"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  scannedAt: ts("scanned_at").notNull().defaultNow(),
  /** Worktree → Eltern-Repo ("app"/"nyxos"); Repos selbst `null`. */
  parentId: text("parent_id"),
  /** Zweig, gegen den vor/hinter gemessen wird. */
  mainBranch: text("main_branch"),
  /** zuletzt aktiv laut Brücke (Reflog, Commit, geänderte Datei). */
  lastActivityAt: ts("last_activity_at"),
});

/** Zweige je Repo mit Vor-/Rückstand zu `main`. Upsert je Scan. */
export const gitBranches = pgTable(
  "git_branches",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ahead: integer("ahead").notNull().default(0),
    behind: integer("behind").notNull().default(0),
    isCurrent: boolean("is_current").notNull().default(false),
    lastCommitAt: ts("last_commit_at"),
    upstream: text("upstream"),
    /** eigene Commits dieses Zweigs (Zweig → Commits). */
    aheadShas: jsonb("ahead_shas").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [uniqueIndex("git_branches_repo_name_idx").on(t.repoId, t.name)],
);

/** Ungesicherte Änderungen je Repo, gruppiert (code/doku/projekt/verschoben). Upsert je Scan;
 * bereinigte Pfade werden beim nächsten Scan durch einen vollen Ersatz entfernt (s. git/store.ts). */
export const gitUncommitted = pgTable(
  "git_uncommitted",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    statusCode: text("status_code").notNull(),
    group: text("group").notNull(), // ChangeGroup
    fromPath: text("from_path"),
  },
  (t) => [uniqueIndex("git_uncommitted_repo_path_idx").on(t.repoId, t.path)],
);

/** Commit-Historie je Repo/Zweig (7-Tage-Diagramm im Überblick). Wächst, kein Upsert-Ersatz. */
export const gitCommits = pgTable(
  "git_commits",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    authorDate: ts("author_date").notNull(),
    subject: text("subject").notNull(),
    branch: text("branch").notNull(),
    // (additiv, ältere Zeilen bleiben leer):
    authorName: text("author_name"),
    committedAt: ts("committed_at"),
    /** Anzahl Eltern; ≥ 2 = Merge-Commit. */
    parentCount: integer("parent_count").notNull().default(1),
    /** Geänderte Dateien `[{path, add, del}]` (höchstens 300), Commit → Diff-Übersicht. */
    files: jsonb("files").$type<{ path: string; add: number | null; del: number | null }[]>(),
    filesChanged: integer("files_changed"),
    insertions: integer("insertions"),
    deletions: integer("deletions"),
    /** Commit → Session (s. git/attribution.ts): Session, Sicherheit, Begründung, Zeitpunkt der Zuordnung. */
    sessionKey: text("session_key"),
    sessionConfidence: text("session_confidence"),
    sessionReason: text("session_reason"),
    attributedAt: ts("attributed_at"),
  },
  (t) => [
    uniqueIndex("git_commits_repo_sha_idx").on(t.repoId, t.sha),
    index("git_commits_author_date_idx").on(t.authorDate),
    index("git_commits_committed_at_idx").on(t.committedAt),
  ],
);

/** Aktions-Log aus dem Reflog (Merge, Push, Reset, Checkout …), nur gelesen. Wächst. */
export const gitActions = pgTable(
  "git_actions",
  {
    id: text("id").primaryKey(), // deterministisch aus der Brücke (doppeltes Senden harmlos)
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    worktreePath: text("worktree_path").notNull(),
    ref: text("ref").notNull(),
    at: ts("at").notNull(),
    action: text("action").notNull(), // GitActionKind
    subject: text("subject").notNull(),
    newSha: text("new_sha"),
    identity: text("identity"),
  },
  (t) => [index("git_actions_at_idx").on(t.at)],
);

/** Worktrees des App-Repos (`git worktree list`). */
export const gitWorktrees = pgTable(
  "git_worktrees",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    branch: text("branch"),
    headSha: text("head_sha"),
    locked: boolean("locked").notNull().default(false),
  },
  (t) => [uniqueIndex("git_worktrees_path_idx").on(t.path)],
);

/** Letztes Probe-Merge-Ergebnis je Repo+Zweig (`git merge-tree --write-tree main <zweig>`, alle
 * 10 Min + bei Änderung, NIE das Repo verändernd — s. apps/bridge/src/git/probeMerge.ts). */
export const gitProbeMerges = pgTable(
  "git_probe_merges",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    status: text("status").notNull(), // 'clean' | 'conflict'
    conflictFiles: jsonb("conflict_files").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    checkedAt: ts("checked_at").notNull().defaultNow(),
    checksumBefore: text("checksum_before").notNull(),
    checksumAfter: text("checksum_after").notNull(),
  },
  (t) => [uniqueIndex("git_probe_merges_repo_branch_idx").on(t.repoId, t.branch)],
);

/** Verlauf automatischer Nachzieh-Entscheidungen. Wächst. */
export const gitCatchupHistory = pgTable(
  "git_catchup_history",
  {
    id: serial("id").primaryKey(),
    repoId: text("repo_id").notNull().references(() => gitRepos.id, { onDelete: "cascade" }),
    worktreePath: text("worktree_path").notNull(),
    branch: text("branch").notNull(),
    outcome: text("outcome").notNull(), // CatchupOutcome
    mainShaBefore: text("main_sha_before").notNull(),
    mainShaAfter: text("main_sha_after"),
    detail: text("detail").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("git_catchup_history_repo_idx").on(t.repoId)],
);

/** Reservierte Dateibereiche. `sessionKey` nur informativ, keine harte FK (eine
 * Reservierung kann auch für eine noch nicht gestartete Aufgabe gelten). */
export const reservations = pgTable(
  "reservations",
  {
    id: serial("id").primaryKey(),
    pathGlob: text("path_glob").notNull(),
    label: text("label").notNull(),
    sessionKey: text("session_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
    until: ts("until"),
  },
  (t) => [index("reservations_path_glob_idx").on(t.pathGlob)],
);

/** Rohdaten für die Lernregel "3 Konflikte in 7 Tagen im selben Ordner". Wächst. */
export const conflictEvents = pgTable(
  "conflict_events",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // 'kollision' | 'merge'
    folder: text("folder").notNull(),
    path: text("path").notNull(),
    detectedAt: ts("detected_at").notNull().defaultNow(),
  },
  (t) => [index("conflict_events_folder_detected_idx").on(t.folder, t.detectedAt)],
);

/** „Ignorieren“/„Erledigt“ einer Konflikt-Entscheidung (Schlüssel aus `buildConflictModel`:
 * Ordner + beteiligte Sessions). Additiv — die Kollisionskarte selbst bleibt unverändert. */
export const conflictDismissals = pgTable("conflict_dismissals", {
  id: serial("id").primaryKey(),
  decisionKey: text("decision_key").notNull().unique(),
  status: text("status").notNull(), // DecisionDismissal: 'ignored' | 'done'
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Lernbuch: verallgemeinert `sort_rules` auf reservierung/konflikt/freigabe. */
export const rules = pgTable("rules", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // RuleKind
  condition: jsonb("condition").notNull(),
  action: jsonb("action").notNull(),
  origin: text("origin").notNull(),
  active: boolean("active").notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastHitAt: ts("last_hit_at"),
});

/** Deploys — für die NyxOS selbst von einem Deploy-Skript gemeldet (`POST /api/server/deploys`). */
export const deploys = pgTable(
  "deploys",
  {
    id: serial("id").primaryKey(),
    project: text("project").notNull(), // Compose-Projekt, z. B. 'nyxos'
    containerName: text("container_name").notNull(),
    imageId: text("image_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    gitRev: text("git_rev"),
    source: text("source").notNull(), // 'deploy.sh' | 'docker-events'
  },
  (t) => [index("deploys_project_created_idx").on(t.project, t.createdAt)],
);

/**
 * (Nutzung): eine Zeile je Nachricht mit Tokennutzung, aus einem Bestand-Scan der Brücke über
 * ALLE Claude-/Codex-Verläufe ("alle Projekte, aber ohne Inhalte"). `project`: Name des Projekts
 * (Ordnername des Repos) für Sessions unterhalb der Projektordner — sonst `'andere'` (bewusst EIN
 * fester, nicht unterscheidbarer Wert, kein Projektname/Pfad: die Anzeige/DB darf nie erkennen lassen,
 * an welchem fremden Projekt gearbeitet wurde). `sessionKey` ist nur bei erfassten Projekten gesetzt (informativ, KEIN Fremdschlüssel — der Scan läuft
 * unabhängig vom Session-Ingest, eine passende `sessions`-Zeile muss nicht existieren). `id` ist
 * deterministisch aus Werkzeug/Session/Zeit/Modell/Zahlen gebildet (s. `usage/ingest.ts`), damit
 * ein erneuter Scan nie doppelt zählt.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    ts: ts("ts").notNull(),
    tool: text("tool").notNull(),
    model: text("model"),
    project: text("project").notNull(), // Projektname | 'andere'
    sessionKey: text("session_key"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheCreation5mTokens: bigint("cache_creation_5m_tokens", { mode: "number" }).notNull().default(0),
    cacheCreation1hTokens: bigint("cache_creation_1h_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    /** In USD, mit dem zum Zeitpunkt des Einlesens gültigen Preis (`prices`) berechnet; `null` =
     * kein Preis für dieses Modell hinterlegt (nie geschätzt, s. GOAL/ESKALATION). */
    cost: doublePrecision("cost"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_ts_idx").on(t.ts),
    index("usage_events_tool_ts_idx").on(t.tool, t.ts),
    index("usage_events_project_ts_idx").on(t.project, t.ts),
    index("usage_events_session_idx").on(t.sessionKey),
  ],
);

/** Verdichtung von `usage_events` je Tag/Werkzeug/Modell/Projekt — Grundlage der Nutzung-Tab-
 * Diagramme, damit die Web-App nie Millionen Einzelzeilen aggregieren muss. */
export const usageDaily = pgTable(
  "usage_daily",
  {
    id: serial("id").primaryKey(),
    day: text("day").notNull(), // 'YYYY-MM-DD' (Kalendertag des Ereignisses, UTC)
    tool: text("tool").notNull(),
    model: text("model"),
    project: text("project").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheCreation5mTokens: bigint("cache_creation_5m_tokens", { mode: "number" }).notNull().default(0),
    cacheCreation1hTokens: bigint("cache_creation_1h_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    cost: doublePrecision("cost"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_daily_day_tool_model_project_idx").on(t.day, t.tool, t.model, t.project),
    index("usage_daily_day_idx").on(t.day),
  ],
);

/** Preise je Modell, editierbar (`PATCH /api/usage/prices/:id`) — Ausgangswerte aus
 * `packages/shared/src/usage.ts` `BUILTIN_MODEL_PRICES` (Quelle je Zeile im Feld `source`). */
export const prices = pgTable(
  "prices",
  {
    id: serial("id").primaryKey(),
    model: text("model").notNull(),
    inputPerToken: doublePrecision("input_per_token").notNull(),
    outputPerToken: doublePrecision("output_per_token").notNull(),
    cacheReadPerToken: doublePrecision("cache_read_per_token").notNull(),
    cacheCreation5mPerToken: doublePrecision("cache_creation_5m_per_token").notNull(),
    cacheCreation1hPerToken: doublePrecision("cache_creation_1h_per_token"),
    contextWindow: integer("context_window"),
    validFrom: text("valid_from").notNull(), // 'YYYY-MM-DD'
    source: text("source").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("prices_model_valid_from_idx").on(t.model, t.validFrom)],
);

/** Bestand an Agenten/Skills (Name, Beschreibung, Pfad, Herkunft) — meldet die Brücke bei Änderung
 *. `kind`: `'agent'` | `'skill'`. `source`: z. B. `'user'` (`~/.claude/agents`),
 * `'project'` (`<Projektordner>/.claude/agents`), `'plugin:<name>'`. */
/**
 * Einstellungen der Nutzung — eine Zeile (`id = 1`), vom Server beim ersten Lesen mit den
 * Standardwerten angelegt (wie `push_settings`). Ziele/Warnschwellen in Tokens (`null` = aus).
 * `warnState` merkt sich, wann zuletzt gewarnt wurde (Tag bzw. Zeitpunkt je Werkzeug), damit der
 * 60-s-Ticker nicht jede Minute neu warnt (`usage/warnings.ts`).
 */
export const usageSettings = pgTable("usage_settings", {
  id: integer("id").primaryKey().default(1),
  defaultRange: text("default_range").notNull().default("30"),
  goalScope: text("goal_scope").notNull().default("all"),
  goalMonthTokens: bigint("goal_month_tokens", { mode: "number" }),
  goalWeekTokens: bigint("goal_week_tokens", { mode: "number" }),
  warnWindowPct: integer("warn_window_pct"),
  warnDailyTokens: bigint("warn_daily_tokens", { mode: "number" }),
  warnState: jsonb("warn_state").$type<{ dailyDay?: string; windowAt?: Record<string, string>; /** je `werkzeug:fenster` der Reset des zuletzt gemeldeten Fensters. */ forecastFor?: Record<string, string> }>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentCatalog = pgTable(
  "agent_catalog",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    path: text("path").notNull(),
    source: text("source").notNull(),
    machineId: text("machine_id").references(() => machines.id),
    seenAt: ts("seen_at").notNull().defaultNow(),
    /** Modell, Werkzeuge, Farbe, Prompt eines Agenten (nur `kind = 'agent'`), sonst null. */
    details: jsonb("details").$type<AgentDetails>(),
  },
  (t) => [uniqueIndex("agent_catalog_kind_path_idx").on(t.kind, t.path)],
);

/**
 * PG „Gehirn": Obsidian-Notizen aus dem Vault auf dem Rechner (Brücke liest nur, `POST /ingest/vault`).
 * Nur Metadaten + Link-Ziele + genannte Session-IDs, KEIN Volltext. `path` relativ zur Wurzel;
 * Schlüssel (root, path), damit mehrere Vaults/Maschinen sich nicht gegenseitig löschen.
 * `sync_id` = Kennung des vollständigen Abgleichs, der die Zeile zuletzt bestätigt hat — nach dem
 * letzten Teil eines Vollabgleichs löscht der Server Zeilen mit anderer Kennung (Datei gelöscht).
 */
export const vaultNotes = pgTable(
  "vault_notes",
  {
    path: text("path").notNull(),
    machineId: text("machine_id").references(() => machines.id, { onDelete: "cascade" }),
    root: text("root").notNull(),
    title: text("title").notNull(),
    heading: text("heading"),
    folder: text("folder").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    links: jsonb("links").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    mentions: jsonb("mentions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    mtime: ts("mtime"),
    size: integer("size").notNull().default(0),
    /** Anfang der Notiz (≤ 600 Zeichen, reiner Text) für die Info-Karte; null bei älteren Brücken. */
    excerpt: text("excerpt"),
    /** Quelldatei einer Code-Notiz (Frontmatter `path`) — daraus die Fremd-Bibliothek im Gehirn; null bei älteren Brücken. */
    sourcePath: text("source_path"),
    syncId: text("sync_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.root, t.path] }), index("vault_notes_sync_idx").on(t.syncId)],
);

/**
 * Kontext-Wächter — Standard + Haiku. Ein-Zeilen-Singleton (fester `id = 1`), lazy angelegt
 * wie `push_settings`/`night_settings` (s. `context-guard/store.ts`). Zwei Sätze in EINER Zeile
 * statt zwei Zeilen mit fester ID in derselben Tabelle wie die Overrides unten: eine `serial`-Spalte
 * neben handvergebenen IDs kollidiert früher oder später mit der eigenen Sequenz (gefunden beim
 * Testen dieses Pakets) — die Trennung in zwei Tabellen umgeht das strukturell.
 */
export const contextGuardDefaults = pgTable("context_guard_defaults", {
  id: integer("id").primaryKey().default(1),
  defaultHinweisPct: integer("default_hinweis_pct").notNull().default(60),
  defaultErzwingenEnabled: boolean("default_erzwingen_enabled").notNull().default(true),
  defaultErzwingenPct: integer("default_erzwingen_pct").default(80),
  haikuHinweisPct: integer("haiku_hinweis_pct").notNull().default(60),
  haikuErzwingenEnabled: boolean("haiku_erzwingen_enabled").notNull().default(true),
  haikuErzwingenPct: integer("haiku_erzwingen_pct").default(80),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Kontext-Wächter — Überschreibungen je Modell ODER je Session (`scope` unterscheidet). Eine
 * Zeile je Modell-Name bzw. je Session, beide mit normaler `serial`-ID (keine Handvergabe, s. o.).
 * Auflösung Session > Modell > Standard/Haiku, s. `resolveContextGuardThresholds` in
 * `packages/shared/src/context-guard.ts` (reine Funktion, DB-frei). `model`/`sessionKey` bleiben
 * beim jeweils anderen Scope NULL — Postgres zählt mehrere NULLs in einem UNIQUE-Index nie als
 * Kollision, die beiden Indizes unten wirken also nur innerhalb ihres eigenen Scopes.
 */
export const contextGuardOverrides = pgTable(
  "context_guard_overrides",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(), // 'model' | 'session'
    model: text("model"),
    sessionKey: text("session_key").references(() => sessions.id, { onDelete: "cascade" }),
    hinweisPct: integer("hinweis_pct").notNull(),
    erzwingenEnabled: boolean("erzwingen_enabled").notNull().default(true),
    erzwingenPct: integer("erzwingen_pct"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cgo_model_idx").on(t.model), uniqueIndex("cgo_session_idx").on(t.sessionKey)],
);

/**
 * Kontext-Wächter — Zustand je Session (eine Zeile), damit Hinweis/Erzwingen genau EINMAL je
 * Schwellen-Überschreitung auslösen (`hinweisNotifiedAt`/`erzwingenAttemptedAt`, zurückgesetzt sobald
 * der Kontext-Anteil wieder unter die jeweilige Schwelle fällt — s. `context-guard/monitor.ts`).
 */
export const contextGuardState = pgTable("context_guard_state", {
  sessionKey: text("session_key")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  lastPct: integer("last_pct"),
  hinweisNotifiedAt: ts("hinweis_notified_at"),
  erzwingenAttemptedAt: ts("erzwingen_attempted_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Protokoll jeder Prüfung mit Wirkung (Hinweis/Versuch), Grundlage für den Nachweis in der
 * Abnahme und für „kein Doppel-Senden" (Reihenfolge, nicht Ersatz für `context_guard_state`). */
export const contextGuardEvents = pgTable(
  "context_guard_events",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'hinweis' | 'erzwingen' | 'manuell'
    pctAtTrigger: integer("pct_at_trigger"),
    action: text("action").notNull(),
    detail: jsonb("detail"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("context_guard_events_session_idx").on(t.sessionKey, t.createdAt)],
);

/** Ein-Zeilen-Tabelle (`id = 1`) für Session-Zustands-Regeln. Fehlt die Zeile, gelten die
 * Standardwerte (`DEFAULT_CRASHED_MAX_HOURS`) — keine Migration muss Startwerte kennen. */
export const sessionStateSettings = pgTable("session_state_settings", {
  id: integer("id").primaryKey().default(1),
  /** Nach so vielen Stunden ohne Prozess zählt eine Session nicht mehr als „abgestürzt“, sondern als beendet. */
  crashedMaxHours: integer("crashed_max_hours").notNull().default(12),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Verlauf der Brücken-Verbindung: eine Zeile je Abschnitt (online / verbindet neu /
 * offline mit Grund). Geht „verbindet neu" in einen echten Ausfall über, wird dieselbe Zeile auf
 * „offline" gesetzt (Beginn bleibt), statt zwei Zeilen zu schreiben. Dauer = Abstand zur nächsten Zeile. */
export const bridgeEvents = pgTable(
  "bridge_events",
  {
    id: serial("id").primaryKey(),
    machineId: text("machine_id"),
    at: ts("at").notNull(),
    state: text("state").notNull(), // 'online' | 'reconnecting' | 'offline'
    reason: text("reason"),
  },
  (t) => [index("bridge_events_at_idx").on(t.at)],
);

/**
 * „Zustellen, sobald sie wartet“: Texte an eine Session (Freigabe-Bescheid, Inbox-Antwort,
 * /compact, Chat-Nachricht …), die gerade nicht gefahrlos eingetippt werden konnten. Dauerhaft, damit
 * ein Neustart/Deploy keinen Freigabe-Bescheid verschluckt. Zustellung: `delivery/queue.ts`.
 */
export const sessionDeliveries = pgTable(
  "session_deliveries",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'compact' | 'approval' | 'inbox' | 'haiku_answer' | 'chat'
    method: text("method").notNull(), // 'send_text' | 'send_message'
    payload: jsonb("payload").notNull(), // { text } bzw. { text, images }
    status: text("status").notNull().default("queued"), // 'queued' | 'sending' | 'sent' | 'expired' | 'failed' | 'cancelled'
    /** Gleicher Schlüssel, noch wartend → kein zweiter Eintrag (z. B. zweimal „Jetzt komprimieren“). */
    dedupeKey: text("dedupe_key"),
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    lastAttemptAt: ts("last_attempt_at"),
    doneAt: ts("done_at"),
  },
  (t) => [index("session_deliveries_session_idx").on(t.sessionKey, t.status, t.id), index("session_deliveries_status_idx").on(t.status, t.expiresAt)],
);

/**
 * „Zuletzt geöffnet“: wann der Nutzer eine Session zuletzt in der Web-App geöffnet hat.
 * Eine Zeile je Session (kein wachsendes Protokoll) – geräteübergreifend, weil serverseitig.
 */
export const sessionOpens = pgTable(
  "session_opens",
  {
    sessionKey: text("session_key")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    lastOpenedAt: ts("last_opened_at").notNull().defaultNow(),
    openCount: integer("open_count").notNull().default(1),
  },
  (t) => [index("session_opens_last_idx").on(t.lastOpenedAt)],
);

/** „Session zusammenfassen & prüfen“ — Haikus Prüfung hängt an der Session (additiv). */
export const sessionAudits = pgTable(
  "session_audits",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** `running` | `done` | `error` */
    status: text("status").notNull(),
    result: jsonb("result"),
    error: text("error"),
    itemsRead: integer("items_read"),
    itemsTotal: integer("items_total"),
    callId: integer("call_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("session_audits_session_idx").on(t.sessionKey, t.createdAt)],
);

/**
 * vorverdaute Kennzahlen je Archiv-Datei (Haupt-Verlauf oder `subagents/agent-*.jsonl`),
 * damit die Seitenpanels nicht bei jedem Öffnen Hunderte MB Verlauf neu lesen müssen (eine echte
 * Session hat 190 Sub-Agent-Dateien, 318 MB). Gültig, solange `sha256` = `archive.sha256`; eine neue
 * Archiv-Fassung rechnet die Zeile neu (`session-digest.ts`). `version` hebt man an, wenn sich die
 * Auswertung ändert — alte Zeilen werden dann beim nächsten Zugriff neu gerechnet.
 */
export const archiveDigests = pgTable(
  "archive_digests",
  {
    archiveId: integer("archive_id")
      .primaryKey()
      .references(() => archive.id, { onDelete: "cascade" }),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** `null` = Haupt-Verlauf, sonst die Sub-Agent-Kennung aus dem Dateinamen. */
    agentId: text("agent_id"),
    sha256: text("sha256").notNull(),
    version: integer("version").notNull(),
    digest: jsonb("digest").notNull(),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [index("archive_digests_session_idx").on(t.sessionKey)],
);

/**
 * jede einzelne Datei-Änderung (Edit/Write/apply_patch) aus dem Archiv — Grundlage für
 * „Anzahl Änderungen, +/−" je Datei und die Inhaltssuche im Reiter „Änderungen". Der Text ist je
 * Änderung auf 64 000 Zeichen begrenzt (deckt fast jede Datei ganz ab, bläht die DB nicht auf).
 */
export const sessionChangeOps = pgTable(
  "session_change_ops",
  {
    id: serial("id").primaryKey(),
    archiveId: integer("archive_id")
      .notNull()
      .references(() => archive.id, { onDelete: "cascade" }),
    sessionKey: text("session_key")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    ts: ts("ts"),
    filePath: text("file_path").notNull(),
    tool: text("tool").notNull(),
    added: integer("added").notNull(),
    removed: integer("removed").notNull(),
    addedText: text("added_text").notNull().default(""),
    removedText: text("removed_text").notNull().default(""),
  },
  (t) => [index("session_change_ops_session_file_idx").on(t.sessionKey, t.filePath), index("session_change_ops_archive_idx").on(t.archiveId)],
);

/**
 * Import-Quellen, die die Brücke schickt (GOAL.md-Aufträge, MASSNAHMENPLAN.md). Nur-Lese-
 * Spiegel: der Server liest die Dateien nie selbst (im Container gibt es keinen Projektordner), er
 * bekommt sie über `POST /ingest/entry-sources` und importiert daraus. `path` ist repo-relativ ab
 * dem Projektordner. Fehlt eine Datei in einer vollständigen Lieferung, bekommt sie `removedAt` (nie löschen).
 */
export const importFiles = pgTable("import_files", {
  path: text("path").primaryKey(),
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  machineId: text("machine_id"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  removedAt: ts("removed_at"),
});

/** letzter Import-Lauf je Quelle (`dateien` = GOAL.md/Audit von der Brücke, `ideen` =
 * Ideen-Postfach). `state` ist ein kurzer Code (ok | leer | wartet | kein_zugang | aus | fehler),
 * `message` der einfache deutsche Satz für die Oberfläche. */
export const importStatus = pgTable("import_status", {
  source: text("source").primaryKey(),
  state: text("state").notNull(),
  message: text("message"),
  lastRunAt: ts("last_run_at"),
  lastOkAt: ts("last_ok_at"),
  lastDeliveryAt: ts("last_delivery_at"),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
});

// ───────────────────────────── Geheimnisse, Modelle, Konnektoren ─────────────────────────────

/** Verschlüsselte Geheimnisse (AES-256-GCM, Schlüssel `NYXOS_SECRETS_KEY`, s. secrets/store.ts). Nie Klartext. */
export const secrets = pgTable("secrets", {
  name: text("name").primaryKey(),
  /** base64: Chiffretext, 12-Byte-IV, 16-Byte-Prüfwert. Der Name ist als AAD gebunden. */
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  /** Nur Anzeige („…abcd“); bei kurzen oder strukturierten Werten null. */
  last4: text("last4"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Stimmen-Einstellungen (EINE Zeile, `id = 1`): Anbieter (eigene Stimme oder ElevenLabs), ElevenLabs-Stimme +
 * Modell und das eigene Aussprache-Wörterbuch. Der ElevenLabs-Schlüssel liegt NICHT hier, sondern verschlüsselt in
 * `secrets` (Name `elevenlabs.api-key`).
 */
export const nyxVoiceSettings = pgTable("nyx_voice_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("local"),
  elevenlabsVoiceId: text("elevenlabs_voice_id"),
  elevenlabsVoiceName: text("elevenlabs_voice_name"),
  elevenlabsModel: text("elevenlabs_model").notNull().default("eleven_multilingual_v2"),
  lexicon: jsonb("lexicon").$type<{ word: string; say: string }[]>().notNull().default([]),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Modell-Anbieter (Vorlage je Art, „custom-…“ für eigene Endpunkte). Schlüssel liegt in `secrets` (`provider.<id>`). */
export const modelProviders = pgTable("model_providers", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  via: text("via").notNull().default("direct"),
  enabled: boolean("enabled").notNull().default(true),
  models: jsonb("models").$type<{ id: string; label: string | null }[]>().notNull().default(sql`'[]'::jsonb`),
  lastTest: jsonb("last_test"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Rolle → Modell. Keine Zeile bzw. `provider_id` null = Standard (Haiku über das Claude-Programm). */
export const modelRoles = pgTable("model_roles", {
  role: text("role").primaryKey(),
  providerId: text("provider_id").references(() => modelProviders.id, { onDelete: "set null" }),
  model: text("model"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** MCP-Konnektoren für Nyx. Token/Anmeldung in `secrets` (`mcp.<name>` bzw. `mcp.<name>.oauth`). */
export const mcpConnectors = pgTable("mcp_connectors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  label: text("label").notNull(),
  template: text("template"),
  transport: text("transport").notNull(), // 'http' | 'sse' | 'stdio'
  url: text("url"),
  command: text("command"),
  args: jsonb("args").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  headers: jsonb("headers").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  auth: text("auth").notNull().default("none"), // 'none' | 'bearer' | 'header' | 'env' | 'oauth'
  authName: text("auth_name"),
  /** Geräte-Code-Anmeldung (z. B. Higgsfield): { deviceAuthorizeUrl, deviceTokenUrl }. */
  authConfig: jsonb("auth_config").$type<{ deviceAuthorizeUrl?: string; deviceTokenUrl?: string } | null>(),
  enabled: boolean("enabled").notNull().default(false),
  oauthExpiresAt: ts("oauth_expires_at"),
  /** Freigegebene Werkzeuge (Tool-Pinning): null = noch nie getestet → Nyx nutzt keins; neue Werkzeuge bleiben aus, bis der Nutzer sie freigibt. */
  allowedTools: jsonb("allowed_tools").$type<string[] | null>(),
  lastTest: jsonb("last_test"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
/** Nyx-Persönlichkeit + Nutzerprofil – eine Zeile (`id = 1`); fehlt sie, gelten die Startwerte
 * `DEFAULT_NYX_PROFILE` (packages/shared/src/nyx-persona.ts). Form der JSON-Spalten = zod-Schemas dort. */
export const nyxProfile = pgTable("nyx_profile", {
  id: integer("id").primaryKey().default(1),
  /** Wer der Nutzer ist (Name, Rolle, Projekte, Arbeitsweise, Vorlieben, No-Gos, Freitext). */
  userProfile: jsonb("user_profile").$type<NyxUserProfile>().notNull(),
  /** Wer Nyx ist (Charakter, Ton, Anrede, „Seele“). */
  personality: jsonb("personality").$type<NyxPersonality>().notNull(),
  /** Regler 0–100: length, speed, expertise, formality, initiative, humor. */
  sliders: jsonb("sliders").$type<NyxSliders>().notNull(),
  activePreset: text("active_preset"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** eigene Vorlagen (die eingebauten stehen im Code). Name ohne Groß/Klein eindeutig. */
export const nyxPresets = pgTable(
  "nyx_presets",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    sliders: jsonb("sliders").$type<NyxSliders>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("nyx_presets_label_idx").on(sql`lower(${t.label})`)],
);

/**
 * Telegram: EINE Zeile (`id = 1`). Gekoppelt ist genau ein Chat (der Nutzer). Vom Kopplungs-Code liegt nur
 * ein gesalzener SHA-256-Hash hier (Hermes `pairing.py`), nie der Code selbst. Das Bot-Token liegt NICHT hier,
 * sondern im Geheimnis-Speicher bzw. in der Server-.env.
 */
export const telegramState = pgTable("telegram_state", {
  id: integer("id").primaryKey(),
  chatId: text("chat_id"),
  chatName: text("chat_name"),
  pairedAt: ts("paired_at"),
  pairHash: text("pair_hash"),
  pairSalt: text("pair_salt"),
  pairExpiresAt: ts("pair_expires_at"),
  pairFailures: integer("pair_failures").notNull().default(0),
  pairLockedUntil: ts("pair_locked_until"),
  /** 'nyx' | 'session' — wohin freie Nachrichten gehen. */
  target: text("target").notNull().default("nyx"),
  sessionKey: text("session_key"),
  nyxThreadId: integer("nyx_thread_id"),
  /** „📞 Sprechen“: jede Sprachnachricht wird sofort beantwortet, Antwort nur als Sprache. */
  talkMode: boolean("talk_mode").notNull().default(false),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Letzte nach Telegram geschickte Antwort je Session (Ereignis-ID), damit nichts doppelt kommt. */
  forwarded: jsonb("forwarded").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  /** Hash des zuletzt gesetzten Befehlsmenüs (`setMyCommands` nur bei Änderung, OpenClaw T-4). */
  commandsHash: text("commands_hash"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ── N6 Skill-Bibliothek ──────────────────────────────────────────────────────────────────

/** Skills, wie die Brücke sie zuletzt gemeldet hat (Stand ohne Brücke). `key` = Aufruf-Name. Verschwindet ein
 * Skill vom Mac, bleibt die Zeile mit `missing_since` (nie still löschen, wie Hermes: nur archivieren). */
export const skills = pgTable("skills", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  source: text("source").notNull(),
  plugin: text("plugin"),
  dir: text("dir"),
  skillPath: text("skill_path"),
  writable: boolean("writable").notNull().default(false),
  sha256: text("sha256"),
  bytes: integer("bytes").notNull().default(0),
  files: jsonb("files").$type<{ rel: string; bytes: number }[]>().notNull().default(sql`'[]'::jsonb`),
  /** Angepinnt = Nyx schreibt keine Vorschläge dazu (Hermes `pinned`). */
  pinned: boolean("pinned").notNull().default(false),
  seenAt: ts("seen_at").notNull().defaultNow(),
  missingSince: ts("missing_since"),
});

/** Verlauf der SKILL.md (Hermes `skill_ledger`): ein Eintrag je neuem Stand (SHA-256), mit Anlass und Auftrag. */
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: serial("id").primaryKey(),
    skillKey: text("skill_key").notNull(),
    sha256: text("sha256").notNull(),
    content: text("content").notNull(),
    reason: text("reason").notNull(),
    jobId: integer("job_id"),
    backupDir: text("backup_dir"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("skill_versions_skill_idx").on(t.skillKey, t.id)],
);

/** Skill-Nutzung aus den Session-Ereignissen (inkrementell): `Skill`-Werkzeug-Aufrufe und `/befehl`-Eingaben. */
export const skillUses = pgTable(
  "skill_uses",
  {
    eventId: text("event_id").primaryKey(),
    skill: text("skill").notNull(),
    sessionKey: text("session_key").notNull(),
    ts: ts("ts").notNull(),
    via: text("via").notNull(),
    toolUseId: text("tool_use_id"),
    /** Heuristik gelaufen (Fenster nach dem Aufruf vollständig) + gefundenes Signal. */
    checkedAt: ts("checked_at"),
    signal: text("signal"),
  },
  (t) => [index("skill_uses_skill_ts_idx").on(t.skill, t.ts), index("skill_uses_unchecked_idx").on(t.ts).where(sql`${t.checkedAt} is null`)],
);

/** Lese-Stand des inkrementellen Nutzungs-Scans (eine Zeile). */
export const skillScanState = pgTable("skill_scan_state", {
  id: integer("id").primaryKey(),
  lastReceivedAt: ts("last_received_at"),
  syncedAt: ts("synced_at"),
  /** Stand des einmaligen Nachzählens (alle Ereignisse neu + Archiv); < SKILL_BACKFILL_VERSION = noch offen. */
  backfillVersion: integer("backfill_version").notNull().default(0),
});

/** Vorschläge von Nyx (Haiku) zu einem Skill – Nyx schreibt NIE selbst Skills (Hermes `write_approval`). */
export const skillSuggestions = pgTable(
  "skill_suggestions",
  {
    id: serial("id").primaryKey(),
    skillKey: text("skill_key").notNull(),
    sessionKey: text("session_key"),
    eventId: text("event_id"),
    signal: text("signal").notNull(),
    problem: text("problem").notNull(),
    evidence: text("evidence").notNull(),
    idea: text("idea").notNull(),
    author: text("author").notNull(),
    status: text("status").notNull().default("open"),
    jobId: integer("job_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_suggestions_event_idx").on(t.skillKey, t.eventId), index("skill_suggestions_skill_idx").on(t.skillKey, t.status)],
);

/** Opus-Aufträge (Neuer Skill / Verbessern / Vorschlag umsetzen): immer sichtbare, temporäre Claude-Session. */
export const skillJobs = pgTable("skill_jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  skillKey: text("skill_key"),
  suggestionId: integer("suggestion_id"),
  model: text("model").notNull(),
  brief: text("brief").notNull().default(""),
  sessionKey: text("session_key"),
  tmuxName: text("tmux_name"),
  backupDir: text("backup_dir"),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Abwesenheit (Migration 0038): Einstellungen „Wenn ich weg bin“ – eine Zeile (`id = 1`), Werte als JSON,
 * fehlende Schlüssel = Standard (`DEFAULT_AWAY_SETTINGS`). Wer gerade da ist, weiß nur der Speicher (Herzschlag).
 */
export const awaySettings = pgTable("away_settings", {
  id: integer("id").primaryKey().default(1),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Nyx bedient NyxOS über die eigene API (`app_api`, s. nyx/appApi/*, Migration 0040). Jede Zeile = ein Aufruf mit
 * Ergebnis (Protokoll). Riskante Aufrufe warten hier auf des Nutzers „Ausführen“ (`outcome = 'wartet'`, genau die Anfrage
 * in `pendingBody`, nach Ausführung/Absage/Verfall wieder leer). Körper im Protokoll nur geschwärzt (`bodyRedacted`).
 */
export const nyxApiCalls = pgTable(
  "nyx_api_calls",
  {
    id: serial("id").primaryKey(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** web · voice · telegram; null = automatischer Lauf bzw. ohne Kanal. */
    channel: text("channel"),
    /** Art des Laufs (chat, schedule, compact …). */
    callKind: text("call_kind"),
    threadId: integer("thread_id").references(() => haikuThreads.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    query: jsonb("query").$type<Record<string, string>>(),
    bodyRedacted: text("body_redacted"),
    /** ausgefuehrt · abgelehnt · fehler · wartet · bestaetigt · nicht_ausgefuehrt · verworfen · abgelaufen */
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    /** Name der Aktion bei Bestätigung (z. B. „Session beenden“). */
    label: text("label"),
    status: integer("status"),
    /** Nur solange `outcome = 'wartet'`: der genaue Körper, der nach „Ausführen“ gesendet wird. */
    pendingBody: jsonb("pending_body"),
    inboxItemId: integer("inbox_item_id").references(() => inboxItems.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at"),
    decidedAt: ts("decided_at"),
    resultExcerpt: text("result_excerpt"),
  },
  (t) => [index("nyx_api_calls_created_idx").on(t.createdAt), index("nyx_api_calls_inbox_idx").on(t.inboxItemId)],
);

export const schema = {
  nyxApiCalls,
  awaySettings,
  sessionStateSettings,
  machines,
  sessions,
  sessionOpens,
  sessionAudits,
  archiveDigests,
  sessionChangeOps,
  importFiles,
  importStatus,
  sessionEvents,
  sessionFiles,
  archive,
  sortRules,
  searchDocs,
  pushSettings,
  pushLog,
  buildRuns,
  nightRuns,
  haikuSettings,
  temporarySettings,
  temporaryMarks,
  haikuCalls,
  haikuThreads,
  haikuMessages,
  haikuReports,
  haikuNotes,
  nyxMemory,
  nyxMemorySuggestions,
  nyxTodos,
  nyxSchedules,
  nyxMedia,
  inboxItems,
  approvals,
  ideaLinks,
  ideaLinkHits,
  authCredentials,
  authSessions,
  authSetupCodes,
  entries,
  subtasks,
  links,
  entryEvents,
  docs,
  gitRepos,
  gitBranches,
  gitUncommitted,
  gitCommits,
  gitWorktrees,
  gitProbeMerges,
  gitCatchupHistory,
  gitActions,
  reservations,
  conflictEvents,
  rules,
  deploys,
  usageEvents,
  usageDaily,
  usageSettings,
  prices,
  agentCatalog,
  vaultNotes,
  contextGuardDefaults,
  contextGuardOverrides,
  contextGuardState,
  contextGuardEvents,
  bridgeEvents,
  sessionDeliveries,
  secrets,
  modelProviders,
  modelRoles,
  mcpConnectors,
  nyxProfile,
  nyxPresets,
  telegramState,
  skills,
  skillVersions,
  skillUses,
  skillScanState,
  skillSuggestions,
  skillJobs,
  nyxFiles,
};

export type Schema = typeof schema;

/** App-wide settings (one row, `id = 1`): language, the user's name, onboarding state, automatic updates. */
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  lang: text("lang").notNull().default("de"),
  userName: text("user_name").notNull().default(""),
  onboardingDone: boolean("onboarding_done").notNull().default(false),
  autoUpdate: boolean("auto_update").notNull().default(true),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
